/**
 * GET /ar/invoices, GET /ar/invoices/:id, GET /ar/invoices/:id/journal (T-0131, SS-UC01-10 data
 * layer, DL-0406) against a real PostgreSQL as lf_app: ar.read is required, money is a decimal
 * string, other tenants' invoices are not found, and "Show me the journal" writes nothing.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDraftInvoice } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let draftId = '';
let foreignId = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  sales: { id: randomUUID(), roles: ['sales_user'] },
};

async function call(path: string, who: string) {
  const c = cookies.get(who);
  return fetch(`${api.url}${path}`, { headers: c ? { cookie: `lf_session=${c}` } : {} });
}

async function draftFor(fx: LedgerFixture, prefix: string): Promise<string> {
  const profiles = await seedBillingCompany(fx);
  const [party] = await seedBillableCustomers(fx, profiles, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return fx.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: fx.companyId,
        partyId: party ?? '',
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '250.00',
          },
        ],
      },
      { outbox: { publish: async () => {} } },
    );
    return d.invoiceId;
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000013101');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000013102');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@inv.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  draftId = await draftFor(f, 'Acme');
  foreignId = await draftFor(other, 'Elsewhere');
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
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0131: invoice read routes', () => {
  it('lists the company invoices for ar.read, newest first, money as decimal strings', async () => {
    const r = await call(`/ar/invoices?company_id=${f.companyId}&status=draft`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { invoices: Record<string, unknown>[] };
    expect(body.invoices).toEqual([
      expect.objectContaining({
        id: draftId,
        invoice_no: null,
        status: 'draft',
        party_name: 'Acme 01 Pty Ltd',
        issue_date: '2026-11-05',
        due_date: '2026-11-19',
      }),
    ]);
  });

  it('shows one invoice with its lines', async () => {
    const r = await call(`/ar/invoices/${draftId}?company_id=${f.companyId}`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { lines: Record<string, unknown>[] };
    expect(body).toMatchObject({ id: draftId, status: 'draft', pricing: 'exclusive' });
    expect(body.lines).toEqual([
      expect.objectContaining({
        line_no: 1,
        description: 'Professional services',
        quantity: '1.0000',
        unit_price: '1000.0000',
      }),
      expect.objectContaining({
        line_no: 2,
        description: 'Subscription',
        quantity: '1.0000',
        unit_price: '250.0000',
      }),
    ]);
  });

  it('SS-UC01-10 "Show me the journal" returns the engine preview (GP-001 totals) and writes nothing', async () => {
    const entries = async () =>
      (
        await f.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
          [f.tenantId],
        )
      ).rows[0]?.n;
    const before = await entries();
    const r = await call(`/ar/invoices/${draftId}/journal?company_id=${f.companyId}`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      entry_date: string;
      total: string;
      lines: { debit: string; credit: string; account_name: string }[];
    };
    expect(body.entry_date).toBe('2026-11-05');
    expect(body.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['1375.0000', '0.0000'],
      ['0.0000', '1000.0000'],
      ['0.0000', '250.0000'],
      ['0.0000', '125.0000'],
    ]);
    expect(body.lines.every((l) => l.account_name.length > 0)).toBe(true);
    expect(await entries()).toBe(before);
  });

  it("refuses without ar.read (403) and hides another tenant's invoice (404)", async () => {
    expect((await call(`/ar/invoices?company_id=${f.companyId}`, 'sales')).status).toBe(403);
    expect(
      (await call(`/ar/invoices/${foreignId}?company_id=${f.companyId}`, 'arClerk')).status,
    ).toBe(404);
    expect(
      (await call(`/ar/invoices/${foreignId}/journal?company_id=${f.companyId}`, 'arClerk')).status,
    ).toBe(404);
    expect((await call(`/ar/invoices?company_id=not-a-uuid`, 'arClerk')).status).toBe(400);
  });
});
