/**
 * SS-PLAT-20 (session part) — server-side sessions per ADR-0016 (T-0105, design §6.2).
 * Cookie: lf_session=<tenant_id>.<session_id>.<secret>. The resolver verifies it under the claimed
 * tenant's RLS. 30-min idle, 12-h absolute, revoke-all through app_user.session_epoch.
 * Time comes from an injected clock, so expiry is tested exactly, with no sleeps.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { parseSessionCookie, type SessionCookie, type SessionService } from './session.service.ts';

const A = '01900000-0000-7000-8000-0000000001aa';
const B = '01900000-0000-7000-8000-0000000001bb';
const USER_A = '01900000-0000-7000-8000-00000000a001';
const USER_B = '01900000-0000-7000-8000-00000000b001';

const MIN = 60_000;
let now = Date.parse('2026-10-24T09:00:00Z');
const clock = { now: () => new Date(now) };

let tdb: TestDatabase;
let api: Api;
let sessions: SessionService;

function parts(cookie: string): SessionCookie {
  const c = parseSessionCookie(cookie);
  if (!c) throw new Error(`malformed cookie from SessionService.create: ${cookie}`);
  return c;
}

async function call(path: string, cookie?: string, method = 'GET'): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    method,
    headers: cookie ? { cookie: `lf_session=${cookie}` } : {},
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const [tenant, user, name, person] of [
    [A, USER_A, 'Harbour & Co Pty Ltd', 'Priya Shah'],
    [B, USER_B, 'Other Pty Ltd', 'Someone Else'],
  ] as const) {
    await withTenant(seed, tenant, async (trx) => {
      await trx.insertInto('app.tenant').values({ id: tenant, name }).execute();
      await trx.insertInto('app.company').values({ name, base_currency: 'AUD' }).execute();
      await trx
        .insertInto('app.app_user')
        .values({ id: user, email: `${user}@example.test`, display_name: person, status: 'active' })
        .execute();
    });
  }
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: { clock } });
  if (!api.sessions) throw new Error('createApi did not configure sessions');
  sessions = api.sessions;
});

afterAll(async () => {
  await api.close();
  await tdb.close();
});

beforeEach(() => {
  now = Date.parse('2026-10-24T09:00:00Z');
});

describe('SS-PLAT-20: MFA and session policy for finance roles — sessions', () => {
  it('a valid session resolves to its tenant and user, and RLS still filters', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: ['pwd', 'otp'], acr: 'mfa' });
    const me = await call('/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ tenant_id: A, user_id: USER_A, display_name: 'Priya Shah' });
    const companies = await call('/companies', cookie);
    expect(await companies.json()).toEqual([
      { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
    ]);
  });

  it('never stores the secret, only its SHA-256', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    const { sessionId: sid, secret } = parts(cookie);
    const row = await withTenant(api.db, A, (trx) =>
      trx.selectFrom('app.session').selectAll().where('id', '=', sid).executeTakeFirstOrThrow(),
    );
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.secret_sha256).toHaveLength(64);
  });

  it('expires after 30 minutes idle (session_expired), and use slides the idle window', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    now += 29 * MIN;
    expect((await call('/auth/me', cookie)).status).toBe(200);
    now += 29 * MIN; // 58 min since login, 29 since last use
    expect((await call('/auth/me', cookie)).status).toBe(200);
    now += 31 * MIN;
    const res = await call('/auth/me', cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_expired' });
  });

  it('expires 12 hours after login even if used continuously', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    for (let t = 20; t < 12 * 60; t += 20) {
      now = Date.parse('2026-10-24T09:00:00Z') + t * MIN;
      expect((await call('/auth/me', cookie)).status, `at +${String(t)} min`).toBe(200);
    }
    now = Date.parse('2026-10-24T09:00:00Z') + 12 * 60 * MIN + MIN;
    const res = await call('/auth/me', cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_expired' });
  });

  it('revoke-all (session epoch bump, e.g. role change) ends every session of that user', async () => {
    const one = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    const two = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    await sessions.revokeAll(A, USER_A, 'role_change');
    expect((await call('/auth/me', one)).status).toBe(401);
    expect((await call('/auth/me', two)).status).toBe(401);
    const fresh = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    expect((await call('/auth/me', fresh)).status).toBe(200);
  });

  it('logout revokes only that session', async () => {
    const keep = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    const out = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    expect((await call('/auth/logout', out, 'POST')).status).toBe(204);
    expect((await call('/auth/me', out)).status).toBe(401);
    expect((await call('/auth/me', keep)).status).toBe(200);
  });

  it('a tampered secret is refused (unauthenticated)', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    const { tenantId, sessionId, secret } = parts(cookie);
    const bad = `${tenantId}.${sessionId}.${secret.slice(0, -2)}xx`;
    const res = await call('/auth/me', bad);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('a forged tenant id with a real session of another tenant is refused', async () => {
    const cookie = await sessions.create(A, { userId: USER_A, amr: [], acr: null });
    const { sessionId, secret } = parts(cookie);
    const res = await call('/companies', `${B}.${sessionId}.${secret}`);
    expect(res.status).toBe(401);
  });

  it('missing or malformed cookies are refused without touching tenant data', async () => {
    expect((await call('/companies')).status).toBe(401);
    expect((await call('/companies', 'not-a-session')).status).toBe(401);
    expect((await call('/companies', `${A}.not-a-uuid.secret`)).status).toBe(401);
  });

  it('a disabled user’s session is refused', async () => {
    const cookie = await sessions.create(B, { userId: USER_B, amr: [], acr: null });
    await withTenant(api.db, B, (trx) =>
      trx
        .updateTable('app.app_user')
        .set({ status: 'disabled' })
        .where('id', '=', USER_B)
        .execute(),
    );
    expect((await call('/auth/me', cookie)).status).toBe(401);
  });
});
