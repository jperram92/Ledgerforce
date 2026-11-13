/**
 * Bank reconciliation (T-0061, UC-08 step 5 + A2, DL-0326, migration 0057).
 *
 * - reconciliationReport: for one imported statement, as at its last date (period end, else its
 *   latest line), the statement closing balance against the book balance (net debit of the bank
 *   account's GL account over non-draft entries dated on or before that date) with the reconciling
 *   items listed:
 *     · unreconciled statement lines — dated on or before as-of and not matched to an entry dated
 *       on or before as-of (unmatched, excluded, or matched to a later book entry);
 *     · outstanding book items — entries on the GL account dated from the reconciliation start
 *       (the bank account's first imported line) to as-of, not matched to a line dated on or
 *       before as-of. Entries before the start are the opening position (DL-0326), not items.
 *   adjusted statement balance = closing − unreconciled lines + outstanding book items; it ties
 *   when it equals the book balance (difference 0).
 * - completeReconciliation: store the report figures once the statement ties (app.bank_reconciliation).
 * - unmatchLine: undo a line's active match. Refused when the line's period is hard-locked
 *   (SS-UC08-07, also enforced by the 0018 trigger) or a completed reconciliation covers the line
 *   (DL-0326, also enforced by the 0057 trigger). The posted entry stays posted (posted =
 *   immutable); it becomes an outstanding book item again.
 *
 * Read-only on ledger tables; no posting is produced. Money via Money (decimal.js) only.
 */
import type { Database } from '@ledgerforce/db';
import { findPeriod, PeriodLockedError, toPeriodError } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { sql, type Transaction } from 'kysely';
import { BankMatchError } from './matching.ts';

type Trx = Transaction<Database>;

export type BankReconciliationErrorCode =
  | 'NOT_FOUND'
  | 'STATEMENT_VOIDED'
  | 'EMPTY_STATEMENT'
  | 'CLOSING_BALANCE_REQUIRED'
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_CURRENCY'
  | 'NOT_BALANCED'
  | 'ALREADY_RECONCILED';

export class BankReconciliationError extends DomainError {
  declare readonly code: BankReconciliationErrorCode;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnreconciledLine {
  id: string;
  statementId: string;
  postedOn: string;
  description: string;
  reference: string | null;
  status: 'unmatched' | 'matched' | 'excluded';
  amount: Money;
}

export interface OutstandingBookItem {
  entryId: string;
  entryNo: string | null;
  entryDate: string;
  sourceType: string;
  memo: string | null;
  /** Net movement of the bank GL account: + debit (money in), − credit (money out). */
  amount: Money;
}

export interface ReconciliationReport {
  companyId: string;
  bankAccountId: string;
  statementId: string;
  glAccountId: string;
  currency: string;
  asOf: string;
  /** First imported line of the bank account; book entries before it are the opening position. */
  startDate: string;
  statementClosingBalance: Money;
  bookBalance: Money;
  unreconciledLines: UnreconciledLine[];
  unreconciledLinesTotal: Money;
  unreconciledBookItems: OutstandingBookItem[];
  unreconciledBookTotal: Money;
  adjustedStatementBalance: Money;
  /** adjusted statement balance − book balance; 0 when the statement ties. */
  difference: Money;
  balanced: boolean;
  unreconciledCount: number;
  /** The completed reconciliation of this statement, if any. */
  reconciliationId: string | null;
}

export interface ReportInput {
  statementId: string;
  /** Decimal string; default: the statement's own closing balance (CAMT/OFX carry one, CSV not). */
  closingBalance?: string;
}

interface StatementRow {
  id: string;
  company_id: string;
  bank_account_id: string;
  gl_account_id: string;
  currency: string;
  base_currency: string;
  status: string;
  closing_balance: string | null;
  as_of: string | null;
  start_date: string | null;
  reconciliation_id: string | null;
}

async function statement(trx: Trx, id: string, lock = false): Promise<StatementRow> {
  if (!UUID_RE.test(id))
    throw new BankReconciliationError('NOT_FOUND', `statement ${id} not found`);
  const r = await sql<StatementRow>`
    SELECT s.id::text, s.company_id::text, s.bank_account_id::text, b.gl_account_id::text,
           s.currency, c.base_currency, s.status, s.closing_balance::text,
           to_char(coalesce(s.period_end,
             (SELECT max(l.posted_on) FROM app.bank_statement_line l
               WHERE l.tenant_id = s.tenant_id AND l.statement_id = s.id)), 'YYYY-MM-DD') AS as_of,
           (SELECT to_char(min(l.posted_on), 'YYYY-MM-DD') FROM app.bank_statement_line l
              JOIN app.bank_statement x ON x.tenant_id = l.tenant_id AND x.id = l.statement_id
             WHERE l.tenant_id = s.tenant_id AND l.bank_account_id = s.bank_account_id
               AND x.status = 'imported') AS start_date,
           (SELECT r.id::text FROM app.bank_reconciliation r
             WHERE r.tenant_id = s.tenant_id AND r.statement_id = s.id AND r.status = 'completed') AS reconciliation_id
      FROM app.bank_statement s
      JOIN app.bank_account b ON b.tenant_id = s.tenant_id AND b.id = s.bank_account_id
      JOIN app.company c ON c.tenant_id = s.tenant_id AND c.id = s.company_id
     WHERE s.id = ${id}
     ${lock ? sql`FOR UPDATE OF s` : sql``}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new BankReconciliationError('NOT_FOUND', `statement ${id} not found`);
  if (row.status !== 'imported') {
    throw new BankReconciliationError('STATEMENT_VOIDED', `statement ${id} is ${row.status}`);
  }
  if (row.currency !== row.base_currency) {
    throw new BankReconciliationError(
      'UNSUPPORTED_CURRENCY',
      `the bank account is in ${row.currency}; reconciliation needs the base currency ${row.base_currency}`,
    );
  }
  return row;
}

function closingOf(row: StatementRow, input: ReportInput): Money {
  const given = input.closingBalance ?? row.closing_balance;
  if (given === null) {
    throw new BankReconciliationError(
      'CLOSING_BALANCE_REQUIRED',
      'this statement carries no closing balance; give the closing balance shown by the bank',
    );
  }
  try {
    return Money.of(given, row.currency);
  } catch (e) {
    throw new BankReconciliationError(
      'INVALID_AMOUNT',
      `closing balance "${given}" is not an amount`,
      {
        cause: e,
      },
    );
  }
}

/** The reconciliation report of one statement (UC-08 step 5, A2). */
export async function reconciliationReport(
  trx: Trx,
  input: ReportInput,
): Promise<ReconciliationReport> {
  return build(trx, await statement(trx, input.statementId), input);
}

async function build(
  trx: Trx,
  st: StatementRow,
  input: ReportInput,
): Promise<ReconciliationReport> {
  const closing = closingOf(st, input);
  if (st.as_of === null || st.start_date === null) {
    throw new BankReconciliationError(
      'EMPTY_STATEMENT',
      `statement ${st.id} has no lines and no period end`,
    );
  }
  const asOf = st.as_of;
  const cur = st.currency;
  const zero = Money.zero(cur);

  const book = await sql<{ balance: string }>`
    SELECT coalesce(sum(l.debit - l.credit), 0)::text AS balance
      FROM app.journal_line l
      JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
     WHERE e.company_id = ${st.company_id} AND l.account_id = ${st.gl_account_id}
       AND e.status <> 'draft' AND e.entry_date <= ${asOf}::date`.execute(trx);
  const bookBalance = Money.of(book.rows[0]?.balance ?? '0', cur);

  const lr = await sql<{
    id: string;
    statement_id: string;
    posted_on: string;
    description: string;
    reference: string | null;
    status: UnreconciledLine['status'];
    amount: string;
  }>`
    SELECT l.id::text, l.statement_id::text, to_char(l.posted_on, 'YYYY-MM-DD') AS posted_on,
           l.description, l.reference, l.status, l.amount::text
      FROM app.bank_statement_line l
      JOIN app.bank_statement s ON s.tenant_id = l.tenant_id AND s.id = l.statement_id
     WHERE l.bank_account_id = ${st.bank_account_id} AND s.status = 'imported'
       AND l.posted_on <= ${asOf}::date
       AND NOT EXISTS (SELECT 1 FROM app.bank_match m
                         JOIN app.journal_entry e ON e.tenant_id = m.tenant_id AND e.id = m.journal_entry_id
                        WHERE m.tenant_id = l.tenant_id AND m.statement_line_id = l.id
                          AND m.status = 'matched' AND e.entry_date <= ${asOf}::date)
     ORDER BY l.posted_on, s.imported_at, l.line_no`.execute(trx);
  const unreconciledLines = lr.rows.map((x): UnreconciledLine => ({
    id: x.id,
    statementId: x.statement_id,
    postedOn: x.posted_on,
    description: x.description,
    reference: x.reference,
    status: x.status,
    amount: Money.of(x.amount, cur),
  }));

  const br = await sql<{
    entry_id: string;
    entry_no: string | null;
    entry_date: string;
    source_type: string;
    memo: string | null;
    amount: string;
  }>`
    SELECT e.id::text AS entry_id, e.entry_no, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
           e.source_type, e.memo, sum(l.debit - l.credit)::text AS amount
      FROM app.journal_entry e
      JOIN app.journal_line l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
     WHERE e.company_id = ${st.company_id} AND l.account_id = ${st.gl_account_id}
       AND e.status <> 'draft'
       AND e.entry_date BETWEEN ${st.start_date}::date AND ${asOf}::date
       AND NOT EXISTS (SELECT 1 FROM app.bank_match m
                         JOIN app.bank_statement_line sl ON sl.tenant_id = m.tenant_id AND sl.id = m.statement_line_id
                        WHERE m.tenant_id = e.tenant_id AND m.journal_entry_id = e.id
                          AND m.status = 'matched' AND sl.posted_on <= ${asOf}::date)
     GROUP BY e.id, e.entry_no, e.entry_date, e.source_type, e.memo
    HAVING sum(l.debit - l.credit) <> 0
     ORDER BY e.entry_date, e.entry_no, e.id`.execute(trx);
  const unreconciledBookItems = br.rows.map((x): OutstandingBookItem => ({
    entryId: x.entry_id,
    entryNo: x.entry_no,
    entryDate: x.entry_date,
    sourceType: x.source_type,
    memo: x.memo,
    amount: Money.of(x.amount, cur),
  }));

  const unreconciledLinesTotal = unreconciledLines.reduce((s, l) => s.add(l.amount), zero);
  const unreconciledBookTotal = unreconciledBookItems.reduce((s, b) => s.add(b.amount), zero);
  const adjustedStatementBalance = closing.sub(unreconciledLinesTotal).add(unreconciledBookTotal);
  const difference = adjustedStatementBalance.sub(bookBalance);
  return {
    companyId: st.company_id,
    bankAccountId: st.bank_account_id,
    statementId: st.id,
    glAccountId: st.gl_account_id,
    currency: cur,
    asOf,
    startDate: st.start_date,
    statementClosingBalance: closing,
    bookBalance,
    unreconciledLines,
    unreconciledLinesTotal,
    unreconciledBookItems,
    unreconciledBookTotal,
    adjustedStatementBalance,
    difference,
    balanced: difference.isZero(),
    unreconciledCount: unreconciledLines.length + unreconciledBookItems.length,
    reconciliationId: st.reconciliation_id,
  };
}

export interface CompleteReconciliationInput extends ReportInput {
  completedBy: string;
}

/**
 * Complete the reconciliation of a statement that ties. Its lines (and every earlier line of the
 * bank account) can then no longer be unmatched (DL-0326).
 */
export async function completeReconciliation(
  trx: Trx,
  input: CompleteReconciliationInput,
): Promise<{ reconciliationId: string; report: ReconciliationReport }> {
  const st = await statement(trx, input.statementId, true);
  if (st.reconciliation_id !== null) {
    throw new BankReconciliationError(
      'ALREADY_RECONCILED',
      `statement ${st.id} is already reconciled (${st.reconciliation_id})`,
    );
  }
  const report = await build(trx, st, input);
  if (!report.balanced) {
    throw new BankReconciliationError(
      'NOT_BALANCED',
      `the statement does not tie: adjusted statement balance ${report.adjustedStatementBalance.toNumericString()} ` +
        `vs book balance ${report.bookBalance.toNumericString()} (difference ${report.difference.toNumericString()})`,
    );
  }
  const r = await sql<{ id: string }>`
    INSERT INTO app.bank_reconciliation (company_id, bank_account_id, statement_id, as_of,
      statement_balance, book_balance, unreconciled_lines_total, unreconciled_book_total,
      unreconciled_count, completed_by)
    VALUES (${st.company_id}, ${st.bank_account_id}, ${st.id}, ${report.asOf},
      ${report.statementClosingBalance.toNumericString()}, ${report.bookBalance.toNumericString()},
      ${report.unreconciledLinesTotal.toNumericString()}, ${report.unreconciledBookTotal.toNumericString()},
      ${report.unreconciledCount}, ${input.completedBy})
    RETURNING id::text`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('bank reconciliation insert returned nothing');
  return { reconciliationId: id, report: { ...report, reconciliationId: id } };
}

/**
 * Undo a statement line's active match: the match is kept as history (status unmatched) and the
 * line is unmatched again. Refused in a hard-locked period and under a completed reconciliation.
 */
export async function unmatchLine(
  trx: Trx,
  input: { statementLineId: string; by: string },
): Promise<{ matchId: string }> {
  const lineId = input.statementLineId;
  if (!UUID_RE.test(lineId))
    throw new BankMatchError('NOT_FOUND', `statement line ${lineId} not found`);
  const lr = await sql<{
    company_id: string;
    bank_account_id: string;
    posted_on: string;
    match_id: string | null;
    reconciled_to: string | null;
  }>`
    SELECT l.company_id::text, l.bank_account_id::text, to_char(l.posted_on, 'YYYY-MM-DD') AS posted_on,
           (SELECT m.id::text FROM app.bank_match m
             WHERE m.tenant_id = l.tenant_id AND m.statement_line_id = l.id AND m.status = 'matched') AS match_id,
           (SELECT to_char(max(r.as_of), 'YYYY-MM-DD') FROM app.bank_reconciliation r
             WHERE r.tenant_id = l.tenant_id AND r.bank_account_id = l.bank_account_id
               AND r.status = 'completed' AND r.as_of >= l.posted_on) AS reconciled_to
      FROM app.bank_statement_line l WHERE l.id = ${lineId}
       FOR UPDATE OF l`.execute(trx);
  const line = lr.rows[0];
  if (!line) throw new BankMatchError('NOT_FOUND', `statement line ${lineId} not found`);
  if (line.match_id === null) {
    throw new BankMatchError('NOT_MATCHED', `statement line ${lineId} is not matched`);
  }
  const period = await findPeriod(trx, line.company_id, line.posted_on);
  if (period?.status === 'hard_locked') {
    throw new PeriodLockedError(
      'PERIOD_LOCKED',
      `statement line ${lineId} dated ${line.posted_on} is in hard-locked period ${period.name}; its reconciliation cannot change`,
      { entryDate: line.posted_on, periodStatus: period.status },
    );
  }
  if (line.reconciled_to !== null) {
    throw new BankMatchError(
      'RECONCILED',
      `statement line ${lineId} dated ${line.posted_on} is covered by the reconciliation completed to ${line.reconciled_to}`,
    );
  }
  try {
    await sql`
      UPDATE app.bank_match SET status = 'unmatched', unmatched_by = ${input.by},
             unmatched_at = clock_timestamp()
       WHERE id = ${line.match_id}`.execute(trx);
    await sql`UPDATE app.bank_statement_line SET status = 'unmatched' WHERE id = ${lineId}`.execute(
      trx,
    );
  } catch (e) {
    const period = toPeriodError(e);
    if (period) throw period;
    if ((e as { constraint?: string } | null)?.constraint === 'bank_match_reconciled') {
      throw new BankMatchError('RECONCILED', (e as Error).message, { cause: e });
    }
    throw e;
  }
  return { matchId: line.match_id };
}

export interface UnreconciledBankAccountRow {
  readonly bankAccountId: string;
  readonly name: string;
  readonly unreconciledLines: number;
}

/**
 * The company's bank accounts with statement lines dated on or before `asOf` that no completed
 * reconciliation covers (UC-10 "bank recs complete", SS-UC10-07, DL-0404): a line is reconciled
 * when a completed reconciliation of its account has as_of on or after the line date (the same
 * rule as the line lock, DL-0326). Read-only.
 */
export async function unreconciledBankAccounts(
  trx: Trx,
  companyId: string,
  asOf: string,
): Promise<UnreconciledBankAccountRow[]> {
  const rows = (
    await sql<{ id: string; name: string; n: number }>`
      SELECT a.id::text, a.name, count(*)::int AS n
        FROM app.bank_statement_line l
        JOIN app.bank_account a ON a.tenant_id = l.tenant_id AND a.id = l.bank_account_id
       WHERE a.company_id = ${companyId.toLowerCase()} AND l.posted_on <= ${asOf}::date
         AND NOT EXISTS (
           SELECT 1 FROM app.bank_reconciliation r
            WHERE r.tenant_id = l.tenant_id AND r.bank_account_id = l.bank_account_id
              AND r.status = 'completed' AND r.as_of >= l.posted_on)
       GROUP BY a.id, a.name
       ORDER BY a.name`.execute(trx)
  ).rows;
  return rows.map((r) => ({ bankAccountId: r.id, name: r.name, unreconciledLines: r.n }));
}
