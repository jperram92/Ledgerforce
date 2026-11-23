/**
 * SS-PLAT-04 — tenant isolation (design §6.7).
 *
 * 1. Completeness: every table that has a tenant_id column (and every table in the app/audit
 *    schemas) has row-level security ENABLED and FORCED with at least one policy, and lf_app holds
 *    no privilege that bypasses RLS (TRUNCATE, TRIGGER, ownership).
 * 2. The checker itself is proven to fail on a deliberately unprotected table.
 * 3. A generated cross-tenant suite runs for every tenant_id table discovered from
 *    information_schema: tenant A cannot SELECT, UPDATE, DELETE or INSERT-as-B tenant B's rows.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from './tenant.ts';
import { createTestDatabase } from './testing/test-db.ts';
import { defineCrossTenantSuite, findRlsViolations } from './testing/cross-tenant.ts';

describe('RLS completeness check', () => {
  it('reports no violations on the migrated schema', async () => {
    const tdb = await createTestDatabase({ migrate: true });
    try {
      expect(await findRlsViolations(tdb.admin)).toEqual([]);
    } finally {
      await tdb.close();
    }
  });

  it('FAILS for a tenant table without RLS, without FORCE, or without a policy', async () => {
    const tdb = await createTestDatabase({ migrate: true });
    try {
      const m = new pg.Client({ connectionString: tdb.url('lf_migrator') });
      await m.connect();
      await m.query(`
        CREATE TABLE app.no_rls (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        CREATE TABLE app.no_force (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE app.no_force ENABLE ROW LEVEL SECURITY;
        CREATE POLICY p ON app.no_force USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
        CREATE TABLE app.no_policy (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE app.no_policy ENABLE ROW LEVEL SECURITY;
        ALTER TABLE app.no_policy FORCE ROW LEVEL SECURITY;
        CREATE TABLE app.no_tenant_column (id uuid PRIMARY KEY);
        CREATE TABLE public.elsewhere (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        CREATE TABLE app.truncatable (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE app.truncatable ENABLE ROW LEVEL SECURITY;
        ALTER TABLE app.truncatable FORCE ROW LEVEL SECURITY;
        CREATE POLICY p ON app.truncatable USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
        GRANT TRUNCATE ON app.truncatable TO lf_app;
      `);
      await m.end();
      const v = await findRlsViolations(tdb.admin);
      const byTable = Object.fromEntries(v.map((x) => [x.table, x.problems]));
      expect(byTable['app.no_rls']).toEqual(
        expect.arrayContaining(['RLS not enabled', 'RLS not forced', 'no policy']),
      );
      expect(byTable['app.no_force']).toEqual(['RLS not forced']);
      expect(byTable['app.no_policy']).toEqual(['no policy']);
      expect(byTable['app.no_tenant_column']).toEqual(
        expect.arrayContaining(['no tenant_id column and not in GLOBAL_TABLES']),
      );
      expect(byTable['public.elsewhere']).toEqual(
        expect.arrayContaining(['RLS not enabled', 'RLS not forced', 'no policy']),
      );
      expect(byTable['app.truncatable']).toEqual(['lf_app has TRUNCATE (bypasses RLS)']);
    } finally {
      await tdb.close();
    }
  });

  it('FAILS for a view over tenant tables that is not security_invoker (ADR-0061) [T-0117]', async () => {
    const tdb = await createTestDatabase({ migrate: true });
    try {
      const m = new pg.Client({ connectionString: tdb.url('lf_migrator') });
      await m.connect();
      await m.query(`
        CREATE VIEW app.definer_view AS SELECT tenant_id, id FROM app.account;
        CREATE VIEW app.invoker_view WITH (security_invoker = true) AS SELECT tenant_id, id FROM app.account;
      `);
      await m.end();
      const byTable = Object.fromEntries(
        (await findRlsViolations(tdb.admin)).map((x) => [x.table, x.problems]),
      );
      expect(byTable['app.definer_view']).toEqual([
        "view is not security_invoker (would bypass the caller's RLS)",
      ]);
      expect(byTable['app.invoker_view']).toBeUndefined();
      // The shipped view passes (positive control within the same schema).
      expect(byTable['app.account_role_binding']).toBeUndefined();
    } finally {
      await tdb.close();
    }
  });
});

// T-0215 (ADR-0099): the inbound-address route lookup is a narrow cross-tenant primitive.
describe('SS-PLAT-170 app.bill_inbox_route(): SECURITY DEFINER lookup of an inbound-address token', () => {
  it('SS-PLAT-170 returns only (tenant, company) for an active token, nothing otherwise; tables stay tenant-isolated; tokens are single-use across tenants', async () => {
    const tdb = await createTestDatabase({ migrate: true });
    try {
      const db = tdb.app;
      const A = randomUUID();
      const B = randomUUID();
      const seed = (tenant: string, token: string, old: string) =>
        withTenant(db, tenant, async (trx) => {
          await trx
            .insertInto('app.tenant')
            .values({ id: tenant, name: `T ${tenant}` })
            .execute();
          const c = await trx
            .insertInto('app.company')
            .values({ name: 'Co', base_currency: 'AUD' })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('app.bill_inbox_address')
            .values([
              { id: randomUUID(), company_id: c.id, token: old, status: 'superseded' },
              { id: randomUUID(), company_id: c.id, token, status: 'active' },
            ])
            .execute();
          return c.id;
        });
      const tokA = 'a'.repeat(26);
      const tokB = 'b'.repeat(26);
      const oldA = 'c'.repeat(26);
      const companyA = await seed(A, tokA, oldA);
      const companyB = await seed(B, tokB, 'd'.repeat(26));

      // No tenant context at all: the function is the only path, and it answers one pair.
      const route = async (t: string) =>
        (await sql<Record<string, unknown>>`SELECT * FROM app.bill_inbox_route(${t})`.execute(db))
          .rows;
      expect(await route(tokA)).toEqual([{ tenant_id: A, company_id: companyA }]);
      expect(await route(tokB.toUpperCase())).toEqual([{ tenant_id: B, company_id: companyB }]);
      expect(await route(oldA)).toEqual([]);
      expect(await route('e'.repeat(26))).toEqual([]);
      expect(await route('')).toEqual([]);

      // Inactive tenant: no route.
      await tdb.admin.query(`UPDATE app.tenant SET status = 'suspended' WHERE id = $1`, [B]);
      expect(await route(tokB)).toEqual([]);

      // Direct reads stay inside the tenant.
      const seen = await withTenant(db, B, (trx) =>
        trx.selectFrom('app.bill_inbox_address').select('token').execute(),
      );
      expect(seen.map((r) => r.token).sort()).toEqual([tokB, 'd'.repeat(26)]);

      // A Mailgun token recorded for tenant A cannot be recorded again by tenant B (global unique).
      const receipt = (tenant: string, company: string) =>
        withTenant(db, tenant, (trx) =>
          trx
            .insertInto('app.inbound_webhook_receipt')
            .values({ company_id: company, provider: 'mailgun', provider_token: 'T'.repeat(50) })
            .execute(),
        );
      await receipt(A, companyA);
      await expect(receipt(B, companyB)).rejects.toThrow(/inbound_webhook_receipt_token_uq/);

      // The function is definer-owned by lf_migrator, pins search_path, and only lf_app may run it.
      const fn = await tdb.admin.query<{
        definer: boolean;
        owner: string;
        config: string[] | null;
        public_exec: boolean;
        app_exec: boolean;
      }>(
        `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('lf_app', p.oid, 'EXECUTE') AS app_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'bill_inbox_route'`,
      );
      expect(fn.rows).toEqual([
        {
          definer: true,
          owner: 'lf_migrator',
          config: ['search_path=pg_catalog, pg_temp'],
          public_exec: false,
          app_exec: true,
        },
      ]);
    } finally {
      await tdb.close();
    }
  });
});

// T-0215 r11 F2 (ADR-0099 addendum): the global token table is reachable only via its function.
describe('SS-PLAT-178 app.consume_inbound_webhook_token(): consume-once, bound to message and recipient hashes', () => {
  it('SS-PLAT-178 new, then retry only with both hashes equal, else replayed; lf_app cannot read or write the table', async () => {
    const tdb = await createTestDatabase({ migrate: true });
    try {
      const h = (c: string) => Buffer.alloc(32, c);
      const consume = async (token: string, body: Buffer, rcpt: Buffer) =>
        (
          await sql<{
            v: string;
          }>`SELECT app.consume_inbound_webhook_token('mailgun', ${token}, ${body}, ${rcpt}) AS v`.execute(
            tdb.app,
          )
        ).rows[0]?.v;
      const tok = 'T'.repeat(50);
      expect(await consume(tok, h('a'), h('r'))).toBe('new');
      expect(await consume(tok, h('a'), h('r'))).toBe('retry');
      expect(await consume(tok, h('b'), h('r'))).toBe('replayed');
      expect(await consume(tok, h('a'), h('s'))).toBe('replayed');
      expect(await consume('U'.repeat(50), h('b'), h('s'))).toBe('new');
      await expect(sql`SELECT * FROM app.inbound_webhook_token`.execute(tdb.app)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        sql`INSERT INTO app.inbound_webhook_token VALUES ('mailgun', ${'V'.repeat(50)}, ${h('a')}, ${h('a')})`.execute(
          tdb.app,
        ),
      ).rejects.toThrow(/permission denied/);
      const fn = await tdb.admin.query<{
        definer: boolean;
        owner: string;
        config: string[] | null;
        public_exec: boolean;
      }>(
        `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'consume_inbound_webhook_token'`,
      );
      expect(fn.rows).toEqual([
        {
          definer: true,
          owner: 'lf_migrator',
          config: ['search_path=pg_catalog, pg_temp'],
          public_exec: false,
        },
      ]);
    } finally {
      await tdb.close();
    }
  });
});

// The generated suite: one describe block per tenant-owned table, discovered at collection time.
const suiteDb = await createTestDatabase({ migrate: true });
afterAll(async () => {
  await suiteDb.close();
});
await defineCrossTenantSuite(suiteDb);
