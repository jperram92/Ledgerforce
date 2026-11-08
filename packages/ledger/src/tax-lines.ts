/**
 * Read API for the tax report (T-0035, design §3.6, RQ-0102).
 *
 * The BAS query in packages/modules/tax reads the ledger only through these two functions (the
 * ledger package is the only one that touches ledger tables). Both are plain SELECTs: nothing
 * is written. Amounts are NUMERIC text with 4 decimals, never JS numbers.
 *
 *  taxedLines          posted lines (entry status posted or reversed — a reversed entry stays in
 *                      the ledger and its reversal is a separate posted entry; drafts never)
 *                      that carry a tax code, with the account's type and the system roles bound
 *                      to it, by entry-date range or by entry id. classSourceType is the source
 *                      type that classifies the entry: for a reversal (reversal_of_id set) the
 *                      reversed entry's source type, otherwise its own.
 *  allocationReleases  every allocation row (a reversal is a negative row) dated in the range,
 *                      once per side: the base amount released from that side's open item
 *                      (allocation.from/to_base_amount; negative for a reversal), the entry of
 *                      the other side, and Σ |base original| of all open items of the side's
 *                      entry — what a cash-basis report needs to apportion a document.
 */
import type { AccountType, Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export interface TaxedLine {
  entryId: string;
  /** YYYY-MM-DD */
  entryDate: string;
  lineNo: number;
  /** The entry's stored source type. */
  sourceType: string;
  /** The reversed entry's source type for a reversal; otherwise sourceType. */
  classSourceType: string;
  accountId: string;
  accountType: AccountType;
  /** System roles bound to the account (sorted; usually none or one). */
  systemRoles: string[];
  /** NUMERIC(19,4) text; exactly one of debit/credit is > 0. */
  debit: string;
  credit: string;
  taxCodeId: string;
  /** Unsigned (the side gives the direction), or null when the line carries none. */
  taxAmount: string | null;
}

export type TaxedLineQuery =
  | { companyId: string; from: string; to: string }
  | { companyId: string; entryIds: readonly string[] };

export async function taxedLines(trx: Trx, q: TaxedLineQuery): Promise<TaxedLine[]> {
  const company = q.companyId.toLowerCase();
  let filter;
  if ('entryIds' in q) {
    if (q.entryIds.length === 0) return [];
    const ids = q.entryIds.map((id) => id.toLowerCase());
    filter = sql`e.id = ANY(${ids}::uuid[])`;
  } else {
    filter = sql`e.entry_date BETWEEN ${q.from}::date AND ${q.to}::date`;
  }
  const r = await sql<TaxedLine>`
    SELECT l.entry_id::text AS "entryId",
           to_char(e.entry_date, 'YYYY-MM-DD') AS "entryDate",
           l.line_no AS "lineNo",
           e.source_type AS "sourceType",
           coalesce(o.source_type, e.source_type) AS "classSourceType",
           l.account_id::text AS "accountId",
           a.type AS "accountType",
           ARRAY(SELECT r.role FROM app.account_system_role r
                  WHERE r.tenant_id = l.tenant_id AND r.company_id = l.company_id
                    AND r.account_id = l.account_id ORDER BY r.role) AS "systemRoles",
           l.debit::text AS debit,
           l.credit::text AS credit,
           l.tax_code_id::text AS "taxCodeId",
           l.tax_amount::text AS "taxAmount"
      FROM app.journal_line l
      JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      JOIN app.account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      LEFT JOIN app.journal_entry o ON o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id
     WHERE l.company_id = ${company}::uuid
       AND e.status IN ('posted', 'reversed')
       AND l.tax_code_id IS NOT NULL
       AND ${filter}
     ORDER BY e.entry_date, e.id, l.line_no`.execute(trx);
  return r.rows;
}

export interface AllocationRelease {
  allocationId: string;
  /** YYYY-MM-DD */
  allocationDate: string;
  /** The journal entry of this side's open item. */
  entryId: string;
  classSourceType: string;
  /** The journal entry of the other side's open item. */
  counterEntryId: string;
  counterClassSourceType: string;
  /** Base released from this side's item; negative for an allocation reversal. */
  baseReleased: string;
  /** Σ |base original| of every open item of entryId. */
  entryBaseOriginal: string;
}

export async function allocationReleases(
  trx: Trx,
  q: { companyId: string; from: string; to: string },
): Promise<AllocationRelease[]> {
  const r = await sql<AllocationRelease>`
    WITH a AS (
      SELECT * FROM app.allocation
       WHERE company_id = ${q.companyId.toLowerCase()}::uuid
         AND allocation_date BETWEEN ${q.from}::date AND ${q.to}::date
    ), sides AS (
      SELECT tenant_id, id, allocation_date, from_entry_id AS item, to_entry_id AS counter,
             from_base_amount AS released FROM a
      UNION ALL
      SELECT tenant_id, id, allocation_date, to_entry_id, from_entry_id, to_base_amount FROM a
    )
    SELECT s.id::text AS "allocationId",
           to_char(s.allocation_date, 'YYYY-MM-DD') AS "allocationDate",
           si.entry_id::text AS "entryId",
           coalesce(eo.source_type, e.source_type) AS "classSourceType",
           ci.entry_id::text AS "counterEntryId",
           coalesce(co.source_type, ce.source_type) AS "counterClassSourceType",
           s.released::text AS "baseReleased",
           (SELECT sum(abs(x.base_original_amount)) FROM app.subledger_entry x
             WHERE x.tenant_id = si.tenant_id AND x.entry_id = si.entry_id)::text
             AS "entryBaseOriginal"
      FROM sides s
      JOIN app.subledger_entry si ON si.tenant_id = s.tenant_id AND si.id = s.item
      JOIN app.subledger_entry ci ON ci.tenant_id = s.tenant_id AND ci.id = s.counter
      JOIN app.journal_entry e ON e.tenant_id = si.tenant_id AND e.id = si.entry_id
      LEFT JOIN app.journal_entry eo ON eo.tenant_id = e.tenant_id AND eo.id = e.reversal_of_id
      JOIN app.journal_entry ce ON ce.tenant_id = ci.tenant_id AND ce.id = ci.entry_id
      LEFT JOIN app.journal_entry co ON co.tenant_id = ce.tenant_id AND co.id = ce.reversal_of_id
     ORDER BY s.allocation_date, s.id, si.entry_id`.execute(trx);
  return r.rows;
}
