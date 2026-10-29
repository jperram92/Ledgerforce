/**
 * SS-PLAT-41, SS-PLAT-42 and the login part of SS-PLAT-20: OIDC login per ADR-0016 (T-0011).
 *
 * The IdP is a real OpenID Provider (`oidc-provider`, OpenID Certified) running in-process on
 * 127.0.0.1, so discovery, the authorization code flow with PKCE, the token exchange and ID-token
 * signatures are all real (RQ-0015, RQ-0020). Its signing keys are generated at runtime. The test
 * decides who logs in, and with which amr/acr, through the interaction handler.
 *
 * Login:    GET /t/:slug/auth/login → 302 to the IdP + cookie lf_oidc=<tenant_id>.<state>
 * Callback: GET /auth/callback?code&state&iss → 303 to / + cookie lf_session (ADR-0016)
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider from 'oidc-provider';
import { sql } from 'kysely';
import { withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000002aa';
const B = '01900000-0000-7000-8000-0000000002bb';
const SUSPENDED = '01900000-0000-7000-8000-0000000002cc';
const NO_SLUG = '01900000-0000-7000-8000-0000000002dd';
const PRIYA = '01900000-0000-7000-8000-00000000a201'; // tenant A, invited, sub-priya
const DAN = '01900000-0000-7000-8000-00000000a202'; // tenant A, disabled, sub-dan
const OMAR = '01900000-0000-7000-8000-00000000b201'; // tenant B, active, sub-omar
const STRANGER = '01900000-0000-7000-8000-00000000a203'; // tenant A, sub-stranger at another issuer

const CLIENT_ID = 'ledgerforce-test';
const CLIENT_SECRET = randomBytes(24).toString('base64url'); // runtime only, never committed
const MFA = 'urn:ledgerforce:loa:mfa';
const MIN = 60_000;

let now = Date.now();
const clock = { now: () => new Date(now) };

let tdb: TestDatabase;
let api: Api;
let idp: http.Server;
let issuer: string;
/** Who the test IdP logs in at the next interaction. */
let nextLogin: { sub: string; amr: string[]; acr: string } = { sub: '', amr: [], acr: '' };

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

function cookieAttributes(res: Response, name: string): string[] {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`)) ?? '';
  return c
    .split(';')
    .slice(1)
    .map((s) => s.trim().toLowerCase());
}

async function startLogin(slug: string): Promise<{ res: Response; authorize: URL; oidc: string }> {
  const res = await fetch(`${api.url}/t/${slug}/auth/login`, { redirect: 'manual' });
  const location = res.headers.get('location') ?? '';
  return { res, authorize: new URL(location, api.url), oidc: cookieValue(res, 'lf_oidc') ?? '' };
}

/** Drives the IdP (cookie jar, manual redirects) until it redirects back to the API. */
async function authenticateAtIdp(
  authorize: URL,
  who: { sub: string; amr?: string[]; acr?: string },
): Promise<URL> {
  nextLogin = { sub: who.sub, amr: who.amr ?? ['pwd', 'otp'], acr: who.acr ?? MFA };
  const jar = new Map<string, string>();
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

function callback(url: URL, oidcCookie: string | undefined): Promise<Response> {
  return fetch(url, {
    redirect: 'manual',
    headers: oidcCookie === undefined ? {} : { cookie: `lf_oidc=${oidcCookie}` },
  });
}

async function login(
  slug: string,
  who: { sub: string; amr?: string[]; acr?: string },
): Promise<Response> {
  const start = await startLogin(slug);
  const back = await authenticateAtIdp(start.authorize, who);
  return callback(back, start.oidc);
}

async function sessionCount(tenant: string): Promise<number> {
  const { rows } = await tdb.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.session WHERE tenant_id = $1',
    [tenant],
  );
  return rows[0]?.n ?? -1;
}

const sha256b64url = (s: string): string => createHash('sha256').update(s).digest('base64url');

// ---------------------------------------------------------------------------------------------
// set-up: database, test IdP, API

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });

  idp = http.createServer();
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;

  for (const [id, name, slug, status] of [
    [A, 'Harbour & Co Pty Ltd', 'harbour', 'active'],
    [B, 'Other Pty Ltd', 'other', 'active'],
    [SUSPENDED, 'Dormant Pty Ltd', 'dormant', 'suspended'],
    [NO_SLUG, 'Legacy Pty Ltd', null, 'active'],
  ] as const) {
    await tdb.admin.query('INSERT INTO app.tenant (id, name, slug, status) VALUES ($1,$2,$3,$4)', [
      id,
      name,
      slug,
      status,
    ]);
  }
  for (const [id, tenant, email, name, sub, iss, status] of [
    [PRIYA, A, 'priya@harbour.test', 'Priya Shah', 'sub-priya', 'ISSUER', 'invited'],
    [DAN, A, 'dan@harbour.test', 'Dan Leaver', 'sub-dan', 'ISSUER', 'disabled'],
    [OMAR, B, 'omar@other.test', 'Omar Other', 'sub-omar', 'ISSUER', 'active'],
    [
      STRANGER,
      A,
      'x@harbour.test',
      'Elsewhere',
      'sub-stranger',
      'https://other-idp.test',
      'active',
    ],
  ] as const) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, idp_subject, idp_issuer, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenant, email, name, sub, iss === 'ISSUER' ? issuer : iss, status],
    );
  }

  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: { clock },
    oidc: { issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowInsecureIssuer: true },
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
    acrValues: [MFA, 'urn:ledgerforce:loa:pwd'],
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
      void provider.interactionFinished(
        req,
        res,
        { login: { accountId: nextLogin.sub, amr: nextLogin.amr, acr: nextLogin.acr } },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    handle(req, res);
  });
});

afterAll(async () => {
  // Optional chaining: a failed set-up must still report its own error, not one from here.
  await (api as Api | undefined)?.close();
  await new Promise((resolve) => (idp as http.Server | undefined)?.close(resolve) ?? resolve(0));
  await (tdb as TestDatabase | undefined)?.close();
});

beforeEach(() => {
  now = Date.now();
});

// ---------------------------------------------------------------------------------------------

describe('SS-PLAT-41: OIDC login creates a session for an invited user (PKCE, state, nonce)', () => {
  it('login redirects to the IdP with code + PKCE S256 + state + nonce, kept server-side and bound to the browser', async () => {
    const { res, authorize, oidc } = await startLogin('harbour');
    expect(res.status).toBe(302);
    expect(authorize.origin).toBe(issuer);
    const p = authorize.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(`${api.url}/auth/callback`);
    expect(p.get('scope')?.split(' ')).toContain('openid');
    expect(p.get('code_challenge_method')).toBe('S256');
    const state = p.get('state') ?? '';
    const nonce = p.get('nonce') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(oidc).toBe(`${A}.${state}`);
    expect(cookieAttributes(res, 'lf_oidc')).toEqual(
      expect.arrayContaining(['httponly', 'samesite=lax', 'path=/auth', 'max-age=600']),
    );

    const { rows } = await tdb.admin.query<{
      tenant_id: string;
      nonce: string;
      code_verifier: string;
      ttl: number;
      consumed_at: Date | null;
    }>(
      `SELECT tenant_id, nonce, code_verifier, consumed_at,
              extract(epoch FROM expires_at - created_at)::int AS ttl
         FROM app.auth_request WHERE state = $1`,
      [state],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.tenant_id).toBe(A);
    expect(row?.nonce).toBe(nonce);
    expect(sha256b64url(row?.code_verifier ?? '')).toBe(p.get('code_challenge'));
    expect(row?.ttl).toBe(600);
    expect(row?.consumed_at).toBeNull();
  });

  it('the callback for an invited user creates a session cookie (HttpOnly, SameSite=Lax, Path=/) and /auth/me works', async () => {
    const before = await sessionCount(A);
    const res = await login('harbour', { sub: 'sub-priya' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const session = cookieValue(res, 'lf_session') ?? '';
    expect(session.startsWith(`${A}.`)).toBe(true);
    const attrs = cookieAttributes(res, 'lf_session');
    expect(attrs).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
    expect(attrs).not.toContain('secure'); // http://127.0.0.1 only; https public URLs get Secure
    expect(cookieValue(res, 'lf_oidc')).toBe(''); // the pre-auth cookie is cleared
    expect(await sessionCount(A)).toBe(before + 1);

    const me = await fetch(`${api.url}/auth/me`, { headers: { cookie: `lf_session=${session}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ tenant_id: A, user_id: PRIYA, display_name: 'Priya Shah' });

    // First login completes the invitation (design §6.3 joiner flow) and is audited.
    const user = await tdb.admin.query('SELECT status FROM app.app_user WHERE id = $1', [PRIYA]);
    expect(user.rows).toEqual([{ status: 'active' }]);
    const audit = await tdb.admin.query(
      `SELECT actor_type, actor_user_id, action, entity_type FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'login' ORDER BY occurred_at DESC LIMIT 1`,
      [A],
    );
    expect(audit.rows).toEqual([
      { actor_type: 'user', actor_user_id: PRIYA, action: 'login', entity_type: 'session' },
    ]);
  });

  it('nonce: an ID token whose nonce differs from the stored one is refused (400), no session', async () => {
    const start = await startLogin('harbour');
    const state = start.authorize.searchParams.get('state');
    await tdb.admin.query('UPDATE app.auth_request SET nonce = $1 WHERE state = $2', [
      randomBytes(32).toString('base64url'),
      state,
    ]);
    const before = await sessionCount(A);
    const back = await authenticateAtIdp(start.authorize, { sub: 'sub-priya' });
    const res = await callback(back, start.oidc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'login_failed' });
    expect(cookieValue(res, 'lf_session')).toBeUndefined();
    expect(await sessionCount(A)).toBe(before);
  });

  it('PKCE: a code redeemed with the wrong verifier is refused (400), no session', async () => {
    const start = await startLogin('harbour');
    const state = start.authorize.searchParams.get('state');
    await tdb.admin.query('UPDATE app.auth_request SET code_verifier = $1 WHERE state = $2', [
      randomBytes(32).toString('base64url'),
      state,
    ]);
    const before = await sessionCount(A);
    const back = await authenticateAtIdp(start.authorize, { sub: 'sub-priya' });
    const res = await callback(back, start.oidc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'login_failed' });
    expect(await sessionCount(A)).toBe(before);
  });

  it('app.tenant_id_for_slug returns only an id, and lf_app still cannot read other tenants', async () => {
    const lookup = async (slug: string) =>
      (
        await sql<{ id: string | null }>`SELECT app.tenant_id_for_slug(${slug}) AS id`.execute(
          tdb.app,
        )
      ).rows[0]?.id ?? null;
    expect(await lookup('harbour')).toBe(A);
    expect(await lookup('HARBOUR')).toBe(A); // slugs are lower case; lookup is case-insensitive
    expect(await lookup('other')).toBe(B);
    expect(await lookup('nope')).toBeNull();
    expect(await lookup('dormant')).toBeNull(); // suspended tenants cannot log in

    const fn = await tdb.admin.query<{
      definer: boolean;
      owner: string;
      returns: string;
      config: string[] | null;
      public_exec: boolean;
      app_exec: boolean;
    }>(
      `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
              format_type(p.prorettype, NULL) AS returns, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('lf_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.oid = 'app.tenant_id_for_slug(text)'::regprocedure`,
    );
    expect(fn.rows).toEqual([
      {
        definer: true,
        owner: 'lf_migrator',
        returns: 'uuid',
        config: ['search_path=pg_catalog, pg_temp'],
        public_exec: false,
        app_exec: true,
      },
    ]);

    // Without a tenant context lf_app sees no tenant rows; inside A it sees only A.
    const none = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.tenant`.execute(
      tdb.app,
    );
    expect(none.rows[0]?.n).toBe(0);
    const own = await withTenant(tdb.app, A, (trx) =>
      sql<{ id: string; slug: string }>`SELECT id, slug FROM app.tenant ORDER BY id`.execute(trx),
    );
    expect(own.rows).toEqual([{ id: A, slug: 'harbour' }]);
  });
});

describe('SS-PLAT-42: Login refuses unknown users, replayed or expired state and unknown tenants', () => {
  it('an authenticated but unknown subject gets 403 and no session (no just-in-time accounts)', async () => {
    const before = await sessionCount(A);
    const res = await login('harbour', { sub: 'sub-nobody' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_invited' });
    expect(cookieValue(res, 'lf_session')).toBeUndefined();
    expect(await sessionCount(A)).toBe(before);
    const users = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM app.app_user WHERE idp_subject = 'sub-nobody'`,
    );
    expect(users.rows).toEqual([{ n: 0 }]);
  });

  it("another tenant's user, a user at another issuer, or a disabled user gets 403", async () => {
    const before = await sessionCount(A);
    for (const sub of ['sub-omar', 'sub-stranger', 'sub-dan']) {
      const res = await login('harbour', { sub });
      expect(res.status, sub).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_invited' });
    }
    expect(await sessionCount(A)).toBe(before);
  });

  it('a replayed callback (state already used) gets 400 and creates no second session', async () => {
    const start = await startLogin('harbour');
    const back = await authenticateAtIdp(start.authorize, { sub: 'sub-priya' });
    const first = await callback(back, start.oidc);
    expect(first.status).toBe(303);
    const before = await sessionCount(A);
    const replay = await callback(back, start.oidc);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'invalid_request' });
    expect(cookieValue(replay, 'lf_session')).toBeUndefined();
    expect(await sessionCount(A)).toBe(before);
  });

  it('a state older than 10 minutes gets 400 and no session', async () => {
    const start = await startLogin('harbour');
    const back = await authenticateAtIdp(start.authorize, { sub: 'sub-priya' });
    now += 10 * MIN + 1000;
    const before = await sessionCount(A);
    const res = await callback(back, start.oidc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(await sessionCount(A)).toBe(before);
  });

  it('a callback without the browser binding, with another login’s cookie, or with a forged tenant gets 400', async () => {
    const before = await sessionCount(A);
    const start = await startLogin('harbour');
    const back = await authenticateAtIdp(start.authorize, { sub: 'sub-priya' });
    const other = await startLogin('harbour'); // e.g. the attacker's own pre-auth cookie
    const forged = `${B}.${start.authorize.searchParams.get('state') ?? ''}`;
    for (const cookie of [undefined, other.oidc, forged, 'garbage']) {
      const res = await callback(back, cookie);
      expect(res.status, String(cookie)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
    expect(await sessionCount(A)).toBe(before);
    expect(await sessionCount(B)).toBe(0);
    // The untouched pre-auth record still works for its own browser: nothing above consumed it.
    expect((await callback(back, start.oidc)).status).toBe(303);
  });

  it('an unknown, suspended, slug-less or malformed tenant slug gets the same 404, with nothing leaked', async () => {
    const bodies = new Set<string>();
    for (const slug of ['nope', 'dormant', 'Not_A-Slug!', encodeURIComponent('harbour ')]) {
      const res = await fetch(`${api.url}/t/${slug}/auth/login`, { redirect: 'manual' });
      expect(res.status, slug).toBe(404);
      expect(res.headers.get('location')).toBeNull();
      expect(setCookies(res)).toEqual([]);
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: 'not_found' })]);
    const pending = await tdb.admin.query(
      'SELECT count(*)::int AS n FROM app.auth_request WHERE tenant_id = ANY($1)',
      [[SUSPENDED, NO_SLUG]],
    );
    expect(pending.rows).toEqual([{ n: 0 }]);
  });
});

describe('SS-PLAT-20: MFA and session policy for finance roles — login', () => {
  it('a session created by OIDC login stores amr/acr and follows the 30-min idle / 12-h absolute policy', async () => {
    const res = await login('harbour', { sub: 'sub-priya', amr: ['pwd', 'otp'], acr: MFA });
    expect(res.status).toBe(303);
    const cookie = cookieValue(res, 'lf_session') ?? '';
    const sid = cookie.split('.')[1];
    const { rows } = await tdb.admin.query<{
      amr: string[];
      acr: string;
      idle: number;
      absolute: number;
    }>(
      `SELECT amr, acr, idle_timeout_seconds AS idle,
              extract(epoch FROM absolute_expires_at - created_at)::int AS absolute
         FROM app.session WHERE id = $1`,
      [sid],
    );
    expect(rows).toEqual([{ amr: ['pwd', 'otp'], acr: MFA, idle: 1800, absolute: 43_200 }]);

    now += 31 * MIN;
    const me = await fetch(`${api.url}/auth/me`, { headers: { cookie: `lf_session=${cookie}` } });
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: 'session_expired' });
  });

  it('a password-only login is captured as such, so T-0013 can demand MFA', async () => {
    const res = await login('harbour', {
      sub: 'sub-priya',
      amr: ['pwd'],
      acr: 'urn:ledgerforce:loa:pwd',
    });
    expect(res.status).toBe(303);
    const sid = (cookieValue(res, 'lf_session') ?? '').split('.')[1];
    const { rows } = await tdb.admin.query('SELECT amr, acr FROM app.session WHERE id = $1', [sid]);
    expect(rows).toEqual([{ amr: ['pwd'], acr: 'urn:ledgerforce:loa:pwd' }]);
  });
});

describe('SS-PLAT-71: A joiner whose role needs MFA is activated only by an MFA login', () => {
  const JOE = '01900000-0000-7000-8000-00000000a271'; // invited Accountant (MFA role)
  const ANA = '01900000-0000-7000-8000-00000000a272'; // invited AR Clerk (no MFA role)

  beforeAll(async () => {
    for (const [uid, sub, role] of [
      [JOE, 'sub-joe', 'accountant'],
      [ANA, 'sub-ana', 'ar_clerk'],
    ] as const) {
      await tdb.admin.query(
        `INSERT INTO app.app_user (id, tenant_id, email, display_name, idp_subject, idp_issuer, status)
         VALUES ($1, $2, $3, 'Joiner', $4, $5, 'invited')`,
        [uid, A, `${sub}@harbour.test`, sub, issuer],
      );
      await tdb.admin.query(
        `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
        [A, uid, role],
      );
    }
  });

  const statusOf = async (uid: string) =>
    (
      await tdb.admin.query<{ status: string }>('SELECT status FROM app.app_user WHERE id = $1', [
        uid,
      ])
    ).rows[0]?.status;
  const audit = async (uid: string) =>
    (
      await tdb.admin.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM audit.audit_log
          WHERE tenant_id = $1 AND actor_user_id = $2 AND action <> 'login' ORDER BY id`,
        [A, uid],
      )
    ).rows;

  it('a password-only first login is refused, the user stays invited, and the refusal is audited', async () => {
    const before = await sessionCount(A);
    const res = await login('harbour', {
      sub: 'sub-joe',
      amr: ['pwd'],
      acr: 'urn:ledgerforce:loa:pwd',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_enrolment_required' });
    expect(cookieValue(res, 'lf_session')).toBeUndefined();
    expect(await sessionCount(A)).toBe(before);
    expect(await statusOf(JOE)).toBe('invited');
    expect(await audit(JOE)).toEqual([
      { action: 'login_refused', after: { reason: 'mfa_enrolment_required' } },
    ]);
  });

  it('an MFA first login activates the user and writes the welcome audit event', async () => {
    const res = await login('harbour', { sub: 'sub-joe' });
    expect(res.status).toBe(303);
    expect(await statusOf(JOE)).toBe('active');
    expect(await audit(JOE)).toEqual([
      { action: 'login_refused', after: { reason: 'mfa_enrolment_required' } },
      { action: 'user.joined', after: { roles: ['accountant'], amr: ['pwd', 'otp'] } },
    ]);
  });

  it('a joiner whose roles need no MFA is activated by a password login', async () => {
    const res = await login('harbour', {
      sub: 'sub-ana',
      amr: ['pwd'],
      acr: 'urn:ledgerforce:loa:pwd',
    });
    expect(res.status).toBe(303);
    expect(await statusOf(ANA)).toBe('active');
    expect(await audit(ANA)).toEqual([
      { action: 'user.joined', after: { roles: ['ar_clerk'], amr: ['pwd'] } },
    ]);
  });
});
