/**
 * Settings screens for setup wizard steps 1 and 3 (T-0176, SS-PLAT-129, ADR-0081). A Finance Admin
 * follows the wizard's link to Company details (legal name, ABN, base currency, first financial
 * year) and to Tax settings (GST basis, BAS frequency, standard tax codes); afterwards the wizard
 * says nothing is missing for those steps. Vite serves the app; each test fakes the API with
 * `page.route`, using the response shapes of GET /companies, GET /setup/wizard and the ADR-0081
 * routes under /setup/company and /setup/tax. The fake derives steps 1 and 3's missing lists from
 * its own state with the wording of @ledgerforce/setup's validators.
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
const CO = id(0x176c1);
const TODAY = '2026-11-15';
const VALID_ABN = '51824753556';

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0176', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

// The worker's Vite cache is removed after its tests; left behind it fills the disk (DL-0820).
let cacheDir = '';

test.beforeAll(async () => {
  server = await createViteServer({
    root: WEB,
    configFile: false,
    cacheDir: (cacheDir = mkdtempSync(join(tmpdir(), 'lf-web-'))),
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
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

const ME = {
  fa: { user_id: id(0x1761), display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1762), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1763), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

const TITLES = [
  'Company details',
  'Chart of accounts',
  'Tax codes',
  'Bank accounts',
  'Connect Salesforce',
  'Import from Salesforce',
  'Posting profiles',
  'Numbering and billing',
  'Opening balances',
  'Users, roles and approvals',
];

/** The standard AU codes as GET /setup/tax lists them (a subset of AU_TAX_CODES is enough). */
const STANDARD_CODES = [
  ['BAS-EXCLUDED', 'BAS excluded', 'excluded', '0.00000000'],
  ['GST', 'GST on income and expenses', 'taxable', '0.10000000'],
  ['GST-FREE', 'GST-free', 'gst_free', '0.00000000'],
  ['INPUT-TAXED', 'Input-taxed', 'input_taxed', '0.00000000'],
].map(([code, name, kind, rate]) => ({
  code,
  name,
  kind,
  rate,
  effective_from: '2000-07-01',
  effective_to: null,
  status: 'active',
}));

interface FiscalYear {
  label: string;
  start_date: string;
  end_date: string;
}

interface Fake {
  errors: string[];
  writes: { method: string; path: string; key: string | null; body: unknown }[];
  company: {
    legal_name: string | null;
    abn: string | null;
    base_currency: string;
    base_currency_locked: boolean;
    fiscal_years: FiscalYear[];
  };
  tax: {
    settings: { effective_from: string; gst_basis: string; bas_frequency: string } | null;
    codes: typeof STANDARD_CODES;
  };
  /** One-off refusals by path, used before the fake's own rules. */
  refuse: Map<string, { status: number; body: unknown }>;
  reads: number;
}

const MONTH_END: Record<string, string> = { '01': '12-31', '07': '06-30' };

function missing1(f: Fake): string[] {
  const out: string[] = [];
  if (!f.company.legal_name?.trim()) out.push('The legal name is missing');
  if (!f.company.abn) out.push('The ABN is missing');
  if (f.company.fiscal_years.length === 0)
    out.push('No fiscal year has been set up (fiscal year start)');
  return out;
}
function missing3(f: Fake): string[] {
  const out = f.tax.codes.length > 0 ? [] : [`No tax code is in force on ${TODAY}`];
  if (!f.tax.settings) {
    out.push('The GST accounting basis (cash or accrual) has not been set');
    out.push('The BAS reporting frequency (monthly, quarterly or annual) has not been set');
  }
  return out;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    writes: [],
    company: {
      legal_name: null,
      abn: null,
      base_currency: 'AUD',
      base_currency_locked: false,
      fiscal_years: [],
    },
    tax: { settings: null, codes: [] },
    refuse: new Map(),
    reads: 0,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const companyView = () => ({ company_id: CO, name: 'Harbour & Co', ...f.company });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|setup)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const need = (p: string) =>
        perms.includes(p) ? null : send(route, 403, { error: 'forbidden', permission: p });
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: [me.role], permissions: perms });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co', base_currency: 'AUD' }]);
      if (method === 'GET') {
        const denied = need('settings.read');
        if (denied) return denied;
        if (path !== '/setup/wizard') expect(url.searchParams.get('company_id')).toBe(CO);
        f.reads += 1;
        if (path === '/setup/company') return send(route, 200, companyView());
        if (path === '/setup/tax')
          return send(route, 200, { company_id: CO, as_of: TODAY, ...f.tax });
        if (path === '/setup/wizard') {
          const miss = (n: number) => (n === 1 ? missing1(f) : n === 3 ? missing3(f) : []);
          return send(route, 200, {
            company_id: CO,
            as_of: TODAY,
            complete: false,
            steps: TITLES.map((title, i) => ({
              step: i + 1,
              title,
              status: i === 0 ? 'in_progress' : 'not_started',
              locked: i > 0,
              valid: miss(i + 1).length === 0,
              missing: miss(i + 1),
              outcome: null,
              reason: null,
              completed_at: null,
              completed_by: null,
            })),
          });
        }
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, string>;
      f.writes.push({ method, path, key: req.headers()['idempotency-key'] ?? null, body });
      const denied = need(
        path.startsWith('/setup/tax') ? 'settings.tax.manage' : 'settings.setup.manage',
      );
      if (denied) return denied;
      expect(body['company_id']).toBe(CO);
      const r = f.refuse.get(path);
      if (r) {
        f.refuse.delete(path);
        return send(route, r.status, r.body);
      }
      if (path === '/setup/company' && method === 'PUT') {
        if (body['abn'] === '51824753557')
          return send(route, 422, { error: 'INVALID_ABN', message: 'checksum' });
        const next = {
          legal_name: body['legal_name'] ?? null,
          abn: (body['abn'] ?? '').replace(/\s+/g, ''),
          base_currency: body['base_currency'] ?? 'AUD',
        };
        if (f.company.base_currency_locked && next.base_currency !== f.company.base_currency)
          return send(route, 409, { error: 'BASE_CURRENCY_LOCKED', message: 'locked' });
        const changed =
          next.legal_name !== f.company.legal_name ||
          next.abn !== f.company.abn ||
          next.base_currency !== f.company.base_currency;
        Object.assign(f.company, next);
        return send(route, 200, { ...companyView(), changed });
      }
      if (path === '/setup/company/fiscal-years' && method === 'POST') {
        const start = body['start'] ?? '';
        const m = /^(\d{4})-(\d{2})-01$/.exec(start);
        const y = Number(m?.[1]);
        const end = `${String(m?.[2] === '01' ? y : y + 1)}-${MONTH_END[m?.[2] ?? ''] ?? '??'}`;
        const fy = { label: `FY${end.slice(0, 4)}`, start_date: start, end_date: end };
        const clash = f.company.fiscal_years.find(
          (x) => x.start_date <= fy.end_date && fy.start_date <= x.end_date,
        );
        if (clash)
          return send(route, 409, {
            error: 'FISCAL_YEAR_OVERLAP',
            message: `a fiscal year from ${fy.start_date} to ${fy.end_date} would overlap ${clash.label} (${clash.start_date} to ${clash.end_date})`,
          });
        f.company.fiscal_years.push(fy);
        return send(route, 201, { ...fy, periods: 12, replayed: false });
      }
      if (path === '/setup/tax' && method === 'PUT') {
        if (!/^\d{4}-\d{2}-01$/.test(body['effective_from'] ?? ''))
          return send(route, 400, {
            error: 'INVALID_TAX_SETTINGS',
            message: 'effectiveFrom must be the 1st of a month (YYYY-MM-01)',
          });
        f.tax.settings = {
          effective_from: body['effective_from'] ?? '',
          gst_basis: body['gst_basis'] ?? '',
          bas_frequency: body['bas_frequency'] ?? '',
        };
        return send(route, 200, { settings: f.tax.settings, changed: true });
      }
      if (path === '/setup/tax/codes/standard' && method === 'POST') {
        const inserted = f.tax.codes.length === 0 ? STANDARD_CODES.length : 0;
        f.tax.codes = [...STANDARD_CODES];
        return send(route, inserted ? 201 : 200, { inserted });
      }
      return send(route, 404, { error: 'not_found' });
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
  if (width < 600) {
    const box = await page.locator('main h1').boundingBox();
    expect(box?.x).toBe(16);
  }
}

const stepItem = (page: Page, n: number) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
    });

for (const width of [1440, 390]) {
  test(`SS-PLAT-129: Company details: the Finance Admin follows step 1's link, saves the details and adds the first financial year @ ${String(width)} [T-0176]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 1)).toContainText('The legal name is missing');
    await stepItem(page, 1).getByRole('link', { name: 'Company details' }).click();
    await expect(page).toHaveURL(/\/settings\/company$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Company details' })).toBeVisible();
    await expect(page.getByText('No financial year yet.')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-129', `company-empty-${String(width)}`);

    await page.getByLabel('Legal name').fill('Harbour & Co Pty Ltd');
    await page.getByLabel('ABN').fill('51 824 753 556');
    await expect(page.getByLabel('Base currency')).toHaveValue('AUD');
    await page.getByRole('button', { name: 'Save company details' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Company details saved.' }),
    ).toBeVisible();

    await page.getByLabel('First month').selectOption({ label: 'July' });
    await page.getByLabel('Year it starts').fill('2026');
    await page.getByRole('button', { name: 'Add financial year' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'FY2027 added: 1 Jul 2026 to 30 Jun 2027' }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Financial years' })).toContainText('FY2027');
    await assertPage(page, width);
    await evidence('SS-PLAT-129', `company-saved-${String(width)}`);

    expect(f.writes).toEqual([
      {
        method: 'PUT',
        path: '/setup/company',
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: {
          company_id: CO,
          legal_name: 'Harbour & Co Pty Ltd',
          abn: '51 824 753 556',
          base_currency: 'AUD',
        },
      },
      {
        method: 'POST',
        path: '/setup/company/fiscal-years',
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: { company_id: CO, start: '2026-07-01' },
      },
    ]);
    expect(f.writes[0]?.key).not.toBe(f.writes[1]?.key);

    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 1)).toContainText('Nothing is missing');
    await expect(
      page.getByRole('button', { name: 'Complete step 1: Company details' }),
    ).toBeVisible();
    expect(f.company.abn).toBe(VALID_ABN);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-129: Tax settings: the Finance Admin follows step 3's link, chooses the GST basis and BAS frequency and adds the standard codes @ ${String(width)} [T-0176]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 3)).toContainText(
      'The GST accounting basis (cash or accrual) has not been set',
    );
    await stepItem(page, 3).getByRole('link', { name: 'Tax settings' }).click();
    await expect(page).toHaveURL(/\/settings\/tax$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tax settings' })).toBeVisible();
    await expect(page.getByText('Not set yet.')).toBeVisible();
    await expect(page.getByText('No tax codes yet.')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-129', `tax-empty-${String(width)}`);

    await page.getByRole('radio', { name: /^Accrual basis/ }).check();
    await page.getByRole('radio', { name: /^Quarterly/ }).check();
    await page.getByLabel('Applies from').fill('2026-07');
    await page.getByRole('button', { name: 'Save tax settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Tax settings saved.' })).toBeVisible();
    await expect(
      page.getByText('In force today: accrual basis, quarterly BAS, from 1 Jul 2026.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add the standard Australian tax codes' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: `${String(STANDARD_CODES.length)} tax codes added.` }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: 'Tax codes' });
    await expect(table.getByRole('row', { name: /GST on income and expenses/ })).toContainText(
      '10%',
    );
    await assertPage(page, width);
    await evidence('SS-PLAT-129', `tax-saved-${String(width)}`);

    expect(f.writes.map((w) => [w.method, w.path, w.body])).toEqual([
      [
        'PUT',
        '/setup/tax',
        {
          company_id: CO,
          effective_from: '2026-07-01',
          gst_basis: 'accrual',
          bas_frequency: 'quarterly',
        },
      ],
      ['POST', '/setup/tax/codes/standard', { company_id: CO }],
    ]);
    expect(f.writes.every((w) => (w.key ?? '').length >= 8)).toBe(true);

    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 3)).toContainText('Nothing is missing');
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-129: Company details refusals are said in plain words: ABN check, locked base currency, overlapping year [T-0176]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.company.fiscal_years.push({
    label: 'FY2027',
    start_date: '2026-07-01',
    end_date: '2027-06-30',
  });
  f.company.base_currency_locked = true;
  await open(page, '/settings/company', 1440);
  // Locked: shown read-only with the reason, and not sent as a change.
  await expect(page.getByLabel('Base currency')).toBeDisabled();
  await expect(page.getByText(/already has journal entries/)).toBeVisible();

  await page.getByLabel('Legal name').fill('Harbour & Co Pty Ltd');
  await page.getByLabel('ABN').fill('51824753557');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.getByRole('alert')).toContainText('This ABN does not pass the ABN check');

  await page.getByLabel('First month').selectOption({ label: 'January' });
  await page.getByLabel('Year it starts').fill('2027');
  await page.getByRole('button', { name: 'Add financial year' }).click();
  await expect(page.getByRole('alert').last()).toContainText(
    'would overlap a financial year the company already has',
  );
  // A year that is not four digits is not sent.
  await page.getByLabel('Year it starts').fill('27');
  await page.getByRole('button', { name: 'Add financial year' }).click();
  await expect(
    page.getByText('Choose the first month and write the year as four digits.'),
  ).toBeVisible();
  expect(f.writes.map((w) => w.path)).toEqual(['/setup/company', '/setup/company/fiscal-years']);
  expect(f.company.fiscal_years).toHaveLength(1);
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: Tax settings refusal is said in plain words and nothing is saved [T-0176]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.refuse.set('/setup/tax', {
    status: 400,
    body: {
      error: 'INVALID_TAX_SETTINGS',
      message: 'basFrequency must be monthly, quarterly or annual',
    },
  });
  await open(page, '/settings/tax', 1440);
  // Nothing chosen: the form says what is needed and sends nothing.
  await page.getByRole('button', { name: 'Save tax settings' }).click();
  await expect(
    page.getByText(
      'Choose how you account for GST, how often you lodge the BAS and the month they apply from.',
    ),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
  await page.getByRole('radio', { name: /^Cash basis/ }).check();
  await page.getByRole('radio', { name: /^Monthly/ }).check();
  await page.getByLabel('Applies from').fill('2026-08');
  await page.getByRole('button', { name: 'Save tax settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose the month the settings apply from');
  expect(f.tax.settings).toBeNull();
  await expect(page.getByText('Not set yet.')).toBeVisible();
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: an Accountant sees Company details read-only [T-0176]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'accountant');
  Object.assign(f.company, { legal_name: 'Harbour & Co Pty Ltd', abn: VALID_ABN });
  f.company.fiscal_years.push({
    label: 'FY2027',
    start_date: '2026-07-01',
    end_date: '2027-06-30',
  });
  await open(page, '/settings/company', 1440);
  await expect(page.getByText('Harbour & Co Pty Ltd')).toBeVisible();
  await expect(page.getByText('51 824 753 556')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Financial years' })).toContainText('FY2027');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save|Add/ })).toHaveCount(0);
  await expect(page.getByText(/Only the Owner or a Finance Admin can change/)).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-129', 'company-read-only-1440');
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: an Accountant sees Tax settings read-only [T-0176]', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  f.tax.settings = { effective_from: '2026-07-01', gst_basis: 'cash', bas_frequency: 'monthly' };
  f.tax.codes = [...STANDARD_CODES];
  await open(page, '/settings/tax', 1440);
  await expect(
    page.getByText('In force today: cash basis, monthly BAS, from 1 Jul 2026.'),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Tax codes' })).toContainText('GST-FREE');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save|Add/ })).toHaveCount(0);
  await expect(page.getByText(/Only the Owner or a Finance Admin can change/)).toBeVisible();
  await assertPage(page, 1440);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: without settings.read, Company details is forbidden [T-0176]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/company', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByLabel('Legal name')).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: without settings.read, Tax settings is forbidden [T-0176]', async ({ page }) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/tax', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Tax codes' })).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-129: both screens are listed on the Settings page [T-0176]', async ({ page }) => {
  await fakeApi(page, 'fa');
  await open(page, '/settings', 1440);
  await expect(page.getByRole('link', { name: 'Company details' })).toBeVisible();
  await page.getByRole('link', { name: 'Tax settings' }).click();
  await expect(page).toHaveURL(/\/settings\/tax$/);
});
