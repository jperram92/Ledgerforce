/**
 * SS-PLAT-20 (MFA part), SS-UC06-03, SS-PLAT-58 and SS-PLAT-59 — MFA for finance roles and
 * step-up re-authentication (T-0013, ADR-0025, RQ-0027). Real sessions, real database, lf_app
 * only, and a real OpenID Provider (`oidc-provider`, in-process on 127.0.0.1) that returns the
 * `amr`, `acr` and `auth_time` the test chooses. Its keys and the client secret are generated at
 * runtime.
 *
 * The payment-batch release (T-0054), bank-detail change (T-0037) and period reopen (T-0023)
 * endpoints do not exist yet. Test controllers stand in for them, declared exactly as those tasks
 * must declare their routes (`@RequirePermission(...)` + `@RequireStepUp(300)`); the checks, the
 * refusals, the step-up flow and the audit rows are the real ones (as T-0012 did, DL-0104).
 *
 * Time: the API runs on the test clock `now`. The test IdP stamps logins with the same clock
 * (`ts`), so `auth_time` and the API agree; openid-client checks `max_age` on the real clock.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import Provider from 'oidc-provider';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { ROLE_IDS, ROLE_TEMPLATES, type RoleId } from '@ledgerforce/shared/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { RequirePermission, RequireStepUp } from './permission.decorator.ts';

const A = '01900000-0000-7000-8000-0000000013aa';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const CLIENT_ID = 'ledgerforce-test';
const CLIENT_SECRET = randomBytes(24).toString('base64url'); // runtime only, never committed
const MFA = 'urn:ledgerforce:loa:mfa';
const PWD = 'urn:ledgerforce:loa:pwd';
const MIN = 60_000;

let now = Date.now();
const clock = { now: () => new Date(now) };

/** Users who log in through the IdP (sub → user id, roles). */
const PEOPLE = {
  acc: { id: uid(0x1301), roles: ['accountant'] },
  apr: { id: uid(0x1302), roles: ['approver'] },
  arc: { id: uid(0x1303), roles: ['ar_clerk'] },
  mix: { id: uid(0x1304), roles: ['ar_clerk', 'accountant'] },
  other: { id: uid(0x1305), roles: ['approver'] },
  ap: { id: uid(0x1306), roles: ['ap_clerk'] },
  fa: { id: uid(0x1307), roles: ['finance_admin'] },
  owner: { id: uid(0x1308), roles: ['owner'] },
} as const satisfies Record<string, { id: string; roles: RoleId[] }>;
type Who = keyof typeof PEOPLE;
/** One user per interactive role template, for the role matrix (sessions created directly). */
const INTERACTIVE = ROLE_IDS.filter((r) => ROLE_TEMPLATES[r].interactiveLogin);
const roleUser = (r: RoleId) => uid(0x1400 + ROLE_IDS.indexOf(r));

let tdb: TestDatabase;
let api: Api;
let idp: http.Server;
let issuer: string;
let interactions = 0;
let nextLogin: { sub: string; amr: string[]; acr: string; ts: number } = {
  sub: '',
  amr: [],
  acr: '',
  ts: 0,
};
/** The browser's cookies at the IdP, per person: a second visit has an IdP (SSO) session. */
const idpJars = new Map<string, Map<string, string>>();

const done = {
  releases: [] as string[],
  bankChanges: [] as string[],
  reopens: [] as string[],
  payroll: [] as string[],
};

@Controller('ap/payment-batches')
class TestPaymentBatchController {
  @Post(':batchId/release')
  @HttpCode(200)
  @RequirePermission('ap.payment_batch.release')
  @RequireStepUp(300)
  release(@Param('batchId') batchId: string): { batch_id: string; status: string } {
    done.releases.push(batchId);
    return { batch_id: batchId, status: 'released' };
  }
}

@Controller('parties/:partyId/bank-detail-changes')
class TestBankDetailChangeController {
  @Post()
  @HttpCode(201)
  @RequirePermission('parties.bank_account.change_request')
  @RequireStepUp(300)
  request(@Param('partyId') partyId: string): { party_id: string; status: string } {
    done.bankChanges.push(partyId);
    return { party_id: partyId, status: 'pending_verification' };
  }
}

@Controller('periods')
class TestPeriodController {
  @Post(':periodId/reopen')
  @HttpCode(200)
  @RequirePermission('period.reopen')
  @RequireStepUp(300)
  reopen(@Param('periodId') periodId: string): { period_id: string; status: string } {
    done.reopens.push(periodId);
    return { period_id: periodId, status: 'open' };
  }
}

/** Forgot @RequireStepUp: a step-up permission must still demand step-up (fail closed). */
@Controller('payroll/net-pay-batches')
class TestNetPayController {
  @Post(':batchId/release')
  @HttpCode(200)
  @RequirePermission('payroll.net_pay_batch.release')
  release(@Param('batchId') batchId: string): { batch_id: string } {
    done.payroll.push(batchId);
    return { batch_id: batchId };
  }
}

/** Ordinary finance endpoints (no step-up). */
@Controller('finance')
class TestFinanceController {
  @Get('ledger')
  @RequirePermission('gl.journal.read')
  ledger(): { ok: true } {
    return { ok: true };
  }

  @Get('receivables')
  @RequirePermission('ar.read')
  receivables(): { ok: true } {
    return { ok: true };
  }

  @Get('company')
  @RequirePermission('company.read')
  company(): { ok: true } {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const c of setCookies(res)) {
    const [kv = ''] = c.split(';');
    const i = kv.indexOf('=');
    if (kv.slice(0, i) === name) return kv.slice(i + 1);
  }
  return undefined;
}

interface IdpLogin {
  amr?: string[];
  acr?: string;
  /** auth_time the IdP asserts, in seconds; defaults to the test clock. */
  ts?: number;
}

/** Drives the IdP (the person's cookie jar, manual redirects) until it redirects back to the API. */
async function authenticateAtIdp(authorize: URL, sub: string, how: IdpLogin): Promise<URL> {
  nextLogin = {
    sub,
    amr: how.amr ?? ['pwd', 'otp'],
    acr: how.acr ?? MFA,
    ts: how.ts ?? Math.floor(now / 1000),
  };
  let jar = idpJars.get(sub);
  if (!jar) {
    jar = new Map();
    idpJars.set(sub, jar);
  }
  let next = authorize;
  for (let hop = 0; hop < 10; hop++) {
    if (next.origin === new URL(api.url).origin) return next;
    const res = await fetch(next, {
      redirect: 'manual',
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of setCookies(res)) {
      const [kv = ''] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const location = res.headers.get('location');
    if (!location) throw new Error(`IdP stopped at ${next.pathname} with ${String(res.status)}`);
    next = new URL(location, next);
  }
  throw new Error('IdP redirect loop');
}

/** Full OIDC login; returns the lf_session cookie value. */
async function login(who: Who, how: IdpLogin = {}): Promise<string> {
  idpJars.set(`sub-${who}`, new Map()); // a sign-in starts without an IdP session
  const start = await fetch(`${api.url}/t/mfa-test/auth/login`, { redirect: 'manual' });
  const back = await authenticateAtIdp(
    new URL(start.headers.get('location') ?? '', api.url),
    `sub-${who}`,
    how,
  );
  const res = await fetch(back, {
    redirect: 'manual',
    headers: { cookie: `lf_oidc=${cookieValue(start, 'lf_oidc') ?? ''}` },
  });
  expect(res.status).toBe(303);
  return cookieValue(res, 'lf_session') ?? '';
}

function beginStepUp(session: string | undefined, query = ''): Promise<Response> {
  return fetch(`${api.url}/auth/step-up${query}`, {
    redirect: 'manual',
    headers: session === undefined ? {} : { cookie: `lf_session=${session}` },
  });
}

interface StepUp {
  start: Response;
  authorize: URL;
  callback: URL;
  oidc: string;
}

/** Starts a step-up for `session` and authenticates at the IdP as `sub` (default: the same person). */
async function stepUpAtIdp(
  session: string,
  who: Who,
  how: IdpLogin = {},
  query = '?max_age=300&return_to=/ap/payment-batches',
): Promise<StepUp> {
  const start = await beginStepUp(session, query);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location') ?? '', api.url);
  const callback = await authenticateAtIdp(authorize, `sub-${who}`, how);
  return { start, authorize, callback, oidc: cookieValue(start, 'lf_oidc') ?? '' };
}

function finishStepUp(s: StepUp, session: string | undefined): Promise<Response> {
  const cookies = [`lf_oidc=${s.oidc}`];
  if (session !== undefined) cookies.push(`lf_session=${session}`);
  return fetch(s.callback, { redirect: 'manual', headers: { cookie: cookies.join('; ') } });
}

function call(method: string, path: string, session?: string): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    method,
    headers: session === undefined ? {} : { cookie: `lf_session=${session}` },
  });
}

const sessionIdOf = (cookie: string) => cookie.split('.')[1] ?? '';

async function sessionRow(cookie: string): Promise<{
  amr: string[];
  acr: string | null;
  auth_time: Date | null;
  revoked_at: Date | null;
}> {
  const { rows } = await tdb.admin.query<{
    amr: string[];
    acr: string | null;
    auth_time: Date | null;
    revoked_at: Date | null;
  }>('SELECT amr, acr, auth_time, revoked_at FROM app.session WHERE id = $1', [
    sessionIdOf(cookie),
  ]);
  const row = rows[0];
  if (!row) throw new Error('no session row');
  return row;
}

async function sessionCount(): Promise<number> {
  const { rows } = await tdb.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.session WHERE tenant_id = $1',
    [A],
  );
  return rows[0]?.n ?? -1;
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}
async function auditSince(mark: string): Promise<AuditRow[]> {
  const { rows } = await tdb.admin.query<AuditRow>(
    `SELECT id::text, actor_user_id, action, entity_type, entity_id, before, after
       FROM audit.audit_log WHERE tenant_id = $1 AND id > $2::bigint ORDER BY id`,
    [A, mark],
  );
  return rows;
}
async function auditMark(): Promise<string> {
  const { rows } = await tdb.admin.query<{ m: string }>(
    'SELECT coalesce(max(id), 0)::text AS m FROM audit.audit_log',
  );
  return rows[0]?.m ?? '0';
}

/** A session created without the IdP (as the T-0012 tests do), with chosen amr and auth_time. */
async function directSession(
  userId: string,
  amr: string[],
  authTime: Date | null,
  acr: string | null = null,
): Promise<string> {
  if (!api.sessions) throw new Error('sessions not configured');
  return api.sessions.create(A, { userId, amr, acr, authTime });
}

// ---------------------------------------------------------------------------------------------
// set-up: database, test IdP, API

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });

  idp = http.createServer();
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;

  await tdb.admin.query(
    "INSERT INTO app.tenant (id, name, slug) VALUES ($1, 'MFA Pty Ltd', 'mfa-test')",
    [A],
  );
  const seedUser = async (id: string, sub: string, roles: readonly string[]) => {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, idp_subject, idp_issuer, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [id, A, `${sub}@mfa.test`, sub, sub, issuer],
    );
    for (const role of roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [A, id, role],
      );
    }
  };
  for (const [who, p] of Object.entries(PEOPLE)) await seedUser(p.id, `sub-${who}`, p.roles);
  for (const r of INTERACTIVE) await seedUser(roleUser(r), `sub-role-${r}`, [r]);

  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: { clock },
    oidc: { issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowInsecureIssuer: true },
    testControllers: [
      TestPaymentBatchController,
      TestBankDetailChangeController,
      TestPeriodController,
      TestNetPayController,
      TestFinanceController,
    ],
  });

  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [`${api.url}/auth/callback`],
      },
    ],
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    acrValues: [MFA, PWD],
    claims: { openid: ['sub', 'acr', 'amr', 'auth_time'] },
    findAccount: (_ctx, sub) => ({ accountId: sub, claims: () => ({ sub }) }),
    loadExistingGrant: async (ctx) => {
      const clientId = ctx.oidc.client?.clientId;
      const accountId = ctx.oidc.session?.accountId;
      if (!clientId || !accountId) return undefined;
      const grant = new ctx.oidc.provider.Grant({ clientId, accountId });
      grant.addOIDCScope('openid');
      await grant.save();
      return grant;
    },
  });
  const handle = provider.callback();
  idp.on('request', (req, res) => {
    if (req.url?.startsWith('/interaction/')) {
      interactions += 1;
      void provider.interactionFinished(
        req,
        res,
        {
          login: {
            accountId: nextLogin.sub,
            amr: nextLogin.amr,
            acr: nextLogin.acr,
            ts: nextLogin.ts,
          },
        },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    handle(req, res);
  });
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await new Promise((resolve) => (idp as http.Server | undefined)?.close(resolve) ?? resolve(0));
  await (tdb as TestDatabase | undefined)?.close();
});

beforeEach(() => {
  now = Date.now();
});

// ---------------------------------------------------------------------------------------------

describe('SS-PLAT-20: MFA and session policy for finance roles', () => {
  it('an Accountant who logged in without MFA is refused on a finance endpoint (403 mfa_required), and it is audited', async () => {
    const session = await login('acc', { amr: ['pwd'], acr: PWD });
    const mark = await auditMark();
    const res = await call('GET', '/finance/ledger', session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.acc.id,
        action: 'mfa_required',
        entity_type: 'session',
        entity_id: sessionIdOf(session),
        after: { method: 'GET', route: '/finance/ledger' },
      }),
    ]);
  });

  it('member routes stay open without MFA, so the Accountant can see who they are and step up', async () => {
    const session = await login('acc', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/auth/me', session)).status).toBe(200);
    expect((await beginStepUp(session)).status).toBe(302);
  });

  it('an Accountant with MFA (amr otp) may call it; an idle session of 31 minutes is refused (401 session_expired)', async () => {
    const session = await login('acc', { amr: ['pwd', 'otp'], acr: PWD });
    expect((await call('GET', '/finance/ledger', session)).status).toBe(200);
    now += 31 * MIN;
    const res = await call('GET', '/finance/ledger', session);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_expired' });
  });

  it('a configured MFA acr counts as MFA even when amr shows only a password', async () => {
    const session = await login('acc', { amr: ['pwd'], acr: MFA });
    expect((await call('GET', '/finance/ledger', session)).status).toBe(200);
  });

  it('a non-finance role (AR Clerk) is unaffected without MFA', async () => {
    const session = await login('arc', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/finance/receivables', session)).status).toBe(200);
  });

  it('holding one finance role among others is enough to require MFA', async () => {
    const session = await login('mix', { amr: ['pwd'], acr: PWD });
    const res = await call('GET', '/finance/receivables', session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
  });

  it.each(INTERACTIVE.map((r) => [r, ROLE_TEMPLATES[r].mfaRequired] as const))(
    'role %s without MFA: refused = %s',
    async (role, mfaRequired) => {
      const session = await directSession(roleUser(role), ['pwd'], new Date(now));
      const res = await call('GET', '/finance/company', session);
      expect(res.status).toBe(mfaRequired ? 403 : 200);
      if (mfaRequired) expect(await res.json()).toEqual({ error: 'mfa_required' });
      const withMfa = await directSession(roleUser(role), ['pwd', 'otp'], new Date(now));
      expect((await call('GET', '/finance/company', withMfa)).status).toBe(200);
    },
  );

  it('after an MFA step-up the same session may use finance endpoints', async () => {
    const session = await login('acc', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/finance/ledger', session)).status).toBe(403);
    const s = await stepUpAtIdp(session, 'acc', { amr: ['pwd', 'otp'] }, '');
    expect((await finishStepUp(s, session)).status).toBe(303);
    expect((await call('GET', '/finance/ledger', session)).status).toBe(200);
  });
});

describe('SS-UC06-03: Release requires step-up MFA', () => {
  it('user B without a fresh step-up gets step_up_required; after step-up the release succeeds', async () => {
    const session = await login('apr', { amr: ['pwd', 'otp'] });
    now += 6 * MIN; // the login is now older than the release's 300-second maximum age
    const mark = await auditMark();
    const refused = await call('POST', '/ap/payment-batches/oct-2026/release', session);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(done.releases).not.toContain('oct-2026');
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.apr.id,
        action: 'step_up_required',
        entity_type: 'session',
        entity_id: sessionIdOf(session),
        after: { method: 'POST', route: '/ap/payment-batches/:batchId/release', max_age: 300 },
      }),
    ]);

    const s = await stepUpAtIdp(session, 'apr');
    const back = await finishStepUp(s, session);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('/ap/payment-batches');

    const ok = await call('POST', '/ap/payment-batches/oct-2026/release', session);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ batch_id: 'oct-2026', status: 'released' });
    expect(done.releases).toContain('oct-2026');
  });

  it('a fresh login without MFA is not a step-up: the Approver (no MFA needed to sign in) is refused', async () => {
    const session = await login('apr', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/finance/company', session)).status).toBe(200);
    const res = await call('POST', '/ap/payment-batches/nov-2026/release', session);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const s = await stepUpAtIdp(session, 'apr', { amr: ['pwd', 'otp'] });
    expect((await finishStepUp(s, session)).status).toBe(303);
    expect((await call('POST', '/ap/payment-batches/nov-2026/release', session)).status).toBe(200);
  });

  it('the step-up lasts its maximum age: 301 seconds later the release is refused again', async () => {
    const session = await login('apr');
    now = Math.floor((now + 10 * MIN) / 1000) * 1000; // auth_time has whole seconds
    const s = await stepUpAtIdp(session, 'apr');
    expect((await finishStepUp(s, session)).status).toBe(303);
    now += 300_000;
    expect((await call('POST', '/ap/payment-batches/dec-2026/release', session)).status).toBe(200);
    now += 1000;
    const res = await call('POST', '/ap/payment-batches/dec-2026/release', session);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
  });
});

describe('SS-PLAT-58: Step-up re-authenticates on the existing session', () => {
  it('step-up redirects to the IdP with prompt=login, max_age and the MFA acr_values, plus PKCE, state and nonce', async () => {
    const session = await login('apr');
    const res = await beginStepUp(session, '?max_age=120&return_to=/periods');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.origin).toBe(issuer);
    const p = url.searchParams;
    expect(p.get('prompt')).toBe('login');
    expect(p.get('max_age')).toBe('120');
    expect(p.get('acr_values')).toBe(MFA);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(`${api.url}/auth/callback`);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(res, 'lf_oidc')).toBe(`${A}.${p.get('state') ?? ''}`);

    const { rows } = await tdb.admin.query(
      'SELECT session_id, max_age_seconds, return_to FROM app.auth_request WHERE state = $1',
      [p.get('state')],
    );
    expect(rows).toEqual([
      { session_id: sessionIdOf(session), max_age_seconds: 120, return_to: '/periods' },
    ]);
  });

  it('the IdP re-authenticates even though it still has an SSO session', async () => {
    const session = await login('apr');
    const before = interactions;
    const s = await stepUpAtIdp(session, 'apr');
    expect(interactions).toBe(before + 1);
    expect((await finishStepUp(s, session)).status).toBe(303);
  });

  it('the callback updates auth_time, amr and acr of the same session: no new session, no new cookie, audited', async () => {
    const session = await login('apr', { amr: ['pwd'], acr: PWD });
    const count = await sessionCount();
    now += 20 * MIN;
    const ts = Math.floor(now / 1000);
    const s = await stepUpAtIdp(session, 'apr', { amr: ['pwd', 'hwk'], acr: MFA, ts });
    const mark = await auditMark();
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/ap/payment-batches');
    expect(cookieValue(res, 'lf_session')).toBeUndefined();
    expect(cookieValue(res, 'lf_oidc')).toBe(''); // pre-auth cookie cleared
    expect(await sessionCount()).toBe(count);
    const row = await sessionRow(session);
    expect(row).toEqual({
      amr: ['pwd', 'hwk'],
      acr: MFA,
      auth_time: new Date(ts * 1000),
      revoked_at: null,
    });
    expect((await call('GET', '/auth/me', session)).status).toBe(200);
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.apr.id,
        action: 'step_up',
        entity_type: 'session',
        entity_id: sessionIdOf(session),
        after: { amr: ['pwd', 'hwk'], acr: MFA, auth_time: new Date(ts * 1000).toISOString() },
      }),
    ]);
  });

  it('a login stores the auth_time the IdP asserted', async () => {
    const ts = Math.floor(now / 1000) - 42;
    const session = await login('apr', { ts });
    expect((await sessionRow(session)).auth_time).toEqual(new Date(ts * 1000));
  });

  it('without return_to the step-up lands on /; a replayed callback is refused', async () => {
    const session = await login('apr');
    const s = await stepUpAtIdp(session, 'apr', {}, '');
    const first = await finishStepUp(s, session);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/');
    const replay = await finishStepUp(s, session);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'invalid_request' });
  });
});

describe('SS-PLAT-59: Step-up fails closed', () => {
  it('a step-up completed at the IdP as another user is refused (403 step_up_mismatch), session unchanged, audited', async () => {
    const session = await login('apr');
    now += 10 * MIN;
    const before = await sessionRow(session);
    const count = await sessionCount();
    const s = await stepUpAtIdp(session, 'other');
    const mark = await auditMark();
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_mismatch' });
    expect(cookieValue(res, 'lf_session')).toBeUndefined();
    expect(await sessionRow(session)).toEqual(before);
    expect(await sessionCount()).toBe(count);
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.apr.id,
        action: 'step_up_refused',
        entity_type: 'session',
        entity_id: sessionIdOf(session),
        after: { reason: 'step_up_mismatch' },
      }),
    ]);
    expect((await call('POST', '/ap/payment-batches/x1/release', session)).status).toBe(401);
  });

  it('a step-up without MFA is refused (403 mfa_required) and does not touch the session', async () => {
    const session = await login('apr');
    now += 10 * MIN;
    const before = await sessionRow(session);
    const s = await stepUpAtIdp(session, 'apr', { amr: ['pwd'], acr: PWD });
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(await sessionRow(session)).toEqual(before);
  });

  it('an IdP answer with a stale auth_time is rejected by the max_age check (400 login_failed)', async () => {
    const session = await login('apr');
    const before = await sessionRow(session);
    const s = await stepUpAtIdp(session, 'apr', { ts: Math.floor(Date.now() / 1000) - 3600 });
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'login_failed' });
    expect(await sessionRow(session)).toEqual(before);
  });

  it('the callback needs the same session cookie that started the step-up', async () => {
    const session = await login('apr');
    const second = await directSession(PEOPLE.apr.id, ['pwd', 'otp'], null); // same user, other session
    const before = [await sessionRow(session), await sessionRow(second)];
    now += MIN;
    const s = await stepUpAtIdp(session, 'apr');
    for (const cookie of [undefined, second, 'garbage']) {
      const res = await finishStepUp(s, cookie);
      expect(res.status, String(cookie)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
    expect([await sessionRow(session), await sessionRow(second)]).toEqual(before);
  });

  it('a session that ended (logout) cannot be stepped up', async () => {
    const session = await login('apr');
    const s = await stepUpAtIdp(session, 'apr');
    expect((await call('POST', '/auth/logout', session)).status).toBe(204);
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('starting a step-up needs a session and a sane max_age and return_to', async () => {
    expect((await beginStepUp(undefined)).status).toBe(401);
    const session = await login('apr');
    for (const q of [
      '?max_age=0',
      '?max_age=3601',
      '?max_age=abc',
      '?max_age=1.5',
      '?return_to=https://evil.test/',
      '?return_to=//evil.test/',
      '?return_to=/\\evil.test',
      '?return_to=relative',
    ]) {
      const res = await beginStepUp(session, q);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
  });

  it('a session without a recorded auth_time never satisfies a step-up', async () => {
    const session = await directSession(PEOPLE.apr.id, ['pwd', 'otp'], null);
    const res = await call('POST', '/ap/payment-batches/x2/release', session);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
  });

  it('bank-detail change and period reopen need a fresh step-up too', async () => {
    const stale = new Date(now - 6 * MIN);
    const fresh = new Date(now - 10_000);
    for (const [user, path, list] of [
      [PEOPLE.ap.id, '/parties/p-1/bank-detail-changes', done.bankChanges],
      [PEOPLE.fa.id, '/periods/2026-09/reopen', done.reopens],
    ] as const) {
      const old = await directSession(user, ['pwd', 'otp'], stale);
      const refused = await call('POST', path, old);
      expect(refused.status, path).toBe(401);
      expect(await refused.json()).toEqual({ error: 'step_up_required', max_age: 300 });
      expect(list).toHaveLength(0);
      const ok = await call('POST', path, await directSession(user, ['pwd', 'otp'], fresh));
      expect(ok.status, path).toBeLessThan(300);
      expect(list).toHaveLength(1);
    }
  });

  it('a route with a step-up permission but no @RequireStepUp still demands step-up', async () => {
    const stale = await directSession(PEOPLE.owner.id, ['pwd', 'otp'], new Date(now - 6 * MIN));
    const res = await call('POST', '/payroll/net-pay-batches/pr-1/release', stale);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(done.payroll).toEqual([]);
    const fresh = await directSession(PEOPLE.owner.id, ['pwd', 'otp'], new Date(now));
    expect((await call('POST', '/payroll/net-pay-batches/pr-1/release', fresh)).status).toBe(200);
  });

  it('permission comes before step-up: a user without the permission gets 403 forbidden, not a step-up prompt', async () => {
    const session = await login('arc', { amr: ['pwd'], acr: PWD });
    const res = await call('POST', '/ap/payment-batches/x3/release', session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      permission: 'ap.payment_batch.release',
    });
  });
});
