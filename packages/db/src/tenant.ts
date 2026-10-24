/**
 * Tenant context (design §6.7). Every tenant-scoped unit of work runs inside
 * `withTenant(db, tenantId, fn)`: one transaction whose first statement is
 * `set_config('app.tenant_id', <id>, true)` (the function form of SET LOCAL, which accepts a bind
 * parameter). RLS policies read it with current_setting('app.tenant_id', true); it vanishes at
 * COMMIT/ROLLBACK, so a pooled connection never leaks one tenant's context to the next request.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<DB, T>(
  db: Kysely<DB>,
  tenantId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new TypeError(`withTenant: tenantId must be a UUID, got ${JSON.stringify(tenantId)}`);
  }
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Kysely instance over a pg Pool. Callers own `destroy()`. */
export function createDb(connectionString: string, poolSize = 10): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: poolSize }) }),
  });
}
