/**
 * SS-PLAT-70 — scoped personal API tokens (T-0016, design §6.2, ADR-0027, RQ-0031). Real sessions,
 * real database, lf_app only.
 *
 * Issuing needs a fresh MFA step-up; the secret is shown once and only its SHA-256 is stored.
 * A token acts as its owner with permissions = scopes ∩ the owner's current role permissions,
 * never satisfies a step-up, cannot carry step-up or administration permissions, is subject to
 * SoD as its owner, expires, can be revoked, records its last use, and is bound to its tenant.
 * Test controllers stand in for business routes, declared as real routes must be.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { scope } from '../tenancy/tenant-tx.ts';
import { fromBody, fromParamWithRecordedAmount, SoD } from '../sod/sod.decorator.ts';

const A = '01900000-0000-7000-8000-000000070a0a';
const B = '01900000-0000-7000-8000-000000070b0b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = id(0x7001);
const AR = id(0x7002); // ar_clerk: no MFA required by role
const ACC = id(0x7003); // accountant: MFA required by role
const BILLS = id(0x7004); // ap_clerk + approver
const MOVER = id(0x7005); // ar_clerk, loses the role
const FA = id(0x7006); // finance_admin: users.read, not users.manage
const OWNER_B = id(0x70b1);

const MIN = 60_000;
let now = Date.now();
const clock = { now: () => new Date(now) };

@Controller('test')
class TestBusinessController {
  @Get('ar/invoices')
  @RequirePermission('ar.read')
  list(): { user: string | null } {
    return { user: scope().access.userId };
  }

  @Post('ar/invoices')
  @RequirePermission('ar.invoice.create')
  create(@Body() body: { number?: string }): { number: string | undefined } {
    return { number: body.number };
  }

  @Get('gl')
  @RequirePermission('gl.account.read')
  gl(): { ok: boolean } {
    return { ok: true };
  }

  /** A non-step-up permission whose route still demands step-up. */
  @Post('sensitive')
  @HttpCode(200)
  @RequirePermission('ar.read')
  @RequireStepUp()
  sensitive(): { ok: boolean } {
    return { ok: true };
  }

  @Post('bills')
  @RequirePermission('ap.bill.enter')
  @SoD('bill.enter', fromBody('id', 'amount'))
  enter(@Req() req: Request): { id: unknown } {
    return { id: (req.body as { id?: unknown }).id };
  }

  @Post('bills/:id/approve')
  @HttpCode(200)
  @RequirePermission('ap.bill.approve')
  @SoD('bill.approve', fromParamWithRecordedAmount('id'))
  approve(): { approved: boolean } {
    return { approved: true };
  }
}

let tdb: TestDatabase;
let api: Api;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A session; `fresh` = MFA authenticated just now (satisfies step-up). */
async function session(user: string, opts: { fresh?: boolean; mfa?: boolean } = {}) {
  if (!api.sessions) throw new Error('sessions not configured');
  const mfa = opts.mfa ?? true;
  return api.sessions.create(user === OWNER_B ? B : A, {
    userId: user,
    amr: mfa ? ['pwd', 'otp'] : ['pwd'],
    acr: null,
    authTime: opts.fresh === false ? new Date(now - 30 * MIN) : new Date(now),
  });
}

interface Auth {
  cookie?: string;
  bearer?: string;
}
function call(method: string, path: string, auth: Auth, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = `lf_session=${auth.cookie}`;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Issued {
  id: string;
  name: string;
  scopes: string[];
  expires_at: string;
  token: string;
}
async function issue(user: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const res = await call(
    'POST',
    '/api-tokens',
    { cookie: await session(user) },
    { name: 'export', scopes, ...extra },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Issued;
}

async function auditRows(where: string, params: unknown[]) {
  const r = await tdb.admin.query(
    `SELECT actor_type, actor_user_id, action, entity_type, entity_id, api_token_id, after
       FROM audit.audit_log WHERE ${where} ORDER BY id`,
    params,
  );
  return r.rows;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  const users: [string, string, string[]][] = [
    [A, OWNER, ['owner']],
    [A, AR, ['ar_clerk']],
    [A, ACC, ['accountant']],
    [A, BILLS, ['ap_clerk', 'approver']],
    [A, MOVER, ['ar_clerk']],
    [A, FA, ['finance_admin']],
    [B, OWNER_B, ['owner']],
  ];
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, roles] of users) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({ id: u, email: `${u}@tokens.test`, display_name: 'U', status: 'active' })
          .execute();
        for (const role of roles) {
          await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
        }
      }
    });
  }
  await seed.destroy();
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: { clock },
    testControllers: [TestBusinessController],
  });
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

beforeEach(() => {
  now = Date.now();
});

describe('SS-PLAT-70: Scoped API tokens are hashed, expire and cannot exceed their owner', () => {
  it('issuing needs a fresh MFA step-up; the secret is returned once and only its SHA-256 is stored', async () => {
    const stale = await call(
      'POST',
      '/api-tokens',
      { cookie: await session(AR, { fresh: false }) },
      { name: 'x', scopes: ['ar.read'] },
    );
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const noMfa = await call(
      'POST',
      '/api-tokens',
      { cookie: await session(AR, { mfa: false }) },
      { name: 'x', scopes: ['ar.read'] },
    );
    expect(noMfa.status).toBe(401);

    const res = await call(
      'POST',
      '/api-tokens',
      { cookie: await session(AR) },
      { name: 'Month-end export', scopes: ['ar.read'] },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Issued;
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      name: 'Month-end export',
      scopes: ['ar.read'],
      expires_at: expect.any(String) as string,
      token: expect.stringMatching(
        /^lfpat\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
      ) as string,
    });
    const [, tenant, tokenId, secret = ''] = body.token.split('.');
    expect([tenant, tokenId]).toEqual([A, body.id]);
    // Default expiry: 90 days.
    const days = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const row = await tdb.admin.query('SELECT * FROM app.api_token WHERE id = $1', [body.id]);
    expect(row.rows[0]).toMatchObject({ user_id: AR, secret_sha256: sha256(secret) });
    expect(JSON.stringify(row.rows[0])).not.toContain(secret);
    // Listing never shows the secret or its hash.
    const list = await call('GET', '/api-tokens', { cookie: await session(AR) });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain(body.id);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(sha256(secret));
    // The issue is audited without the secret.
    const audit = await auditRows(`action = 'POST /api-tokens' AND entity_id = $1`, [body.id]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('scopes must be known, token-allowed and held by the owner; expiry is 1–366 days', async () => {
    const owner = await session(OWNER);
    const post = (b: unknown, c = owner) => call('POST', '/api-tokens', { cookie: c }, b);
    const cases: [unknown, number, unknown][] = [
      [{ name: 'x', scopes: ['invoices:read'] }, 400, { error: 'invalid_scope' }],
      [{ name: 'x', scopes: [] }, 400, { error: 'invalid_scope' }],
      [{ name: 'x', scopes: ['ar.read', 'ar.read'] }, 400, { error: 'invalid_scope' }],
      [{ name: 'x', scopes: 'ar.read' }, 400, { error: 'invalid_scope' }],
      [
        { name: 'x', scopes: ['ar.read', 'ap.payment_batch.release'] },
        400,
        { error: 'scope_not_allowed', scope: 'ap.payment_batch.release' },
      ],
      [
        { name: 'x', scopes: ['users.manage'] },
        400,
        { error: 'scope_not_allowed', scope: 'users.manage' },
      ],
      [{ name: '', scopes: ['ar.read'] }, 400, { error: 'invalid_name' }],
      [{ name: 'x', scopes: ['ar.read'], expires_in_days: 367 }, 400, { error: 'invalid_expiry' }],
      [{ name: 'x', scopes: ['ar.read'], expires_in_days: 0 }, 400, { error: 'invalid_expiry' }],
      [{ name: 'x', scopes: ['ar.read'], expires_in_days: 1.5 }, 400, { error: 'invalid_expiry' }],
    ];
    for (const [b, status, err] of cases) {
      const res = await post(b);
      expect([JSON.stringify(b), res.status]).toEqual([JSON.stringify(b), status]);
      expect(await res.json()).toEqual(err);
    }
    // An AR Clerk cannot mint a token for a permission they do not hold.
    const beyond = await post(
      { name: 'x', scopes: ['ar.read', 'gl.journal.post'] },
      await session(AR),
    );
    expect(beyond.status).toBe(403);
    expect(await beyond.json()).toEqual({ error: 'forbidden', permission: 'gl.journal.post' });
    const ok = await post({ name: 'x', scopes: ['ar.read'], expires_in_days: 366 });
    expect(ok.status).toBe(201);
  });

  it('a token acts as its owner, only within its scopes, and every use is attributed to it', async () => {
    const t = await issue(AR, ['ar.read']);
    const read = await call('GET', '/test/ar/invoices', { bearer: t.token });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ user: AR });
    const used = await tdb.admin.query<{ used: boolean }>(
      'SELECT last_used_at IS NOT NULL AS used FROM app.api_token WHERE id = $1',
      [t.id],
    );
    expect(used.rows).toEqual([{ used: true }]);

    // The owner holds ar.invoice.create, the token does not: refused, and the refusal names it.
    const denied = await call('POST', '/test/ar/invoices', { bearer: t.token }, { number: 'X1' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', permission: 'ar.invoice.create' });
    expect(await auditRows(`action = 'permission_denied' AND api_token_id = $1`, [t.id])).toEqual([
      {
        actor_type: 'user',
        actor_user_id: AR,
        action: 'permission_denied',
        entity_type: 'permission',
        entity_id: 'ar.invoice.create',
        api_token_id: t.id,
        after: { method: 'POST', route: '/test/ar/invoices', permission: 'ar.invoice.create' },
      },
    ]);

    const w = await issue(AR, ['ar.read', 'ar.invoice.create']);
    const created = await call('POST', '/test/ar/invoices', { bearer: w.token }, { number: 'X2' });
    expect(created.status).toBe(201);
    expect(await auditRows(`action = 'POST /test/ar/invoices'`, [])).toEqual([
      {
        actor_type: 'user',
        actor_user_id: AR,
        action: 'POST /test/ar/invoices',
        entity_type: 'request',
        entity_id: null,
        api_token_id: w.id,
        after: null,
      },
    ]);
  });

  it('a mover who loses a role loses it on every token at once', async () => {
    const t = await issue(MOVER, ['ar.read']);
    expect((await call('GET', '/test/ar/invoices', { bearer: t.token })).status).toBe(200);
    const revoke = await call(
      'POST',
      `/users/${MOVER}/roles/ar_clerk/revoke`,
      { cookie: await session(OWNER) },
      { reason: 'moved to sales' },
    );
    expect(revoke.status).toBe(200);
    const after = await call('GET', '/test/ar/invoices', { bearer: t.token });
    expect(after.status).toBe(403);
    expect(await after.json()).toEqual({ error: 'forbidden', permission: 'ar.read' });
  });

  it('a token never satisfies a step-up, cannot issue tokens and is not a session', async () => {
    const t = await issue(AR, ['ar.read']);
    const sensitive = await call('POST', '/test/sensitive', { bearer: t.token });
    expect(sensitive.status).toBe(401);
    expect(await sensitive.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const mint = await call(
      'POST',
      '/api-tokens',
      { bearer: t.token },
      { name: 'x', scopes: ['ar.read'] },
    );
    expect(mint.status).toBe(401);
    expect((await call('GET', '/auth/me', { bearer: t.token })).status).toBe(401);
    expect((await call('POST', '/auth/logout', { bearer: t.token })).status).toBe(401);
    // The same route with a fresh MFA session works (positive control).
    expect((await call('POST', '/test/sensitive', { cookie: await session(AR) })).status).toBe(200);
  });

  it('an MFA role uses a token issued under step-up without per-request MFA', async () => {
    const withoutMfa = await call('GET', '/test/gl', {
      cookie: await session(ACC, { mfa: false }),
    });
    expect(withoutMfa.status).toBe(403);
    expect(await withoutMfa.json()).toEqual({ error: 'mfa_required' });
    const t = await issue(ACC, ['gl.account.read']);
    expect((await call('GET', '/test/gl', { bearer: t.token })).status).toBe(200);
  });

  it('segregation of duties applies to the token owner', async () => {
    const entered = await call(
      'POST',
      '/test/bills',
      { cookie: await session(BILLS) },
      { id: 'bill-7001', amount: '5000.0000' },
    );
    expect(entered.status).toBe(201);
    const t = await issue(BILLS, ['ap.read', 'ap.bill.approve']);
    const approve = await call('POST', '/test/bills/bill-7001/approve', { bearer: t.token }, {});
    expect(approve.status).toBe(403);
    expect(await approve.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_BILL_SELF_APPROVAL',
    });
    expect(await auditRows(`action = 'sod_violation' AND api_token_id = $1`, [t.id])).toHaveLength(
      1,
    );
  });

  it('revoked, expired, forged, foreign-tenant and malformed tokens are refused with 401', async () => {
    const t = await issue(AR, ['ar.read']);
    const [, , tokenId = '', secret = ''] = t.token.split('.');
    const refuse = async (auth: Auth, expected = 'invalid_token') => {
      const res = await call('GET', '/test/ar/invoices', auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expected });
    };
    // Wrong secret, same id.
    const other = secret.startsWith('A') ? `B${secret.slice(1)}` : `A${secret.slice(1)}`;
    await refuse({ bearer: `lfpat.${A}.${tokenId}.${other}` });
    // The right token presented for another tenant is not found under that tenant's RLS.
    await refuse({ bearer: `lfpat.${B}.${tokenId}.${secret}` });
    // Malformed tokens never reach the database.
    await refuse({ bearer: 'lfpat.not-a-token' }, 'unauthenticated');
    await refuse({ bearer: secret }, 'unauthenticated');
    // A cookie and a bearer token together are ambiguous.
    await refuse({ bearer: t.token, cookie: await session(AR) }, 'unauthenticated');
    // In the query string a token is ignored.
    const q = await fetch(
      `${api.url}/test/ar/invoices?access_token=${encodeURIComponent(t.token)}`,
    );
    expect(q.status).toBe(401);
    expect((await call('GET', '/test/ar/invoices', { bearer: t.token })).status).toBe(200); // control

    const short = await issue(AR, ['ar.read'], { expires_in_days: 1 });
    expect((await call('GET', '/test/ar/invoices', { bearer: short.token })).status).toBe(200);
    now += 25 * 60 * MIN;
    await refuse({ bearer: short.token });
    now = Date.now();

    const revoked = await call(
      'POST',
      `/api-tokens/${t.id}/revoke`,
      { cookie: await session(AR) },
      {},
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ id: t.id, revoked: true });
    await refuse({ bearer: t.token });
    const again = await call(
      'POST',
      `/api-tokens/${t.id}/revoke`,
      { cookie: await session(AR) },
      {},
    );
    expect(await again.json()).toEqual({ id: t.id, revoked: false });
  });

  it('owners revoke only their own tokens; an administrator (users.manage) revokes anyone’s', async () => {
    const t = await issue(AR, ['ar.read']);
    const foreign = await call(
      'POST',
      `/api-tokens/${t.id}/revoke`,
      { cookie: await session(ACC) },
      {},
    );
    expect(foreign.status).toBe(404);
    const listed = await call('GET', `/users/${AR}/api-tokens`, { cookie: await session(FA) });
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(t.id);
    expect(JSON.stringify(rows)).not.toMatch(/secret|lfpat\./);
    const notAdmin = await call(
      'POST',
      `/users/${AR}/api-tokens/${t.id}/revoke`,
      { cookie: await session(FA) },
      { reason: 'incident' },
    );
    expect(notAdmin.status).toBe(403);
    const admin = await call(
      'POST',
      `/users/${AR}/api-tokens/${t.id}/revoke`,
      { cookie: await session(OWNER) },
      { reason: 'incident 42' },
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ id: t.id, revoked: true });
    const row = await tdb.admin.query(
      'SELECT revoked_by, revoke_reason FROM app.api_token WHERE id = $1',
      [t.id],
    );
    expect(row.rows).toEqual([{ revoked_by: OWNER, revoke_reason: 'incident 42' }]);
    expect((await call('GET', '/test/ar/invoices', { bearer: t.token })).status).toBe(401);
    // Another tenant's administrator cannot see or revoke it.
    const b = await call('GET', `/users/${AR}/api-tokens`, { cookie: await session(OWNER_B) });
    expect(b.status).toBe(404);
  });
});
