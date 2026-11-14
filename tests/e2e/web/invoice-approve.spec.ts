/**
 * "Approve and post" on the invoice screen (T-0132, UC-01, SS-UC01-13, ADR-0073). After "Show me
 * the journal", a holder of ar.invoice.approve approves and posts the draft; the clerk, who may
 * not, is told who can; the draft's creator is told beforehand that someone else must approve
 * it; refusals from the API (separation of duties, already posted, a posting refusal) are said in
 * plain words; in small-team mode the only user gives a reason that is recorded. The API is faked
 * per test with `page.route`, using the response shapes of apps/api (T-0131, T-0132).
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
const CO = id(0x132c);
const ACME = id(0x132a);
const DRAFT = id(0x1321);
const ENTRY = id(0x132e);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0132', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  approver: { user_id: id(0x1311), display_name: 'Priya Natarajan', role: 'approver' as const },
  clerk: { user_id: id(0x1312), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  owner: { user_id: id(0x1313), display_name: 'Tom Walker', role: 'owner' as const },
};

const line = (n: number, description: string, price: string) => ({
  line_no: n,
  description,
  quantity: '1.0000',
  unit_price: price,
  tax_code: null,
  net: null,
  tax: null,
  gross: null,
});
const DRAFT_DETAIL = {
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
  approval: { allowed: true, rule: null, small_team_exception_required: false },
  lines: [line(1, 'Professional services', '1000.0000'), line(2, 'Subscription', '250.0000')],
};
const POSTED_DETAIL = {
  ...DRAFT_DETAIL,
  invoice_no: 'INV-000123',
  status: 'posted',
  entry_id: ENTRY,
  net_total: '1250.0000',
  tax_total: '125.0000',
  gross_total: '1375.0000',
  approval: null,
  lines: [
    {
      ...line(1, 'Professional services', '1000.0000'),
      tax_code: 'GST',
      net: '1000.0000',
      tax: '100.0000',
      gross: '1100.0000',
    },
    {
      ...line(2, 'Subscription', '250.0000'),
      tax_code: 'GST',
      net: '250.0000',
      tax: '25.0000',
      gross: '275.0000',
    },
  ],
};
const APPROVED = {
  id: DRAFT,
  status: 'posted',
  invoice_no: 'INV-000123',
  entry_id: ENTRY,
  net_total: '1250.0000',
  tax_total: '125.0000',
  gross_total: '1375.0000',
  replayed: false,
};
/** GP-001 as the engine previews it (T-0131 previewInvoiceJournal). */
const jl = (
  n: number,
  code: string,
  type: string,
  name: string,
  debit: string,
  credit: string,
) => ({
  line_no: n,
  account_id: id(0x1330 + n),
  account_code: code,
  account_type: type,
  account_name: name,
  debit,
  credit,
  party_id: n === 4 ? null : ACME,
});
const PREVIEW = {
  entry_date: '2026-11-05',
  requested_date: '2026-11-05',
  redirected: false,
  needs_override: false,
  base_currency: 'AUD',
  total: '1375.0000',
  lines: [
    jl(1, '1200', 'asset', 'Trade debtors', '1375.0000', '0.0000'),
    jl(2, '4110', 'revenue', 'Professional services', '0.0000', '1000.0000'),
    jl(3, '4120', 'revenue', 'Subscriptions', '0.0000', '250.0000'),
    jl(4, '2310', 'liability', 'GST collected', '0.0000', '125.0000'),
  ],
};

interface Approval {
  key: string | null;
  companyId: string | null;
  body: unknown;
}
interface Fake {
  errors: string[];
  approvals: Approval[];
  detail: unknown;
  approveReply: { status: number; body: unknown } | null;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], approvals: [], detail: DRAFT_DETAIL, approveReply: null };
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
      if (path === `/ar/invoices/${DRAFT}/approve` && req.method() === 'POST') {
        f.approvals.push({
          key: req.headers()['idempotency-key'] ?? null,
          companyId: url.searchParams.get('company_id'),
          body: req.postDataJSON() as unknown,
        });
        if (!perms.includes('ar.invoice.approve'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.invoice.approve' });
        if (f.approveReply) return send(route, f.approveReply.status, f.approveReply.body);
        f.detail = POSTED_DETAIL;
        return send(route, 200, APPROVED);
      }
      if (path === `/ar/invoices/${DRAFT}`) return send(route, 200, f.detail);
      if (path === `/ar/invoices/${DRAFT}/journal`) return send(route, 200, PREVIEW);
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}/sales/invoices/${DRAFT}`);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}

async function showJournal(page: Page) {
  await page.getByRole('button', { name: 'Show me the journal' }).click();
  await expect(page.getByRole('table', { name: 'Journal preview' })).toBeVisible();
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
  test(`SS-UC01-13: an Approver approves and posts a draft invoice from its screen @ ${String(width)} [T-0132]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'approver');
    await open(page, width);
    await expect(page.getByRole('heading', { level: 1, name: 'Draft invoice' })).toBeVisible();
    // The journal comes first (P4): no approve action until it has been shown.
    await expect(page.getByRole('button', { name: 'Approve and post' })).toHaveCount(0);
    await showJournal(page);
    const approve = page.getByRole('button', { name: 'Approve and post' });
    await expect(approve).toBeEnabled();
    await assertPage(page, width);
    await evidence('SS-UC01-13', `invoice-ready-to-approve-${String(width)}`);

    await approve.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice INV-000123' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Approved and posted as INV-000123');
    await expect(page.getByRole('button', { name: 'Approve and post' })).toHaveCount(0);
    expect(f.approvals).toHaveLength(1);
    expect(f.approvals[0]?.companyId).toBe(CO);
    expect(f.approvals[0]?.key).toMatch(/^inv-approve-[0-9a-f-]{36}$/);
    expect(f.approvals[0]?.body).toEqual({});
    await assertPage(page, width);
    await evidence('SS-UC01-13', `invoice-posted-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC01-13: without ar.invoice.approve there is no approve action, and the screen says who approves [T-0132]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, 1440);
  await showJournal(page);
  await expect(page.getByRole('button', { name: 'Approve and post' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Journal' })).toContainText(
    'An Approver, a Finance Admin or the Owner approves and posts it.',
  );
  await assertPage(page, 1440);
  await evidence('SS-UC01-13', 'invoice-no-approve-permission');
  expect(f.approvals).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("SS-UC01-13: the draft's creator is told beforehand that someone else must approve it [T-0132]", async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'approver');
  f.detail = {
    ...DRAFT_DETAIL,
    approval: {
      allowed: false,
      rule: 'SOD_INVOICE_SELF_APPROVAL',
      small_team_exception_required: false,
    },
  };
  await open(page, 390);
  await showJournal(page);
  const approve = page.getByRole('button', { name: 'Approve and post' });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAccessibleDescription(
    /You created this invoice\. Someone else who can approve invoices has to approve it/,
  );
  await assertPage(page, 390);
  await evidence('SS-UC01-13', 'invoice-creator-cannot-approve');
  expect(f.approvals).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-UC01-13: refusals from the API are explained in plain words [T-0132]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'approver');
  await open(page, 1440);
  await showJournal(page);
  const approve = page.getByRole('button', { name: 'Approve and post' });

  f.approveReply = {
    status: 403,
    body: {
      error: 'sod_violation',
      rule: 'SOD_INVOICE_SELF_APPROVAL',
      small_team_exception_required: false,
    },
  };
  await approve.click();
  await expect(page.getByRole('alert')).toHaveText(
    'You created this invoice, so you can’t approve it as well. Someone else who can approve invoices has to approve it.',
  );

  f.approveReply = {
    status: 409,
    body: { error: 'already_posted', message: 'invoice INV-000123 was already approved' },
  };
  await approve.click();
  await expect(page.getByRole('alert')).toHaveText(
    'Someone else has already approved and posted this invoice. Reload the page to see it.',
  );

  f.approveReply = {
    status: 422,
    body: {
      error: 'NO_BILLING_TO',
      message: 'the customer has no active Billing To contact with an email address',
    },
  };
  await approve.click();
  await expect(page.getByRole('alert')).toHaveText(
    'We could not post this invoice: the customer has no active Billing To contact with an email address',
  );
  await assertPage(page, 1440);
  await evidence('SS-UC01-13', 'invoice-approve-refused');
  // One key for this screen: a retry is the same request, so a lost answer cannot post twice.
  expect(new Set(f.approvals.map((a) => a.key)).size).toBe(1);
  expect(f.errors).toEqual([]);
});

test('SS-UC01-13: in small-team mode the only user approves their own draft with a recorded reason [T-0132]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'owner');
  f.detail = {
    ...DRAFT_DETAIL,
    approval: {
      allowed: false,
      rule: 'SOD_INVOICE_SELF_APPROVAL',
      small_team_exception_required: true,
    },
  };
  await open(page, 1440);
  await showJournal(page);
  const approve = page.getByRole('button', { name: 'Approve and post' });
  await expect(approve).toBeDisabled();
  const reason = page.getByLabel('Why you are approving your own invoice');
  await reason.fill('Sole trader; our accountant reviews each month');
  await expect(approve).toBeEnabled();
  await assertPage(page, 1440);
  await evidence('SS-UC01-13', 'invoice-small-team-reason');
  await approve.click();
  await expect(page.getByRole('status')).toContainText('Approved and posted as INV-000123');
  expect(f.approvals[0]?.body).toEqual({
    sod_exception: { reason: 'Sole trader; our accountant reviews each month' },
  });
  expect(f.errors).toEqual([]);
});
