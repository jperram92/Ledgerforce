/**
 * CSRF guard (T-0144, ADR-0076, DL-0477 item 7, RQ-0141 F6–F8; OWASP CSRF Prevention Cheat Sheet).
 * Cookie-authenticated unsafe requests must prove they are same-origin. A request passes with
 * Sec-Fetch-Site same-origin or none, or, without Fetch Metadata, with an Origin equal to the public
 * origin. Anything else is 403 csrf_rejected, and the handler never runs. Requests without the
 * session cookie (Bearer tokens, webhooks) and safe methods are not inspected. Runs against a real
 * PostgreSQL as lf_app. The probe route is POST /ar/parties/:id/reminder-pause, which writes one row
 * when it runs.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const PUBLIC_ORIGIN = 'https://books.example.test';
let f: LedgerFixture;
let api: Api;
let party = '';
let cookie = '';
const clerk = randomUUID();

const rows = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.ar_reminder_pause WHERE tenant_id = $1',
      [f.tenantId],
    )
  ).rows[0]?.n ?? 0;

function post(headers: Record<string, string>, withCookie = true) {
  return fetch(`${api.url}/ar/parties/${party}/reminder-pause`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(withCookie ? { cookie: `lf_session=${cookie}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ company_id: f.companyId, paused: true, reason: 'CSRF probe' }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014401');
  await f.admin.query(
    `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'clerk@csrf.test', 'Clerk', 'active')`,
    [clerk, f.tenantId],
  );
  await f.admin.query(
    `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'ar_clerk')`,
    [f.tenantId, clerk],
  );
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Csrf',
    billDate: '2026-11-01',
  });
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: {},
    security: { publicOrigin: PUBLIC_ORIGIN },
  });
  if (!api.sessions) throw new Error('sessions not configured');
  cookie = await api.sessions.create(f.tenantId, {
    userId: clerk,
    amr: ['pwd', 'otp'],
    acr: null,
    authTime: new Date(Date.now() - 30 * 60 * 1000),
  });
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0144: CSRF guard for cookie-authenticated writes (ADR-0076)', () => {
  it('AC-1 Sec-Fetch-Site cross-site or same-site → 403 csrf_rejected; nothing written', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await post({ 'sec-fetch-site': site });
      expect(r.status, site).toBe(403);
      expect(await r.json()).toEqual({ error: 'csrf_rejected' });
    }
    expect(await rows()).toBe(0);
  });

  it('AC-2 without Fetch Metadata, a foreign or null Origin is refused; the public origin passes', async () => {
    for (const origin of ['https://evil.example', 'null', `${PUBLIC_ORIGIN}.evil.example`]) {
      const r = await post({ origin });
      expect(r.status, origin).toBe(403);
    }
    expect(await rows()).toBe(0);
    const ok = await post({ origin: PUBLIC_ORIGIN });
    expect(ok.status).toBe(201);
    expect(await rows()).toBe(1);
  });

  it('AC-3 neither header → refused (fail-safe); same-origin Fetch Metadata → the handler runs', async () => {
    const r = await post({});
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'csrf_rejected' });
    expect(await rows()).toBe(1);
    // The party is paused now, so a second pause reaches the handler and is refused there (409).
    const same = await post({ 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(409);
  });

  it('AC-3 requests without the session cookie are not inspected (Bearer tokens, webhooks)', async () => {
    const r = await post({ authorization: 'Bearer lf_not_a_real_token' }, false);
    expect(r.status).not.toBe(403);
    expect(await r.json()).not.toEqual({ error: 'csrf_rejected' });
  });

  it('safe methods are not inspected', async () => {
    const r = await fetch(
      `${api.url}/ar/parties/${party}/reminder-pause?company_id=${f.companyId}`,
      {
        headers: { cookie: `lf_session=${cookie}`, 'sec-fetch-site': 'cross-site' },
      },
    );
    expect(r.status).toBe(200);
  });
});
