/**
 * SS-PLAT-20 (MFA part), SS-UC06-03, SS-PLAT-58, SS-PLAT-59, SS-PLAT-135 and SS-PLAT-136 — MFA
 * for finance roles and step-up re-authentication (T-0013, ADR-0025, RQ-0027), which rotates the
 * session id and cookie (T-0192, ADR-0087, RQ-0169). Real sessions, real database, lf_app
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

@Controller('test/ap/payment-batches')
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
    headers:
      session === undefined
        ? {}
        : { cookie: `lf_session=${session}`, 'sec-fetch-site': 'same-origin' },
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
  query = '?max_age=300&return_to=/test/ap/payment-batches',
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

/** ADR-0087: a successful step-up answers with the new (rotated) session cookie. */
function rotatedCookie(res: Response): string {
  const fresh = cookieValue(res, 'lf_session');
  if (!fresh) throw new Error(`no rotated lf_session cookie (status ${String(res.status)})`);
  return fresh;
}

function call(method: string, path: string, session?: string): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    method,
    headers:
      session === undefined
        ? {}
        : { cookie: `lf_session=${session}`, 'sec-fetch-site': 'same-origin' },
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

  it('after an MFA step-up the rotated session may use finance endpoints (ADR-0087)', async () => {
    const session = await login('acc', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/finance/ledger', session)).status).toBe(403);
    const s = await stepUpAtIdp(session, 'acc', { amr: ['pwd', 'otp'] }, '');
    const back = await finishStepUp(s, session);
    expect(back.status).toBe(303);
    const fresh = rotatedCookie(back);
    expect((await call('GET', '/finance/ledger', fresh)).status).toBe(200);
    expect((await call('GET', '/finance/ledger', session)).status).toBe(401);
  });
});

describe('SS-UC06-03: Release requires step-up MFA', () => {
  it('user B without a fresh step-up gets step_up_required; after step-up the release succeeds', async () => {
    const session = await login('apr', { amr: ['pwd', 'otp'] });
    now += 6 * MIN; // the login is now older than the release's 300-second maximum age
    const mark = await auditMark();
    const refused = await call('POST', '/test/ap/payment-batches/oct-2026/release', session);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(done.releases).not.toContain('oct-2026');
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.apr.id,
        action: 'step_up_required',
        entity_type: 'session',
        entity_id: sessionIdOf(session),
        after: { method: 'POST', route: '/test/ap/payment-batches/:batchId/release', max_age: 300 },
      }),
    ]);

    const s = await stepUpAtIdp(session, 'apr');
    const back = await finishStepUp(s, session);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('/test/ap/payment-batches');

    const ok = await call('POST', '/test/ap/payment-batches/oct-2026/release', rotatedCookie(back));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ batch_id: 'oct-2026', status: 'released' });
    expect(done.releases).toContain('oct-2026');
  });

  it('a fresh login without MFA is not a step-up: the Approver (no MFA needed to sign in) is refused', async () => {
    const session = await login('apr', { amr: ['pwd'], acr: PWD });
    expect((await call('GET', '/finance/company', session)).status).toBe(200);
    const res = await call('POST', '/test/ap/payment-batches/nov-2026/release', session);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const s = await stepUpAtIdp(session, 'apr', { amr: ['pwd', 'otp'] });
    const back = await finishStepUp(s, session);
    expect(back.status).toBe(303);
    const fresh = rotatedCookie(back);
    expect((await call('POST', '/test/ap/payment-batches/nov-2026/release', fresh)).status).toBe(
      200,
    );
  });

  it('the step-up lasts its maximum age: 301 seconds later the release is refused again', async () => {
    const session = await login('apr');
    now = Math.floor((now + 10 * MIN) / 1000) * 1000; // auth_time has whole seconds
    const s = await stepUpAtIdp(session, 'apr');
    const back = await finishStepUp(s, session);
    expect(back.status).toBe(303);
    const fresh = rotatedCookie(back);
    now += 300_000;
    expect((await call('POST', '/test/ap/payment-batches/dec-2026/release', fresh)).status).toBe(
      200,
    );
    now += 1000;
    const res = await call('POST', '/test/ap/payment-batches/dec-2026/release', fresh);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
  });
});

describe('SS-PLAT-58: Step-up re-authenticates the signed-in user (rotated session, ADR-0087)', () => {
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

  it('the callback records auth_time, amr and acr on a new rotated session, sets its cookie, and audits the rotation', async () => {
    // ADR-0087 supersedes ADR-0025's "no new session, no new cookie" (DL-0730, DL-0731).
    const session = await login('apr', { amr: ['pwd'], acr: PWD });
    const count = await sessionCount();
    now += 20 * MIN;
    const ts = Math.floor(now / 1000);
    const s = await stepUpAtIdp(session, 'apr', { amr: ['pwd', 'hwk'], acr: MFA, ts });
    const mark = await auditMark();
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/test/ap/payment-batches');
    const fresh = rotatedCookie(res);
    expect(cookieValue(res, 'lf_oidc')).toBe(''); // pre-auth cookie cleared
    expect(await sessionCount()).toBe(count + 1); // the old row is kept (revoked), never deleted
    expect(await sessionRow(fresh)).toEqual({
      amr: ['pwd', 'hwk'],
      acr: MFA,
      auth_time: new Date(ts * 1000),
      revoked_at: null,
    });
    expect((await sessionRow(session)).revoked_at).not.toBeNull();
    expect((await call('GET', '/auth/me', fresh)).status).toBe(200);
    expect(await auditSince(mark)).toEqual([
      expect.objectContaining({
        actor_user_id: PEOPLE.apr.id,
        action: 'step_up',
        entity_type: 'session',
        entity_id: sessionIdOf(fresh),
        after: {
          amr: ['pwd', 'hwk'],
          acr: MFA,
          auth_time: new Date(ts * 1000).toISOString(),
          rotated_from: sessionIdOf(session),
        },
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
    expect((await call('POST', '/test/ap/payment-batches/x1/release', session)).status).toBe(401);
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
    // A fresh step-up for each case: the pre-auth row is single use, so one attempt must not
    // hide the next.
    for (const cookie of [undefined, second, 'garbage']) {
      const s = await stepUpAtIdp(session, 'apr');
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
    const res = await call('POST', '/test/ap/payment-batches/x2/release', session);
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
    const res = await call('POST', '/test/ap/payment-batches/x3/release', session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      permission: 'ap.payment_batch.release',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-0192, ADR-0087, RQ-0169: a step-up rotates the session id (OWASP ASVS 5.0 7.2.4).

interface FullSessionRow {
  user_id: string;
  absolute_expires_at: Date;
  idle_timeout_seconds: number;
  user_session_epoch: number;
  revoked_at: Date | null;
  revoke_reason: string | null;
}
async function fullSessionRow(cookie: string): Promise<FullSessionRow> {
  const { rows } = await tdb.admin.query<FullSessionRow>(
    `SELECT user_id, absolute_expires_at, idle_timeout_seconds, user_session_epoch, revoked_at,
            revoke_reason
       FROM app.session WHERE id = $1`,
    [sessionIdOf(cookie)],
  );
  const row = rows[0];
  if (!row) throw new Error('no session row');
  return row;
}

/** Waits until a backend of this test database waits on a lock (the blocked rotation). */
async function untilLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await tdb.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the step-up callback never waited on the session row');
}

describe('SS-PLAT-135: Step-up rotates the session id and cookie (ASVS 5.0 7.2.4)', () => {
  it('SS-PLAT-135 after a step-up the old session cookie is refused and the new one works with the fresh step-up time', async () => {
    const session = await login('apr');
    now += 10 * MIN; // the login is too old for a release
    expect((await call('POST', '/test/ap/payment-batches/r-135a/release', session)).status).toBe(
      401,
    );
    const before = await fullSessionRow(session);
    const ts = Math.floor(now / 1000);
    const s = await stepUpAtIdp(session, 'apr', { ts });
    const res = await finishStepUp(s, session);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/test/ap/payment-batches');

    // A new cookie: same tenant, new session id, new secret; the same attributes as at login.
    const fresh = rotatedCookie(res);
    expect(fresh).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(fresh.split('.')[0]).toBe(A);
    expect(sessionIdOf(fresh)).not.toBe(sessionIdOf(session));
    expect(fresh.split('.')[2]).not.toBe(session.split('.')[2]);
    const setCookie = setCookies(res).find((c) => c.startsWith('lf_session=')) ?? '';
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//i);

    // The old cookie is refused everywhere, also on member routes.
    const oldMe = await call('GET', '/auth/me', session);
    expect(oldMe.status).toBe(401);
    expect(await oldMe.json()).toEqual({ error: 'session_expired' });
    const oldRelease = await call('POST', '/test/ap/payment-batches/r-135a/release', session);
    expect(oldRelease.status).toBe(401);
    expect(done.releases).not.toContain('r-135a');

    // The new cookie carries the fresh step-up.
    expect((await call('GET', '/auth/me', fresh)).status).toBe(200);
    expect((await call('POST', '/test/ap/payment-batches/r-135a/release', fresh)).status).toBe(200);
    expect(done.releases).toContain('r-135a');

    // Nothing deleted: the old row is revoked as 'rotated'; the new row keeps the user, the
    // absolute expiry (no lifetime extension), the idle timeout and the revoke-all epoch.
    expect(await fullSessionRow(session)).toEqual({
      ...before,
      revoked_at: expect.any(Date) as Date,
      revoke_reason: 'rotated',
    });
    expect(await fullSessionRow(fresh)).toEqual({
      ...before,
      revoked_at: null,
      revoke_reason: null,
    });
    expect((await sessionRow(fresh)).auth_time).toEqual(new Date(ts * 1000));
  });

  it('SS-PLAT-135 the rotated session keeps the 12-hour cap and the revoke-all epoch; logout ends it', async () => {
    const a = await login('apr');
    now += 10 * MIN;
    const s1 = await stepUpAtIdp(a, 'apr');
    const fa = rotatedCookie(await finishStepUp(s1, a));
    const cap = (await fullSessionRow(a)).absolute_expires_at.getTime();
    // Keep the idle timer alive just before the cap, so only the (carried) cap can refuse.
    now = cap - 1000;
    await tdb.admin.query('UPDATE app.session SET last_seen_at = $2 WHERE id = $1', [
      sessionIdOf(fa),
      new Date(now),
    ]);
    expect((await call('GET', '/auth/me', fa)).status).toBe(200);
    now = cap;
    const capped = await call('GET', '/auth/me', fa);
    expect(capped.status).toBe(401);
    expect(await capped.json()).toEqual({ error: 'session_expired' });

    now = Date.now();
    const b = await login('apr');
    now += 10 * MIN;
    const s2 = await stepUpAtIdp(b, 'apr');
    const fb = rotatedCookie(await finishStepUp(s2, b));
    expect((await call('GET', '/auth/me', fb)).status).toBe(200);
    if (!api.sessions) throw new Error('sessions not configured');
    await api.sessions.revokeAll(A, PEOPLE.apr.id, 'test');
    expect((await call('GET', '/auth/me', fb)).status).toBe(401);

    const c = await login('apr');
    now += 10 * MIN;
    const s3 = await stepUpAtIdp(c, 'apr');
    const fc = rotatedCookie(await finishStepUp(s3, c));
    expect((await call('POST', '/auth/logout', fc)).status).toBe(204);
    expect((await call('GET', '/auth/me', fc)).status).toBe(401);
    expect((await call('GET', '/auth/me', c)).status).toBe(401);
  });

  it('SS-PLAT-135 a refused step-up issues no cookie and the old session keeps working unchanged', async () => {
    const session = await login('apr');
    now += 10 * MIN;
    await call('GET', '/auth/me', session); // the idle touch happens here, not in the checks below
    const before = await fullSessionRow(session);
    const refusals: [Who, IdpLogin][] = [
      ['other', {}],
      ['apr', { amr: ['pwd'], acr: PWD }],
    ];
    for (const [who, how] of refusals) {
      const s = await stepUpAtIdp(session, who, how);
      const res = await finishStepUp(s, session);
      expect(res.status).toBe(403);
      expect(cookieValue(res, 'lf_session')).toBeUndefined();
    }
    expect(await fullSessionRow(session)).toEqual(before);
    expect((await call('GET', '/auth/me', session)).status).toBe(200);
  });
});

describe('SS-PLAT-136: Rotation under concurrency fails closed', () => {
  it('SS-PLAT-136 a concurrent request with the old cookie during rotation fails closed (401), never with elevated rights', async () => {
    const session = await login('apr');
    now += 10 * MIN; // pre-step-up auth_time is stale; beginning the step-up touches last_seen_at
    const s = await stepUpAtIdp(session, 'apr');
    // Hold the old session row so the callback's rotation is caught half-way, uncommitted.
    const blocker = await tdb.admin.connect();
    let callback: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM app.session WHERE id = $1 FOR UPDATE', [
        sessionIdOf(session),
      ]);
      callback = finishStepUp(s, session);
      await untilLockWait();

      const during = await call('POST', '/test/ap/payment-batches/r-136a/release', session);
      expect(during.status).toBe(401);
      expect(await during.json()).toEqual({ error: 'step_up_required', max_age: 300 });
      expect(done.releases).not.toContain('r-136a');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    if (!callback) throw new Error('callback not started');
    const back = await callback;
    expect(back.status).toBe(303);
    const fresh = rotatedCookie(back);

    const after = await call('POST', '/test/ap/payment-batches/r-136a/release', session);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: 'session_expired' });
    expect(done.releases).not.toContain('r-136a');
    expect((await call('POST', '/test/ap/payment-batches/r-136a/release', fresh)).status).toBe(200);
  });

  it('SS-PLAT-136 requests racing the callback with the old cookie never get the fresh step-up', async () => {
    const session = await login('apr');
    now += 10 * MIN;
    const s = await stepUpAtIdp(session, 'apr');
    const racers = Array.from({ length: 12 }, (_, i) =>
      call('POST', `/test/ap/payment-batches/r-136b-${String(i)}/release`, session),
    );
    const [back, ...answers] = await Promise.all([finishStepUp(s, session), ...racers]);
    expect(back.status).toBe(303);
    for (const a of answers) expect(a.status).toBe(401);
    expect(done.releases.filter((r) => r.startsWith('r-136b-'))).toEqual([]);
    const late = await call('POST', '/test/ap/payment-batches/r-136b-late/release', session);
    expect(late.status).toBe(401);
    expect(done.releases).not.toContain('r-136b-late');
  });
});
