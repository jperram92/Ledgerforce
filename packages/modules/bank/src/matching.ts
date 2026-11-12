/**
 * Bank matching (T-0060, UC-08 steps 2–4, RQ-0108, DL-0312, migration 0050).
 *
 * - createMatchRule: store a bank rule (validated declarative definition → suggested account).
 * - runMatching: for a bank account's unmatched lines, load unmatched book transactions
 *   (customer receipts and confirmed supplier payment batches on the bank's GL account) and the
 *   active rules, plan with the pure matcher, then record exact unique matches (method
 *   auto_exact, line → matched) and store every other proposal as an open suggestion. Rules never
 *   match anything by themselves (SS-UC08-04). Idempotent: a re-run adds nothing new.
 * - createTransactionFromLine: an unmatched line becomes a manual journal — the bank line on the
 *   bank's GL account plus the person's counter lines (or the accepted rule's account) — created,
 *   submitted and posted through @ledgerforce/journals, i.e. through the posting engine with the
 *   manual-journal rules (control accounts refused, approval threshold, period checks). The line is
 *   then matched to the posted entry (SS-UC08-05). Idempotent per line.
 *
 * This module never writes ledger tables; the database guard (0050) re-checks every match.
 */
import type { Database } from '@ledgerforce/db';
import {
  createManualJournal,
  getManualJournal,
  postManualJournal,
  submitManualJournal,
} from '@ledgerforce/journals';
import type { AccountRef, PostingLineInput, PostingOutbox } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import type { SodSettings } from '@ledgerforce/shared/sod';
import { sql, type Transaction } from 'kysely';
import {
  MATCH_WINDOW_DAYS,
  planMatches,
  validateMatchRule,
  type MatchCandidate,
  type MatchLine,
  type MatchRule,
} from './matcher.ts';

type Trx = Transaction<Database>;

export type BankMatchErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_MATCHED'
  | 'INVALID_TRANSACTION'
  | 'SUGGESTION_CLOSED'
  | 'NOT_MATCHED'
  | 'RECONCILED';

export class BankMatchError extends DomainError {
  declare readonly code: BankMatchErrorCode;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MatchRuleInput {
  companyId: string;
  /** Omit for a rule that applies to every bank account of the company. */
  bankAccountId?: string;
  name: string;
  /** Lower runs first; default 100. */
  priority?: number;
  /** Validated by validateMatchRule. */
  definition: unknown;
  /** GL account the rule suggests for the counter line. */
  accountId: string;
  createdBy?: string;
}

/** Store a bank rule. Returns its id. */
export async function createMatchRule(trx: Trx, input: MatchRuleInput): Promise<string> {
  const definition = validateMatchRule(input.definition);
  const r = await sql<{ id: string }>`
    INSERT INTO app.bank_match_rule (company_id, bank_account_id, name, priority, definition, account_id, created_by)
    VALUES (${input.companyId}, ${input.bankAccountId ?? null}, ${input.name.trim()}, ${input.priority ?? 100},
            ${JSON.stringify(definition)}::jsonb, ${input.accountId}, ${input.createdBy ?? null})
    RETURNING id::text`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new Error('bank rule insert returned nothing');
  return row.id;
}

interface BankAccountRow {
  id: string;
  company_id: string;
  gl_account_id: string;
}

async function bankAccount(trx: Trx, id: string): Promise<BankAccountRow> {
  if (!UUID_RE.test(id)) throw new BankMatchError('NOT_FOUND', `bank account ${id} not found`);
  const r = await sql<BankAccountRow>`
    SELECT id::text, company_id::text, gl_account_id::text FROM app.bank_account WHERE id = ${id}`.execute(
    trx,
  );
  const row = r.rows[0];
  if (!row) throw new BankMatchError('NOT_FOUND', `bank account ${id} not found`);
  return row;
}

async function unmatchedLines(trx: Trx, bankAccountId: string): Promise<MatchLine[]> {
  const r = await sql<{
    id: string;
    amount: string;
    description: string;
    reference: string | null;
    posted_on: string;
  }>`
    SELECT l.id::text, l.amount::text, l.description, l.reference,
           to_char(l.posted_on, 'YYYY-MM-DD') AS posted_on
      FROM app.bank_statement_line l
      JOIN app.bank_statement s ON s.tenant_id = l.tenant_id AND s.id = l.statement_id
     WHERE l.bank_account_id = ${bankAccountId} AND l.status = 'unmatched' AND s.status = 'imported'
     ORDER BY l.posted_on, l.statement_id, l.line_no`.execute(trx);
  return r.rows.map((x) => ({
    id: x.id,
    amount: x.amount,
    description: x.description,
    reference: x.reference,
    postedOn: x.posted_on,
  }));
}

/**
 * Posted book transactions on the bank's GL account with no active match, dated inside the
 * window around the unmatched lines.
 */
async function unmatchedCandidates(
  trx: Trx,
  bank: BankAccountRow,
  from: string,
  to: string,
): Promise<MatchCandidate[]> {
  const r = await sql<{
    kind: MatchCandidate['kind'];
    id: string;
    entry_id: string;
    amount: string;
    date: string;
    refs: (string | null)[];
  }>`
    SELECT 'customer_receipt' AS kind, r.id::text, r.entry_id::text, r.amount::text,
           to_char(r.receipt_date, 'YYYY-MM-DD') AS date, ARRAY[r.reference, r.receipt_no] AS refs
      FROM app.customer_receipt r
     WHERE r.company_id = ${bank.company_id} AND r.account_id = ${bank.gl_account_id}
       AND r.receipt_date BETWEEN ${from}::date - ${MATCH_WINDOW_DAYS}::int AND ${to}::date + ${MATCH_WINDOW_DAYS}::int
       AND NOT EXISTS (SELECT 1 FROM app.bank_match m
                        WHERE m.tenant_id = r.tenant_id AND m.journal_entry_id = r.entry_id AND m.status = 'matched')
    UNION ALL
    SELECT 'supplier_payment', b.id::text, c.entry_id::text, (-b.total)::text,
           to_char(c.confirmed_on, 'YYYY-MM-DD'), ARRAY[b.batch_no, c.bank_reference]
      FROM app.payment_batch_confirmation c
      JOIN app.payment_batch b ON b.tenant_id = c.tenant_id AND b.id = c.batch_id
     WHERE c.company_id = ${bank.company_id} AND b.account_id = ${bank.gl_account_id}
       AND c.confirmed_on BETWEEN ${from}::date - ${MATCH_WINDOW_DAYS}::int AND ${to}::date + ${MATCH_WINDOW_DAYS}::int
       AND NOT EXISTS (SELECT 1 FROM app.bank_match m
                        WHERE m.tenant_id = c.tenant_id AND m.journal_entry_id = c.entry_id AND m.status = 'matched')
     ORDER BY 5, 2`.execute(trx);
  return r.rows.map((x) => ({
    kind: x.kind,
    id: x.id,
    entryId: x.entry_id,
    amount: x.amount,
    date: x.date,
    references: x.refs.filter((s): s is string => s !== null && s.trim() !== ''),
  }));
}

async function activeRules(trx: Trx, bank: BankAccountRow): Promise<MatchRule[]> {
  const r = await sql<{
    id: string;
    name: string;
    priority: number;
    definition: unknown;
    account_id: string;
  }>`
    SELECT id::text, name, priority, definition, account_id::text FROM app.bank_match_rule
     WHERE company_id = ${bank.company_id} AND status = 'active'
       AND (bank_account_id IS NULL OR bank_account_id = ${bank.id})`.execute(trx);
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    priority: x.priority,
    accountId: x.account_id,
    ...validateMatchRule(x.definition),
  }));
}

export interface MatchingRunResult {
  linesConsidered: number;
  autoMatched: number;
  /** New open suggestions stored by this run (existing open ones are not repeated). */
  suggested: number;
}

/** Run exact matching and rule suggestions for one bank account's unmatched lines. */
export async function runMatching(
  trx: Trx,
  opts: { bankAccountId: string; runBy?: string },
): Promise<MatchingRunResult> {
  const bank = await bankAccount(trx, opts.bankAccountId);
  // One run per bank account at a time, so two runs cannot pair the same transaction twice.
  await sql`SELECT 1 FROM app.bank_account WHERE id = ${bank.id} FOR UPDATE`.execute(trx);
  const lines = await unmatchedLines(trx, bank.id);
  if (lines.length === 0) return { linesConsidered: 0, autoMatched: 0, suggested: 0 };
  const dates = lines.map((l) => l.postedOn).sort();
  const candidates = await unmatchedCandidates(trx, bank, dates[0] ?? '', dates.at(-1) ?? '');
  const plan = planMatches(lines, candidates, await activeRules(trx, bank));

  for (const a of plan.auto) {
    await recordMatch(trx, bank, {
      lineId: a.lineId,
      entryId: a.candidate.entryId,
      sourceKind: a.candidate.kind,
      sourceId: a.candidate.id,
      method: 'auto_exact',
      ruleId: null,
      by: opts.runBy ?? null,
    });
  }
  let suggested = 0;
  for (const s of plan.suggestions) {
    const r =
      s.kind === 'rule'
        ? await sql`
          INSERT INTO app.bank_match_suggestion (company_id, bank_account_id, statement_line_id, kind, rule_id, account_id)
          SELECT ${bank.company_id}, ${bank.id}, ${s.lineId}, 'rule', ${s.ruleId}, ${s.accountId}
           WHERE NOT EXISTS (SELECT 1 FROM app.bank_match_suggestion x
                              WHERE x.statement_line_id = ${s.lineId} AND x.kind = 'rule'
                                AND x.rule_id = ${s.ruleId} AND x.status = 'open')
          RETURNING id`.execute(trx)
        : await sql`
          INSERT INTO app.bank_match_suggestion (company_id, bank_account_id, statement_line_id, kind,
                                                 source_kind, source_id, journal_entry_id)
          SELECT ${bank.company_id}, ${bank.id}, ${s.lineId}, 'candidate', ${s.candidate.kind},
                 ${s.candidate.id}, ${s.candidate.entryId}
           WHERE NOT EXISTS (SELECT 1 FROM app.bank_match_suggestion x
                              WHERE x.statement_line_id = ${s.lineId} AND x.kind = 'candidate'
                                AND x.journal_entry_id = ${s.candidate.entryId} AND x.status = 'open')
          RETURNING id`.execute(trx);
    suggested += r.rows.length;
  }
  return { linesConsidered: lines.length, autoMatched: plan.auto.length, suggested };
}

interface MatchFacts {
  lineId: string;
  entryId: string;
  sourceKind: 'customer_receipt' | 'supplier_payment' | 'bank_transaction';
  sourceId: string;
  method: 'auto_exact' | 'rule' | 'suggestion' | 'created';
  ruleId: string | null;
  by: string | null;
}

/** Insert the match, mark the line matched and close the line's other open suggestions. */
async function recordMatch(
  trx: Trx,
  bank: BankAccountRow,
  m: MatchFacts,
  accepted: string | null = null,
): Promise<string> {
  const r = await sql<{ id: string }>`
    INSERT INTO app.bank_match (company_id, bank_account_id, statement_line_id, journal_entry_id,
                                source_kind, source_id, method, rule_id, matched_by)
    VALUES (${bank.company_id}, ${bank.id}, ${m.lineId}, ${m.entryId}, ${m.sourceKind}, ${m.sourceId},
            ${m.method}, ${m.ruleId}, ${m.by})
    RETURNING id::text`.execute(trx);
  await sql`UPDATE app.bank_statement_line SET status = 'matched' WHERE id = ${m.lineId}`.execute(
    trx,
  );
  await sql`
    UPDATE app.bank_match_suggestion
       SET status = CASE WHEN id = ${accepted} THEN 'accepted' ELSE 'dismissed' END,
           decided_by = ${m.by}, decided_at = clock_timestamp()
     WHERE statement_line_id = ${m.lineId} AND status = 'open'`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new Error('bank match insert returned nothing');
  return row.id;
}

export interface LineMatchView {
  id: string;
  journalEntryId: string;
  sourceKind: string;
  sourceId: string;
  method: string;
  ruleId: string | null;
  status: string;
  matchedBy: string | null;
}

export interface SuggestionView {
  id: string;
  kind: 'candidate' | 'rule';
  sourceKind: string | null;
  sourceId: string | null;
  journalEntryId: string | null;
  ruleId: string | null;
  accountId: string | null;
  status: 'open' | 'accepted' | 'dismissed';
}

/** A line's active match (or null) and all its suggestions, oldest first. */
export async function listLineMatching(
  trx: Trx,
  statementLineId: string,
): Promise<{ match: LineMatchView | null; suggestions: SuggestionView[] }> {
  const m = await sql<LineMatchView>`
    SELECT id::text, journal_entry_id::text AS "journalEntryId", source_kind AS "sourceKind",
           source_id::text AS "sourceId", method, rule_id::text AS "ruleId", status,
           matched_by::text AS "matchedBy"
      FROM app.bank_match WHERE statement_line_id = ${statementLineId} AND status = 'matched'`.execute(
    trx,
  );
  const s = await sql<SuggestionView>`
    SELECT id::text, kind, source_kind AS "sourceKind", source_id::text AS "sourceId",
           journal_entry_id::text AS "journalEntryId", rule_id::text AS "ruleId",
           account_id::text AS "accountId", status
      FROM app.bank_match_suggestion WHERE statement_line_id = ${statementLineId}
     ORDER BY created_at, id`.execute(trx);
  return { match: m.rows[0] ?? null, suggestions: s.rows };
}

/** A counter line of a transaction created from a statement line (base currency). */
export interface CounterLine {
  account: AccountRef;
  /** Positive decimal string; the side is the opposite of the bank line's. */
  amount: string;
  taxCodeId?: string;
  taxAmount?: string;
  dimensions?: readonly string[];
  partyId?: string;
  memo?: string;
}

export interface CreateTransactionInput {
  statementLineId: string;
  /** The counter lines; omit when accepting a rule suggestion (one line to its account). */
  lines?: readonly CounterLine[];
  /** An open rule suggestion of this line being accepted. */
  fromSuggestionId?: string;
  /** Default: the line's posting date. */
  entryDate?: string;
  memo?: string;
  createdBy: string;
  settings: SodSettings;
  outbox?: PostingOutbox;
}

export interface CreateTransactionResult {
  matchId: string;
  manualJournalId: string;
  entryId: string;
  entryNo: string;
  /** True when this line's transaction already existed: nothing new was posted. */
  replayed: boolean;
}

interface LineRow {
  id: string;
  bank_account_id: string;
  amount: string;
  description: string;
  reference: string | null;
  posted_on: string;
  status: string;
  currency: string;
  base_currency: string;
}

/**
 * Create a transaction from an unmatched statement line: a manual journal posted through the
 * posting engine, then matched to the line (SS-UC08-05).
 */
export async function createTransactionFromLine(
  trx: Trx,
  input: CreateTransactionInput,
): Promise<CreateTransactionResult> {
  if (!UUID_RE.test(input.statementLineId)) {
    throw new BankMatchError('NOT_FOUND', `statement line ${input.statementLineId} not found`);
  }
  const lr = await sql<LineRow>`
    SELECT l.id::text, l.bank_account_id::text, l.amount::text, l.description, l.reference,
           to_char(l.posted_on, 'YYYY-MM-DD') AS posted_on, l.status, s.currency,
           c.base_currency
      FROM app.bank_statement_line l
      JOIN app.bank_statement s ON s.tenant_id = l.tenant_id AND s.id = l.statement_id
      JOIN app.company c ON c.tenant_id = l.tenant_id AND c.id = l.company_id
     WHERE l.id = ${input.statementLineId}
       FOR UPDATE OF l`.execute(trx);
  const line = lr.rows[0];
  if (!line) {
    throw new BankMatchError('NOT_FOUND', `statement line ${input.statementLineId} not found`);
  }
  const bank = await bankAccount(trx, line.bank_account_id);
  const key = `bank_line:${line.id}`;

  if (line.status !== 'unmatched') {
    const existing = await sql<{
      match_id: string;
      mj: string;
      entry_id: string;
      entry_no: string;
    }>`
      SELECT m.id::text AS match_id, m.source_id::text AS mj, m.journal_entry_id::text AS entry_id,
             e.entry_no
        FROM app.bank_match m JOIN app.journal_entry e ON e.tenant_id = m.tenant_id AND e.id = m.journal_entry_id
       WHERE m.statement_line_id = ${line.id} AND m.status = 'matched' AND m.source_kind = 'bank_transaction'
         AND EXISTS (SELECT 1 FROM app.manual_journal j WHERE j.id = m.source_id AND j.idempotency_key = ${key})`.execute(
      trx,
    );
    const x = existing.rows[0];
    if (x) {
      return {
        matchId: x.match_id,
        manualJournalId: x.mj,
        entryId: x.entry_id,
        entryNo: x.entry_no,
        replayed: true,
      };
    }
    throw new BankMatchError(
      'ALREADY_MATCHED',
      `statement line ${line.id} is ${line.status}; unmatch it before creating a transaction`,
    );
  }
  if (line.currency !== line.base_currency) {
    throw new BankMatchError(
      'INVALID_TRANSACTION',
      `the line is in ${line.currency}; creating a transaction needs the base currency ${line.base_currency}`,
    );
  }

  let counter: readonly CounterLine[];
  let ruleId: string | null = null;
  const amount = Money.of(line.amount, line.currency);
  if (input.fromSuggestionId !== undefined) {
    const sr = await sql<{
      id: string;
      kind: string;
      status: string;
      rule_id: string | null;
      account_id: string | null;
    }>`
      SELECT id::text, kind, status, rule_id::text, account_id::text FROM app.bank_match_suggestion
       WHERE id = ${UUID_RE.test(input.fromSuggestionId) ? input.fromSuggestionId : null}
         AND statement_line_id = ${line.id}`.execute(trx);
    const s = sr.rows[0];
    if (!s || s.kind !== 'rule' || s.account_id === null) {
      throw new BankMatchError(
        'NOT_FOUND',
        `rule suggestion ${input.fromSuggestionId} not found for this line`,
      );
    }
    if (s.status !== 'open') {
      throw new BankMatchError('SUGGESTION_CLOSED', `suggestion ${s.id} is ${s.status}`);
    }
    ruleId = s.rule_id;
    counter = input.lines ?? [
      { account: { id: s.account_id }, amount: amount.abs().toNumericString() },
    ];
  } else {
    counter = input.lines ?? [];
  }
  if (counter.length === 0) {
    throw new BankMatchError(
      'INVALID_TRANSACTION',
      'a transaction needs at least one counter line',
    );
  }

  // Bank side: money in debits the bank, money out credits it; counter lines take the other side.
  const bankIn = amount.isPositive();
  const side = (v: string, debit: boolean) => (debit ? { debit: v } : { credit: v });
  const lines: PostingLineInput[] = [
    {
      account: { id: bank.gl_account_id },
      ...side(amount.abs().toNumericString(), bankIn),
      memo: line.description.slice(0, 200),
    },
    ...counter.map((c): PostingLineInput => ({
      account: c.account,
      ...side(c.amount, !bankIn),
      ...(c.taxCodeId === undefined ? {} : { taxCodeId: c.taxCodeId }),
      ...(c.taxAmount === undefined ? {} : { taxAmount: c.taxAmount }),
      ...(c.dimensions === undefined ? {} : { dimensions: c.dimensions }),
      ...(c.partyId === undefined ? {} : { partyId: c.partyId }),
      ...(c.memo === undefined ? {} : { memo: c.memo }),
    })),
  ];
  const memo =
    input.memo ??
    `Bank ${line.posted_on}: ${line.description}${line.reference ? ` (${line.reference})` : ''}`;

  const { id: manualJournalId } = await createManualJournal(trx, {
    input: {
      companyId: bank.company_id,
      entryDate: input.entryDate ?? line.posted_on,
      memo: memo.slice(0, 500),
      lines,
    },
    createdBy: input.createdBy,
    idempotencyKey: key,
  });
  const doc = await getManualJournal(trx, manualJournalId);
  if (doc.status === 'draft') {
    await submitManualJournal(trx, {
      id: manualJournalId,
      submittedBy: input.createdBy,
      settings: input.settings,
    });
  }
  const posted = await postManualJournal(trx, {
    id: manualJournalId,
    postedBy: input.createdBy,
    settings: input.settings,
    ...(input.outbox === undefined ? {} : { outbox: input.outbox }),
  });
  const matchId = await recordMatch(
    trx,
    bank,
    {
      lineId: line.id,
      entryId: posted.entryId,
      sourceKind: 'bank_transaction',
      sourceId: manualJournalId,
      method: ruleId === null ? 'created' : 'rule',
      ruleId,
      by: input.createdBy,
    },
    input.fromSuggestionId ?? null,
  );
  return {
    matchId,
    manualJournalId,
    entryId: posted.entryId,
    entryNo: posted.entryNo,
    replayed: false,
  };
}
