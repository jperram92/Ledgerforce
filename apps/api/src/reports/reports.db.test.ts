/**
 * Ledger reports on the real routes (T-0077, design §8.1, DL-0313): GL detail needs reports.run,
 * aged payables ap.read, aged receivables ar.read; money is a decimal string; bad queries are 400;
 * an AP clerk (ap.read only) is refused GL detail and aged AR. Real PostgreSQL as lf_app, real
 * sessions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedPayablesCompany } from '@ledgerforce/ap/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let api: Api;
let supplier = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  accountant: { id: randomUUID(), roles: ['accountant'] },
  apClerk: { id: randomUUID(), roles: ['ap_clerk'] },
};

const get = (path: string, who: string) =>
  fetch(`${api.url}${path}`, { headers: { cookie: `lf_session=${cookies.get(who) ?? ''}` } });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007703');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@reports.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  const payables = await seedPayablesCompany(f);
  supplier = await payables.addSupplier('Report Route Supplies Pty Ltd', null);
  await payables.postBill(supplier, 'RR-1', '1100.00', '2026-11-30'); // bill date 2026-11-02
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people))
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-108/109 report routes [T-0077]', () => {
  it('SS-PLAT-108 GET /gl/detail returns the AP control detail with decimal-string money', async () => {
    const ap = f.acct['2000'] ?? '';
    const res = await get(
      `/gl/detail?company_id=${f.companyId}&from=2026-11-01&to=2026-11-30&account_id=${ap}&party_id=${supplier}`,
      'accountant',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      accounts: {
        code: string;
        opening: string;
        closing: string;
        lines: { date: string; credit: string; balance: string; party_name: string }[];
      }[];
    };
    expect(body.currency).toBe('AUD');
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      code: '2000',
      opening: '0.0000',
      closing: '-1100.0000',
    });
    expect(body.accounts[0]?.lines).toEqual([
      expect.objectContaining({
        date: '2026-11-02',
        credit: '1100.0000',
        balance: '-1100.0000',
        party_name: 'Report Route Supplies Pty Ltd',
      }),
    ]);
  });

  it('SS-PLAT-109 GET /ap/aged-payables ages the bill and totals the AP control balance', async () => {
    const res = await get(
      `/ap/aged-payables?company_id=${f.companyId}&as_of=2026-12-31`,
      'apClerk',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { partyId: string; days31to60: string }[];
      totals: { total: string };
    };
    expect(body.rows).toEqual([
      expect.objectContaining({ partyId: supplier, days31to60: '1100.0000' }),
    ]);
    expect(body.totals.total).toBe('1100.0000');
  });

  it('GET /ar/aged-receivables answers an AR reader', async () => {
    const res = await get(
      `/ar/aged-receivables?company_id=${f.companyId}&as_of=2026-12-31`,
      'accountant',
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { totals: { total: string } }).totals.total).toBe('0.0000');
  });

  it('refuses an AP clerk GL detail and aged AR (403) and bad queries (400)', async () => {
    const gl = `/gl/detail?company_id=${f.companyId}&to=2026-11-30`;
    expect((await get(gl, 'apClerk')).status).toBe(403);
    expect(
      (await get(`/ar/aged-receivables?company_id=${f.companyId}&as_of=2026-12-31`, 'apClerk'))
        .status,
    ).toBe(403);
    expect((await get(gl, 'accountant')).status).toBe(200);
    for (const q of [
      `/gl/detail?company_id=nope&to=2026-11-30`,
      `/gl/detail?company_id=${f.companyId}&from=2026-12-01&to=2026-11-30`,
      `/gl/detail?company_id=${f.companyId}&to=2026-11-30&account_id=x`,
      `/ap/aged-payables?company_id=${f.companyId}&as_of=31-12-2026`,
    ])
      expect([q, (await get(q, 'accountant')).status]).toEqual([q, 400]);
    expect(
      (await get(`/gl/detail?company_id=${f.companyId}&period_id=${randomUUID()}`, 'accountant'))
        .status,
    ).toBe(422);
  });
});

type Section = {
  type: string;
  total: string;
  groups: {
    subtype: string;
    total: string;
    lines: { code: string; amount: string; computed: boolean }[];
  }[];
};

describe('SS-PLAT-76 trial balance, P&L and balance sheet routes [T-0089]', () => {
  it('GET /gl/trial-balance lists each account on its side with decimal-string totals', async () => {
    const res = await get(
      `/gl/trial-balance?company_id=${f.companyId}&from=2026-11-01&to=2026-11-30`,
      'accountant',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      from: string | null;
      to: string;
      rows: { code: string; type: string; debit: string; credit: string }[];
      total_debit: string;
      total_credit: string;
      nets_to_zero: boolean;
    };
    expect(body).toMatchObject({
      currency: 'AUD',
      from: '2026-11-01',
      to: '2026-11-30',
      total_debit: '1100.0000',
      total_credit: '1100.0000',
      nets_to_zero: true,
    });
    expect(body.rows.map((r) => [r.code, r.debit, r.credit])).toEqual([
      ['2000', '0.0000', '1100.0000'],
      ['6230', '1100.0000', '0.0000'],
    ]);
    const open = await get(
      `/gl/trial-balance?company_id=${f.companyId}&to=2026-11-30`,
      'accountant',
    );
    expect(((await open.json()) as { from: string | null }).from).toBeNull();
  });

  it('GET /gl/profit-and-loss groups expenses by subtype and returns the net profit', async () => {
    const res = await get(
      `/gl/profit-and-loss?company_id=${f.companyId}&from=2026-11-01&to=2026-11-30`,
      'accountant',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      revenue: Section;
      expenses: Section;
      net_profit: string;
    };
    expect(body.currency).toBe('AUD');
    expect(body.revenue).toEqual({ type: 'revenue', total: '0.0000', groups: [] });
    expect(body.expenses.total).toBe('1100.0000');
    expect(body.expenses.groups.flatMap((g) => g.lines.map((l) => [l.code, l.amount]))).toEqual([
      ['6230', '1100.0000'],
    ]);
    expect(body.net_profit).toBe('-1100.0000');
  });

  it('GET /gl/balance-sheet balances, with the year to date on the current-year earnings line', async () => {
    const res = await get(
      `/gl/balance-sheet?company_id=${f.companyId}&as_at=2026-11-30`,
      'accountant',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      as_at: string;
      fiscal_year: { label: string; start: string; end: string };
      assets: Section;
      liabilities: Section;
      equity: Section;
      total_liabilities_and_equity: string;
      current_year_earnings: string;
      prior_years_earnings: string;
      balanced: boolean;
    };
    expect(body).toMatchObject({
      as_at: '2026-11-30',
      total_liabilities_and_equity: '0.0000',
      current_year_earnings: '-1100.0000',
      prior_years_earnings: '0.0000',
      balanced: true,
    });
    expect(body.fiscal_year.start).toBe('2026-07-01');
    expect(body.assets.total).toBe('0.0000');
    expect(body.liabilities.total).toBe('1100.0000');
    const equity = body.equity.groups.flatMap((g) => g.lines);
    expect(equity.filter((l) => l.computed).map((l) => l.amount)).toEqual(['0.0000', '-1100.0000']);
  });

  it('needs reports.run (403 for an AP clerk), refuses bad queries (400) and dates outside any year (422)', async () => {
    const co = f.companyId;
    for (const q of [
      `/gl/trial-balance?company_id=${co}&to=2026-11-30`,
      `/gl/profit-and-loss?company_id=${co}&from=2026-11-01&to=2026-11-30`,
      `/gl/balance-sheet?company_id=${co}&as_at=2026-11-30`,
    ])
      expect([q, (await get(q, 'apClerk')).status]).toEqual([q, 403]);
    for (const q of [
      `/gl/trial-balance?company_id=nope&to=2026-11-30`,
      `/gl/trial-balance?company_id=${co}`,
      `/gl/trial-balance?company_id=${co}&from=2026-12-01&to=2026-11-30`,
      `/gl/profit-and-loss?company_id=${co}&to=2026-11-30`,
      `/gl/profit-and-loss?company_id=${co}&from=2026-11-01&to=2026-02-30`,
      `/gl/balance-sheet?company_id=${co}`,
      `/gl/balance-sheet?company_id=${co}&as_at=30-11-2026`,
    ])
      expect([q, (await get(q, 'accountant')).status]).toEqual([q, 400]);
    expect(
      (await get(`/gl/balance-sheet?company_id=${co}&as_at=2001-01-31`, 'accountant')).status,
    ).toBe(422);
  });
});
