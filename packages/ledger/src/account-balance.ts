/**
 * account_balance (design §3.3, T-0027, RQ-0032): posted totals per company, account, period,
 * dimension set and transaction currency. The database maintains it inside the posting
 * transaction (migration 0023: a statement trigger on journal_line, SECURITY DEFINER; lf_app has
 * SELECT only), so the engine's write step needs no balance code and no other path can write it.
 *
 * This module reads it: the trial balance per account, and a verifier that recomputes every row
 * from the posted lines (audits, invariant tests). Amounts are NUMERIC text with 4 decimals,
 * summed in PostgreSQL (exact); never JS numbers.
 */
import type { AccountType, Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  /** Σ base-currency debits of posted lines, all periods, dimension sets and currencies. */
  debit: string;
  credit: string;
}

/** Trial balance of a company read from account_balance: one row per account, by code. */
export async function trialBalance(trx: Trx, companyId: string): Promise<TrialBalanceRow[]> {
  const r = await sql<TrialBalanceRow>`
    SELECT a.id::text AS "accountId", a.code,
           sum(b.debit_total)::text AS debit, sum(b.credit_total)::text AS credit
      FROM app.account_balance b
      JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
     WHERE b.company_id = ${companyId.toLowerCase()}
     GROUP BY a.id, a.code
     ORDER BY a.code`.execute(trx);
  return r.rows;
}

export interface BalanceDrift {
  accountId: string;
  periodId: string;
  dimensionSetId: string;
  currency: string;
  balanceDebit: string;
  balanceCredit: string;
  balanceTxnDebit: string;
  balanceTxnCredit: string;
  linesDebit: string;
  linesCredit: string;
  linesTxnDebit: string;
  linesTxnCredit: string;
}

/**
 * Every key where account_balance differs from the sum of the company's posted (non-draft)
 * journal lines, including rows missing on either side. Empty = consistent.
 */
export async function accountBalanceDrift(trx: Trx, companyId: string): Promise<BalanceDrift[]> {
  const company = companyId.toLowerCase();
  const r = await sql<BalanceDrift>`
    WITH lines AS (
      SELECT l.account_id, e.period_id, l.dimension_set_id, l.txn_currency AS currency,
             sum(l.debit) AS d, sum(l.credit) AS c,
             sum(CASE WHEN l.debit > 0 THEN l.txn_amount ELSE 0 END) AS td,
             sum(CASE WHEN l.credit > 0 THEN l.txn_amount ELSE 0 END) AS tc
        FROM app.journal_line l
        JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       WHERE l.company_id = ${company} AND e.status <> 'draft'
       GROUP BY l.account_id, e.period_id, l.dimension_set_id, l.txn_currency),
    bal AS (
      SELECT account_id, period_id, dimension_set_id, currency, debit_total AS d,
             credit_total AS c, txn_debit_total AS td, txn_credit_total AS tc
        FROM app.account_balance WHERE company_id = ${company})
    SELECT account_id::text AS "accountId", period_id::text AS "periodId",
           dimension_set_id::text AS "dimensionSetId", currency::text AS currency,
           coalesce(b.d, 0::numeric(19,4))::text AS "balanceDebit",
           coalesce(b.c, 0::numeric(19,4))::text AS "balanceCredit",
           coalesce(b.td, 0::numeric(19,4))::text AS "balanceTxnDebit",
           coalesce(b.tc, 0::numeric(19,4))::text AS "balanceTxnCredit",
           coalesce(l.d, 0::numeric(19,4))::text AS "linesDebit",
           coalesce(l.c, 0::numeric(19,4))::text AS "linesCredit",
           coalesce(l.td, 0::numeric(19,4))::text AS "linesTxnDebit",
           coalesce(l.tc, 0::numeric(19,4))::text AS "linesTxnCredit"
      FROM bal b FULL JOIN lines l USING (account_id, period_id, dimension_set_id, currency)
     WHERE (coalesce(b.d, 0), coalesce(b.c, 0), coalesce(b.td, 0), coalesce(b.tc, 0))
           IS DISTINCT FROM (coalesce(l.d, 0), coalesce(l.c, 0), coalesce(l.td, 0), coalesce(l.tc, 0))
     ORDER BY 1, 2, 3, 4`.execute(trx);
  return r.rows;
}

export interface AccountMovementQuery {
  companyId: string;
  /** First day (YYYY-MM-DD), inclusive; null or omitted = from the company's first period. */
  from?: string | null;
  /** Last day (YYYY-MM-DD), inclusive. */
  to: string;
  /** Keep only dimension sets that contain every one of these values (AND). Empty = all. */
  dimensionValueIds?: readonly string[];
}

export interface AccountMovementRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  /** Σ base-currency debits of posted (non-draft) lines dated in the range; NUMERIC text. */
  debit: string;
  credit: string;
}

/**
 * Posted base-currency movements per account for a date range, for the reports (design §8.1,
 * RQ-0037). Periods wholly inside the range are read from account_balance; a period the range
 * cuts is read from its posted lines by entry_date. Every entry lies in the one period holding
 * its date, so each line counts once. Read-only; only accounts with posted lines appear.
 */
export async function accountMovements(
  trx: Trx,
  q: AccountMovementQuery,
): Promise<AccountMovementRow[]> {
  const company = q.companyId.toLowerCase();
  const from = q.from ?? null;
  const values = (q.dimensionValueIds ?? []).map((v) => v.toLowerCase());
  const r = await sql<AccountMovementRow>`
    WITH per AS MATERIALIZED (
      SELECT id,
             start_date >= coalesce(${from}::date, '-infinity'::date)
               AND end_date <= ${q.to}::date AS whole
        FROM app.fiscal_period
       WHERE company_id = ${company}
         AND end_date >= coalesce(${from}::date, '-infinity'::date)
         AND start_date <= ${q.to}::date),
    sets AS MATERIALIZED (
      SELECT id FROM app.dimension_set
       WHERE company_id = ${company} AND value_ids @> ${values}::uuid[]),
    mv AS MATERIALIZED (
      SELECT b.account_id, b.debit_total AS d, b.credit_total AS c
        FROM app.account_balance b
       WHERE b.company_id = ${company}
         AND b.period_id IN (SELECT id FROM per WHERE whole)
         AND b.dimension_set_id IN (SELECT id FROM sets)
      UNION ALL
      SELECT l.account_id, l.debit, l.credit
        FROM app.journal_entry e
        JOIN app.journal_line l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
       WHERE e.company_id = ${company} AND e.status <> 'draft'
         AND e.period_id IN (SELECT id FROM per WHERE NOT whole)
         AND e.entry_date BETWEEN coalesce(${from}::date, '-infinity'::date) AND ${q.to}::date
         AND l.dimension_set_id IN (SELECT id FROM sets)),
    agg AS MATERIALIZED (
      SELECT account_id, sum(d) AS d, sum(c) AS c FROM mv GROUP BY account_id)
    SELECT a.id::text AS "accountId", a.code, a.name, a.type, a.subtype,
           agg.d::numeric(19,4)::text AS debit, agg.c::numeric(19,4)::text AS credit
      FROM agg
      JOIN app.account a ON a.company_id = ${company} AND a.id = agg.account_id
     ORDER BY a.code`.execute(trx);
  return r.rows;
}
