/**
 * Report screens (T-0089, design §8.1, DL-0450): trial balance, profit and loss, balance sheet,
 * general-ledger detail and aged receivables / payables. Every figure on screen is the API's
 * decimal string, formatted for reading; totals and the balanced flags come from the API, never
 * from the browser. The app is served by Vite; the API is faked per test with `page.route` using
 * the response shapes of GET /gl/trial-balance, /gl/profit-and-loss, /gl/balance-sheet,
 * /gl/detail (apps/api ReportsController), /ar/aged-receivables and /ap/aged-payables.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';
import { genericnessProbe } from '../fixtures/genericness.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x89c1);
const ACME = id(0x89a1);
const SALTBUSH = id(0x89a2);
const TELCO = id(0x89a3);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0089', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

test.beforeAll(async () => {
  server = await createViteServer({
    root: WEB,
    configFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'lf-web-')),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  if (!addr || typeof addr === 'string') throw new Error('web server has no port');
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

test.afterAll(async () => {
  await server?.close();
});

const ME = {
  accountant: { user_id: id(0x8911), display_name: 'Priya Natarajan', role: 'accountant' as const },
  apClerk: { user_id: id(0x8912), display_name: 'Tom Walsh', role: 'ap_clerk' as const },
};

const ACCT: Record<string, { id: string; name: string; type: string; subtype: string }> = {
  '1010': { id: id(0x8901), name: 'Operating account', type: 'asset', subtype: 'bank' },
  '1200': { id: id(0x8902), name: 'Trade debtors', type: 'asset', subtype: 'receivable' },
  '2000': { id: id(0x8903), name: 'Trade creditors', type: 'liability', subtype: 'payable' },
  '2310': {
    id: id(0x8904),
    name: 'GST collected',
    type: 'liability',
    subtype: 'current_liability',
  },
  '3000': { id: id(0x8905), name: "Owner's capital", type: 'equity', subtype: 'equity' },
  '3200': {
    id: id(0x8906),
    name: 'Retained earnings',
    type: 'equity',
    subtype: 'retained_earnings',
  },
  '3300': {
    id: id(0x8907),
    name: 'Current year earnings',
    type: 'equity',
    subtype: 'current_year_earnings',
  },
  '4110': {
    id: id(0x8908),
    name: 'Professional services',
    type: 'revenue',
    subtype: 'operating_revenue',
  },
  '6200': { id: id(0x8909), name: 'Rent', type: 'expense', subtype: 'operating_expense' },
  '6220': {
    id: id(0x890a),
    name: 'Telephone and internet',
    type: 'expense',
    subtype: 'operating_expense',
  },
};
const acct = (code: string) => {
  const a = ACCT[code];
  if (!a) throw new Error(`no account ${code}`);
  return a;
};

const tbRow = (code: string, debit: string, credit: string) => ({
  account_id: acct(code).id,
  code,
  name: acct(code).name,
  type: acct(code).type,
  subtype: acct(code).subtype,
  debit,
  credit,
});

/** November 2026, as GET /gl/trial-balance answers it (totals computed by the API). */
const TB = {
  company_id: CO,
  currency: 'AUD',
  from: '2026-11-01',
  to: '2026-11-30',
  dimension_value_ids: [],
  rows: [
    tbRow('1010', '12450.0000', '0.0000'),
    tbRow('1200', '4400.0000', '0.0000'),
    tbRow('2000', '0.0000', '1100.0000'),
    tbRow('2310', '0.0000', '400.0000'),
    tbRow('3000', '0.0000', '10000.0000'),
    tbRow('4110', '0.0000', '8950.0000'),
    tbRow('6200', '2500.0000', '0.0000'),
    tbRow('6220', '1100.0000', '0.0000'),
  ],
  total_debit: '20450.0000',
  total_credit: '20450.0000',
  nets_to_zero: true,
};

const line = (code: string, amount: string, computed = false) => ({
  account_id: acct(code).id,
  code,
  name: acct(code).name,
  amount,
  computed,
});

const PL = {
  company_id: CO,
  currency: 'AUD',
  from: '2026-11-01',
  to: '2026-11-30',
  dimension_value_ids: [],
  revenue: {
    type: 'revenue',
    total: '8950.0000',
    groups: [
      { subtype: 'operating_revenue', total: '8950.0000', lines: [line('4110', '8950.0000')] },
    ],
  },
  expenses: {
    type: 'expense',
    total: '3600.0000',
    groups: [
      {
        subtype: 'operating_expense',
        total: '3600.0000',
        lines: [line('6200', '2500.0000'), line('6220', '1100.0000')],
      },
    ],
  },
  net_profit: '5350.0000',
};

const BS = {
  company_id: CO,
  currency: 'AUD',
  as_at: '2026-11-30',
  fiscal_year: { label: 'FY2027', start: '2026-07-01', end: '2027-06-30' },
  assets: {
    type: 'asset',
    total: '16850.0000',
    groups: [
      { subtype: 'bank', total: '12450.0000', lines: [line('1010', '12450.0000')] },
      { subtype: 'receivable', total: '4400.0000', lines: [line('1200', '4400.0000')] },
    ],
  },
  liabilities: {
    type: 'liability',
    total: '1500.0000',
    groups: [
      { subtype: 'payable', total: '1100.0000', lines: [line('2000', '1100.0000')] },
      { subtype: 'current_liability', total: '400.0000', lines: [line('2310', '400.0000')] },
    ],
  },
  equity: {
    type: 'equity',
    total: '15350.0000',
    groups: [
      { subtype: 'equity', total: '10000.0000', lines: [line('3000', '10000.0000')] },
      {
        subtype: 'retained_earnings',
        total: '0.0000',
        lines: [line('3200', '0.0000', true)],
      },
      {
        subtype: 'current_year_earnings',
        total: '5350.0000',
        lines: [line('3300', '5350.0000', true)],
      },
    ],
  },
  total_liabilities_and_equity: '16850.0000',
  prior_years_earnings: '0.0000',
  current_year_earnings: '5350.0000',
  balanced: true,
};

const glAccount = (code: string) => ({
  account_id: acct(code).id,
  code,
  name: acct(code).name,
  type: acct(code).type,
  subtype: acct(code).subtype,
  opening: '0.0000',
  lines: [
    {
      entry_id: id(0x8931),
      entry_no: 'AP-000014',
      line_no: 1,
      date: '2026-11-02',
      source_type: 'ap_bill',
      memo: 'November phone and internet',
      party_id: TELCO,
      party_name: 'Telco Pty Ltd',
      debit: '1100.0000',
      credit: '0.0000',
      balance: '1100.0000',
      txn_currency: 'AUD',
      txn_amount: '1100.0000',
    },
  ],
  total_debit: '1100.0000',
  total_credit: '0.0000',
  closing: '1100.0000',
});

const GL = (accountIds: string[]) => ({
  company_id: CO,
  currency: 'AUD',
  from: '2026-11-01',
  to: '2026-11-30',
  period_id: null,
  account_ids: accountIds,
  dimension_value_ids: [],
  party_id: null,
  accounts: [glAccount('6220')],
  total_debit: '1100.0000',
  total_credit: '0.0000',
});

const zeroBuckets = {
  current: '0.0000',
  days1to30: '0.0000',
  days31to60: '0.0000',
  days61to90: '0.0000',
  days90plus: '0.0000',
};
const AGED_AR = {
  asOf: '2026-11-30',
  rows: [
    {
      partyId: ACME,
      partyName: 'Acme Pty Ltd',
      ...zeroBuckets,
      current: '1375.0000',
      total: '1375.0000',
    },
    {
      partyId: SALTBUSH,
      partyName: 'Saltbush Co',
      ...zeroBuckets,
      days31to60: '3025.0000',
      total: '3025.0000',
    },
  ],
  totals: { ...zeroBuckets, current: '1375.0000', days31to60: '3025.0000', total: '4400.0000' },
};
const AGED_AP = {
  asOf: '2026-11-30',
  rows: [
    {
      partyId: TELCO,
      partyName: 'Telco Pty Ltd',
      ...zeroBuckets,
      current: '1100.0000',
      total: '1100.0000',
    },
  ],
  totals: { ...zeroBuckets, current: '1100.0000', total: '1100.0000' },
};

const CHART = {
  companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
  accounts: Object.entries(ACCT).map(([code, a]) => ({
    id: a.id,
    company_id: CO,
    code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    normal_balance: a.type === 'asset' || a.type === 'expense' ? 'debit' : 'credit',
    currency: null,
    postable: true,
    is_control: code === '1200' || code === '2000',
    status: 'active',
    system_roles: [],
  })),
};

interface Fake {
  errors: string[];
  /** Every report request: path and query string. */
  calls: string[];
  override: Map<string, { status: number; body: unknown }>;
}

const NEEDS: Record<string, string> = {
  '/gl/trial-balance': 'reports.run',
  '/gl/profit-and-loss': 'reports.run',
  '/gl/balance-sheet': 'reports.run',
  '/gl/detail': 'reports.run',
  '/accounts': 'gl.account.read',
  '/ar/aged-receivables': 'ar.read',
  '/ap/aged-payables': 'ap.read',
};

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], calls: [], override: new Map() };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) =>
      url.origin === origin && /^\/(auth|companies|accounts|gl|ar|ap)(\/|$)/.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: [me.role], permissions: perms });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      const needs = NEEDS[path];
      if (!needs) return send(route, 404, { error: 'not_found' });
      if (!perms.includes(needs))
        return send(route, 403, { error: 'forbidden', permission: needs });
      if (path === '/accounts') return send(route, 200, CHART);
      f.calls.push(`${path}${url.search}`);
      expect(url.searchParams.get('company_id')).toBe(CO);
      const o = f.override.get(path);
      if (o) return send(route, o.status, o.body);
      if (path === '/gl/trial-balance') return send(route, 200, TB);
      if (path === '/gl/profit-and-loss') return send(route, 200, PL);
      if (path === '/gl/balance-sheet') return send(route, 200, BS);
      if (path === '/gl/detail') return send(route, 200, GL(url.searchParams.getAll('account_id')));
      if (path === '/ar/aged-receivables') return send(route, 200, AGED_AR);
      return send(route, 200, AGED_AP);
    },
  );
  return f;
}

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}${path}`);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}

async function assertPage(page: Page, width: number) {
  expect((await page.title()).trim()).not.toBe('');
  await expect(page.locator('main')).toHaveCount(1);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
  expect(await page.evaluate(genericnessProbe)).toEqual({
    shadows: [],
    bigRadius: [],
    caps: [],
    purple: [],
    dots: 0,
    arrows: 0,
  });
  expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  const amounts = await page.locator('main [data-amount]').all();
  expect(amounts.length).toBeGreaterThan(0);
  for (const cell of amounts) {
    expect(await cell.getAttribute('data-amount')).toMatch(/^-?\d+\.\d{2}$/);
    // P3: right-aligned at desktop width, tabular figures always.
    const style = await cell.evaluate((e) => {
      const s = getComputedStyle(e.closest('td, th') ?? e);
      return { align: s.textAlign, nums: getComputedStyle(e).fontVariantNumeric };
    });
    expect(style.nums).toContain('tabular-nums');
    if (width > 900) expect(style.align).toBe('right');
  }
}

const amountsIn = (page: Page, table: string, part = 'tbody') =>
  page
    .getByRole('table', { name: table })
    .locator(`${part} [data-amount]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount')));

for (const width of [1440, 390]) {
  test(`SS-PLAT-76: Trial balance screen for a range, totals from the ledger, each account opens its detail @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/reports/trial-balance?from=2026-11-01&to=2026-11-30', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Trial balance' })).toBeVisible();
    await expect(page.getByLabel('From')).toHaveValue('2026-11-01');
    await expect(page.getByLabel('To')).toHaveValue('2026-11-30');
    const table = page.getByRole('table', { name: 'Trial balance' });
    await expect(table.locator('tbody tr')).toHaveCount(8);
    await expect(table.locator('tbody tr').first()).toContainText('1010');
    await expect(table.locator('tbody tr').first()).toContainText('Operating account');
    expect(await amountsIn(page, 'Trial balance')).toEqual([
      '12450.00',
      '0.00',
      '4400.00',
      '0.00',
      '0.00',
      '1100.00',
      '0.00',
      '400.00',
      '0.00',
      '10000.00',
      '0.00',
      '8950.00',
      '2500.00',
      '0.00',
      '1100.00',
      '0.00',
    ]);
    expect(await amountsIn(page, 'Trial balance', 'tfoot')).toEqual(['20450.00', '20450.00']);
    await expect(page.getByText('Debits equal credits')).toBeVisible();
    expect(f.calls).toEqual([
      '/gl/trial-balance?company_id=' + CO + '&from=2026-11-01&to=2026-11-30',
    ]);
    // P1: every account row opens its general-ledger detail for the same range.
    for (const row of await table.locator('tbody tr').all())
      await expect(row.getByRole('link')).toHaveCount(1);
    await assertPage(page, width);
    await evidence('SS-PLAT-76', `trial-balance-screen-${String(width)}`);

    await table.getByRole('link', { name: /6220 Telephone and internet/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'General ledger detail' }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: '6220 Telephone and internet' })).toBeVisible();
    expect(f.calls.at(-1)).toBe(
      `/gl/detail?company_id=${CO}&from=2026-11-01&to=2026-11-30&account_id=${acct('6220').id}`,
    );
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-76: Profit and loss screen groups revenue and expenses with the net profit from the API @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/reports/profit-and-loss?from=2026-11-01&to=2026-11-30', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Profit and loss' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Profit and loss' });
    await expect(table.getByRole('rowheader', { name: 'Income', exact: true })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'Expenses', exact: true })).toBeVisible();
    await expect(table.getByRole('link', { name: /4110 Professional services/ })).toBeVisible();
    await expect(table.getByRole('link', { name: /6200 Rent/ })).toBeVisible();
    const net = table.getByRole('row', { name: /Net profit/ });
    await expect(net.locator('[data-amount]')).toHaveAttribute('data-amount', '5350.00');
    // One group per section: the section total stands alone, no repeated subtotal.
    expect(await amountsIn(page, 'Profit and loss')).toEqual([
      '8950.00',
      '8950.00',
      '2500.00',
      '1100.00',
      '3600.00',
    ]);
    expect(await amountsIn(page, 'Profit and loss', 'tfoot')).toEqual(['5350.00']);
    await assertPage(page, width);
    await evidence('SS-PLAT-76', `profit-and-loss-screen-${String(width)}`);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-76: Balance sheet screen balances, with computed earnings lines marked @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/reports/balance-sheet?as_at=2026-11-30', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Balance sheet' })).toBeVisible();
    await expect(page.getByLabel('As at')).toHaveValue('2026-11-30');
    const table = page.getByRole('table', { name: 'Balance sheet' });
    for (const h of ['Assets', 'Liabilities', 'Equity'])
      await expect(table.getByRole('rowheader', { name: h, exact: true })).toBeVisible();
    await expect(table.getByRole('row', { name: /3300 Current year earnings/ })).toContainText(
      'Worked out',
    );
    await expect(
      table.getByRole('row', { name: /Total liabilities and equity/ }).locator('[data-amount]'),
    ).toHaveAttribute('data-amount', '16850.00');
    await expect(
      table.getByRole('row', { name: /^Total assets/ }).locator('[data-amount]'),
    ).toHaveAttribute('data-amount', '16850.00');
    await expect(page.getByText('Balanced: assets equal liabilities plus equity')).toBeVisible();
    await expect(page.getByText(/FY2027/)).toBeVisible();
    expect(f.calls).toEqual([`/gl/balance-sheet?company_id=${CO}&as_at=2026-11-30`]);
    await assertPage(page, width);
    await evidence('SS-PLAT-76', `balance-sheet-screen-${String(width)}`);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-108: General ledger detail screen shows opening, lines with running balance and closing @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(
      page,
      `/reports/gl-detail?from=2026-11-01&to=2026-11-30&account_id=${acct('6220').id}`,
      width,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'General ledger detail' }),
    ).toBeVisible();
    await expect(page.getByLabel('Account')).toHaveValue(acct('6220').id);
    const table = page.getByRole('table', { name: '6220 Telephone and internet' });
    await expect(table.getByRole('row', { name: /Opening balance/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /AP-000014/ })).toContainText('Telco Pty Ltd');
    await expect(
      table
        .getByRole('row', { name: /Closing balance/ })
        .locator('[data-amount]')
        .last(),
    ).toHaveAttribute('data-amount', '1100.00');
    await assertPage(page, width);
    await evidence('SS-PLAT-108', `gl-detail-screen-${String(width)}`);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-107: Aged receivables screen buckets each customer, totals from the API @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/reports/aged-receivables?as_of=2026-11-30', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Aged receivables' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Aged receivables' });
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr').nth(1)).toContainText('Saltbush Co');
    expect(await amountsIn(page, 'Aged receivables', 'tfoot')).toEqual([
      '1375.00',
      '0.00',
      '3025.00',
      '0.00',
      '0.00',
      '4400.00',
    ]);
    expect(f.calls).toEqual([`/ar/aged-receivables?company_id=${CO}&as_of=2026-11-30`]);
    await assertPage(page, width);
    await evidence('SS-PLAT-107', `aged-receivables-screen-${String(width)}`);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-109: Aged payables screen buckets each supplier @ ${String(width)} [T-0089]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'apClerk');
    await open(page, '/reports/aged-payables?as_of=2026-11-30', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Aged payables' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Aged payables' });
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr').first()).toContainText('Telco Pty Ltd');
    expect(await amountsIn(page, 'Aged payables', 'tfoot')).toEqual([
      '1100.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '1100.00',
    ]);
    await assertPage(page, width);
    await evidence('SS-PLAT-109', `aged-payables-screen-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0089: Download CSV writes the figures the API returned', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/reports/trial-balance?from=2026-11-01&to=2026-11-30', 1440);
  await expect(page.getByRole('table', { name: 'Trial balance' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('trial-balance-2026-11-01-to-2026-11-30.csv');
  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  expect(text.startsWith('\uFEFF'), 'UTF-8 byte-order mark for spreadsheets').toBe(true);
  const csv = text.slice(1).split('\r\n');
  expect(csv[0]).toBe('Code,Account,Debit,Credit');
  expect(csv[1]).toBe('1010,Operating account,12450.00,0.00');
  expect(csv[5]).toBe("3000,Owner's capital,0.00,10000.00");
  expect(csv[9]).toBe(',Total,20450.00,20450.00');
  expect(f.errors).toEqual([]);
});

test('T-0089: changing the dates asks the API again and the URL keeps them', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/reports/profit-and-loss?from=2026-11-01&to=2026-11-30', 1440);
  await expect(page.getByRole('table', { name: 'Profit and loss' })).toBeVisible();
  await page.getByLabel('From').fill('2026-07-01');
  await page.getByRole('button', { name: 'Show report' }).click();
  await expect(page).toHaveURL(/from=2026-07-01&to=2026-11-30/);
  await expect
    .poll(() => f.calls.at(-1))
    .toBe(`/gl/profit-and-loss?company_id=${CO}&from=2026-07-01&to=2026-11-30`);
  expect(f.errors).toEqual([]);
});

test('T-0089: without dates the reports start at this month and today', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-13T10:00:00+11:00'));
  const f = await fakeApi(page, 'accountant');
  await open(page, '/reports/trial-balance', 1440);
  await expect(page.getByLabel('From')).toHaveValue('2026-11-01');
  await expect(page.getByLabel('To')).toHaveValue('2026-11-13');
  await expect
    .poll(() => f.calls[0])
    .toBe(`/gl/trial-balance?company_id=${CO}&from=2026-11-01&to=2026-11-13`);
  expect(f.errors).toEqual([]);
});

test('T-0089: an AP clerk is told who can run the trial balance, and sees no figures', async ({
  page,
}) => {
  const f = await fakeApi(page, 'apClerk');
  await open(page, '/reports/trial-balance?from=2026-11-01&to=2026-11-30', 1440);
  await expect(page.getByText(/You do not have access to the trial balance/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Trial balance' })).toHaveCount(0);
  expect(f.calls).toEqual([]);
  await open(page, '/reports/aged-receivables?as_of=2026-11-30', 1440);
  await expect(page.getByText(/You do not have access to aged receivables/)).toBeVisible();
  expect(f.errors).toEqual([]);
});

test('T-0089: a refused report says why, and a date with no fiscal year is explained', async ({
  page,
}) => {
  const f = await fakeApi(page, 'accountant');
  f.override.set('/gl/balance-sheet', {
    status: 422,
    body: { error: 'NO_FISCAL_YEAR', message: 'no fiscal year holds 2001-01-31' },
  });
  await open(page, '/reports/balance-sheet?as_at=2001-01-31', 1440);
  await expect(page.getByRole('alert')).toContainText(
    'There is no financial year that holds this date',
  );
  await expect(page.getByRole('table', { name: 'Balance sheet' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0089: a period with nothing posted says so instead of an empty table', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  f.override.set('/gl/trial-balance', {
    status: 200,
    body: { ...TB, rows: [], total_debit: '0.0000', total_credit: '0.0000' },
  });
  await open(page, '/reports/trial-balance?from=2026-11-01&to=2026-11-30', 1440);
  await expect(page.getByRole('heading', { name: 'Nothing posted in these dates' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Trial balance' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0089: the Reports page lists the six reports', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/reports', 1440);
  const nav = page.getByRole('navigation', { name: 'In Reports' });
  for (const name of [
    'Trial balance',
    'Profit and loss',
    'Balance sheet',
    'General ledger detail',
    'Aged receivables',
    'Aged payables',
  ])
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});
