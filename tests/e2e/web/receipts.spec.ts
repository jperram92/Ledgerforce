/**
 * Receipt allocation screen (T-0085, UC-03, SS-UC03-10, DL-0492): the AR Clerk sees the receipts
 * waiting to be allocated, picks one, chooses the customer's open invoice and allocates; the
 * invoice then reads Paid. The app is served by Vite; the API is faked per test with `page.route`
 * using the response shapes of GET /ar/receipts, POST /ar/receipts/:id/allocations,
 * GET /ar/invoices and GET /ar/invoices/:id/payment-status (apps/api, T-0046, T-0151).
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
const CO = id(0x85c1);
const ACME = id(0x85a1);
const OTHER = id(0x85a2);
const INV = id(0x8501);
const INV_OTHER = id(0x8502);
const RCT = id(0x8511);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0085', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  clerk: { user_id: id(0x8531), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  sales: { user_id: id(0x8532), display_name: 'Sam Reyes', role: 'sales_user' as const },
};

const RECEIPT = {
  id: RCT,
  receipt_no: 'RCT-000041',
  party_id: ACME,
  party_name: 'Acme Pty Ltd',
  receipt_date: '2026-11-15',
  method: 'eft',
  reference: 'EFT 4471',
  amount: '1375.0000',
  unallocated: '1375.0000',
};
const INVOICES = [
  {
    id: INV,
    invoice_no: 'INV-000123',
    status: 'posted',
    party_id: ACME,
    party_name: 'Acme Pty Ltd',
    issue_date: '2026-11-05',
    due_date: '2026-11-19',
    gross_total: '1375.0000',
  },
  {
    id: INV_OTHER,
    invoice_no: 'INV-000124',
    status: 'posted',
    party_id: OTHER,
    party_name: 'Bay Traders',
    issue_date: '2026-11-06',
    due_date: '2026-11-20',
    gross_total: '550.0000',
  },
];

interface Fake {
  errors: string[];
  allocations: { body: unknown; key: string | null }[];
  allocated: boolean;
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], allocations: [], allocated: false, override: new Map() };
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
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const o = f.override.get(`${req.method()} ${path}`);
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
      if (req.method() === 'POST' && path === `/ar/receipts/${RCT}/allocations`) {
        if (!perms.includes('ar.receipt.record'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.receipt.record' });
        f.allocations.push({
          body: req.postDataJSON(),
          key: req.headers()['idempotency-key'] ?? null,
        });
        f.allocated = true;
        return send(route, 200, {
          id: RCT,
          receipt_no: 'RCT-000041',
          entry_id: id(0x8541),
          replayed: false,
          amount: '1375.0000',
          unallocated: '0.0000',
        });
      }
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      expect(url.searchParams.get('company_id')).toBe(CO);
      if (path === '/ar/receipts') {
        expect(url.searchParams.get('unallocated')).toBe('true');
        return send(route, 200, { receipts: f.allocated ? [] : [RECEIPT] });
      }
      if (path === '/ar/invoices') {
        expect(url.searchParams.get('status')).toBe('posted');
        return send(route, 200, { invoices: INVOICES });
      }
      if (path === `/ar/invoices/${INV}/payment-status`)
        return send(
          route,
          200,
          f.allocated
            ? { status: 'paid', open: '0.0000' }
            : { status: 'unpaid', open: '1375.0000' },
        );
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
  if (width < 600) {
    // 16px gutter at the narrow width: main's content starts at least 16px from each edge.
    const box = await page.locator('main h1').boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(16);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 16);
  }
}

for (const width of [1440, 390]) {
  test(`SS-UC03-10: Receipt allocation screen @ ${String(width)} [T-0085]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, '/sales/receipts', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
    const list = page.getByRole('table', { name: 'Receipts waiting to be allocated' });
    await expect(list.getByRole('row')).toHaveCount(2);
    await expect(list.getByRole('row').nth(1)).toContainText('RCT-000041');
    await expect(list.getByRole('row').nth(1)).toContainText('Acme Pty Ltd');
    expect(
      await list
        .locator('tbody [data-amount]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount'))),
    ).toEqual(['1375.00', '1375.00']);
    await assertPage(page, width);
    await evidence('SS-UC03-10', `receipts-waiting-${String(width)}`);

    await list.getByRole('button', { name: 'Allocate RCT-000041' }).click();
    const form = page.getByRole('region', { name: 'Allocate RCT-000041' });
    const invoice = form.getByLabel('Invoice');
    // Only this customer's invoices are offered.
    await expect(invoice.getByRole('option')).toHaveText(['INV-000123, due 2026-11-19']);
    await expect(form.getByLabel('Amount')).toHaveValue('1375.00');
    await expect(form.getByLabel('Date')).toHaveValue('2026-11-15');
    await expect(form).toContainText('Unpaid');
    await assertPage(page, width);
    await evidence('SS-UC03-10', `receipt-allocate-form-${String(width)}`);

    await form.getByRole('button', { name: 'Allocate to INV-000123' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'INV-000123' })).toContainText(
      'INV-000123 is now Paid',
    );
    expect(f.allocations).toHaveLength(1);
    expect(f.allocations[0]?.body).toEqual({
      company_id: CO,
      invoice_id: INV,
      amount: '1375.00',
      allocation_date: '2026-11-15',
    });
    expect(f.allocations[0]?.key).toMatch(/^alloc-/);
    await expect(page.getByRole('table', { name: 'Receipts waiting to be allocated' })).toHaveCount(
      0,
    );
    await expect(page.getByText('No receipts waiting')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC03-10', `invoice-paid-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0085: an allocation the ledger refuses explains why and the invoice stays unpaid', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  f.override.set(`POST /ar/receipts/${RCT}/allocations`, {
    status: 422,
    body: {
      error: 'OVER_ALLOCATED',
      message: "allocation 1500.0000 exceeds the receipt's unallocated 1375.0000",
    },
  });
  await open(page, '/sales/receipts', 1440);
  await page.getByRole('button', { name: 'Allocate RCT-000041' }).click();
  const form = page.getByRole('region', { name: 'Allocate RCT-000041' });
  await form.getByLabel('Amount').fill('1500.00');
  await form.getByRole('button', { name: 'Allocate to INV-000123' }).click();
  await expect(form.getByRole('alert')).toContainText('exceeds the receipt');
  await expect(page.getByText('is now Paid')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Receipts waiting to be allocated' })).toHaveCount(
    1,
  );
  expect(f.errors).toEqual([]);
});

test('T-0085: a user without ar.read is told so, and no receipt is listed', async ({ page }) => {
  const f = await fakeApi(page, 'sales');
  await open(page, '/sales/receipts', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Receipts waiting to be allocated' })).toHaveCount(
    0,
  );
  expect(f.errors).toEqual([]);
});
