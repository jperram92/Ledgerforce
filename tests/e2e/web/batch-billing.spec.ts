/**
 * Batch billing screens (T-0084, UC-02, SS-UC02-08): the AR Clerk previews November for 40
 * customers, sees the totals and the exception list (one customer has no Billing To contact), the
 * Approver approves, and after the job ran the exception list holds the one invoice that failed
 * while the other 39 posted (the SS-UC02-03 batch). The app is served by Vite; the API is faked per
 * test with `page.route` using the response shapes of POST /ar/batches/preview, GET /ar/batches/:id
 * and POST /ar/batches/:id/approve (apps/api, T-0043/T-0044/T-0084).
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
const CO = id(0x84c1);
const BATCH = id(0x8401);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0084', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  clerk: { user_id: id(0x8411), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  approver: { user_id: id(0x8412), display_name: 'Mei Tan', role: 'approver' as const },
  auditor: { user_id: id(0x8413), display_name: 'Ari Patel', role: 'auditor' as const },
  sales: { user_id: id(0x8414), display_name: 'Sam Reyes', role: 'sales_user' as const },
};
type Who = keyof typeof ME;

/** Test data only: fixed-point text from whole cents (BigInt, never floating point). */
const money = (cents: bigint) => {
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}00`;
};
const NAMES = [
  'Acme Pty Ltd',
  'Banksia Bakery',
  'Bondi Coastal Physio',
  'Coral Bay Tourism',
  'Daintree Coffee Co',
  'Emu Plains Joinery',
  'Flinders Freight Co',
  'Gidgee Design',
  'Hawkesbury Nurseries',
  'Ironbark Legal',
  'Jarrah Joinery',
  'Kestrel Logistics Pty Ltd',
  'Lighthouse Learning',
  'Mallee Motors',
  'Murray River Organics',
  'Ningaloo Dive',
  'Otway Brewing',
  'Pinnacle Dental Group',
  'Quokka Creative',
  'Redgum Ventures',
  'Saltbush Studio',
  'Tasman Tiles',
  'Uluru Outfitters',
  'Victor Harbor Vets',
  'Wattle Accounting',
  'Xanthorrhoea Gardens',
  'Yarra Valley Wines',
  'Zigzag Printing',
  'Arnhem Air',
  'Barossa Barrels',
  'Cockatoo Cleaning',
  'Dandenong Dental',
  'Eyre Peninsula Fishing',
  'Fremantle Fitness',
  'Gippsland Grain',
  'Hobart Hardware',
  'Illawarra IT',
  'Jindabyne Lodge',
  'Kimberley Kitchens',
  'Launceston Labels',
];
const LIGHTHOUSE = 13;
const ITEMS = NAMES.map((name, k) => {
  const net = 100000n + BigInt(k) * 2500n;
  const tax = net / 10n;
  return { item_no: k + 1, party_id: id(0x8500 + k), party_name: name, net, tax, gross: net + tax };
});
const sum = (f: (i: (typeof ITEMS)[number]) => bigint) => ITEMS.reduce((s, i) => s + f(i), 0n);
const NO_BILLING_TO = 'the customer has no active Billing To contact with an email address';

type BatchStatus = 'preview' | 'approved' | 'posted';
function batch(status: BatchStatus, replayed = false) {
  const ran = status === 'posted';
  const items = ITEMS.map((i) => {
    const bad = i.item_no === LIGHTHOUSE;
    return {
      item_no: i.item_no,
      party_id: i.party_id,
      party_name: i.party_name,
      line_count: 1 + (i.item_no % 3),
      net: money(i.net),
      tax: money(i.tax),
      gross: money(i.gross),
      warnings: bad ? [{ code: 'NO_BILLING_TO', line: 0, message: NO_BILLING_TO }] : [],
      status: !ran ? 'preview' : bad ? 'failed' : 'posted',
      invoice_no: ran && !bad ? `INV-${String(1100 + i.item_no).padStart(6, '0')}` : null,
      failure_code: ran && bad ? 'NO_BILLING_TO' : null,
      failure_message: ran && bad ? NO_BILLING_TO : null,
    };
  });
  const posted = ITEMS.filter((i) => ran && i.item_no !== LIGHTHOUSE);
  return {
    id: BATCH,
    replayed,
    status,
    period_from: '2026-11-01',
    period_to: '2026-11-30',
    issue_date: '2026-11-30',
    items,
    totals: {
      invoices: 40,
      ready: 39,
      net: money(sum((i) => i.net)),
      tax: money(sum((i) => i.tax)),
      gross: money(sum((i) => i.gross)),
    },
    outcome: {
      posted: posted.length,
      failed: ran ? 1 : 0,
      posted_gross: money(posted.reduce((s, i) => s + i.gross, 0n)),
    },
  };
}
const TOTAL_GROSS = money(sum((i) => i.gross));
const POSTED_GROSS = money(sum((i) => (i.item_no === LIGHTHOUSE ? 0n : i.gross)));

interface Fake {
  who: Who;
  status: BatchStatus;
  errors: string[];
  previews: { key: string | null; body: unknown }[];
  approvals: number;
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: Who, status: BatchStatus = 'preview'): Promise<Fake> {
  const f: Fake = { who, status, errors: [], previews: [], approvals: 0, override: new Map() };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, code: number, body: unknown) =>
    route.fulfill({ status: code, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|ar)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const me = ME[f.who];
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
      if (req.method() === 'POST' && path === '/ar/batches/preview') {
        if (!perms.includes('ar.batch.run'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.batch.run' });
        f.previews.push({ key: req.headers()['idempotency-key'] ?? null, body: req.postDataJSON() });
        return send(route, 201, batch('preview'));
      }
      if (req.method() === 'POST' && path === `/ar/batches/${BATCH}/approve`) {
        if (!perms.includes('ar.batch.approve'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.batch.approve' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.approvals += 1;
        f.status = 'approved';
        return send(route, 200, batch('approved'));
      }
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      if (req.method() === 'GET' && path === `/ar/batches/${BATCH}`) {
        expect(url.searchParams.get('company_id')).toBe(CO);
        return send(route, 200, batch(f.status));
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
  for (const s of await page.locator('main [data-status]').all()) {
    expect((await s.textContent())?.trim()).not.toBe('');
  }
}

const amountsIn = (page: Page, name: string) =>
  page
    .getByRole('region', { name })
    .locator('[data-amount]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount')));

for (const width of [1440, 390]) {
  test(`SS-UC02-08: Batch screens show preview and exception list @ ${String(width)} [T-0084]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');

    // The AR Clerk asks for a preview of November.
    await open(page, '/sales/batches', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Batch billing' })).toBeVisible();
    await page.getByLabel('From').fill('2026-11-01');
    await page.getByLabel('To', { exact: true }).fill('2026-11-30');
    await assertPage(page, width);
    await evidence('SS-UC02-08', `batch-start-${String(width)}`);
    await page.getByRole('button', { name: 'Preview the invoices' }).click();

    // Preview: totals, the exception list and every invoice; nothing is posted.
    await expect(page).toHaveURL(new RegExp(`/sales/batches/${BATCH}$`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'November 2026 batch' }),
    ).toBeVisible();
    expect(f.previews).toHaveLength(1);
    expect(f.previews[0]?.key).toMatch(/^bb-[0-9a-f-]{36}$/);
    expect(f.previews[0]?.body).toEqual({
      company_id: CO,
      period_from: '2026-11-01',
      period_to: '2026-11-30',
    });
    const totals = page.getByRole('region', { name: 'Totals' });
    await expect(totals).toContainText('39 of 40');
    expect(await amountsIn(page, 'Totals')).toEqual([
      batch('preview').totals.net.slice(0, -2),
      batch('preview').totals.tax.slice(0, -2),
      TOTAL_GROSS.slice(0, -2),
    ]);
    const exceptions = page.getByRole('table', { name: 'Exceptions' });
    await expect(exceptions.getByRole('row')).toHaveCount(2);
    await expect(exceptions.getByRole('row').nth(1)).toContainText('Lighthouse Learning');
    await expect(exceptions.getByRole('row').nth(1)).toContainText(NO_BILLING_TO_SENTENCE);
    await expect(exceptions.getByRole('row').nth(1)).toContainText('the other invoices still post');
    const invoices = page.getByRole('table', { name: 'Invoices in this batch' });
    await expect(invoices.getByRole('row')).toHaveCount(41);
    await expect(invoices.getByRole('row').nth(13)).toContainText('Needs attention');
    await expect(invoices.getByRole('row').nth(1)).toContainText('Ready');
    await expect(page.getByText('Nothing is posted yet.')).toBeVisible();
    // The clerk cannot approve: the page says whose turn it is instead (P6, P13).
    await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(page.getByText(/Waiting for approval/)).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC02-08', `batch-preview-exceptions-${String(width)}`);

    // The Approver approves; one job will post every invoice on its own.
    f.who = 'approver';
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'November 2026 batch' }),
    ).toBeVisible();
    const approve = page.getByRole('button', { name: 'Approve and post 39 invoices' });
    await expect(approve).toBeVisible();
    await assertPage(page, width);
    await approve.click();
    await expect(page.getByRole('status').filter({ hasText: 'Approved' })).toBeVisible();
    expect(f.approvals).toBe(1);
    await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-UC02-08', `batch-approved-${String(width)}`);

    // After the job: 39 posted with their numbers, one in the exception list with its reason.
    f.status = 'posted';
    f.who = 'clerk';
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'November 2026 batch' }),
    ).toBeVisible();
    await expect(totals).toContainText('39 of 40 posted');
    expect(await amountsIn(page, 'Totals')).toContain(POSTED_GROSS.slice(0, -2));
    await expect(exceptions.getByRole('row')).toHaveCount(2);
    await expect(exceptions.getByRole('row').nth(1)).toContainText('Lighthouse Learning');
    await expect(exceptions.getByRole('row').nth(1)).toContainText('Failed');
    await expect(exceptions.getByRole('row').nth(1)).toContainText(NO_BILLING_TO_SENTENCE);
    await expect(exceptions.getByRole('row').nth(1)).toContainText('next batch');
    await expect(invoices.getByRole('row').nth(1)).toContainText('INV-001101');
    await expect(invoices.getByRole('row').nth(13)).toContainText('Failed');
    await assertPage(page, width);
    await evidence('SS-UC02-08', `batch-posted-exceptions-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0084: someone without ar.batch.run is told who can run a batch, and nothing is sent', async ({
  page,
}) => {
  const f = await fakeApi(page, 'auditor');
  await open(page, '/sales/batches', 1440);
  await expect(page.getByText(/can preview a batch/)).toBeVisible();
  await expect(page.getByText(/AR Clerk/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview the invoices' })).toHaveCount(0);
  expect(f.previews).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0084: someone without ar.read cannot open a batch', async ({ page }) => {
  const f = await fakeApi(page, 'sales');
  await open(page, `/sales/batches/${BATCH}`, 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Exceptions' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0084: a period that ends before it starts is caught before anything is sent', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/sales/batches', 1440);
  await page.getByLabel('From').fill('2026-11-30');
  await page.getByLabel('To', { exact: true }).fill('2026-11-01');
  await page.getByRole('button', { name: 'Preview the invoices' }).click();
  await expect(page.getByRole('alert')).toContainText('The period ends before it starts');
  expect(f.previews).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0084: an approval the API refuses explains why and leaves the batch as it was', async ({
  page,
}) => {
  const f = await fakeApi(page, 'approver');
  f.override.set(`POST /ar/batches/${BATCH}/approve`, {
    status: 422,
    body: { error: 'BATCH_STATE', message: `batch ${BATCH} is not a preview awaiting approval` },
  });
  await open(page, `/sales/batches/${BATCH}`, 1440);
  await page.getByRole('button', { name: 'Approve and post 39 invoices' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer waiting for approval');
  await expect(page.getByRole('button', { name: 'Approve and post 39 invoices' })).toBeVisible();
  expect(f.errors).toEqual([]);
});
