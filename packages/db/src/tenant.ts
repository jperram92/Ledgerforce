/**
 * Tenant context (design §6.7). Every tenant-scoped unit of work runs inside
 * `withTenant(db, tenantId, fn)`: one transaction whose first statement is
 * `set_config('app.tenant_id', <id>, true)` (the function form of SET LOCAL, which accepts a bind
 * parameter). RLS policies read it with current_setting('app.tenant_id', true); it vanishes at
 * COMMIT/ROLLBACK, so a pooled connection never leaks one tenant's context to the next request.
 *
 * Fail closed (RQ-0013): a *session-level* value (SET app.tenant_id / set_config(..., false))
 * survives the transaction and would become the context for the next user of the connection.
 * Before setting the local value, withTenant checks that none is present and refuses to run if
 * one is. lint rule lf/no-session-tenant-context stops such code being written at all.
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
    const leaked = await sql<{ t: string | null }>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS t`.execute(trx);
    if (leaked.rows[0]?.t) {
      throw new TenantContextLeakError();
    }
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** A session-level app.tenant_id was found on a pooled connection; tenant work was refused. */
export class TenantContextLeakError extends Error {
  constructor() {
    super(
      'withTenant: a session-level app.tenant_id is set on this connection (it would leak across ' +
        'pooled requests); refusing to run. Only set_config(..., true) inside withTenant is allowed.',
    );
    this.name = 'TenantContextLeakError';
  }
}

/** Kysely instance over a pg Pool. Callers own `destroy()`. */
export function createDb(connectionString: string, poolSize = 10): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: poolSize }) }),
  });
}
