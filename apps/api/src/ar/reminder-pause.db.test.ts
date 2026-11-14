/**
 * POST /ar/parties/:id/reminder-pause and GET /ar/parties/:id/reminder-pause (T-0129, SS-UC04-07,
 * UC-04 "AR Clerk can pause reminders per party (audited)") against a real PostgreSQL as lf_app.
 * The route requires ar.dunning.run and an Idempotency-Key. Replays answer 200 with the same row.
 * Each pause or resume leaves one audit.audit_log row. lf_app can only INSERT there, so the test
 * reads it as the admin.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let api: Api;
let party = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  sales: { id: randomUUID(), roles: ['sales_user'] },
};

function post(who: string, body: unknown, key?: string) {
  const c = cookies.get(who);
  return fetch(`${api.url}/ar/parties/${party}/reminder-pause`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(c ? { cookie: `lf_session=${c}`, 'sec-fetch-site': 'same-origin' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}
function get(who: string) {
  const c = cookies.get(who);
  return fetch(`${api.url}/ar/parties/${party}/reminder-pause?company_id=${f.companyId}`, {
    headers: c ? { cookie: `lf_session=${c}`, 'sec-fetch-site': 'same-origin' } : {},
  });
}
const audits = async () =>
  (
    await f.admin.query<{ action: string; actor_user_id: string; entity_type: string }>(
      `SELECT action, actor_user_id::text, entity_type FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'ar_reminder_pause' ORDER BY id`,
      [f.tenantId],
    )
  ).rows;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012902');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@pause.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Paused',
    billDate: '2026-11-01',
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC04-07: pause and resume reminders over HTTP', () => {
  it('refuses without ar.dunning.run (403) and records nothing', async () => {
    const r = await post(
      'sales',
      { company_id: f.companyId, paused: true, reason: 'Dispute' },
      'k-sales',
    );
    expect(r.status).toBe(403);
    expect(await audits()).toEqual([]);
  });

  it('requires an Idempotency-Key (400) and a reason (422)', async () => {
    expect(
      (await post('arClerk', { company_id: f.companyId, paused: true, reason: 'Dispute' })).status,
    ).toBe(400);
    const r = await post('arClerk', { company_id: f.companyId, paused: true, reason: ' ' }, 'k-0');
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'REASON_REQUIRED' });
  });

  it('the AR Clerk pauses (201, audited); a replay answers 200 with the same row', async () => {
    const r = await post(
      'arClerk',
      { company_id: f.companyId, paused: true, reason: 'Disputed invoice' },
      'k-1',
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      party_id: party,
      paused: true,
      reason: 'Disputed invoice',
      set_by: people['arClerk']?.id,
      replayed: false,
    });
    const replay = await post(
      'arClerk',
      { company_id: f.companyId, paused: true, reason: 'Disputed invoice' },
      'k-1',
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: body['id'], replayed: true });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: people['arClerk']?.id });
  });

  it('a second pause is a conflict (409); resume is 201 and audited; GET shows the history', async () => {
    const again = await post(
      'arClerk',
      { company_id: f.companyId, paused: true, reason: 'Again' },
      'k-2',
    );
    expect(again.status).toBe(409);
    const resume = await post(
      'arClerk',
      { company_id: f.companyId, paused: false, reason: 'Settled' },
      'k-3',
    );
    expect(resume.status).toBe(201);
    expect(await audits()).toHaveLength(2);
    const h = await get('arClerk');
    expect(h.status).toBe(200);
    const view = (await h.json()) as { paused: boolean; history: { reason: string }[] };
    expect(view.paused).toBe(false);
    expect(view.history.map((x) => x.reason)).toEqual(['Disputed invoice', 'Settled']);
  });
});
