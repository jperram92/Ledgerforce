/**
 * Payment batch confirmation on the real route (T-0057, UC-06 step 5, GP-009, DL-0304):
 * POST /ap/payment-batches/:id/confirm?company_id= records the bank's confirmation of a released
 * batch, posts its GP-009 journal and writes the `ledger.entry.posted` outbox event (which drives
 * the remittance advices) in the same transaction. It needs ap.payment_batch.release, is
 * idempotent (a repeat returns the first confirmation, replayed) and audited; a draft batch is
 * refused with NOT_CONFIRMABLE, an AP Clerk with 403, and without the posting queue it answers 503
 * (nothing posts without the event that sends the remittances). Real PostgreSQL as lf_app, real
 * sessions, real pg-boss outbox.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedPayablesCompany, type PayablesFixture } from '@ledgerforce/ap/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { ledgerOutbox } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let api: Api;
let noQueue: Api;
let outboxHarness: OutboxHarness;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  apClerk: { id: randomUUID(), roles: ['ap_clerk'] },
  releaser: { id: randomUUID(), roles: ['approver'] },
  treasurer: { id: randomUUID(), roles: ['approver'] },
};

async function call(method: string, path: string, who: string, body?: unknown, on: Api = api) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${on.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005704');
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@confirm.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  p = await seedPayablesCompany(f);
  outboxHarness = await createOutboxHarness(f.tdb);
  const boss = await outboxHarness.startRuntime();
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: {},
    postingOutbox: ledgerOutbox(boss),
  });
  noQueue = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const who of Object.keys(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: people[who]?.id ?? '',
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (noQueue as Api | undefined)?.close();
  await (api as Api | undefined)?.close();
  await (outboxHarness as OutboxHarness | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const q = () => `company_id=${f.companyId}`;
const build = async (id: string, date: string) => {
  const res = await call('PUT', `/ap/payment-batches/${id}`, 'apClerk', {
    company_id: f.companyId,
    payment_date: date,
    due_by: date,
    account_id: f.acct['1010'],
  });
  expect(res.status).toBe(201);
};
const confirm = (id: string, who: string, body: unknown, on: Api = api) =>
  call('POST', `/ap/payment-batches/${id}/confirm?${q()}`, who, body, on);

describe('SS-UC06-07: Batch posts GP-009 on confirmation only', () => {
  it('SS-UC06-07 a releaser records the bank confirmation: GP-009 posts once with its outbox event, audited', async () => {
    const s = await p.addSupplier('Harbour Paper Co', 72);
    await p.postBill(s, 'HP-1', '2750.00', '2026-11-27');
    const id = randomUUID();
    await build(id, '2026-11-27');

    // Draft: refused, nothing posted.
    const early = await confirm(id, 'treasurer', { confirmed_on: '2026-11-28' });
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ error: 'NOT_CONFIRMABLE' });

    expect(
      (await call('POST', `/ap/payment-batches/${id}/release?${q()}`, 'releaser')).status,
    ).toBe(200);
    const released = await call('GET', `/ap/payment-batches/${id}?${q()}`, 'treasurer');
    expect(await released.json()).toMatchObject({ status: 'released', confirmation: null });

    // An AP Clerk cannot confirm; bad input is refused; no queue → 503.
    expect((await confirm(id, 'apClerk', { confirmed_on: '2026-11-28' })).status).toBe(403);
    expect((await confirm(id, 'treasurer', {})).status).toBe(400);
    const before = await confirm(id, 'treasurer', { confirmed_on: '2026-11-26' });
    expect(before.status).toBe(422);
    expect(await before.json()).toMatchObject({ error: 'INVALID_BATCH' });
    const unqueued = await confirm(id, 'treasurer', { confirmed_on: '2026-11-28' }, noQueue);
    expect(unqueued.status).toBe(503);
    expect(await unqueued.json()).toMatchObject({ error: 'queue_not_configured' });
    const none = await f.admin.query(
      `SELECT 1 FROM app.journal_entry WHERE tenant_id = $1 AND source_type = 'ap_payment'`,
      [f.tenantId],
    );
    expect(none.rows).toHaveLength(0);

    const res = await confirm(id, 'treasurer', {
      confirmed_on: '2026-11-28',
      bank_reference: 'CBA-20261128-001',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry_id: string };
    expect(body).toMatchObject({
      batch_id: id,
      confirmed_on: '2026-11-28',
      bank_reference: 'CBA-20261128-001',
      confirmed_by: people['treasurer']?.id,
      replayed: false,
      payments: [{ party_id: s, amount: '2750.0000' }],
      remittance_missing: [s],
    });
    const lines = await f.admin.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::text, l.credit::text FROM app.journal_line l
         JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.line_no`,
      [body.entry_id],
    );
    expect(lines.rows).toEqual([
      { code: '2000', debit: '2750.0000', credit: '0.0000' },
      { code: '1010', debit: '0.0000', credit: '2750.0000' },
    ]);
    const events = await f.admin.query<{ topic: string; source: string }>(
      `SELECT topic, payload->>'sourceType' AS source FROM app.outbox_event
        WHERE tenant_id = $1 AND aggregate_id = $2`,
      [f.tenantId, body.entry_id],
    );
    expect(events.rows).toEqual([{ topic: 'ledger.entry.posted', source: 'ap_payment' }]);

    const again = await confirm(id, 'treasurer', { confirmed_on: '2026-11-29' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      entry_id: body.entry_id,
      confirmed_on: '2026-11-28',
      replayed: true,
    });
    const got = await call('GET', `/ap/payment-batches/${id}?${q()}`, 'treasurer');
    expect(await got.json()).toMatchObject({
      status: 'released',
      confirmation: { entry_id: body.entry_id, confirmed_on: '2026-11-28' },
    });

    const audit = await f.admin.query<{ action: string; entity_id: string; after: unknown }>(
      `SELECT action, entity_id::text, after FROM audit.audit_log
        WHERE tenant_id = $1 AND action LIKE 'POST %/confirm' AND entity_id IS NOT NULL
        ORDER BY occurred_at`,
      [f.tenantId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'POST /ap/payment-batches/:id/confirm',
        entity_id: id,
        after: {
          entry_id: body.entry_id,
          confirmed_on: '2026-11-28',
          bank_reference: 'CBA-20261128-001',
          total: '2750.0000',
        },
      },
    ]);
  });
});
