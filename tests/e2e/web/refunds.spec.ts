/**
 * Customer refund in the credit-note screen (T-0152, UC-11, SS-UC11-08 refund half, ADR-0074):
 * after CN-000007 posts on paid INV-000123, Acme holds a 220.00 credit. The AR Clerk requests a
 * refund of it, sees the posting engine's GP-006 preview (Dr Trade debtors / Cr the bank), and an
 * Approver (not the requester) approves it; the money then leaves in the next payment batch.
 * The API is faked per test with `page.route` using the response shapes of the real routes
 * (apps/api/src/ar/refunds.controller.ts, proven by refunds.db.test.ts): GET /ar/parties/:id/credit,
 * PUT /ar/refunds/:id, GET /ar/refunds/:id[/journal], POST /ar/refunds/:id/approve.
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
const CO = id(0x152c1);
const ACME = id(0x152a1);
const INV = id(0x15201);
const CN = id(0x15221);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0152', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  clerk: { user_id: id(0x15231), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  approver: { user_id: id(0x15233), display_name: 'Ana Kim', role: 'approver' as const },
  admin: { user_id: id(0x15234), display_name: 'Priya Shah', role: 'finance_admin' as const },
  auditor: { user_id: id(0x15235), display_name: 'Tom Hale', role: 'auditor' as const },
};
type Who = keyof typeof ME;

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
  entry_id: id(0x15209),
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
const POSTED_CN = {
  id: CN,
  replayed: false,
  status: 'posted',
  credit_note_no: 'CN-000007',
  invoice_id: INV,
  entry_id: id(0x15260),
  net: '200.0000',
  tax: '20.0000',
  gross: '220.0000',
};
/** GP-006 as the engine previews it (previewCustomerRefundJournal). */
const PREVIEW = {
  entry_date: '2026-11-24',
  requested_date: '2026-11-24',
  redirected: false,
  needs_override: false,
  base_currency: 'AUD',
  total: '220.0000',
  bank_account_source: 'only_bank_account',
  lines: [
    {
      line_no: 1,
      account_id: id(0x15253),
      account_code: '1200',
      account_type: 'asset',
      account_name: 'Trade debtors',
      debit: '220.0000',
      credit: '0.0000',
      party_id: ACME,
    },
    {
      line_no: 2,
      account_id: id(0x15254),
      account_code: '1010',
      account_type: 'asset',
      account_name: 'Operating account',
      debit: '0.0000',
      credit: '220.0000',
      party_id: null,
    },
  ],
};

interface Fake {
  who: Who;
  errors: string[];
  created: { id: string; body: unknown }[];
  approvals: number;
  previewCalls: number;
  refund: Record<string, unknown> | null;
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = {
    who,
    errors: [],
    created: [],
    approvals: 0,
    previewCalls: 0,
    refund: null,
    override: new Map(),
  };
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
      const me = ME[f.who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const o = f.override.get(`${req.method()} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`);
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
      if (req.method() === 'PUT' && path.startsWith('/ar/refunds/')) {
        if (!perms.includes('ar.refund.create'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.refund.create' });
        const rid = path.split('/').pop() ?? '';
        const body = req.postDataJSON() as Record<string, unknown>;
        f.created.push({ id: rid, body });
        f.refund = {
          id: rid,
          replayed: false,
          refund_no: 'RF-000001',
          party_id: ACME,
          refund_date: body['refund_date'],
          amount: '220.0000',
          method: 'bank_batch',
          status: 'requested',
          approval: 'pending',
          created_by: me.user_id,
          approved_by: null,
          approved_at: null,
          entry_id: null,
          paid_on: null,
        };
        return send(route, 201, f.refund);
      }
      if (req.method() === 'POST' && /^\/ar\/refunds\/[0-9a-f-]{36}\/approve$/.test(path)) {
        if (!perms.includes('ar.refund.approve'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.refund.approve' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        if (f.refund?.['created_by'] === me.user_id)
          return send(route, 403, { error: 'sod_violation', rule: 'SOD_REFUND_SELF_APPROVAL' });
        f.approvals += 1;
        f.refund = {
          ...f.refund,
          approval: 'approved',
          approved_by: me.user_id,
          approved_at: '2026-11-24T01:00:00.000Z',
        };
        return send(route, 200, f.refund);
      }
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      expect(url.searchParams.get('company_id')).toBe(CO);
      if (path === `/ar/invoices/${INV}`) return send(route, 200, INVOICE);
      if (path === `/ar/invoices/${INV}/payment-status`)
        return send(route, 200, { status: 'paid', open: '0.0000' });
      if (path === `/ar/credit-notes/${CN}`) return send(route, 200, POSTED_CN);
      if (path === `/ar/parties/${ACME}/credit`)
        return send(route, 200, {
          party_id: ACME,
          balance: '-220.0000',
          requested: f.refund ? '220.0000' : '0.0000',
          available: f.refund ? '0.0000' : '220.0000',
        });
      if (f.refund && path === `/ar/refunds/${String(f.refund['id'])}`)
        return send(route, 200, { ...f.refund, replayed: false });
      if (f.refund && path === `/ar/refunds/${String(f.refund['id'])}/journal`) {
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

const CN_PAGE = `/sales/credit-notes?credit_note=${CN}`;

for (const width of [1440, 390]) {
  test(`SS-UC11-08: the Clerk requests a refund of the credit, sees GP-006, and an Approver approves it @ ${String(width)} [T-0152]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, CN_PAGE, width);
    await expect(page.getByRole('region', { name: 'Credit note CN-000007' })).toContainText(
      'Posted',
    );
    const refund = page.getByRole('region', { name: 'Refund' });
    expect(
      await refund
        .locator('dl [data-amount]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount'))),
    ).toEqual(['220.00', '0.00']);
    const form = refund.getByRole('form', { name: 'Request a refund' });
    await form.getByLabel('Amount to refund').fill('220.00');
    await form.getByLabel('Pay from').fill('2026-11-24');
    await form.getByLabel('Reason (optional)').fill('Customer asked for the credit back');
    await assertPage(page, width);
    await evidence('SS-UC11-08', `refund-request-${String(width)}`);

    await form.getByRole('button', { name: 'Request refund' }).click();
    await expect(refund.getByRole('heading', { name: /Refund RF-000001/ })).toBeVisible();
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.body).toEqual({
      company_id: CO,
      party_id: ACME,
      refund_date: '2026-11-24',
      amount: '220.00',
      method: 'bank_batch',
      reason: 'Customer asked for the credit back',
    });
    expect(new URL(page.url()).searchParams.get('refund')).toBe(f.created[0]?.id);
    await expect(refund.getByRole('status')).toContainText('Waiting for approval');
    await expect(refund.getByRole('button', { name: 'Approve refund' })).toHaveCount(0);
    await expect(refund).toContainText('An Approver, Finance Admin or Owner approves refunds');
    expect(f.previewCalls).toBe(0);

    await refund.getByRole('button', { name: 'Show me the journal' }).click();
    const journal = page.getByRole('table', { name: 'Journal preview' });
    await expect(journal.getByRole('row').nth(1)).toContainText('Trade debtors');
    await expect(journal.getByRole('row').nth(2)).toContainText('Operating account');
    expect(
      await journal
        .locator('tbody [data-amount]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-amount'))),
    ).toEqual(['220.00', '220.00']);
    await expect(refund).toContainText('Nothing is posted yet');
    expect(f.previewCalls).toBe(1);
    await assertPage(page, width);
    await evidence('SS-UC11-08', `refund-journal-preview-${String(width)}`);

    // The Approver opens the same refund and approves it.
    f.who = 'approver';
    await page.reload();
    await expect(refund.getByRole('status')).toContainText('Waiting for approval');
    await refund.getByRole('button', { name: 'Approve refund' }).click();
    await expect(refund.getByRole('status')).toContainText(
      'Approved. It will be paid in the next supplier payment batch.',
    );
    expect(f.approvals).toBe(1);
    await expect(refund.getByRole('button', { name: 'Approve refund' })).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-UC11-08', `refund-approved-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC11-08 refusal: the person who requested a refund cannot approve it (SOD_REFUND_SELF_APPROVAL) [T-0152]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'admin');
  await open(page, CN_PAGE, 1440);
  const refund = page.getByRole('region', { name: 'Refund' });
  const form = refund.getByRole('form', { name: 'Request a refund' });
  await form.getByLabel('Amount to refund').fill('220.00');
  await form.getByLabel('Pay from').fill('2026-11-24');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await refund.getByRole('button', { name: 'Approve refund' }).click();
  await expect(refund.getByRole('alert')).toContainText('separation-of-duties rule');
  await expect(refund.getByRole('status')).toContainText('Waiting for approval');
  expect(f.approvals).toBe(0);
  await assertPage(page, 1440);
  await evidence('SS-UC11-08', 'refund-self-approval-refused-1440');
  expect(f.errors).toEqual([]);
});

test('SS-UC11-08 refusal: more than the customer can have back is refused in place [T-0152]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  f.override.set('PUT /ar/refunds/:id', {
    status: 422,
    body: {
      error: 'REFUND_EXCEEDS_CREDIT',
      message: "refund 500.0000 exceeds the customer's refundable credit 220.0000",
    },
  });
  await open(page, CN_PAGE, 1440);
  const form = page.getByRole('form', { name: 'Request a refund' });
  await form.getByLabel('Amount to refund').fill('500.00');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(form.getByRole('alert')).toContainText('exceeds the customer');
  expect(new URL(page.url()).searchParams.get('refund')).toBeNull();
  expect(f.errors).toEqual([]);
});

test('SS-UC11-08 forbidden: a user without the refund permissions sees the credit but can neither request nor approve [T-0152]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'auditor');
  await open(page, CN_PAGE, 1440);
  const refund = page.getByRole('region', { name: 'Refund' });
  await expect(refund).toContainText('AR Clerks, Finance Admins and Owners request refunds');
  await expect(refund.getByRole('form', { name: 'Request a refund' })).toHaveCount(0);
  await expect(refund.getByRole('button')).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-UC11-08', 'refund-forbidden-1440');
  expect(f.created).toEqual([]);
  expect(f.errors).toEqual([]);
});
