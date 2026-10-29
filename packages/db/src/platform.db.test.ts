/**
 * Baseline platform migrations (design §6.7, §6.8): roles, schemas, tenancy tables,
 * tenant context, append-only audit log.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/test-db.ts';

let tdb: TestDatabase;
const A = randomUUID();
const B = randomUUID();

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  await tdb.admin.query(
    `INSERT INTO app.tenant (id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [A, B],
  );
});
afterAll(async () => {
  await tdb.close();
});

async function asRole<T>(
  role: 'lf_app' | 'lf_migrator',
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: tdb.url(role) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('roles', () => {
  it('lf_app and lf_migrator are not superusers and cannot bypass RLS', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname IN ('lf_app', 'lf_migrator') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      {
        rolname: 'lf_app',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
      {
        rolname: 'lf_migrator',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
  });

  it('every table in app and audit is owned by lf_migrator, none by lf_app', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('app', 'audit')`,
    );
    expect(rows).toEqual([{ tableowner: 'lf_migrator' }]);
  });

  it('lf_app is not a member of lf_migrator (cannot inherit ownership)', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT pg_has_role('lf_app', 'lf_migrator', 'MEMBER') AS member`,
    );
    expect(rows[0].member).toBe(false);
  });

  it('lf_app cannot create objects in app, audit or public', async () => {
    for (const schema of ['app', 'audit', 'public']) {
      await asRole('lf_app', async (c) => {
        await expect(c.query(`CREATE TABLE ${schema}.evil (id int)`)).rejects.toMatchObject({
          code: '42501',
        });
      });
    }
  });

  it('migrations were recorded in schema_migrations', async () => {
    const { rows } = await tdb.admin.query(
      'SELECT version, applied_by FROM public.schema_migrations ORDER BY version',
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.applied_by))).toEqual(new Set(['lf_migrator']));
  });
});

describe('schemas and tables', () => {
  it('creates app.tenant, app.company, app.app_user and audit.audit_log', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT schemaname || '.' || tablename AS t FROM pg_tables
        WHERE schemaname IN ('app', 'audit') ORDER BY 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(
      expect.arrayContaining(['app.app_user', 'app.company', 'app.tenant', 'audit.audit_log']),
    );
  });

  it('app.uuid_generate_v7() produces RFC 9562 version-7 UUIDs in time order', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT app.uuid_generate_v7()::text AS u FROM generate_series(1, 50)`,
    );
    const ids = rows.map((r) => r.u as string);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const prefixes = ids.map((u) => u.slice(0, 13));
    expect([...prefixes].sort()).toEqual(prefixes); // ms timestamp prefix never goes backwards
    expect(new Set(ids).size).toBe(50);
  });

  it('company.base_currency must be an ISO-style code', async () => {
    await expect(
      tdb.admin.query(
        `INSERT INTO app.company (tenant_id, name, base_currency) VALUES ($1, 'X', 'aud')`,
        [A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('withTenant()', () => {
  it('sets app.tenant_id for the transaction only', async () => {
    const inside = await withTenant(tdb.app, A, async (trx) => {
      const r = await sql<{
        t: string;
      }>`SELECT current_setting('app.tenant_id', true) AS t`.execute(trx);
      return r.rows[0]?.t;
    });
    expect(inside).toBe(A);
    const after = await sql<{
      t: string | null;
    }>`SELECT nullif(current_setting('app.tenant_id', true), '') AS t`.execute(tdb.app);
    expect(after.rows[0]?.t ?? null).toBeNull();
  });

  it('scopes reads and defaults tenant_id on insert', async () => {
    await withTenant(tdb.app, A, async (trx) => {
      await trx
        .insertInto('app.company')
        .values({ name: 'A Pty Ltd', base_currency: 'AUD' })
        .execute();
    });
    await withTenant(tdb.app, B, async (trx) => {
      await trx.insertInto('app.company').values({ name: 'B Ltd', base_currency: 'NZD' }).execute();
    });
    const seenByA = await withTenant(tdb.app, A, (trx) =>
      trx.selectFrom('app.company').select(['name', 'tenant_id']).execute(),
    );
    expect(seenByA).toEqual([{ name: 'A Pty Ltd', tenant_id: A }]);
  });

  it('sees nothing without a tenant context', async () => {
    const rows = await tdb.app.selectFrom('app.company').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('rolls back on error', async () => {
    await expect(
      withTenant(tdb.app, A, async (trx) => {
        await trx
          .insertInto('app.company')
          .values({ name: 'Ghost', base_currency: 'AUD' })
          .execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM app.company WHERE name = 'Ghost'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects a tenant id that is not a UUID (no SQL reaches the server)', async () => {
    await expect(withTenant(tdb.app, "x' OR true --", async () => 1)).rejects.toThrow(/UUID/);
  });
});

describe('SS-PLAT-08: Audit log is append-only (design §6.8)', () => {
  const insertAudit = (c: pg.Client, tenant: string) =>
    c.query(
      `INSERT INTO audit.audit_log (tenant_id, actor_type, action, entity_type, entity_id, after)
       VALUES ($1, 'user', 'company.create', 'company', 'c-1', '{"name":"A"}')`,
      [tenant],
    );

  it('lf_app can INSERT for its own tenant', async () => {
    await asRole('lf_app', async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
      const r = await insertAudit(c, A);
      await c.query('COMMIT');
      expect(r.rowCount).toBe(1);
    });
  });

  it('lf_app cannot UPDATE, DELETE, TRUNCATE or SELECT audit rows (privilege)', async () => {
    for (const stmt of [
      `UPDATE audit.audit_log SET action = 'tampered'`,
      `DELETE FROM audit.audit_log`,
      `TRUNCATE audit.audit_log`,
      `SELECT * FROM audit.audit_log`,
    ]) {
      await asRole('lf_app', async (c) => {
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A]);
        await expect(c.query(stmt), stmt).rejects.toMatchObject({ code: '42501' });
      });
    }
  });

  it('even the owner (lf_migrator) is blocked from UPDATE/DELETE/TRUNCATE by trigger', async () => {
    for (const stmt of [
      `UPDATE audit.audit_log SET action = 'tampered'`,
      `DELETE FROM audit.audit_log`,
      `TRUNCATE audit.audit_log`,
    ]) {
      await asRole('lf_migrator', async (c) => {
        // statement-level trigger: fires even when RLS would filter every row away
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A]);
        await expect(c.query(stmt), stmt).rejects.toThrow(/append-only/);
      });
    }
    const { rows } = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'tampered'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('lf_app cannot disable the triggers or switch replication role', async () => {
    await asRole('lf_app', async (c) => {
      await expect(
        c.query('ALTER TABLE audit.audit_log DISABLE TRIGGER ALL'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(c.query(`SET session_replication_role = replica`)).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
});
