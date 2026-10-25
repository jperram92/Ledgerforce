/**
 * The journal as stored, in the shape preview() returns it (T-0026, SS-PLAT-15). Test-only.
 *
 * `storedJournal(trx, entryId)` reads an entry and its lines back as lf_app; `expectedJournal(built)`
 * keeps the fields of a preview that the database stores. A preview matches what post() wrote
 * when the two are deep-equal. Dimension values compare as a sorted set (the database stores a
 * set's values in canonical order); rates compare without trailing zeros (the engine's canonical
 * form, RQ-0030 / posting-command.ts).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { BuiltEntry } from '../posting-engine.ts';

export interface JournalView {
  entryDate: string;
  periodId: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  lines: {
    lineNo: number;
    accountId: string;
    accountCode: string;
    debit: string;
    credit: string;
    txnCurrency: string;
    txnAmount: string;
    fxRate: string;
    taxCodeId: string | null;
    taxAmount: string | null;
    dimensionValueIds: string[];
    partyId: string | null;
    memo: string | null;
  }[];
}

export function expectedJournal(built: BuiltEntry): JournalView {
  return {
    entryDate: built.entryDate,
    periodId: built.periodId,
    sourceType: built.sourceType,
    sourceId: built.sourceId,
    memo: built.memo,
    idempotencyKey: built.idempotencyKey,
    createdBy: built.createdBy,
    lines: built.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.accountCode,
      debit: l.debit,
      credit: l.credit,
      txnCurrency: l.txnCurrency,
      txnAmount: l.txnAmount,
      fxRate: l.fxRate,
      taxCodeId: l.taxCodeId,
      taxAmount: l.taxAmount,
      dimensionValueIds: [...l.dimensionValueIds].sort(),
      partyId: l.partyId,
      memo: l.memo,
    })),
  };
}

export async function storedJournal(
  trx: Transaction<Database>,
  entryId: string,
): Promise<JournalView> {
  const head = await sql<Omit<JournalView, 'lines'>>`
    SELECT to_char(entry_date, 'YYYY-MM-DD') AS "entryDate", period_id::text AS "periodId",
           source_type AS "sourceType", source_id AS "sourceId", memo,
           idempotency_key AS "idempotencyKey", created_by::text AS "createdBy"
      FROM app.journal_entry WHERE id = ${entryId}`.execute(trx);
  const entry = head.rows[0];
  if (!entry) throw new Error(`storedJournal: no entry ${entryId}`);
  const lines = await sql<JournalView['lines'][number]>`
    SELECT l.line_no AS "lineNo", l.account_id::text AS "accountId", a.code AS "accountCode",
           l.debit::text AS debit, l.credit::text AS credit, l.txn_currency AS "txnCurrency",
           l.txn_amount::text AS "txnAmount", trim_scale(l.fx_rate)::text AS "fxRate",
           l.tax_code_id::text AS "taxCodeId", l.tax_amount::text AS "taxAmount",
           ARRAY(SELECT v::text FROM unnest(s.value_ids) v ORDER BY v::text COLLATE "C") AS "dimensionValueIds",
           l.party_id::text AS "partyId", l.memo
      FROM app.journal_line l
      JOIN app.account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      JOIN app.dimension_set s ON s.tenant_id = l.tenant_id AND s.id = l.dimension_set_id
     WHERE l.entry_id = ${entryId}
     ORDER BY l.line_no`.execute(trx);
  return { ...entry, lines: lines.rows };
}
