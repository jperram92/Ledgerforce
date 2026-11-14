/**
 * AR cash routes for the receipt allocation and credit-note screens (T-0151, split from T-0085,
 * UC-03, UC-11, DL-0490), real PostgreSQL (lf_app) and real sessions:
 *   GET  /ar/receipts?company_id=&unallocated=true         — ar.read
 *   POST /ar/receipts/:id/allocations  (Idempotency-Key)    — ar.receipt.record, replay-safe
 *   GET  /ar/credit-notes/:id/journal?company_id=           — ar.read, writes nothing
 * Permission denial is 403, another tenant's document is 404, money is a decimal string.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  approveInvoice,
  createCreditNote,
  createDraftInvoice,
  recordReceipt,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let invoiceId = '';
let receiptId = '';
let creditNoteId = '';
let foreignReceipt = '';
let foreignCreditNote = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  auditor: { id: randomUUID(), roles: ['auditor'] },
  apClerk: { id: randomUUID(), roles: ['ap_clerk'] },
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

/** A posted 1,375.00 invoice, an unallocated 1,375.00 receipt and a 220.00 draft credit note. */
async function seed(fx: LedgerFixture, prefix: string) {
  const profiles = await seedBillingCompany(fx);
  const [party = ''] = await seedBillableCustomers(fx, profiles, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return fx.inTenant(async (trx) => {
    const outbox = { publish: async () => {} };
    const d = await createDraftInvoice(
      trx,
      {
        companyId: fx.companyId,
        partyId: party,
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox },
    );
    const inv = await approveInvoice(
      trx,
      { companyId: fx.companyId, invoiceId: d.invoiceId },
      { outbox },
    );
    const r = await recordReceipt(trx, {
      companyId: fx.companyId,
      partyId: party,
      receiptDate: '2026-11-15',
      amount: '1375.00',
      method: 'eft',
      depositTo: { accountId: fx.acct['1010'] ?? '' },
      idempotencyKey: `seed-${prefix}`,
      allocations: [],
    });
    const cn = await createCreditNote(trx, {
      companyId: fx.companyId,
      invoiceId: inv.invoiceId,
      id: randomUUID(),
      issueDate: '2026-11-20',
      reasonCode: 'scope_reduction',
      lines: [{ invoiceLineNo: 1, amount: '200.00' }],
    });
    return { invoiceId: inv.invoiceId, receiptId: r.receiptId, creditNoteId: cn.creditNoteId };
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000015102');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000015103');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@cash.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  ({ invoiceId, receiptId, creditNoteId } = await seed(f, 'Harbour'));
  ({ receiptId: foreignReceipt, creditNoteId: foreignCreditNote } = await seed(other, 'Elsewhere'));
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
}, 240_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

describe('T-0151: AR cash routes', () => {
  it('AC-3 GET /ar/receipts lists unallocated receipts as decimal strings; 403 without ar.read [T-0151]', async () => {
    const denied = await call('GET', `/ar/receipts?company_id=${f.companyId}`, 'apClerk');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', permission: 'ar.read' });
    const res = await call(
      'GET',
      `/ar/receipts?company_id=${f.companyId}&unallocated=true`,
      'auditor',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      receipts: [
        {
          id: receiptId,
          receipt_no: expect.stringMatching(/^RCT-/),
          party_id: expect.any(String),
          party_name: expect.stringMatching(/^Harbour/),
          receipt_date: '2026-11-15',
          method: 'eft',
          reference: null,
          amount: '1375.0000',
          unallocated: '1375.0000',
        },
      ],
    });
  });

  it('AC-4 POST allocations needs an Idempotency-Key and ar.receipt.record; a replay is the same allocation; another tenant is 404 [T-0151]', async () => {
    const body = {
      company_id: f.companyId,
      invoice_id: invoiceId,
      amount: '1375.00',
      allocation_date: '2026-11-15',
    };
    const path = `/ar/receipts/${receiptId}/allocations`;
    expect((await call('POST', path, 'auditor', body, 'a-1')).status).toBe(403);
    const noKey = await call('POST', path, 'arClerk', body);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: 'idempotency_key_required' });
    const foreign = await call(
      'POST',
      `/ar/receipts/${foreignReceipt}/allocations`,
      'arClerk',
      body,
      'a-x',
    );
    expect(foreign.status).toBe(404);

    const first = await call('POST', path, 'arClerk', body, 'a-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: receiptId,
      unallocated: '0.0000',
      replayed: false,
    });
    const again = await call('POST', path, 'arClerk', body, 'a-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      id: receiptId,
      unallocated: '0.0000',
      replayed: true,
    });
    const status = await call(
      'GET',
      `/ar/invoices/${invoiceId}/payment-status?company_id=${f.companyId}`,
      'auditor',
    );
    expect(await status.json()).toEqual({ status: 'paid', open: '0.0000' });
    const left = await call(
      'GET',
      `/ar/receipts?company_id=${f.companyId}&unallocated=true`,
      'auditor',
    );
    expect(await left.json()).toEqual({ receipts: [] });
  });

  it('AC-5 GET /ar/credit-notes/:id/journal previews GP-005 and writes nothing; 403 without ar.read; another tenant is 404 [T-0151]', async () => {
    const path = (id: string) => `/ar/credit-notes/${id}/journal?company_id=${f.companyId}`;
    expect((await call('GET', path(creditNoteId), 'apClerk')).status).toBe(403);
    expect((await call('GET', path(foreignCreditNote), 'auditor')).status).toBe(404);
    const entries = async () =>
      (
        await f.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
          [f.tenantId],
        )
      ).rows[0]?.n;
    const before = await entries();
    const res = await call('GET', path(creditNoteId), 'auditor');
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      entry_date: string;
      total: string;
      base_currency: string;
      lines: { account_name: string; debit: string; credit: string }[];
    };
    expect(await entries()).toBe(before);
    expect(j).toMatchObject({ entry_date: '2026-11-20', total: '220.0000', base_currency: 'AUD' });
    expect(j.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['200.0000', '0.0000'],
      ['20.0000', '0.0000'],
      ['0.0000', '220.0000'],
    ]);
  });
});
