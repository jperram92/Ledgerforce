/**
 * Tax codes in the database (T-0118, design §3.6, DL-0261): seed a company's codes from a
 * catalogue (AU_TAX_CODES by default) and look a code up by date. Codes are data (design
 * principle 3); a rate change is a new effective-dated row, never an edit of the rate, and the
 * database refuses overlapping ranges of one code (migration 0032).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { AU_TAX_CODES, type TaxCodeDefinition } from './au-tax-codes.ts';

/**
 * Insert every catalogue code the company does not have yet (same code and effective_from).
 * Returns the number of rows inserted; a second run inserts nothing.
 */
export async function seedTaxCodes(
  trx: Transaction<Database>,
  companyId: string,
  catalogue: readonly TaxCodeDefinition[] = AU_TAX_CODES,
): Promise<number> {
  // Skip what the company already has. ON CONFLICT cannot do this: the overlap trigger runs
  // before the conflict check and would refuse the duplicate range first.
  const have = new Set(
    (
      await sql<{ k: string }>`
        SELECT code || '@' || to_char(effective_from, 'YYYY-MM-DD') AS k
          FROM app.tax_code WHERE company_id = ${companyId}`.execute(trx)
    ).rows.map((r) => r.k),
  );
  const missing = catalogue.filter((t) => !have.has(`${t.code}@${t.effectiveFrom}`));
  if (missing.length === 0) return 0;
  await trx
    .insertInto('app.tax_code')
    .values(
      missing.map((t) => ({
        company_id: companyId,
        code: t.code,
        name: t.name,
        kind: t.kind,
        rate: t.rate,
        effective_from: t.effectiveFrom,
        effective_to: t.effectiveTo,
        sales_labels: [...t.sales],
        purchase_labels: [...t.purchases],
        verify: t.verify,
      })),
    )
    .execute();
  return missing.length;
}

/** The id of the company's active `code` in force on `date` (YYYY-MM-DD), or undefined. */
export async function taxCodeIdOn(
  trx: Transaction<Database>,
  companyId: string,
  code: string,
  date: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('app.tax_code')
    .select('id')
    .where('company_id', '=', companyId)
    .where('code', '=', code)
    .where('status', '=', 'active')
    .where('effective_from', '<=', sql<Date>`${date}::date`)
    .where((eb) =>
      eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', sql<Date>`${date}::date`)]),
    )
    .executeTakeFirst();
  return row?.id;
}
