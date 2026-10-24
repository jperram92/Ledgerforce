/**
 * SS-PLAT-RLS — tenant isolation (design §6.7).
 *
 * 1. Completeness: every table that has a tenant_id column (and every table in the app/audit
 *    schemas) has row-level security ENABLED and FORCED with at least one policy, and lf_app holds
 *    no privilege that bypasses RLS (TRUNCATE, TRIGGER, ownership).
 * 2. The checker itself is proven to fail on a deliberately unprotected table.
 * 3. A generated cross-tenant suite runs for every tenant_id table discovered from
 *    information_schema: tenant A cannot SELECT, UPDATE, DELETE or INSERT-as-B tenant B's rows.
 */
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
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
});

// The generated suite: one describe block per tenant-owned table, discovered at collection time.
const suiteDb = await createTestDatabase({ migrate: true });
afterAll(async () => {
  await suiteDb.close();
});
await defineCrossTenantSuite(suiteDb);
