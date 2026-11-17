/**
 * Posting-profile matrix screen (T-0188, design §4.4, IA S13, mockup 08, ADR-0082, SS-PLAT-134).
 * The Finance Admin sees which account each customer or supplier type × product type posts to:
 * the product default, an override, or a gap. They fill a gap by choosing an account, and the
 * gap leaves the wizard's step 7 missing list.
 * Vite serves the app. Each test fakes the API with `page.route`, using the response shapes of
 * apps/api/src/setup/posting-profiles.controller.ts (T-0187) and GET /setup/wizard (ADR-0075).
 * The fake resolves cells the way the module does for the cases used here (override, else the
 * product default, else a gap). The browser resolves nothing.
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
const CO = id(0x188c);
const FRAN = id(0x1881);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0188', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: FRAN, display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1882), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1883), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

interface Acct {
  id: string;
  code: string;
  name: string;
}
const A = (n: number, code: string, name: string): Acct => ({ id: id(0x1900 + n), code, name });
const AR = A(1, '1200', 'Trade debtors');
const AP = A(2, '2000', 'Trade creditors');
const SERVICES = A(3, '4110', 'Professional services');
const SUBS = A(4, '4120', 'Subscriptions');
const EXPORT_SUBS = A(5, '4160', 'Export subscriptions');
const SOFTWARE = A(6, '6310', 'Software and subscriptions');
const CONTRACTORS = A(7, '6200', 'Contractors');
const PURCHASES = A(8, '5100', 'Cost of goods sold');
const CHOICES = [
  { ...SERVICES, type: 'revenue' },
  { ...SUBS, type: 'revenue' },
  { ...EXPORT_SUBS, type: 'revenue' },
  { ...PURCHASES, type: 'expense' },
  { ...CONTRACTORS, type: 'expense' },
  { ...SOFTWARE, type: 'expense' },
];

const PARTIES = [
  ['DOMESTIC_CUSTOMER', 'Domestic customer', 'customer', AR, 'GST'],
  ['DOMESTIC_SUPPLIER', 'Domestic supplier', 'supplier', AP, 'GST'],
  ['OVERSEAS_CUSTOMER', 'Overseas customer', 'customer', AR, 'GST-FREE-EXPORT'],
].map(([code, name, kind, control, tax], i) => ({
  id: id(0x1a00 + i),
  code: code as string,
  name: name as string,
  kind: kind as 'customer' | 'supplier',
  control_account: control as Acct,
  default_tax_code: tax as string,
}));
/** Hardware's revenue account was archived: every customer × Hardware sale is a gap. */
const PRODUCTS = [
  ['HARDWARE', 'Hardware', null, null, PURCHASES],
  ['PROFESSIONAL_SERVICES', 'Professional services', SERVICES, CONTRACTORS, null],
  ['SUBSCRIPTION', 'Subscription', SUBS, SOFTWARE, null],
].map(([code, name, revenue, expense, cogs], i) => ({
  id: id(0x1b00 + i),
  code: code as string,
  name: name as string,
  revenue_account: revenue as Acct | null,
  expense_account: expense as Acct | null,
  cogs_account: cogs as Acct | null,
  default_tax_code: 'GST',
}));
const pid = (code: string) => PARTIES.find((x) => x.code === code)?.id ?? '';
const prid = (code: string) => PRODUCTS.find((x) => x.code === code)?.id ?? '';

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

interface Put {
  key: string | null;
  body: Record<string, unknown>;
}
interface Fake {
  errors: string[];
  puts: Put[];
  matrixGets: number;
  /** party id:product id → revenue/expense account id */
  overrides: Map<string, string>;
  refuse: { status: number; body: unknown } | null;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    puts: [],
    matrixGets: 0,
    // Overseas customers' subscriptions go to the export subscriptions account.
    overrides: new Map([[`${pid('OVERSEAS_CUSTOMER')}:${prid('SUBSCRIPTION')}`, EXPORT_SUBS.id]]),
    refuse: null,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const byId = new Map(CHOICES.map((c) => [c.id, { id: c.id, code: c.code, name: c.name }]));
  const cells = () =>
    PARTIES.flatMap((party) =>
      PRODUCTS.map((product) => {
        const sale = party.kind === 'customer';
        const o = f.overrides.get(`${party.id}:${product.id}`);
        const fallback = sale
          ? product.revenue_account
          : (product.expense_account ?? product.cogs_account);
        const account = o ? (byId.get(o) ?? null) : fallback;
        const base = {
          party_profile_id: party.id,
          product_profile_id: product.id,
          purpose: sale ? 'sale' : 'purchase',
          override: o !== undefined,
        };
        if (!account)
          return {
            ...base,
            account: null,
            account_source: null,
            tax_code: null,
            tax_code_source: null,
            gap: { reason: 'account', message: `${product.code} has no revenue account` },
          };
        const tax = party.default_tax_code === 'GST' ? 'GST' : party.default_tax_code;
        return {
          ...base,
          account,
          account_source: o ? 'override' : 'product',
          tax_code: tax,
          tax_code_source: tax === 'GST' ? 'product' : 'party',
          gap: null,
        };
      }),
    );
  const gapLines = () =>
    cells()
      .filter((c) => c.gap)
      .map((c) => {
        const party = PARTIES.find((x) => x.id === c.party_profile_id)?.code ?? '';
        const product = PRODUCTS.find((x) => x.id === c.product_profile_id)?.code ?? '';
        return `Posting-profile gap: ${party} × ${product} (${c.purpose}): ${c.gap?.message ?? ''}`;
      });
  const step = (n: number) => {
    const done = n <= 6;
    const missing = n === 7 ? gapLines() : [];
    return {
      step: n,
      title: TITLES[n - 1],
      status: done ? 'complete' : n === 7 ? 'in_progress' : 'not_started',
      locked: n > 7,
      valid: missing.length === 0,
      missing,
      outcome: done ? 'validated' : null,
      reason: null,
      completed_at: done ? '2026-11-13T23:00:00.000Z' : null,
      completed_by: done ? FRAN : null,
    };
  };
  await page.route(
    (url) =>
      url.origin === origin &&
      /^\/(auth|companies|setup|posting-profiles)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
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
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (path === '/setup/wizard' && req.method() === 'GET')
        return (
          need('settings.read') ??
          send(route, 200, {
            company_id: CO,
            as_of: '2026-11-15',
            complete: false,
            steps: TITLES.map((_, i) => step(i + 1)),
          })
        );
      if (path === '/posting-profiles/matrix' && req.method() === 'GET') {
        const denied = need('settings.read');
        if (denied) return denied;
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.matrixGets += 1;
        return send(route, 200, {
          company_id: CO,
          as_of: '2026-11-15',
          parties: PARTIES,
          products: PRODUCTS,
          cells: cells(),
          choices: CHOICES,
        });
      }
      if (path === '/posting-profiles/overrides' && req.method() === 'PUT') {
        const denied = need('settings.chart.manage');
        if (denied) return denied;
        const body = req.postDataJSON() as Record<string, unknown>;
        f.puts.push({ key: req.headers()['idempotency-key'] ?? null, body });
        if (f.refuse) return send(route, f.refuse.status, f.refuse.body);
        const k = `${String(body['party_profile_id'])}:${String(body['product_profile_id'])}`;
        const acct = body['revenue_account_id'] ?? body['expense_account_id'];
        const changed = f.overrides.get(k) !== acct;
        if (typeof acct === 'string') f.overrides.set(k, acct);
        return send(route, 200, {
          party_profile_id: body['party_profile_id'],
          product_profile_id: body['product_profile_id'],
          revenue_account_id: body['revenue_account_id'] ?? null,
          expense_account_id: body['expense_account_id'] ?? null,
          cogs_account_id: null,
          discount_account_id: null,
          tax_code: null,
          changed,
        });
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
}

const stepItem = (page: Page, n: number) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
    });
const SALES = 'Sales: income account by customer type and product type';
const PURCHASES_T = 'Purchases: expense account by supplier type and product type';
/** The cell of a row (party name) and column (0 = Hardware, 1 = Professional services, 2 = Subscription). */
const cell = (page: Page, table: string, party: string, col: number) =>
  page
    .getByRole('table', { name: table })
    .getByRole('row', { name: new RegExp(`^${party}`) })
    .getByRole('cell')
    .nth(col);

for (const width of [1440, 390]) {
  test(`SS-PLAT-134: Posting-profile matrix marks defaults, overrides and gaps, and a filled gap leaves step 7 @ ${String(width)} [T-0188]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 7)).toContainText('DOMESTIC_CUSTOMER × HARDWARE');
    await expect(stepItem(page, 7)).toContainText('OVERSEAS_CUSTOMER × HARDWARE');
    await stepItem(page, 7).getByRole('link', { name: 'Posting profiles' }).click();
    await expect(page).toHaveURL(/\/accounting\/posting-profiles$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Posting profiles' })).toBeVisible();
    await expect(
      page.getByText('2 gaps: a document that needs one of them cannot post.'),
    ).toBeVisible();
    await expect(cell(page, SALES, 'Domestic customer', 1)).toContainText('Default');
    await expect(cell(page, SALES, 'Domestic customer', 1)).toContainText('4110');
    await expect(cell(page, SALES, 'Overseas customer', 2)).toContainText('Override');
    await expect(cell(page, SALES, 'Overseas customer', 2)).toContainText('4160');
    await expect(cell(page, SALES, 'Domestic customer', 0)).toContainText('Gap');
    await expect(cell(page, PURCHASES_T, 'Domestic supplier', 0)).toContainText('5100');
    await assertPage(page, width);
    await evidence('SS-PLAT-134', `matrix-defaults-overrides-gaps-${String(width)}`);

    await page.getByRole('button', { name: 'Fill the gap: Domestic customer × Hardware' }).click();
    const panel = page.getByRole('region', { name: 'Fill the gap: Domestic customer × Hardware' });
    await expect(panel).toContainText('HARDWARE has no revenue account');
    await panel.getByLabel('Income account').selectOption({ label: '4110 Professional services' });
    await assertPage(page, width);
    await evidence('SS-PLAT-134', `matrix-fill-gap-choose-${String(width)}`);
    await panel.getByRole('button', { name: 'Use this account' }).click();
    await expect(
      page.getByText('Domestic customer × Hardware now posts to 4110 Professional services.'),
    ).toBeVisible();
    await expect(cell(page, SALES, 'Domestic customer', 0)).toContainText('Override');
    await expect(cell(page, SALES, 'Domestic customer', 0)).toContainText('4110');
    await expect(page.getByText('1 gap: a document that needs it cannot post.')).toBeVisible();
    expect(f.puts).toHaveLength(1);
    expect(f.puts[0]).toEqual({
      key: expect.stringMatching(/^.{8,}$/) as unknown,
      body: {
        company_id: CO,
        party_profile_id: pid('DOMESTIC_CUSTOMER'),
        product_profile_id: prid('HARDWARE'),
        revenue_account_id: SERVICES.id,
      },
    });
    await assertPage(page, width);
    await evidence('SS-PLAT-134', `matrix-gap-filled-${String(width)}`);

    await page.getByRole('link', { name: 'Back to the setup steps' }).click();
    await expect(page).toHaveURL(/\/settings\/setup$/);
    await expect(stepItem(page, 7)).not.toContainText('DOMESTIC_CUSTOMER × HARDWARE');
    await expect(stepItem(page, 7)).toContainText('OVERSEAS_CUSTOMER × HARDWARE');
    await assertPage(page, width);
    await evidence('SS-PLAT-134', `wizard-step-7-one-gap-left-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-134: a refused account is explained, and the gap stays [T-0188]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  f.refuse = {
    status: 422,
    body: {
      error: 'PROFILE_ACCOUNT',
      message:
        'profile override: revenue account 4110 must be a postable revenue account of this company',
    },
  };
  await open(page, '/accounting/posting-profiles', 1440);
  await page.getByRole('button', { name: 'Fill the gap: Overseas customer × Hardware' }).click();
  const panel = page.getByRole('region', { name: 'Fill the gap: Overseas customer × Hardware' });
  // Nothing is sent until an account is chosen.
  await panel.getByRole('button', { name: 'Use this account' }).click();
  await expect(panel.getByText('Choose an account first.')).toBeVisible();
  expect(f.puts).toEqual([]);
  await panel.getByLabel('Income account').selectOption({ label: '4110 Professional services' });
  await panel.getByRole('button', { name: 'Use this account' }).click();
  await expect(panel.getByRole('alert')).toContainText(
    'LedgerForce did not accept this account: profile override: revenue account 4110 must be a postable revenue account of this company.',
  );
  await expect(cell(page, SALES, 'Overseas customer', 0)).toContainText('Gap');
  await expect(
    page.getByText('2 gaps: a document that needs one of them cannot post.'),
  ).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-134', 'matrix-fill-refused-1440');
  // A retry of the same choice keeps its key, so a lost answer cannot apply twice.
  await panel.getByRole('button', { name: 'Use this account' }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(f.puts).toHaveLength(2);
  expect(f.puts[0]?.key).toBe(f.puts[1]?.key);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-134: an Accountant sees the matrix without actions [T-0188]', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/accounting/posting-profiles', 1440);
  await expect(page.getByRole('table', { name: SALES })).toBeVisible();
  await expect(cell(page, SALES, 'Domestic customer', 0)).toContainText('Gap');
  await expect(page.getByRole('button', { name: /^Fill the gap/ })).toHaveCount(0);
  await expect(page.getByText(/The Owner or a Finance Admin fills gaps/)).toBeVisible();
  await assertPage(page, 1440);
  expect(f.puts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-134: a user without settings.read is told so, and the matrix is not read [T-0188]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/accounting/posting-profiles', 1440);
  await expect(
    page.getByRole('heading', { name: "You can't see the posting profiles" }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: SALES })).toHaveCount(0);
  expect(f.matrixGets).toBe(0);
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});
