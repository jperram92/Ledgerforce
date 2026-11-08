/**
 * Whole-database fingerprint for "writes nothing" proofs (T-0026, SS-PLAT-15, RQ-0035). Test-only.
 *
 * Taken as the superuser (bypasses RLS, sees every tenant and the pgboss schema):
 *  - every ordinary and partitioned table in every non-system schema → row count and an
 *    order-independent hash of the rows' text form (so an UPDATE that keeps the count, such as
 *    a number-series counter or the hash-chain head moving, still changes the fingerprint);
 *  - every sequence → last_value (nextval is never rolled back, so a "write then roll back"
 *    would still show here).
 * Tables are read from the catalogue, so tables added by later migrations are covered without
 * editing the tests.
 */
import type { TestDatabase } from '@ledgerforce/db/testing';

export interface DatabaseFingerprint {
  /** "schema.table" → "rows:hash" */
  tables: Record<string, string>;
  /** "schema.sequence" → last_value (null = never used) */
  sequences: Record<string, string | null>;
}

const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;

export async function databaseFingerprint(
  admin: TestDatabase['admin'],
): Promise<DatabaseFingerprint> {
  const { rows: rels } = await admin.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1, 2`,
  );
  const tables: Record<string, string> = {};
  for (const r of rels) {
    const { rows } = await admin.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')) AS h
         FROM ${quote(r.schema)}.${quote(r.name)} t`,
    );
    tables[`${r.schema}.${r.name}`] = `${rows[0]?.n ?? '?'}:${rows[0]?.h ?? '?'}`;
  }
  const { rows: seqs } = await admin.query<{ name: string; last_value: string | null }>(
    `SELECT schemaname || '.' || sequencename AS name, last_value::text
       FROM pg_sequences ORDER BY 1`,
  );
  return {
    tables,
    sequences: Object.fromEntries(seqs.map((s) => [s.name, s.last_value])),
  };
}
