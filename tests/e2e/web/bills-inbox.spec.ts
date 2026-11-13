/**
 * Bills inbox screens (T-0136, UC-05, SS-UC05-09, RQ-0148). The AP Clerk opens the bills that
 * suppliers emailed in, downloads the PDF, codes it into a draft on the bill entry form (supplier
 * suggested from the sender) and finds the draft on /purchases/bills, ready for the T-0086 approval
 * screens. Vite serves the app; each test fakes the API with `page.route`, using the response
 * shapes of apps/api/src/ap/inbox.controller.ts and bills.controller.ts (inbox.db.test.ts proves
 * them on a real database).
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
const CO = id(0x136c1);
const PAPER = id(0x136a1);
const OFFICE = id(0x136a2);
const STATIONERY = id(0x13661);
const LAPTOP = id(0x13662);
const ITEM = id(0x13611);
const BARE = id(0x13612);
const DONE = id(0x13613);
const OLD = id(0x13601);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0136', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

type Role = keyof typeof ROLE_TEMPLATES;
const ME: Record<string, { user_id: string; display_name: string; roles: Role[] }> = {
  clerk: { user_id: id(0x13621), display_name: 'Lena Ortiz', roles: ['ap_clerk'] },
  approver: { user_id: id(0x13622), display_name: 'Sam Nguyen', roles: ['approver'] },
  sales: { user_id: id(0x13623), display_name: 'Ari Cole', roles: ['ar_clerk'] },
};

const CODING = {
  suppliers: [
    { id: OFFICE, name: 'Harbour Office Furniture' },
    { id: PAPER, name: 'Paper Co Pty Ltd' },
  ],
  accounts: [
    { id: LAPTOP, code: '1500', name: 'Computer equipment', type: 'asset' },
    { id: STATIONERY, code: '6230', name: 'Printing and stationery', type: 'expense' },
  ],
  tax_codes: [
    { code: 'GST', name: 'GST on purchases', rate: '0.10000000' },
    { code: 'GST-CAP', name: 'GST on capital purchases', rate: '0.10000000' },
  ],
};

interface Item {
  id: string;
  status: 'new' | 'no_attachment' | 'coded' | 'rejected';
  from_address: string | null;
  subject: string | null;
  received_at: string;
  party_id: string | null;
  supplier_name: string | null;
  bill_id: string | null;
  attachments: { n: number; file_name: string; content_type: string; size_bytes: number }[];
}

interface FakeBill {
  id: string;
  bill_no: string | null;
  status: 'draft' | 'posted';
  supplier_name: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  gross: string;
}

interface Fake {
  errors: string[];
  items: Map<string, Item>;
  bills: Map<string, FakeBill>;
  codes: { item: string; key: string | null; body: Record<string, unknown> }[];
  downloads: string[];
  refuse: { status: number; body: unknown } | null;
}

const SEED: Item[] = [
  {
    id: ITEM,
    status: 'new',
    from_address: 'accounts@paperco.example',
    subject: 'Invoice SUP-INV-991',
    received_at: '2026-11-02T22:15:00.000Z',
    party_id: PAPER,
    supplier_name: 'Paper Co Pty Ltd',
    bill_id: null,
    attachments: [
      { n: 1, file_name: 'SUP-INV-991.pdf', content_type: 'application/pdf', size_bytes: 48_213 },
    ],
  },
  {
    id: BARE,
    status: 'no_attachment',
    from_address: 'someone@unknown.example',
    subject: 'Our invoice is on its way',
    received_at: '2026-11-02T20:05:00.000Z',
    party_id: null,
    supplier_name: null,
    bill_id: null,
    attachments: [],
  },
  {
    id: DONE,
    status: 'coded',
    from_address: 'accounts@paperco.example',
    subject: 'Invoice SUP-INV-700',
    received_at: '2026-10-20T01:00:00.000Z',
    party_id: PAPER,
    supplier_name: 'Paper Co Pty Ltd',
    bill_id: OLD,
    attachments: [
      { n: 1, file_name: 'SUP-INV-700.pdf', content_type: 'application/pdf', size_bytes: 31_002 },
    ],
  },
];

async function fakeApi(page: Page, who: string): Promise<Fake> {
  const f: Fake = {
    errors: [],
    items: new Map(SEED.map((i) => [i.id, structuredClone(i)])),
    bills: new Map([
      [
        OLD,
        {
          id: OLD,
          bill_no: 'BILL-000044',
          status: 'posted',
          supplier_name: 'Paper Co Pty Ltd',
          supplier_ref: 'SUP-INV-700',
          bill_date: '2026-10-20',
          due_date: '2026-11-19',
          gross: '88.0000',
        },
      ],
    ]),
    codes: [],
    downloads: [],
    refuse: null,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|ap)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const me = ME[who];
      if (!me) throw new Error(`unknown user ${who}`);
      const perms = new Set(me.roles.flatMap((r) => ROLE_TEMPLATES[r].permissions));
      const need = (p: string) =>
        perms.has(p as never) ? null : send(route, 403, { error: 'forbidden', permission: p });
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: me.roles, permissions: [...perms] });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (req.method() === 'GET') expect(url.searchParams.get('company_id')).toBe(CO);
      if (path === '/ap/bill-coding') return need('ap.bill.enter') ?? send(route, 200, CODING);
      if (path === '/ap/inbox')
        return (
          need('ap.read') ??
          send(route, 200, {
            items: [...f.items.values()].sort((a, b) => (a.received_at < b.received_at ? 1 : -1)),
          })
        );
      const pdf = /^\/ap\/inbox\/([^/]+)\/attachments\/(\d+)$/.exec(path);
      if (pdf) {
        const denied = need('ap.read');
        if (denied) return denied;
        const att = f.items.get(pdf[1] ?? '')?.attachments.find((a) => String(a.n) === pdf[2]);
        if (!att) return send(route, 404, { error: 'not_found' });
        f.downloads.push(`${pdf[1] ?? ''}/${pdf[2] ?? ''}`);
        return route.fulfill({
          status: 200,
          body: PDF,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="${att.file_name}"`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
          },
        });
      }
      const coding = /^\/ap\/inbox\/([^/]+)\/code$/.exec(path);
      if (coding && req.method() === 'POST') {
        const denied = need('ap.bill.enter');
        if (denied) return denied;
        const body = req.postDataJSON() as Record<string, unknown>;
        f.codes.push({
          item: coding[1] ?? '',
          key: req.headers()['idempotency-key'] ?? null,
          body,
        });
        if (f.refuse) return send(route, f.refuse.status, f.refuse.body);
        const it = f.items.get(coding[1] ?? '');
        if (!it) return send(route, 404, { error: 'not_found' });
        const billId = String(body['bill_id']);
        it.status = 'coded';
        it.bill_id = billId;
        f.bills.set(billId, {
          id: billId,
          bill_no: null,
          status: 'draft',
          supplier_name:
            CODING.suppliers.find((s) => s.id === body['party_id'])?.name ?? 'Unknown supplier',
          supplier_ref: String(body['supplier_ref']),
          bill_date: String(body['bill_date']),
          due_date: '2026-12-03',
          gross: '2750.0000',
        });
        return send(route, 201, {
          item_id: it.id,
          status: 'coded',
          replayed: false,
          bill: {
            id: billId,
            status: 'draft',
            bill_no: null,
            entry_id: null,
            net: '2500.0000',
            tax: '250.0000',
            gross: '2750.0000',
          },
        });
      }
      if (path === '/ap/bills' && req.method() === 'GET')
        return (
          need('ap.read') ??
          send(route, 200, {
            bills: [...f.bills.values()]
              .sort((a, b) => (a.bill_date < b.bill_date ? 1 : -1))
              .map((b) => ({
                id: b.id,
                bill_no: b.bill_no,
                status: b.status,
                awaiting_approval: false,
                party_id: PAPER,
                supplier_name: b.supplier_name,
                supplier_ref: b.supplier_ref,
                bill_date: b.bill_date,
                due_date: b.due_date,
                gross: b.gross,
              })),
          })
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

/** Code the GP-008 bill: 500.00 stationery (GST) + 2,000.00 laptop (GST-CAP). */
async function fillCoding(page: Page) {
  await page.getByLabel("Supplier's invoice number").fill('SUP-INV-991');
  await page.getByLabel('Bill date').fill('2026-11-03');
  await page.getByLabel('Line 1 description').fill('Stationery and consumables');
  await page.getByLabel('Line 1 account').selectOption({ label: '6230 Printing and stationery' });
  await page.getByLabel('Line 1 tax code').selectOption('GST');
  await page.getByLabel('Line 1 amount before GST').fill('500.00');
  await page.getByRole('button', { name: 'Add a line' }).click();
  await page.getByLabel('Line 2 description').fill('Laptop');
  await page.getByLabel('Line 2 account').selectOption({ label: '1500 Computer equipment' });
  await page.getByLabel('Line 2 tax code').selectOption('GST-CAP');
  await page.getByLabel('Line 2 amount before GST').fill('2,000.00');
}

for (const width of [1440, 390]) {
  test(`SS-UC05-09: Emailed bill coded into a draft from the inbox @ ${String(width)} [T-0136]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, '/purchases/inbox', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Bills inbox' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Emailed bills' });
    await expect(table.getByRole('row')).toHaveCount(4);
    const row = (n: number) => table.getByRole('row').nth(n);
    await expect(row(1)).toContainText('3 Nov 2026');
    await expect(row(1)).toContainText('accounts@paperco.example');
    await expect(row(1)).toContainText('Invoice SUP-INV-991');
    await expect(row(1)).toContainText('Paper Co Pty Ltd');
    await expect(row(1)).toContainText('To code');
    await expect(row(2)).toContainText('No PDF attached');
    await expect(row(2)).toContainText('Not matched');
    await expect(row(3)).toContainText('Coded into a bill');
    await expect(row(3).getByRole('link', { name: 'Open bill BILL-000044' })).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC05-09', `bills-inbox-list-${String(width)}`);

    const pdfLink = row(1).getByRole('link', { name: 'Download SUP-INV-991.pdf (48 KB)' });
    await expect(pdfLink).toHaveAttribute(
      'href',
      `/ap/inbox/${ITEM}/attachments/1?company_id=${CO}`,
    );
    // A browser download is not routed through page.route in Chromium, so assert what was
    // downloaded from where; the response headers and bytes are proven in inbox.db.test.ts.
    const download = page.waitForEvent('download');
    await pdfLink.click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('SUP-INV-991.pdf');
    expect(file.url()).toBe(`${origin}/ap/inbox/${ITEM}/attachments/1?company_id=${CO}`);

    await row(1).getByRole('link', { name: 'Code Invoice SUP-INV-991' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Code an emailed bill' }),
    ).toBeVisible();
    await expect(page.getByText('From accounts@paperco.example')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Download SUP-INV-991.pdf (48 KB)' }),
    ).toBeVisible();
    // The sender matched Paper Co, so the form starts with that supplier chosen.
    await expect(page.getByLabel('Supplier', { exact: true })).toHaveValue(PAPER);
    await fillCoding(page);
    await assertPage(page, width);
    await evidence('SS-UC05-09', `code-emailed-bill-form-${String(width)}`);

    await page.getByRole('button', { name: 'Save draft bill' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bills' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      'Draft bill SUP-INV-991 from Paper Co Pty Ltd was created from the email',
    );
    expect(f.codes).toHaveLength(1);
    const [sent] = f.codes;
    expect(sent?.item).toBe(ITEM);
    expect(sent?.key).toMatch(/^.{8,}$/);
    expect(sent?.body).toEqual({
      company_id: CO,
      bill_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      party_id: PAPER,
      supplier_ref: 'SUP-INV-991',
      bill_date: '2026-11-03',
      lines: [
        {
          description: 'Stationery and consumables',
          account_id: STATIONERY,
          tax_code: 'GST',
          amount: '500.00',
        },
        { description: 'Laptop', account_id: LAPTOP, tax_code: 'GST-CAP', amount: '2000.00' },
      ],
    });
    const bills = page.getByRole('table', { name: 'Bills' });
    const draft = bills.getByRole('row').filter({ hasText: 'SUP-INV-991' });
    await expect(draft).toContainText('Draft bill SUP-INV-991 from Paper Co Pty Ltd');
    await expect(draft).toContainText('Draft');
    await expect(draft).toContainText('2,750.00');
    await assertPage(page, width);
    await evidence('SS-UC05-09', `coded-draft-on-bills-list-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0136: a refused coding explains why and keeps the form', async ({ page }) => {
  const f = await fakeApi(page, 'clerk');
  f.refuse = {
    status: 422,
    body: {
      error: 'PERIOD_LOCKED',
      message: 'the period for 2026-11-03 is locked for purchases (ap_locked)',
    },
  };
  await open(page, `/purchases/inbox/${ITEM}`, 1440);
  await fillCoding(page);
  await page.getByRole('button', { name: 'Save draft bill' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'LedgerForce did not accept this bill: the period for 2026-11-03 is locked for purchases',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Code an emailed bill' })).toBeVisible();
  await expect(page.getByLabel('Line 2 description')).toHaveValue('Laptop');
  expect(f.codes).toHaveLength(1);
  // A retry of the same form reuses its bill id and idempotency key (no second draft).
  f.refuse = null;
  await page.getByRole('button', { name: 'Save draft bill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bills' })).toBeVisible();
  expect(f.codes).toHaveLength(2);
  expect(f.codes[1]?.key).toBe(f.codes[0]?.key);
  expect(f.codes[1]?.body['bill_id']).toBe(f.codes[0]?.body['bill_id']);
  expect(f.errors).toEqual([]);
});

test('T-0136: an Approver sees the inbox and the PDFs but cannot code a bill', async ({ page }) => {
  const f = await fakeApi(page, 'approver');
  await open(page, '/purchases/inbox', 1440);
  const table = page.getByRole('table', { name: 'Emailed bills' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(page.getByRole('link', { name: /^Download SUP-INV-991\.pdf/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Code / })).toHaveCount(0);
  await expect(page.getByText(/AP Clerks and Owners code emailed bills/)).toBeVisible();
  await open(page, `/purchases/inbox/${ITEM}`, 1440);
  await expect(page.getByText("You can't enter bills")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft bill' })).toHaveCount(0);
  expect(f.codes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0136: a user without ap.read is told so, and nothing is listed', async ({ page }) => {
  const f = await fakeApi(page, 'sales');
  await open(page, '/purchases/inbox', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Emailed bills' })).toHaveCount(0);
  expect(f.downloads).toEqual([]);
  expect(f.errors).toEqual([]);
});
