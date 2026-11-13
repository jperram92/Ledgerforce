/**
 * Credit-note screen (T-0085, UC-11, SS-UC11-08 credit-note half, DL-0492): from paid INV-000123
 * the AR Clerk issues a partial credit note, sees the draft's totals and the posting engine's
 * preview of the GP-005 journal; an Approver posts it. The refund half of SS-UC11-08 is T-0152
 * (blocked: no refund permission), so the screen says refunds are not available here yet.
 * The API is faked per test with `page.route` using the response shapes of
 * GET /ar/invoices[/:id], GET /ar/invoices/:id/payment-status, PUT /ar/credit-notes/:id,
 * GET /ar/credit-notes/:id[/journal] and POST /ar/credit-notes/:id/approve (T-0045, T-0131, T-0151).
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
const INV = id(0x8501);
const CN = id(0x8521);

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
  approver: { user_id: id(0x8533), display_name: 'Ana Kim', role: 'approver' as const },
  sales: { user_id: id(0x8532), display_name: 'Sam Reyes', role: 'sales_user' as const },
};

const INVOICE = {
  id: INV,
  invoice_no: 'INV-000123',
  status: 'posted',
  kind: 'standard',
  pricing: 'exclusive',
  party_id: ACME,
  party_name: 'Acme Pty Ltd',
  issue_date: '2026-11-05',
  due_date: '2026-11-19',
  entry_id: id(0x8509),
  net_total: '1250.0000',
  tax_total: '125.0000',
  gross_total: '1375.0000',
  warnings: [],
  lines: [
    {
      line_no: 1,
      description: 'Professional services',
      quantity: '1.0000',
      unit_price: '1000.0000',
      tax_code: 'GST',
      net: '1000.0000',
      tax: '100.0000',
      gross: '1100.0000',
    },
    {
      line_no: 2,
      description: 'Subscription',
      quantity: '1.0000',
      unit_price: '250.0000',
      tax_code: 'GST',
      net: '250.0000',
      tax: '25.0000',
      gross: '275.0000',
    },
  ],
};
const DRAFT = {
  id: CN,
  replayed: false,
  status: 'draft',
  credit_note_no: null,
  invoice_id: INV,
  entry_id: null,
  net: '200.0000',
  tax: '20.0000',
  gross: '220.0000',
};
/** GP-005 as the engine previews it (T-0151 previewCreditNoteJournal). */
const PREVIEW = {
  entry_date: '2026-11-20',
  requested_date: '2026-11-20',
  redirected: false,
  needs_override: false,
  base_currency: 'AUD',
  total: '220.0000',
  lines: [
    {
      line_no: 1,
      account_id: id(0x8551),
      account_code: '4110',
      account_type: 'revenue',
      account_name: 'Professional services',
      debit: '200.0000',
      credit: '0.0000',
      party_id: ACME,
    },
    {
      line_no: 2,
      account_id: id(0x8552),
      account_code: '2310',
      account_type: 'liability',
      account_name: 'GST collected',
      debit: '20.0000',
      credit: '0.0000',
      party_id: null,
    },
    {
      line_no: 3,
      account_id: id(0x8553),
      account_code: '1200',
      account_type: 'asset',
      account_name: 'Trade debtors',
      debit: '0.0000',
      credit: '220.0000',
      party_id: ACME,
    },
  ],
};

interface Fake {
  errors: string[];
  created: { id: string; body: unknown }[];
  approvals: number;
  previewCalls: number;
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], created: [], approvals: 0, previewCalls: 0, override: new Map() };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  let draftId = CN;
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|ar)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const o = f.override.get(`${req.method()} ${path.replace(/[0-9a-f-]{36}$/, ':id')}`);
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
      if (req.method() === 'PUT' && path.startsWith('/ar/credit-notes/')) {
        if (!perms.includes('ar.credit_note.create'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.credit_note.create' });
        draftId = path.split('/').pop() ?? '';
        f.created.push({ id: draftId, body: req.postDataJSON() });
        return send(route, 201, { ...DRAFT, id: draftId });
      }
      if (req.method() === 'POST' && path === `/ar/credit-notes/${draftId}/approve`) {
        if (!perms.includes('ar.credit_note.approve'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.credit_note.approve' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.approvals += 1;
        return send(route, 200, {
          ...DRAFT,
          id: draftId,
          status: 'posted',
          credit_note_no: 'CN-000007',
          entry_id: id(0x8560),
        });
      }
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      expect(url.searchParams.get('company_id')).toBe(CO);
      if (path === '/ar/invoices')
        return send(route, 200, {
          invoices: [
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
          ],
        });
      if (path === `/ar/invoices/${INV}`) return send(route, 200, INVOICE);
      if (path === `/ar/invoices/${INV}/payment-status`)
        return send(route, 200, { status: 'paid', open: '0.0000' });
      if (path === `/ar/credit-notes/${draftId}`)
        return send(route, 200, {
          ...DRAFT,
          id: draftId,
          ...(f.approvals > 0
            ? { status: 'posted', credit_note_no: 'CN-000007', entry_id: id(0x8560) }
            : {}),
        });
      if (path === `/ar/credit-notes/${draftId}/journal`) {
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
  if (width < 600) {
    const box = await page.locator('main h1').boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(16);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 16);
  }
}

const amountsIn = (page: Page, table: string) =>
  page
    .getByRole('table', { name: table })
    .locator('tbody [data-amount]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount')));

for (const width of [1440, 390]) {
  test(`SS-UC11-08: Credit note and refund screens @ ${String(width)} [T-0085]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, `/sales/invoices/${INV}`, width);
    await page.getByRole('link', { name: 'Issue a credit note' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Credit note' })).toBeVisible();
    const invoice = page.getByRole('region', { name: 'Invoice INV-000123' });
    await expect(invoice).toContainText('Paid');
    await expect(
      invoice.getByRole('table', { name: 'Invoice lines' }).getByRole('row'),
    ).toHaveCount(3);
    const form = page.getByRole('region', { name: 'What to credit' });
    await expect(form.getByLabel('Line')).toHaveValue('1');
    await form.getByLabel('Amount excluding GST').fill('200.00');
    await form.getByLabel('Reason').selectOption({ label: 'Less work than invoiced' });
    await form.getByLabel('Date').fill('2026-11-20');
    await assertPage(page, width);
    await evidence('SS-UC11-08', `credit-note-form-${String(width)}`);

    await form.getByRole('button', { name: 'Create draft credit note' }).click();
    const draft = page.getByRole('region', { name: 'Draft credit note' });
    await expect(draft).toBeVisible();
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.body).toEqual({
      company_id: CO,
      invoice_id: INV,
      issue_date: '2026-11-20',
      reason_code: 'scope_reduction',
      lines: [{ invoice_line_no: 1, amount: '200.00' }],
    });
    expect(
      await draft
        .locator('[data-amount]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount'))),
    ).toEqual(['200.00', '20.00', '220.00']);
    expect(f.previewCalls).toBe(0);

    await draft.getByRole('button', { name: 'Show me the journal' }).click();
    const journal = page.getByRole('table', { name: 'Journal preview' });
    await expect(journal.getByRole('row').nth(1)).toContainText('Professional services');
    await expect(journal.getByRole('row').nth(2)).toContainText('GST collected');
    await expect(journal.getByRole('row').nth(3)).toContainText('Trade debtors');
    expect(await amountsIn(page, 'Journal preview')).toEqual(['200.00', '20.00', '220.00']);
    await expect(draft).toContainText('Nothing is posted yet.');
    await expect(draft).toContainText('An Approver posts it');
    await expect(draft.getByRole('button', { name: 'Approve and post' })).toHaveCount(0);
    const refund = page.getByRole('region', { name: 'Refund' });
    await expect(refund).toContainText('not available here yet');
    expect(f.previewCalls).toBe(1);
    expect(f.approvals).toBe(0);
    await assertPage(page, width);
    await evidence('SS-UC11-08', `credit-note-journal-preview-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC11-08: an Approver opens the draft, sees the journal and posts it [T-0085]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'approver');
  await open(page, `/sales/credit-notes?credit_note=${CN}`, 1440);
  const draft = page.getByRole('region', { name: 'Draft credit note' });
  await draft.getByRole('button', { name: 'Show me the journal' }).click();
  await expect(page.getByRole('table', { name: 'Journal preview' })).toBeVisible();
  await draft.getByRole('button', { name: 'Approve and post' }).click();
  const posted = page.getByRole('region', { name: 'Credit note CN-000007' });
  await expect(posted).toContainText('Posted');
  await expect(page.getByRole('region', { name: 'What to credit' })).toHaveCount(0);
  expect(f.approvals).toBe(1);
  await assertPage(page, 1440);
  await evidence('SS-UC11-08', 'credit-note-posted-1440');
  expect(f.errors).toEqual([]);
});

test('T-0085: a credit beyond the invoice is refused with the reason and nothing is drafted', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  f.override.set('PUT /ar/credit-notes/:id', {
    status: 422,
    body: {
      error: 'CREDIT_EXCEEDS_INVOICE',
      message: 'credit 1650.0000 exceeds the creditable amount 1375.0000',
    },
  });
  await open(page, `/sales/credit-notes?invoice=${INV}`, 1440);
  const form = page.getByRole('region', { name: 'What to credit' });
  await form.getByLabel('Amount excluding GST').fill('1500.00');
  await form.getByLabel('Date').fill('2026-11-20');
  await form.getByRole('button', { name: 'Create draft credit note' }).click();
  await expect(form.getByRole('alert')).toContainText('exceeds the creditable amount');
  await expect(page.getByRole('region', { name: 'Draft credit note' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0085: a user without ar.read is told so, and no invoice is shown', async ({ page }) => {
  const f = await fakeApi(page, 'sales');
  await open(page, `/sales/credit-notes?invoice=${INV}`, 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('region', { name: 'What to credit' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
