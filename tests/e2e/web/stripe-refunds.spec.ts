/**
 * Stripe refund in the credit-note screen (T-0172, UC-11, ADR-0083, DL-0562; SS-UC11-09,
 * SS-UC11-10): the AR Clerk asks for Acme's 220.00 credit back to the card it paid with; an
 * Approver approves it. Approving a Stripe refund needs a fresh sign-in step (401
 * step_up_required → the step-up prompt), then the refund goes to Stripe at once and the region
 * shows the result; a send that did not finish says it is retried automatically.
 * The API is faked with `page.route` using the shapes of the real routes
 * (apps/api/src/ar/refunds.controller.ts, proven by refunds-stripe.db.test.ts). No screenshots:
 * T-0172's evidence is text only; T-0190's cancel tests capture screenshots (evidence fixture).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { expect, test } from '@ledgerforce/testing/evidence';
import { createViteServer } from 'vitest/node';
import { ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x172c1);
const ACME = id(0x172a1);
const INV = id(0x17201);
const CN = id(0x17221);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  clerk: { user_id: id(0x17231), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  approver: { user_id: id(0x17233), display_name: 'Ana Kim', role: 'approver' as const },
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
  entry_id: id(0x17209),
  net_total: '1250.0000',
  tax_total: '125.0000',
  gross_total: '1375.0000',
  warnings: [],
  lines: [
    {
      line_no: 1,
      description: 'Professional services',
      quantity: '1.0000',
      unit_price: '1250.0000',
      tax_code: 'GST',
      net: '1250.0000',
      tax: '125.0000',
      gross: '1375.0000',
    },
  ],
};
const POSTED_CN = {
  id: CN,
  replayed: false,
  status: 'posted',
  credit_note_no: 'CN-000007',
  invoice_id: INV,
  entry_id: id(0x17260),
  net: '200.0000',
  tax: '20.0000',
  gross: '220.0000',
};

interface Fake {
  who: Who;
  /** Whether the session has a fresh step-up (DL-0562, 300 s). */
  steppedUp: boolean;
  /**
   * What Stripe does on approval: sent, the send did not finish (retried by the outbox), or
   * Stripe has the refund but the journal could not be written (security review r8 F1).
   */
  stripe: 'sent' | 'pending' | 'sent_not_posted' | 'refused';
  errors: string[];
  created: { id: string; body: Record<string, unknown> }[];
  approvals: number;
  stepUps: number;
  cancels: number;
  refund: Record<string, unknown> | null;
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = {
    who,
    steppedUp: false,
    stripe: 'sent',
    errors: [],
    created: [],
    approvals: 0,
    stepUps: 0,
    cancels: 0,
    refund: null,
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
          refund_no: 'RF-000004',
          party_id: ACME,
          refund_date: body['refund_date'],
          amount: '220.0000',
          method: body['method'],
          status: 'requested',
          approval: 'pending',
          created_by: me.user_id,
          approved_by: null,
          approved_at: null,
          entry_id: null,
          paid_on: null,
          ...(body['method'] === 'stripe'
            ? { stripe: { status: 'not_sent', stripe_refund_id: null, message: null } }
            : {}),
        };
        return send(route, 201, f.refund);
      }
      if (req.method() === 'POST' && /^\/ar\/refunds\/[0-9a-f-]{36}\/approve$/.test(path)) {
        if (!perms.includes('ar.refund.approve'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.refund.approve' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        if (f.refund?.['method'] === 'stripe' && !f.steppedUp) {
          f.stepUps += 1;
          return send(route, 401, { error: 'step_up_required', max_age: 300 });
        }
        f.approvals += 1;
        const approved = {
          ...f.refund,
          approval: 'approved',
          approved_by: me.user_id,
          approved_at: '2026-11-24T00:00:00.000Z',
        };
        f.refund =
          f.stripe === 'refused'
            ? {
                ...approved,
                stripe: {
                  status: 'failed',
                  code: 'StripeApiError',
                  stripe_refund_id: null,
                  message:
                    'stripe request failed (400): Charge ch_1SQbT0190Disputed has been charged back; cannot issue a refund.',
                },
              }
            : f.stripe === 'sent_not_posted'
              ? {
                  ...approved,
                  stripe: {
                    status: 'failed',
                    code: 'SENT_NOT_POSTED',
                    stripe_refund_id: 're_1SQbT0172AcmeOut',
                    message:
                      'refund RF-000004 was sent to Stripe as re_1SQbT0172AcmeOut (the money has left), but it was not posted: PERIOD_LOCKED: the period is locked',
                  },
                }
              : f.stripe === 'sent'
                ? {
                    ...approved,
                    status: 'paid',
                    entry_id: id(0x17299),
                    paid_on: '2026-11-24',
                    stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172Acme', message: null },
                  }
                : {
                    ...approved,
                    stripe: {
                      status: 'pending',
                      stripe_refund_id: null,
                      message:
                        'stripe request failed (unreachable): the Stripe API could not be reached',
                    },
                  };
        return send(route, 200, f.refund);
      }
      if (req.method() === 'POST' && /^\/ar\/refunds\/[0-9a-f-]{36}\/cancel$/.test(path)) {
        if (!perms.includes('ar.refund.create'))
          return send(route, 403, { error: 'forbidden', permission: 'ar.refund.create' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.cancels += 1;
        f.refund = {
          ...f.refund,
          status: 'cancelled',
          stripe: { status: 'not_sent', stripe_refund_id: null, message: null },
        };
        return send(route, 200, f.refund);
      }
      if (!perms.includes('ar.read'))
        return send(route, 403, { error: 'forbidden', permission: 'ar.read' });
      if (path === `/ar/invoices/${INV}`) return send(route, 200, INVOICE);
      if (path === `/ar/invoices/${INV}/payment-status`)
        return send(route, 200, { status: 'paid', open: '0.0000' });
      if (path === `/ar/credit-notes/${CN}`) return send(route, 200, POSTED_CN);
      if (path === `/ar/parties/${ACME}/credit`)
        return send(route, 200, {
          party_id: ACME,
          balance: f.refund?.['status'] === 'paid' ? '0.0000' : '-220.0000',
          requested: f.refund && f.refund['status'] === 'requested' ? '220.0000' : '0.0000',
          available: f.refund && f.refund['status'] !== 'cancelled' ? '0.0000' : '220.0000',
        });
      if (f.refund && path === `/ar/refunds/${String(f.refund['id'])}`)
        return send(route, 200, { ...f.refund, replayed: false });
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}${path}`);
  await expect(page.locator('h1')).toHaveCount(1);
}

async function noAxeViolations(page: Page) {
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
}

const CN_PAGE = `/sales/credit-notes?credit_note=${CN}`;

async function requestStripeRefund(page: Page, f: Fake) {
  const refund = page.getByRole('region', { name: 'Refund' });
  const form = refund.getByRole('form', { name: 'Request a refund' });
  await form.getByRole('radio', { name: /Back to the card/ }).check();
  await form.getByLabel('Amount to refund').fill('220.00');
  await form.getByLabel('Pay from').fill('2026-11-24');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(refund.getByRole('heading', { name: /Refund RF-000004/ })).toBeVisible();
  expect(f.created[0]?.body['method']).toBe('stripe');
  return refund;
}

for (const width of [1440, 390]) {
  test(`SS-UC11-09: a Stripe refund is approved after a fresh sign-in step and the result is shown @ ${String(width)} [T-0172]`, async ({
    page,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, CN_PAGE, width);
    const refund = await requestStripeRefund(page, f);
    await expect(refund.getByRole('status')).toContainText('Waiting for approval');
    await expect(refund).toContainText('goes back to the card at once');

    f.who = 'approver';
    await page.reload();
    await refund.getByRole('button', { name: 'Approve refund' }).click();
    // DL-0562: approving a Stripe refund needs a fresh sign-in step.
    const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('sends 220.00 back to the card at once');
    await expect(prompt.getByRole('heading', { name: 'Confirm it’s you' })).toBeFocused();
    expect(f.stepUps).toBe(1);
    expect(f.approvals).toBe(0);
    await noAxeViolations(page);
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(refund.getByRole('status')).toContainText('Waiting for approval');

    // Back from the step-up: press approve again; Stripe takes it at once.
    f.steppedUp = true;
    await refund.getByRole('button', { name: 'Approve refund' }).click();
    await expect(refund.getByRole('status')).toContainText(
      'Refunded to the card through Stripe on 2026-11-24',
    );
    await expect(refund.getByRole('status')).toContainText('re_1SQbT0172Acme');
    expect(f.approvals).toBe(1);
    await expect(refund.getByRole('button', { name: 'Approve refund' })).toHaveCount(0);
    await noAxeViolations(page);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC11-10: a Stripe send that did not finish at approval says it is retried automatically [T-0172]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, CN_PAGE, 1440);
  const refund = await requestStripeRefund(page, f);
  f.who = 'approver';
  f.steppedUp = true;
  f.stripe = 'pending';
  await page.reload();
  await refund.getByRole('button', { name: 'Approve refund' }).click();
  await expect(refund.getByRole('status')).toContainText('Approved');
  await expect(refund.getByRole('status')).toContainText('tries again automatically');
  await expect(refund.getByRole('button', { name: 'Approve refund' })).toHaveCount(0);
  // After a reload the stored state says the same (no Stripe call from the browser).
  await page.reload();
  await expect(refund.getByRole('status')).toContainText('tries again automatically');
  await noAxeViolations(page);
  expect(f.approvals).toBe(1);
  expect(f.errors).toEqual([]);
});

test('SS-UC11-10: a refund Stripe took but the books could not record says the money has left and is not posted [T-0172]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, CN_PAGE, 1440);
  const refund = await requestStripeRefund(page, f);
  f.who = 'approver';
  f.steppedUp = true;
  f.stripe = 'sent_not_posted';
  await page.reload();
  await refund.getByRole('button', { name: 'Approve refund' }).click();
  const status = refund.getByRole('status');
  // Security review r8 F1: never "Stripe refused" when Stripe has the money out.
  await expect(status).toContainText('Sent to Stripe (Stripe refund re_1SQbT0172AcmeOut)');
  await expect(status).toContainText('not posted');
  await expect(status).toContainText('PERIOD_LOCKED');
  await expect(status).toContainText('Sync issues');
  await expect(status).not.toContainText('Stripe refused');
  await expect(refund.getByRole('button', { name: 'Approve refund' })).toHaveCount(0);
  await noAxeViolations(page);
  expect(f.approvals).toBe(1);
  expect(f.errors).toEqual([]);
});

test.describe('T-0190 cancel', () => {
  test.use({ evidenceTaskId: 'T-0190' });

  for (const width of [1440, 390]) {
    test(`SS-UC11-11: a Stripe refund Stripe refused is cancelled by the clerk and its credit is free again @ ${String(width)} [T-0190]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'clerk');
      await open(page, CN_PAGE, width);
      const refund = await requestStripeRefund(page, f);
      f.who = 'approver';
      f.steppedUp = true;
      f.stripe = 'refused';
      await page.reload();
      await refund.getByRole('button', { name: 'Approve refund' }).click();
      await expect(refund.getByRole('status')).toContainText('Stripe refused the refund');
      await expect(refund.getByRole('status')).toContainText('charged back');
      // An Approver checks; the people who request refunds withdraw them.
      await expect(refund.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);

      f.who = 'clerk';
      await page.reload();
      await expect(refund.getByRole('status')).toContainText('Stripe refused the refund');
      await refund.getByRole('button', { name: 'Cancel refund' }).click();
      const confirm = refund.getByRole('group', { name: 'Cancel this refund?' });
      await expect(confirm).toContainText('220.00');
      await expect(confirm).toContainText('checks with Stripe first');
      await noAxeViolations(page);
      await evidence('SS-UC11-11', `stripe-refund-cancel-confirm-${String(width)}`);
      expect(f.cancels).toBe(0);
      await confirm.getByRole('button', { name: 'Yes, cancel it' }).click();
      await expect(refund.getByRole('status')).toHaveText('Cancelled.');
      await expect(refund).toContainText(/can have back\s*220\.00/);
      await expect(refund.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);
      expect(f.cancels).toBe(1);
      await noAxeViolations(page);
      await evidence('SS-UC11-11', `stripe-refund-cancelled-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-UC11-11: a refund Stripe took (sent, not posted) offers no Cancel, even to the clerk [T-0190]', async ({
    page,
  }) => {
    const f = await fakeApi(page, 'clerk');
    await open(page, CN_PAGE, 1440);
    const refund = await requestStripeRefund(page, f);
    f.who = 'approver';
    f.steppedUp = true;
    f.stripe = 'sent_not_posted';
    await page.reload();
    await refund.getByRole('button', { name: 'Approve refund' }).click();
    await expect(refund.getByRole('status')).toContainText('the money has left');
    f.who = 'clerk';
    await page.reload();
    await expect(refund.getByRole('status')).toContainText('the money has left');
    await expect(refund.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);
    expect(f.cancels).toBe(0);
    expect(f.errors).toEqual([]);
  });
});
