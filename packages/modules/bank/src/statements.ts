/**
 * Statement import (T-0058, UC-08 flow 1 and A1, RQ-0019, DL-0082): parse → check → store the
 * normalised lines, skipping duplicates at two levels and telling the user what happened.
 *  1. The same file (SHA-256) for the same bank account is never imported twice.
 *  2. A line whose dedupe key is already stored for the bank account is skipped
 *     (INSERT … ON CONFLICT DO NOTHING), so overlapping statements add only new lines.
 * Statement lines are imported data, not ledger rows: nothing here touches journal tables.
 *
 * importStatementFile (T-0059, RQ-0028): a camt.053 file with one statement per bank account is
 * imported for the company. Every statement is matched to its bank account and fully checked
 * before anything is written, so the file is imported as a whole or not at all.
 */
import type { Database } from '@ledgerforce/db';
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import { matchStatementAccount } from './account-match.ts';
import { validateCsvMapping, type CsvMapping } from './csv.ts';
import { dedupeKeys } from './dedupe.ts';
import { StatementImportError } from './errors.ts';
import { assertBalances, detectFormat, parseStatement, splitCamt053 } from './parse.ts';
import type { ParsedStatement, StatementFormat } from './types.ts';

export { StatementImportError } from './errors.ts';

export interface ImportStatementInput {
  bankAccountId: string;
  /** The file exactly as received (its bytes are hashed). */
  content: Uint8Array;
  fileName?: string;
  /** Detected from the content when omitted. */
  format?: StatementFormat;
  /** CSV only; defaults to the mapping saved on the bank account. */
  csvMapping?: CsvMapping | undefined;
  importedBy?: string;
}

export interface ImportResult {
  /**
   * imported: at least one new line (or an empty statement) was stored;
   * duplicate_file: this exact file was imported before, nothing stored;
   * duplicate_lines: a new file, but every line in it was already imported.
   */
  outcome: 'imported' | 'duplicate_file' | 'duplicate_lines';
  statementId: string;
  linesInFile: number;
  linesCreated: number;
  linesDuplicate: number;
  /** What to tell the user. */
  message: string;
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
const BATCH = 1000;

function checkAccount(parsed: ParsedStatement, last3: string): void {
  if (parsed.accountRef === null) return;
  const alnum = (s: string) => s.replace(/[^0-9A-Za-z]/g, '');
  const ours = alnum(last3);
  const theirs = alnum(parsed.accountRef).slice(-ours.length);
  if (ours === '' || theirs !== ours) {
    throw new StatementImportError(
      `the file is for account …${theirs}, not this bank account (…${last3}): choose the right account`,
    );
  }
}

export async function importStatement(
  trx: Transaction<Database>,
  input: ImportStatementInput,
): Promise<ImportResult> {
  const account = await trx
    .selectFrom('app.bank_account')
    .select(['id', 'company_id', 'currency', 'account_number_last3', 'csv_mapping', 'status'])
    .where('id', '=', input.bankAccountId)
    .executeTakeFirst();
  if (!account) throw new StatementImportError('bank account not found');
  if (account.status !== 'active') throw new StatementImportError('the bank account is archived');

  const format = input.format ?? detectFormat(input.content);
  let csv = input.csvMapping;
  if (format === 'csv' && csv === undefined && account.csv_mapping !== null) {
    csv = validateCsvMapping(account.csv_mapping);
  }
  const parsed = parseStatement(input.content, { format, currency: account.currency, csv });
  assertBalances(parsed);
  checkAccount(parsed, account.account_number_last3);
  return store(trx, account, parsed, {
    format,
    sha: createHash('sha256').update(input.content).digest('hex'),
    fileName: input.fileName,
    importedBy: input.importedBy,
  });
}

interface StoreMeta {
  format: StatementFormat;
  sha: string;
  fileName: string | undefined;
  importedBy: string | undefined;
}

/** Write one checked statement and its new lines (file- and line-level duplicates skipped). */
async function store(
  trx: Transaction<Database>,
  account: { id: string; company_id: string; currency: string },
  parsed: ParsedStatement,
  meta: StoreMeta,
): Promise<ImportResult> {
  const { format, sha } = meta;
  const linesInFile = parsed.lines.length;
  const inserted = await trx
    .insertInto('app.bank_statement')
    .values({
      company_id: account.company_id,
      bank_account_id: account.id,
      currency: account.currency,
      format,
      file_name: meta.fileName ?? null,
      file_sha256: sha,
      account_ref: parsed.accountRef,
      period_start: parsed.periodStart,
      period_end: parsed.periodEnd,
      opening_balance: parsed.openingBalance?.toNumericString() ?? null,
      closing_balance: parsed.closingBalance?.toNumericString() ?? null,
      lines_total: linesInFile,
      imported_by: meta.importedBy ?? null,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'bank_account_id', 'file_sha256']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    const earlier = await trx
      .selectFrom('app.bank_statement')
      .select(['id', 'imported_at'])
      .where('bank_account_id', '=', account.id)
      .where('file_sha256', '=', sha)
      .executeTakeFirstOrThrow();
    return {
      outcome: 'duplicate_file',
      statementId: earlier.id,
      linesInFile,
      linesCreated: 0,
      linesDuplicate: linesInFile,
      message: `This file was already imported on ${earlier.imported_at.toISOString().slice(0, 10)}: no lines were added.`,
    };
  }

  const keys = dedupeKeys(parsed.lines);
  const rows = parsed.lines.map((l, i) => ({
    company_id: account.company_id,
    bank_account_id: account.id,
    statement_id: inserted.id,
    line_no: i + 1,
    posted_on: l.postedOn,
    amount: l.amount.toNumericString(),
    description: l.description,
    reference: l.reference,
    bank_txn_id: l.bankTxnId,
    dedupe_key: keys[i] ?? '',
    entry_ref: l.batch?.entryRef ?? null,
    entry_tx_no: l.batch?.part ?? null,
  }));
  let linesCreated = 0;
  for (let from = 0; from < rows.length; from += BATCH) {
    const created = await trx
      .insertInto('app.bank_statement_line')
      .values(rows.slice(from, from + BATCH))
      .onConflict((oc) => oc.columns(['tenant_id', 'bank_account_id', 'dedupe_key']).doNothing())
      .returning('line_no')
      .execute();
    linesCreated += created.length;
  }
  const linesDuplicate = linesInFile - linesCreated;
  const allDuplicates = linesInFile > 0 && linesCreated === 0;
  return {
    outcome: allDuplicates ? 'duplicate_lines' : 'imported',
    statementId: inserted.id,
    linesInFile,
    linesCreated,
    linesDuplicate,
    message: allDuplicates
      ? `All ${plural(linesInFile, 'line')} in this file were already imported: no new lines.`
      : `${String(linesCreated)} new ${linesCreated === 1 ? 'line' : 'lines'} imported; ` +
        `${plural(linesDuplicate, 'line')} already imported and skipped.`,
  };
}

export interface ImportStatementFileInput {
  companyId: string;
  /** The file exactly as received (its bytes are hashed). */
  content: Uint8Array;
  fileName?: string;
  /** Detected from the content when omitted; only camt.053 names each statement's account. */
  format?: StatementFormat;
  importedBy?: string;
}

export interface FileImportResult {
  /**
   * imported: at least one statement added lines (or was empty and new);
   * duplicate_file: every statement of this file was imported before;
   * duplicate_lines: otherwise nothing new.
   */
  outcome: ImportResult['outcome'];
  /** One per statement, in file order. */
  statements: (ImportResult & { bankAccountId: string; bankAccountName: string })[];
  message: string;
}

/**
 * Import a camt.053 file for the company: each statement onto the bank account its Acct names
 * (account-match.ts). Atomic: an unknown, ambiguous or repeated account, a currency mismatch, a
 * broken balance or a batch that does not add up refuses the whole file before anything is written;
 * the caller's transaction covers the writes.
 */
export async function importStatementFile(
  trx: Transaction<Database>,
  input: ImportStatementFileInput,
): Promise<FileImportResult> {
  const format = input.format ?? detectFormat(input.content);
  if (format !== 'camt053') {
    throw new StatementImportError(
      'only camt.053 files name the bank account of each statement: choose the bank account ' +
        'and import this file into it',
    );
  }
  const stmts = splitCamt053(input.content);
  if (stmts.length === 0) throw new StatementImportError('the camt.053 file holds no statement');
  const accounts = await trx
    .selectFrom('app.bank_account')
    .select(['id', 'company_id', 'name', 'bsb', 'account_number_last3', 'currency', 'status'])
    .where('company_id', '=', input.companyId)
    .orderBy('created_at')
    .execute();
  const candidates = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    bsb: a.bsb,
    last3: a.account_number_last3,
    currency: a.currency,
    status: a.status,
  }));

  const plan = stmts.map((st) => {
    const match = matchStatementAccount(st, candidates);
    const account = accounts.find((a) => a.id === match.id);
    if (!account) throw new StatementImportError('bank account not found');
    return { st, account };
  });
  plan.forEach((p, i) => {
    const earlier = plan.findIndex((q) => q.account.id === p.account.id);
    if (earlier < i) {
      throw new StatementImportError(
        `statements ${String(earlier + 1)} and ${String(i + 1)} of this file are for the same bank ` +
          `account (${p.account.name}): the bank should send one statement per account`,
      );
    }
  });
  const checked = plan.map(({ st, account }) => {
    const parsed = st.read(account.currency);
    assertBalances(parsed);
    checkAccount(parsed, account.account_number_last3);
    return { account, parsed };
  });

  const sha = createHash('sha256').update(input.content).digest('hex');
  const statements: FileImportResult['statements'] = [];
  for (const { account, parsed } of checked) {
    const r = await store(trx, account, parsed, {
      format,
      sha,
      fileName: input.fileName,
      importedBy: input.importedBy,
    });
    statements.push({ ...r, bankAccountId: account.id, bankAccountName: account.name });
  }
  const outcome: ImportResult['outcome'] = statements.every((s) => s.outcome === 'duplicate_file')
    ? 'duplicate_file'
    : statements.some((s) => s.outcome === 'imported')
      ? 'imported'
      : 'duplicate_lines';
  return {
    outcome,
    statements,
    message: statements.map((s) => `${s.bankAccountName}: ${s.message}`).join(' '),
  };
}
