/**
 * SS-PLAT-04 — tenant context with pooled connections (T-0010, RQ-0013, design §6.7).
 * The generated per-table suite lives in rls.db.test.ts; these tests prove the context itself
 * can never outlive its transaction on a reused pool connection, and fails closed if it does.
 */
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant } from './tenant.ts';
import type { Database } from './schema.ts';
import { createTestDatabase, type TestDatabase } from './testing/test-db.ts';

let tdb: TestDatabase;
let db: Kysely<Database>;
let tenantA: string;
let tenantB: string;

async function currentTenant(k: Kysely<Database>): Promise<string | null> {
  const r = await sql<{
    t: string | null;
  }>`SELECT nullif(current_setting('app.tenant_id', true), '') AS t`.execute(k);
  return r.rows[0]?.t ?? null;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  // One connection, so every call below reuses the same server session.
  db = createDb(tdb.url('lf_app'), 1);
  tenantA = '01900000-0000-7000-8000-00000000000a';
  tenantB = '01900000-0000-7000-8000-00000000000b';
  for (const [id, name] of [
    [tenantA, 'Harbour & Co'],
    [tenantB, 'Other Pty Ltd'],
  ] as const) {
    await withTenant(db, id, async (trx) => {
      await trx.insertInto('app.tenant').values({ id, name }).execute();
      await trx.insertInto('app.company').values({ name, base_currency: 'AUD' }).execute();
    });
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-04: RLS isolates tenants on every tenant table — tenant context', () => {
  it('sets the context inside the transaction and clears it on COMMIT for the next user of the connection', async () => {
    const inside = await withTenant(db, tenantA, (trx) =>
      currentTenant(trx as unknown as Kysely<Database>),
    );
    expect(inside).toBe(tenantA);
    expect(await currentTenant(db)).toBeNull();
    const visible = await db.selectFrom('app.company').select('name').execute();
    expect(visible).toEqual([]);
  });

  it('clears the context on ROLLBACK and re-throws the error', async () => {
    await expect(
      withTenant(db, tenantA, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await currentTenant(db)).toBeNull();
  });

  it('a tenant sees only its own company on the same reused connection', async () => {
    const a = await withTenant(db, tenantA, (trx) =>
      trx.selectFrom('app.company').select('name').execute(),
    );
    const b = await withTenant(db, tenantB, (trx) =>
      trx.selectFrom('app.company').select('name').execute(),
    );
    expect(a).toEqual([{ name: 'Harbour & Co' }]);
    expect(b).toEqual([{ name: 'Other Pty Ltd' }]);
  });

  it('without a context nothing is visible and inserts are rejected', async () => {
    expect(await db.selectFrom('app.tenant').selectAll().execute()).toEqual([]);
    await expect(
      db.insertInto('app.company').values({ name: 'Sneaky', base_currency: 'AUD' }).execute(),
    ).rejects.toThrow();
  });

  it('fails closed when a session-level app.tenant_id has leaked onto the connection', async () => {
    await sql`SELECT set_config('app.tenant_id', ${tenantB}, false)`.execute(db);
    try {
      await expect(withTenant(db, tenantA, async () => 'ran')).rejects.toThrow(
        /session-level app\.tenant_id/,
      );
    } finally {
      await sql`RESET app.tenant_id`.execute(db);
    }
    expect(await currentTenant(db)).toBeNull();
  });

  it('rejects a tenant id that is not a UUID before touching the database', async () => {
    await expect(withTenant(db, "x' OR '1'='1", async () => 'ran')).rejects.toThrow(TypeError);
  });
});
