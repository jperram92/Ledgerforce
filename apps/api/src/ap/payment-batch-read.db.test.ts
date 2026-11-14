/**
 * Reading payment batches for the release screen (T-0153, for T-0087; UC-06, design §6.5, §6.6):
 * the batch list and the batch view with names — supplier, bill number, creator, releaser — and
 * the payee's bank account masked to the last 3 digits. Read-only routes: `ap.read`, RLS-scoped.
 * Real PostgreSQL as lf_app, real sessions, real SoD and step-up on the release that is read back.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedPayablesCompany, type PayablesFixture } from '@ledgerforce/ap/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const OTHER_TENANT = '01900000-0000-7000-8000-0000000153b1';
let f: LedgerFixture;
let p: PayablesFixture;
let api: Api;
const cookies = new Map<string, string>();
const people = {
  clerk: { id: randomUUID(), roles: ['ap_clerk'], name: 'Casey Clerk' },
  releaser: { id: randomUUID(), roles: ['approver'], name: 'Riley Releaser' },
  arClerk: { id: randomUUID(), roles: ['ar_clerk'], name: 'Avery AR' },
} as const;
const outsider = { id: randomUUID(), roles: ['owner'], name: 'Olive Outsider' };

const call = (method: string, path: string, who: string) =>
  fetch(`${api.url}${path}`, {
    method,
    headers: { cookie: `lf_session=${cookies.get(who) ?? ''}`, 'sec-fetch-site': 'same-origin' },
  });

let batchId: string;
let supplier: string;
let billId: string;
let heldBill: string;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-0000000153a1');
  await f.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [
    OTHER_TENANT,
    'Other Pty Ltd',
  ]);
  const all: [string, { id: string; roles: readonly string[]; name: string }, string][] = [
    ...Object.entries(people).map(([who, x]) => [who, x, f.tenantId] as [string, typeof x, string]),
    ['outsider', outsider, OTHER_TENANT],
  ];
  for (const [who, person, tenant] of all) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, tenant, `${who}@read.test`, person.name],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [tenant, person.id, role],
      );
    }
  }
  p = await seedPayablesCompany(f);
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  const sessions = api.sessions;
  if (!sessions) throw new Error('sessions not configured');
  for (const [who, person, tenant] of all) {
    cookies.set(
      who,
      await sessions.create(tenant, {
        userId: person.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
  supplier = await p.addSupplier('Paper Co Pty Ltd', 72);
  const recent = await p.addSupplier('Fresh Details Pty Ltd', 2);
  billId = await p.postBill(supplier, 'PC-1', '1250.50', '2026-11-20');
  heldBill = await p.postBill(recent, 'FD-1', '300.00', '2026-11-20');
  batchId = randomUUID();
  const built = await fetch(`${api.url}/ap/payment-batches/${batchId}`, {
    method: 'PUT',
    headers: {
      cookie: `lf_session=${cookies.get('clerk') ?? ''}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      company_id: f.companyId,
      payment_date: '2026-11-20',
      due_by: '2026-11-20',
      account_id: f.acct['1010'],
    }),
  });
  if (built.status !== 201) throw new Error(`batch not built: ${String(built.status)}`);
  const released = await call(
    'POST',
    `/ap/payment-batches/${batchId}/release?company_id=${f.companyId}`,
    'releaser',
  );
  if (released.status !== 200) throw new Error(`batch not released: ${String(released.status)}`);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const q = () => `company_id=${f.companyId}`;

describe('T-0153 AC-1: payment batches read for the release screen', () => {
  it('AC-1 lists the company batches with decimal-string totals, counts and releases [T-0153]', async () => {
    const res = await call('GET', `/ap/payment-batches?${q()}`, 'releaser');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      batches: [
        {
          id: batchId,
          batch_no: expect.stringMatching(/^PB-/),
          status: 'released',
          payment_date: '2026-11-20',
          total: '1250.5000',
          payment_count: 1,
          excluded_count: 1,
          releases_required: 1,
          release_count: 1,
          created_by_name: 'Casey Clerk',
          created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ],
    });
  });

  it('AC-1 the batch view names supplier, bill, creator and releaser and masks the account [T-0153]', async () => {
    const res = await call('GET', `/ap/payment-batches/${batchId}?${q()}`, 'releaser');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('100001');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({
      created_by: people.clerk.id,
      created_by_name: 'Casey Clerk',
      releases: [{ released_by: people.releaser.id, released_by_name: 'Riley Releaser' }],
      payments: [
        {
          bill_id: billId,
          bill_no: expect.stringMatching(/^BILL-/),
          party_id: supplier,
          party_name: 'Paper Co Pty Ltd',
          amount: '1250.5000',
          bank_account: { bsb: '062-000', account_number: '***001' },
        },
      ],
      excluded: [
        {
          bill_id: heldBill,
          bill_no: expect.stringMatching(/^BILL-/),
          party_name: 'Fresh Details Pty Ltd',
          amount: '300.0000',
          reason: 'BANK_DETAILS_COOLING_OFF',
        },
      ],
    });
  });

  it('AC-1 needs ap.read; another tenant sees no batch and gets 404; a bad company id is 400 [T-0153]', async () => {
    const denied = await call('GET', `/ap/payment-batches?${q()}`, 'arClerk');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'forbidden', permission: 'ap.read' });
    const list = await call('GET', `/ap/payment-batches?${q()}`, 'outsider');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ batches: [] });
    const view = await call('GET', `/ap/payment-batches/${batchId}?${q()}`, 'outsider');
    expect(view.status).toBe(404);
    expect(await view.json()).toMatchObject({ error: 'not_found' });
    expect((await call('GET', '/ap/payment-batches?company_id=nope', 'releaser')).status).toBe(400);
  });
});
