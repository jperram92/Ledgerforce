/**
 * SS-UC11-06 on the real routes (T-0045, UC-11, DL-0273): a credit note above the self-approval
 * threshold (1,000.00 by default, ADR-0026) created by the AR Clerk cannot be approved by the
 * same Clerk; another approver may; at or below the threshold the Clerk may approve their own.
 * The amount is the credit note's stored gross. Real PostgreSQL (lf_app), real sessions.
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
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk', 'approver'] },
  approver: { id: randomUUID(), roles: ['approver'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004502');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@cn.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  const profiles = await seedBillingCompany(f);
  const [acme] = await seedBillableCustomers(f, profiles, {
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
        partyId: acme ?? '',
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Consulting',
            quantity: '1',
            unitPrice: '3000.00',
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

const draft = (id: string, amount: string) =>
  call('PUT', `/ar/credit-notes/${id}`, 'arClerk', {
    company_id: f.companyId,
    invoice_id: invoiceId,
    issue_date: '2026-11-20',
    reason_code: 'price_concession',
    lines: [{ invoice_line_no: 1, amount }],
  });

describe('SS-UC11-06: Clerk cannot approve own credit note above threshold', () => {
  it('SS-UC11-06 the Clerk who created a 1,650.00 credit note is refused approval; another approver posts it', async () => {
    const id = randomUUID();
    const created = await draft(id, '1500.00');
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id, status: 'draft', gross: '1650.0000' });
    const replay = await draft(id, '1500.00');
    expect(replay.status).toBe(200);
    const own = await call(
      'POST',
      `/ar/credit-notes/${id}/approve?company_id=${f.companyId}`,
      'arClerk',
    );
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_CREDIT_NOTE_SELF_APPROVAL',
    });
    const other = await call(
      'POST',
      `/ar/credit-notes/${id}/approve?company_id=${f.companyId}`,
      'approver',
    );
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({
      id,
      status: 'posted',
      credit_note_no: expect.stringMatching(/^CN-/),
    });
  });

  it('SS-UC11-06 at or below the threshold the Clerk may approve their own credit note', async () => {
    const id = randomUUID();
    expect((await draft(id, '200.00')).status).toBe(201);
    const own = await call(
      'POST',
      `/ar/credit-notes/${id}/approve?company_id=${f.companyId}`,
      'arClerk',
    );
    expect(own.status).toBe(200);
  });

  it('SS-UC11-07 a credit beyond what is left on the invoice is refused with CREDIT_EXCEEDS_INVOICE', async () => {
    const res = await draft(randomUUID(), '2000.00');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'CREDIT_EXCEEDS_INVOICE' });
  });
});
