/**
 * BAS label mapping and the tax report query (T-0035, design §3.6, RQ-0102).
 *
 * Each tax code maps to BAS labels through the effective-dated data table app.bas_label_map
 * (migration 0036), loaded from the country template. The report is a query: it reads only the
 * ledger's posted journal lines and subledger allocations, through the read API of
 * packages/ledger (the only package that touches ledger tables), and writes nothing.
 */
import type { BasLabel, Database, GstBasis } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { BasAmount, BasBasisScope, BasFlow } from './tax-codes.ts';

export interface BasLabelMapRow {
  taxCode: string;
  flow: BasFlow;
  label: BasLabel;
  amount: BasAmount;
  positiveSide: 'debit' | 'credit';
  basis: BasBasisScope;
  validFrom: string;
  validTo: string | null;
}

/** The company's BAS label map rows in effect on `on` (YYYY-MM-DD). */
export async function basLabelMap(
  trx: Transaction<Database>,
  q: { companyId: string; on: string },
): Promise<BasLabelMapRow[]> {
  const rows = await trx
    .selectFrom('app.bas_label_map')
    .select([
      'tax_code',
      'flow',
      'label',
      'amount',
      'positive_side',
      'basis',
      sql<string>`valid_from::text`.as('valid_from'),
      sql<string | null>`valid_to::text`.as('valid_to'),
    ])
    .where('company_id', '=', q.companyId)
    .where('valid_from', '<=', q.on)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', q.on)]))
    .orderBy('tax_code')
    .orderBy('label')
    .execute();
  return rows.map((r) => ({
    taxCode: r.tax_code,
    flow: r.flow,
    label: r.label,
    amount: r.amount,
    positiveSide: r.positive_side,
    basis: r.basis,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}

/** The company's GST accounting basis (design §3.6): accruals (default) or cash. */
export async function getGstBasis(
  trx: Transaction<Database>,
  companyId: string,
): Promise<GstBasis> {
  const row = await trx
    .selectFrom('app.company')
    .select('gst_basis')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  return row.gst_basis;
}
