/**
 * Dimension sets (design §3.3). dimension_set is a ledger table (packages/ledger/AGENTS.md), so
 * this is its only writer. The database computes each set's canonical form and hash
 * (migration 0006); this module only asks for "the set holding these values" and lets
 * ON CONFLICT deduplicate. Call inside the caller's tenant transaction (READ COMMITTED: after a
 * conflict with a concurrent insert, the follow-up SELECT must see the committed row).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

/** Id of the set holding exactly these dimension values (any order), creating it if new. */
export async function dimensionSetId(
  trx: Transaction<Database>,
  companyId: string,
  valueIds: readonly string[],
): Promise<string> {
  const inserted = await trx
    .insertInto('app.dimension_set')
    .values({ company_id: companyId, value_ids: [...valueIds] })
    .onConflict((oc) => oc.columns(['tenant_id', 'company_id', 'hash']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return inserted.id;
  // Already exists: find it by its canonical (sorted) values, which the trigger defined.
  const existing = await trx
    .selectFrom('app.dimension_set')
    .select('id')
    .where('company_id', '=', companyId)
    .where(sql<boolean>`value_ids @> ${sql.val([...valueIds])}::uuid[]`)
    .where(sql<boolean>`cardinality(value_ids) = ${valueIds.length}`)
    .executeTakeFirstOrThrow();
  return existing.id;
}

/** Codes of the account's required dimensions that the set lacks, in the account's order. */
export async function missingRequiredDimensions(
  trx: Transaction<Database>,
  accountId: string,
  setId: string,
): Promise<string[]> {
  const r = await sql<{ missing: string[] }>`
    SELECT app.dimension_set_missing_required(${accountId}, ${setId}) AS missing`.execute(trx);
  return r.rows[0]?.missing ?? [];
}
