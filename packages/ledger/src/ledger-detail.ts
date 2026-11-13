/**
 * General ledger detail read (T-0077, design §8.1, DL-0313): posted journal lines for a date
 * range, and each account's balance before it, under the same filters (accounts, dimension
 * values, party). Read only — SELECT on journal_entry, journal_line, dimension_set, account and
 * party; drafts are left out (status <> 'draft'), reversed entries and their reversals both stay.
 * Amounts are base currency NUMERIC text (debit and credit as posted); no floating point.
 */
import type { AccountType, Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export interface LedgerDetailQuery {
  companyId: string;
  /** YYYY-MM-DD inclusive; null = from the first posting (opening balances are then zero). */
  from: string | null;
  /** YYYY-MM-DD inclusive. */
  to: string;
  /** Only these accounts; empty or omitted = every account. */
  accountIds?: readonly string[];
  /** Lines whose dimension set holds every one of these values (as accountMovements). */
  dimensionValueIds?: readonly string[];
  /** Only lines carrying this party. */
  partyId?: string | null;
}

export interface LedgerDetailAccount {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  /** Σ debit / Σ credit of matching lines dated before `from`. */
  openingDebit: string;
  openingCredit: string;
}

export interface LedgerDetailLine {
  accountId: string;
  entryId: string;
  entryNo: string | null;
  lineNo: number;
  /** YYYY-MM-DD */
  entryDate: string;
  sourceType: string;
  /** The line's memo, else the entry's. */
  memo: string | null;
  partyId: string | null;
  partyName: string | null;
  debit: string;
  credit: string;
  txnCurrency: string;
  txnAmount: string;
}

export interface LedgerDetail {
  /** Every account with an opening balance or a line, in code order. */
  accounts: LedgerDetailAccount[];
  /** Lines in account code, date, entry number, line order. */
  lines: LedgerDetailLine[];
}

export async function ledgerDetail(trx: Trx, q: LedgerDetailQuery): Promise<LedgerDetail> {
  const company = q.companyId.toLowerCase();
  const from = q.from ?? null;
  const accounts = (q.accountIds ?? []).map((a) => a.toLowerCase());
  const values = (q.dimensionValueIds ?? []).map((v) => v.toLowerCase());
  const party = q.partyId ? q.partyId.toLowerCase() : null;
  const matching = sql`
    SELECT e.id AS entry_id, e.entry_no, e.entry_date, e.source_type, e.memo AS entry_memo,
           l.line_no, l.account_id, l.party_id, l.memo AS line_memo, l.debit, l.credit,
           l.txn_currency, l.txn_amount
      FROM app.journal_entry e
      JOIN app.journal_line l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
     WHERE e.company_id = ${company} AND e.status <> 'draft'
       AND e.entry_date <= ${q.to}::date
       AND (cardinality(${accounts}::uuid[]) = 0 OR l.account_id = ANY(${accounts}::uuid[]))
       AND (${party}::uuid IS NULL OR l.party_id = ${party}::uuid)
       AND l.dimension_set_id IN (
             SELECT id FROM app.dimension_set
              WHERE company_id = ${company} AND value_ids @> ${values}::uuid[])`;
  const opening = await sql<LedgerDetailAccount>`
    WITH m AS MATERIALIZED (${matching}),
    agg AS (
      SELECT account_id,
             coalesce(sum(debit) FILTER (WHERE entry_date < ${from}::date), 0) AS d,
             coalesce(sum(credit) FILTER (WHERE entry_date < ${from}::date), 0) AS c
        FROM m
       GROUP BY account_id)
    SELECT a.id::text AS "accountId", a.code, a.name, a.type, a.subtype,
           agg.d::numeric(19,4)::text AS "openingDebit", agg.c::numeric(19,4)::text AS "openingCredit"
      FROM agg
      JOIN app.account a ON a.company_id = ${company} AND a.id = agg.account_id
     WHERE agg.d <> agg.c
        OR EXISTS (SELECT 1 FROM m WHERE m.account_id = agg.account_id
                     AND m.entry_date >= coalesce(${from}::date, '-infinity'::date))
     ORDER BY a.code`.execute(trx);
  const lines = await sql<LedgerDetailLine>`
    WITH m AS (${matching})
    SELECT m.account_id::text AS "accountId", m.entry_id::text AS "entryId", m.entry_no AS "entryNo",
           m.line_no AS "lineNo", to_char(m.entry_date, 'YYYY-MM-DD') AS "entryDate",
           m.source_type AS "sourceType", coalesce(m.line_memo, m.entry_memo) AS memo,
           m.party_id::text AS "partyId", p.legal_name AS "partyName",
           m.debit::text AS debit, m.credit::text AS credit,
           m.txn_currency AS "txnCurrency", m.txn_amount::text AS "txnAmount"
      FROM m
      JOIN app.account a ON a.company_id = ${company} AND a.id = m.account_id
      LEFT JOIN app.party p ON p.company_id = ${company} AND p.id = m.party_id
     WHERE m.entry_date >= coalesce(${from}::date, '-infinity'::date)
     ORDER BY a.code, m.entry_date, m.entry_no NULLS LAST, m.entry_id, m.line_no`.execute(trx);
  return { accounts: opening.rows, lines: lines.rows };
}
