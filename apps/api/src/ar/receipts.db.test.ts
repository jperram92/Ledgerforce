/**
 * Receipts over HTTP (T-0046, UC-03, DL-0274): the AR Clerk records a receipt allocated to an
 * invoice (idempotent), reads the invoice as Paid; an Auditor cannot record receipts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { approveInvoice, createDraftInvoice } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let api: Api;
let invoiceId = '';
let partyId = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  auditor: { id: randomUUID(), roles: ['auditor'] },
};

async function call(method: string, path: string, who: string, body?: unknown, key?: string) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  h['sec-fetch-site'] = 'same-origin';
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key) h['idempotency-key'] = key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004602');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@rcpt.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  const profiles = await seedBillingCompany(f);
  [partyId = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  invoiceId = await f.inTenant(async (trx) => {
    const outbox = { publish: async () => {} };
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox },
    );
    return (
      await approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox })
    ).invoiceId;
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

const receipt = () => ({
  company_id: f.companyId,
  party_id: partyId,
  receipt_date: '2026-11-15',
  amount: '1375.00',
  method: 'eft',
  deposit_to: { account_id: f.acct['1010'] },
  allocations: [{ invoice_id: invoiceId, amount: '1375.00' }],
});

describe('SS-UC03-07: receipts over HTTP', () => {
  it('an Auditor cannot record a receipt', async () => {
    const res = await call('POST', '/ar/receipts', 'auditor', receipt(), 'r-audit');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ar.receipt.record' });
  });

  it('SS-UC03-07 the AR Clerk records a full EFT receipt; the invoice reads Paid; a replay returns the same receipt', async () => {
    const res = await call('POST', '/ar/receipts', 'arClerk', receipt(), 'r-1');
    expect(res.status).toBe(201);
    const r = (await res.json()) as { id: string; unallocated: string };
    expect(r.unallocated).toBe('0.0000');
    const again = await call('POST', '/ar/receipts', 'arClerk', receipt(), 'r-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: r.id, replayed: true });
    const status = await call(
      'GET',
      `/ar/invoices/${invoiceId}/payment-status?company_id=${f.companyId}`,
      'auditor',
    );
    expect(await status.json()).toEqual({ status: 'paid', open: '0.0000' });
  });

  it('over-allocation is refused with 422 OVER_ALLOCATED', async () => {
    const res = await call(
      'POST',
      '/ar/receipts',
      'arClerk',
      { ...receipt(), amount: '10.00' },
      'r-2',
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'OVER_ALLOCATED' });
  });
});
