/**
 * Invoices screens (T-0083, UC-01, SS-UC01-10, DL-0407): the AR Clerk lists invoices, opens a
 * draft, sees its lines as entered and clicks "Show me the journal" to see the posting engine's
 * preview (GP-001). The app is served by Vite; the API is faked per test with `page.route` using the
 * response shapes of GET /companies and GET /ar/invoices[/:id[/journal]] (apps/api, T-0131).
 */
import { mkdtempSync } from 'node:fs';
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
const CO = id(0x83c1);
const ACME = id(0x83a1);
const DRAFT = id(0x8301);
const POSTED = id(0x8302);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0083', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  clerk: { user_id: id(0x8311), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  sales: { user_id: id(0x8312), display_name: 'Sam Reyes', role: 'sales_user' as const },
};

const LIST = [
  {
    id: DRAFT,
    invoice_no: null,
    status: 'draft',
    party_id: ACME,
    party_name: 'Acme Pty Ltd',
    issue_date: '2026-11-05',
    due_date: '2026-11-19',
    gross_total: null,
  },
  {
    id: POSTED,
    invoice_no: 'INV-000122',
    status: 'posted',
    party_id: ACME,
    party_name: 'Acme Pty Ltd',
    issue_date: '2026-11-01',
    due_date: '2026-11-15',
    gross_total: '440.0000',
  },
];
const DETAIL = {
  id: DRAFT,
  invoice_no: null,
  status: 'draft',
  kind: 'standard',
  pricing: 'exclusive',
  party_id: ACME,
  party_name: 'Acme Pty Ltd',
  issue_date: '2026-11-05',
  due_date: '2026-11-19',
  entry_id: null,
  net_total: null,
  tax_total: null,
  gross_total: null,
  warnings: [],
  lines: [
    {
      line_no: 1,
      description: 'Professional services',
      quantity: '1.0000',
      unit_price: '1000.0000',
      tax_code: null,
      net: null,
      tax: null,
      gross: null,
    },
    {
      line_no: 2,
      description: 'Subscription',
      quantity: '1.0000',
      unit_price: '250.0000',
      tax_code: null,
      net: null,
      tax: null,
      gross: null,
    },
  ],
};
/** GP-001 as the engine previews it (T-0131 previewInvoiceJournal). */
const PREVIEW = {
  entry_date: '2026-11-05',
  requested_date: '2026-11-05',
  redirected: false,
  needs_override: false,
  base_currency: 'AUD',
  total: '1375.0000',
  lines: [
    {
      line_no: 1,
      account_id: id(0x8321),
      account_code: '1200',
      account_type: 'asset',
      account_name: 'Trade debtors',
      debit: '1375.0000',
      credit: '0.0000',
      party_id: ACME,
    },
    {
      line_no: 2,
      account_id: id(0x8322),
      account_code: '4110',
      account_type: 'revenue',
      account_name: 'Professional services',
      debit: '0.0000',
      credit: '1000.0000',
      party_id: ACME,
    },
    {
      line_no: 3,
      account_id: id(0x8323),
      account_code: '4120',
      account_type: 'revenue',
      account_name: 'Subscriptions',
      debit: '0.0000',
      credit: '250.0000',
      party_id: ACME,
    },
    {
      line_no: 4,
      account_id: id(0x8324),
      account_code: '2310',
      account_type: 'liability',
      account_name: 'GST collected',
      debit: '0.0000',
      credit: '125.0000',
      party_id: null,
    },
  ],
};

interface Fake {
  errors: string[];
  previewCalls: number;
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], previewCalls: 0, override: new Map() };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|ar)(\/|$)/.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const o = f.override.get(path);
      if (o) return send(route, o.status, o.body);
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
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      expect(url.searchParams.get('company_id')).toBe(CO);
      if (path === '/ar/invoices') {
        const st = url.searchParams.get('status');
        return send(route, 200, { invoices: LIST.filter((i) => !st || i.status === st) });
      }
      if (path === `/ar/invoices/${DRAFT}`) return send(route, 200, DETAIL);
      if (path === `/ar/invoices/${DRAFT}/journal`) {
        f.previewCalls += 1;
        return send(route, 200, PREVIEW);
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
  for (const cell of await page.locator('main [data-amount]').all()) {
    expect(await cell.getAttribute('data-amount')).toMatch(/^-?\d+\.\d{2}$/);
  }
}

for (const width of [1440, 390]) {
  test(`SS-UC01-10: Invoice detail shows mapped lines and journal preview @ ${String(width)} [T-0083]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, '/sales/invoices', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible();
    const list = page.getByRole('table', { name: 'Invoices' });
    await expect(list.getByRole('row')).toHaveCount(3);
    await expect(list.getByRole('row').nth(1)).toContainText('Draft');
    await expect(list.getByRole('row').nth(2)).toContainText('INV-000122');
    await assertPage(page, width);
    await evidence('SS-UC01-10', `invoice-list-${String(width)}`);

    await list.getByRole('link', { name: /Draft invoice for Acme Pty Ltd/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Draft invoice' })).toBeVisible();
    const lines = page.getByRole('table', { name: 'Invoice lines' });
    await expect(lines.getByRole('row')).toHaveCount(3);
    await expect(lines.getByRole('row').nth(1)).toContainText('Professional services');
    await expect(lines.getByRole('row').nth(2)).toContainText('Subscription');
    expect(f.previewCalls).toBe(0);

    await page.getByRole('button', { name: 'Show me the journal' }).click();
    const journal = page.getByRole('region', { name: 'Journal' });
    const table = journal.getByRole('table', { name: 'Journal preview' });
    await expect(table.getByRole('row').nth(1)).toContainText('1200');
    await expect(table.getByRole('row').nth(1)).toContainText('Trade debtors');
    await expect(table.getByRole('row').nth(4)).toContainText('GST collected');
    const amounts = await table
      .locator('tbody [data-amount]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount')));
    expect(amounts).toEqual(['1375.00', '1000.00', '250.00', '125.00']);
    await expect(journal).toContainText('Nothing is posted yet.');
    expect(f.previewCalls).toBe(1);
    await assertPage(page, width);
    await evidence('SS-UC01-10', `invoice-journal-preview-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0083: a user without ar.read is told so, and nothing is listed', async ({ page }) => {
  const f = await fakeApi(page, 'sales');
  await open(page, '/sales/invoices', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Invoices' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0083: a refused preview explains why and posts nothing', async ({ page }) => {
  const f = await fakeApi(page, 'clerk');
  f.override.set(`/ar/invoices/${DRAFT}/journal`, {
    status: 422,
    body: { error: 'PROFILE_GAP', message: 'line 2: no revenue account for SUBSCRIPTION' },
  });
  await open(page, `/sales/invoices/${DRAFT}`, 1440);
  await page.getByRole('button', { name: 'Show me the journal' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'line 2: no revenue account for SUBSCRIPTION',
  );
  await expect(page.getByRole('table', { name: 'Journal preview' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
