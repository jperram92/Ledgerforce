/**
 * SS-PLAT-28 — every API request runs in its own tenant transaction (T-0104, design §6.7).
 * The tenant comes only from a TenantResolver. Tests plug in a resolver that maps a test bearer
 * token to a tenant; the production default refuses everything until OIDC exists (T-0011).
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql } from 'kysely';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import type { TenantResolver } from './tenant-resolver.ts';

const A = '01900000-0000-7000-8000-0000000000aa';
const B = '01900000-0000-7000-8000-0000000000bb';

async function names(res: Response): Promise<string[]> {
  return ((await res.json()) as { name: string }[]).map((c) => c.name);
}

const testResolver: TenantResolver = {
  async resolve(req: Request) {
    const auth = req.headers.authorization ?? '';
    return { 'Bearer test-A': A, 'Bearer test-B': B }[auth] ?? null;
  },
};

let tdb: TestDatabase;
let api: Api;
let refusing: Api;
let queries = 0;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const [id, name] of [
    [A, 'Harbour & Co Pty Ltd'],
    [B, 'Other Pty Ltd'],
  ] as const) {
    await withTenant(seed, id, async (trx) => {
      await trx.insertInto('app.tenant').values({ id, name }).execute();
      await trx.insertInto('app.company').values({ name, base_currency: 'AUD' }).execute();
    });
  }
  await seed.destroy();
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    poolSize: 1,
    tenantResolver: testResolver,
    onQuery: () => {
      queries++;
    },
  });
  refusing = await createApi({ databaseUrl: tdb.url('lf_app') });
});

afterAll(async () => {
  await api.close();
  await refusing.close();
  await tdb.close();
});

describe('SS-PLAT-28: Every API request runs in its own tenant transaction', () => {
  it('a request resolved to tenant A sees only A’s company', async () => {
    const res = await fetch(`${api.url}/companies`, {
      headers: { authorization: 'Bearer test-A' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
  });

  it('tenant B, on the same pooled connection straight after, sees only B’s company', async () => {
    const a = await fetch(`${api.url}/companies`, { headers: { authorization: 'Bearer test-A' } });
    const b = await fetch(`${api.url}/companies`, { headers: { authorization: 'Bearer test-B' } });
    expect(await names(a)).toEqual(['Harbour & Co Pty Ltd']);
    expect(await names(b)).toEqual(['Other Pty Ltd']);
  });

  it('a request with no resolvable tenant gets 401 and runs no SQL', async () => {
    const before = queries;
    const res = await fetch(`${api.url}/companies`);
    expect(res.status).toBe(401);
    expect(queries).toBe(before);
  });

  it('leaves no tenant context on the pooled connection after the request', async () => {
    await fetch(`${api.url}/companies`, { headers: { authorization: 'Bearer test-A' } });
    const r = await sql<{
      t: string | null;
    }>`SELECT nullif(current_setting('app.tenant_id', true), '') AS t`.execute(api.db);
    expect(r.rows[0]?.t ?? null).toBeNull();
  });

  it('the production default resolver refuses every request until OIDC exists (T-0011)', async () => {
    const res = await fetch(`${refusing.url}/companies`, {
      headers: { authorization: 'Bearer test-A' },
    });
    expect(res.status).toBe(401);
  });

  it('never takes the tenant from a header or query string', async () => {
    const res = await fetch(`${refusing.url}/companies?tenant_id=${A}`, {
      headers: { 'x-tenant-id': A },
    });
    expect(res.status).toBe(401);
  });
});
