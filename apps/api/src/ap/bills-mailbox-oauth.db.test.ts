/**
 * SS-PLAT-192 — connect a Microsoft 365 / Google bills mailbox over HTTP (T-0216, ADR-0105 rules
 * 3–5, RQ-0187 F4, DL-0934). Real PostgreSQL as lf_app, real sessions, recorded token responses
 * (no network). Start needs settings.setup.manage + a fresh step-up + an Idempotency-Key and
 * answers a PKCE authorization URL; the callback is single use, expires after 10 minutes, belongs
 * to the starting user and session, saves the mailbox (superseding the old one), returns and audits
 * no secret, and redirects to Settings with a fixed outcome code.
 */
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { saveBillsMailbox, type MailboxOAuthConfig } from '@ledgerforce/ap';
import { recordedBody, recordedTokenFetch } from '@ledgerforce/ap/testing/oauth';
import { withTenant } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms, openField } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const TENANT = '01900000-0000-7000-8000-000000021611';
const OTHER_TENANT = '01900000-0000-7000-8000-000000021612';
const REDIRECT = 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback';
const MS_SECRET = 'ms-client-secret-for-tests';
const MS_REFRESH = String(recordedBody('microsoft_code').refresh_token);
const MS_ACCESS = String(recordedBody('microsoft_code').access_token);

let f: LedgerFixture;
let api: Api;
let bare: Api;
const tok = recordedTokenFetch();
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  fa2: { id: randomUUID(), roles: ['finance_admin'] },
  clerk: { id: randomUUID(), roles: ['accountant'] },
};

const oauth: MailboxOAuthConfig = {
  redirectUri: REDIRECT,
  microsoft: { clientId: 'ms-client-id', clientSecret: MS_SECRET },
  fetch: tok.fetch,
};

async function call(
  target: Api,
  method: string,
  path: string,
  who: string,
  body?: unknown,
  key: string | null = randomUUID(),
) {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key !== null && method !== 'GET') h['idempotency-key'] = key;
  return fetch(`${target.url}${path}`, {
    method,
    headers: h,
    redirect: 'manual',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(who: string, ageMinutes: number) {
  if (!api.sessions) throw new Error('sessions not configured');
  cookies.set(
    who,
    await api.sessions.create(f.tenantId, {
      userId: people[who]?.id ?? '',
      amr: ['pwd', 'otp'],
      acr: null,
      authTime: new Date(Date.now() - ageMinutes * 60 * 1000),
    }),
  );
}

async function stepUp(who: string) {
  const sessionId = cookies.get(who)?.split('.')[1] ?? '';
  await f.inTenant(
    (trx) =>
      api.sessions?.reauthenticateInTx(trx, sessionId, {
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }) ?? Promise.resolve(),
  );
}

const START = '/setup/bills-mailbox/oauth/start';
const startBody = (extra: Record<string, unknown> = {}) => ({
  company_id: f.companyId,
  provider: 'microsoft',
  username: 'bills@harbour.example',
  ...extra,
});

async function start(who = 'fa') {
  const res = await call(api, 'POST', START, who, startBody());
  expect(res.status).toBe(201);
  const body = (await res.json()) as { authorization_url: string; expires_at: string };
  const url = new URL(body.authorization_url);
  return { url, state: url.searchParams.get('state') ?? '', body };
}

const callback = (who: string, q: Record<string, string>) =>
  call(api, 'GET', `/setup/bills-mailbox/oauth/callback?${new URLSearchParams(q).toString()}`, who);

const mailboxes = async () =>
  (
    await f.admin.query<{
      id: string;
      status: string;
      auth_method: string;
      oauth_provider: string | null;
      host: string;
      username: string;
      password_ct: Buffer;
      password_iv: Buffer;
      password_tag: Buffer;
      password_dek_wrapped: Buffer;
      password_kek_id: string;
      password_enc_version: number;
    }>('SELECT * FROM app.bill_inbox_mailbox WHERE company_id = $1 ORDER BY created_at, id', [
      f.companyId,
    ])
  ).rows;

const auditRows = async (action: string) =>
  (
    await f.admin.query<{ actor_user_id: string; entity_id: string; after: unknown }>(
      'SELECT actor_user_id, entity_id, after FROM audit.audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id',
      [f.tenantId, action],
    )
  ).rows;

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@oauth.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  await withTenant(f.db, OTHER_TENANT, (trx) =>
    trx.insertInto('app.tenant').values({ id: OTHER_TENANT, name: 'Other Pty Ltd' }).execute(),
  );
  // An existing password mailbox the OAuth connection will supersede.
  await f.inTenant((trx) =>
    saveBillsMailbox(trx, kms, f.companyId, {
      host: 'imap.harbour.example',
      username: 'bills@harbour.example',
      password: 'old-password',
    }),
  );
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: {},
    kms,
    mailboxOAuth: oauth,
  });
  bare = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {}, kms });
  await login('fa', 30);
  await login('fa2', 30);
  await login('clerk', 1);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (bare as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-192: starting a mailbox connection', () => {
  it('SS-PLAT-192 needs a fresh step-up and settings.setup.manage; an Idempotency-Key; a valid body', async () => {
    const stale = await call(api, 'POST', START, 'fa', startBody());
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const clerk = await call(api, 'POST', START, 'clerk', startBody());
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toMatchObject({
      error: 'forbidden',
      permission: 'settings.setup.manage',
    });
    await stepUp('fa');
    await stepUp('fa2');
    const noKey = await call(api, 'POST', START, 'fa', startBody(), null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual({ error: 'idempotency_key_required' });
    for (const bad of [
      startBody({ provider: 'yahoo' }),
      startBody({ username: 'not an address' }),
      startBody({ folder: 'Bills\r\nX' }),
      startBody({ company_id: 'nope' }),
    ]) {
      const r = await call(api, 'POST', START, 'fa', bad);
      expect(r.status).toBe(400);
    }
    const other = await call(api, 'POST', START, 'fa', startBody({ company_id: OTHER_TENANT }));
    expect(other.status).toBe(404);
  });

  it('SS-PLAT-192 an unconfigured provider or server is 503 oauth_not_configured', async () => {
    const google = await call(api, 'POST', START, 'fa', startBody({ provider: 'google' }));
    expect(google.status).toBe(503);
    expect(await google.json()).toMatchObject({ error: 'oauth_not_configured' });
    const none = await call(bare, 'POST', START, 'fa', startBody());
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ error: 'oauth_not_configured' });
  });

  it('SS-PLAT-192 answers the provider authorization URL with PKCE S256 and state; stores only the state hash; audited without state or verifier', async () => {
    const res = await call(api, 'POST', START, 'fa', startBody({ folder: 'Bills' }));
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = JSON.parse(text) as {
      authorization_url: string;
      expires_at: string;
      provider: string;
    };
    const url = new URL(body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe('bills@harbour.example');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(text).not.toContain(MS_SECRET);
    const row = (
      await f.admin.query<{ state_sha256: string; code_verifier: string; folder: string }>(
        'SELECT state_sha256, code_verifier, folder FROM app.bill_inbox_oauth_request WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
        [f.tenantId],
      )
    ).rows[0];
    expect(row?.state_sha256).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row?.folder).toBe('Bills');
    expect(text).not.toContain(row?.code_verifier ?? 'missing');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(row?.code_verifier ?? '')
        .digest('base64url'),
    );
    const audits = await f.admin.query<{ entity_type: string; after: unknown }>(
      `SELECT entity_type, after FROM audit.audit_log WHERE tenant_id = $1 AND action LIKE 'POST %oauth/start' ORDER BY id DESC LIMIT 1`,
      [f.tenantId],
    );
    expect(audits.rows[0]?.entity_type).toBe('bill_inbox_oauth_request');
    const auditText = JSON.stringify(audits.rows[0]?.after);
    expect(auditText).not.toContain(state);
    expect(auditText).not.toContain(row?.code_verifier ?? 'missing');
  });
});

describe('SS-PLAT-192: the callback connects the mailbox once, for the same person', () => {
  it('SS-PLAT-192 another user’s or another session’s callback is refused and leaves the request usable; the owner connects: 303 to Settings, mailbox sealed, old one superseded, audited without secret', async () => {
    const { state } = await start('fa');
    const foreign = await callback('fa2', { state, code: 'code-1' });
    expect(foreign.status).toBe(303);
    expect(foreign.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
    expect(tok.seen).toHaveLength(0);
    // A different session of the same user is refused too.
    const otherSession = cookies.get('fa');
    await login('fa', 30);
    const sameUser = await callback('fa', { state, code: 'code-1' });
    expect(sameUser.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
    cookies.set('fa', otherSession ?? '');

    tok.queue('microsoft_code');
    const res = await callback('fa', { state, code: 'code-1' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/settings/bills-mailbox?mailbox=connected');
    const text = await res.text();
    expect(text).not.toContain(MS_REFRESH);
    expect(text).not.toContain(MS_ACCESS);
    expect(tok.seen).toHaveLength(1);
    expect(tok.seen[0]?.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
    });

    const rows = await mailboxes();
    expect(rows.map((r) => [r.status, r.auth_method])).toEqual([
      ['superseded', 'password'],
      ['active', 'oauth2'],
    ]);
    const active = rows[1];
    if (!active) throw new Error('no active mailbox');
    expect(active).toMatchObject({
      oauth_provider: 'microsoft',
      host: 'outlook.office365.com',
      username: 'bills@harbour.example',
    });
    expect(
      await openField(
        kms,
        {
          ciphertext: active.password_ct,
          iv: active.password_iv,
          tag: active.password_tag,
          wrappedDek: active.password_dek_wrapped,
          keyId: active.password_kek_id,
          version: active.password_enc_version,
        },
        `lf-field-v1|${f.tenantId}|${f.companyId}|app.bill_inbox_mailbox|${active.id}|refresh_token`,
      ),
    ).toBe(MS_REFRESH);

    const audit = await auditRows('ap.bills_mailbox.oauth_connected');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: people.fa?.id, entity_id: active.id });
    const auditText = JSON.stringify(audit[0]?.after);
    expect(auditText).toContain('outlook.office365.com');
    expect(auditText).not.toContain(MS_REFRESH);
    expect(auditText).not.toContain(MS_ACCESS);

    // Single use: the same callback again changes nothing and calls no provider.
    const replay = await callback('fa', { state, code: 'code-1' });
    expect(replay.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
    expect(tok.seen).toHaveLength(1);
    expect(await mailboxes()).toHaveLength(2);
  });

  it('SS-PLAT-192 an expired request (over 10 minutes) is refused without calling the provider', async () => {
    const { state } = await start('fa');
    await f.admin.query(
      `UPDATE app.bill_inbox_oauth_request
          SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
        WHERE state_sha256 = $1`,
      [createHash('sha256').update(state).digest('hex')],
    );
    const before = tok.seen.length;
    const res = await callback('fa', { state, code: 'code-2' });
    expect(res.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
    expect(tok.seen.length).toBe(before);
  });

  it('SS-PLAT-192 a refused consent, a refused code (invalid_grant) or a provider outage redirects with a fixed code; no mailbox changes; the request is used up', async () => {
    const count = (await mailboxes()).length;
    const a = await start('fa');
    const denied = await callback('fa', {
      state: a.state,
      error: 'access_denied',
      error_description: 'AADSTS65004: User declined to consent. bills@harbour.example',
    });
    expect(denied.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=access_denied',
    );
    const b = await start('fa');
    tok.queue('microsoft_invalid_grant');
    const refused = await callback('fa', { state: b.state, code: 'bad-code' });
    expect(refused.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=auth_failed',
    );
    const again = await callback('fa', { state: b.state, code: 'bad-code' });
    expect(again.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
    const c = await start('fa');
    tok.queue('server_error');
    const down = await callback('fa', { state: c.state, code: 'code-3' });
    expect(down.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=connect_failed',
    );
    expect((await mailboxes()).length).toBe(count);
  });

  it('SS-PLAT-192 the callback needs settings.setup.manage and a malformed one is invalid_request', async () => {
    const clerk = await callback('clerk', { state: 'x'.repeat(43), code: 'c' });
    expect(clerk.status).toBe(403);
    const missing = await callback('fa', { code: 'c' });
    expect(missing.headers.get('location')).toBe(
      '/settings/bills-mailbox?mailbox_error=invalid_request',
    );
  });
});
