/**
 * Check a Stripe refund with Stripe, and the two-person resend, in the credit-note screen's refund
 * region (T-0208, UC-11, ADR-0091, ADR-0103, RQ-0185; SS-UC11-14, SS-UC11-15, SS-UC11-16).
 *
 * Acme's 220.00 Stripe refund RF-000004 was approved more than 23 hours ago and never sent
 * (KEY_EXPIRED). An Approver checks it with Stripe: the region says what Stripe holds (recorded,
 * held for an unapproved or cancelled document, or nothing with the failed refund ids). With
 * nothing at Stripe the Approver asks to send it again with a reason; the region then shows the
 * waiting resend (who asked, when, why). The person who asked cannot confirm it; a different
 * person confirms it behind the step-up prompt, and the refund is sent.
 * The API is faked with `page.route` using the shapes of the real routes
 * (apps/api/src/ar/refunds.controller.ts, proven by refunds-stripe.db.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { expect, test } from '@ledgerforce/testing/evidence';
import { createViteServer } from 'vitest/node';
import { ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x208c1);
const ACME = id(0x208a1);
const INV = id(0x20801);
const CN = id(0x20821);
const RF = id(0x20841);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';
let cacheDir = '';

test.use({ timezoneId: 'Australia/Sydney', locale: 'en-AU', evidenceTaskId: 'T-0208' });

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
  clerk: { user_id: id(0x20831), display_name: 'Lena Ortiz', role: 'ar_clerk' as const },
  approver: { user_id: id(0x20833), display_name: 'Ana Kim', role: 'approver' as const },
  financeAdmin: { user_id: id(0x20835), display_name: 'Sam Lee', role: 'finance_admin' as const },
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
  entry_id: id(0x20809),
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
  entry_id: id(0x20860),
  net: '200.0000',
  tax: '20.0000',
  gross: '220.0000',
};

const EXPIRED = {
  status: 'failed',
  code: 'KEY_EXPIRED',
  stripe_refund_id: null,
  message:
    'it was not sent within 23 hours of its approval, so it is no longer sent automatically; check it with Stripe, then resend or cancel it',
  resend: null,
};

const expiredRefund = (): Record<string, unknown> => ({
  id: RF,
  replayed: false,
  refund_no: 'RF-000004',
  party_id: ACME,
  refund_date: '2026-11-22',
  amount: '220.0000',
  method: 'stripe',
  status: 'requested',
  approval: 'approved',
  created_by: ME.clerk.user_id,
  approved_by: ME.approver.user_id,
  approved_at: '2026-11-22T00:00:00.000Z',
  entry_id: null,
  paid_on: null,
  stripe: EXPIRED,
});

const paid = (r: Record<string, unknown>, stripeRefundId: string) => ({
  ...r,
  status: 'paid',
  entry_id: id(0x20899),
  paid_on: '2026-11-24',
  stripe: { status: 'sent', stripe_refund_id: stripeRefundId, message: null, resend: null },
});

type CheckAnswer = 'recorded' | 'not_at_stripe' | 'not_resendable' | 'held_unapproved';

interface Fake {
  who: Who;
  steppedUp: boolean;
  check: CheckAnswer;
  errors: string[];
  checks: number;
  resendAsks: { resendId: string; reason: string; by: string }[];
  confirms: number;
  stepUps: number;
  refund: Record<string, unknown>;
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = {
    who,
    steppedUp: false,
    check: 'not_at_stripe',
    errors: [],
    checks: 0,
    resendAsks: [],
    confirms: 0,
    stepUps: 0,
    refund: expiredRefund(),
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
      const approverOnly = () =>
        perms.includes('ar.refund.approve')
          ? null
          : send(route, 403, { error: 'forbidden', permission: 'ar.refund.approve' });
      if (req.method() === 'POST' && path === `/ar/refunds/${RF}/stripe-check`) {
        const no = approverOnly();
        if (no) return no;
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.checks += 1;
        if (f.check === 'recorded') {
          f.refund = paid(f.refund, 're_1SQbT0208Found');
          return send(route, 200, {
            outcome: 'recorded',
            stripe_refund_id: 're_1SQbT0208Found',
            failed_at_stripe: [],
            cancelled_held_at_stripe: [],
            resendable: false,
            refund: f.refund,
          });
        }
        if (f.check === 'held_unapproved')
          return send(route, 200, {
            outcome: 'held_unapproved',
            stripe_refund_id: 're_1SQbT0208Held',
            failed_at_stripe: [],
            cancelled_held_at_stripe: [],
            resendable: false,
            refund: f.refund,
          });
        return send(route, 200, {
          outcome: 'not_at_stripe',
          stripe_refund_id: null,
          failed_at_stripe: ['re_1SQbT0208Failed'],
          cancelled_held_at_stripe:
            f.check === 'not_resendable'
              ? [{ refund_id: id(0x20843), stripe_refund_id: 're_1SQbT0208Stray' }]
              : [],
          resendable: f.check === 'not_at_stripe',
          refund: f.refund,
        });
      }
      const ask = /^\/ar\/refunds\/([0-9a-f-]{36})\/stripe-resends\/([0-9a-f-]{36})$/.exec(path);
      if (req.method() === 'PUT' && ask) {
        const no = approverOnly();
        if (no) return no;
        const body = req.postDataJSON() as { reason?: string };
        const resendId = ask[2] ?? '';
        f.resendAsks.push({ resendId, reason: body.reason ?? '', by: me.user_id });
        const resend = {
          id: resendId,
          requested_by: me.user_id,
          requested_by_name: me.display_name,
          requested_at: '2026-11-24T01:30:00.000Z',
          reason: body.reason ?? '',
        };
        f.refund = { ...f.refund, stripe: { ...EXPIRED, resend } };
        return send(route, 201, {
          id: resendId,
          refund_id: RF,
          replayed: false,
          status: 'requested',
          requested_by: me.user_id,
          requested_at: resend.requested_at,
          reason: resend.reason,
          confirmed_by: null,
          confirmed_at: null,
          idempotency_key: `lf-refund-v3-${resendId}`,
        });
      }
      const confirm =
        /^\/ar\/refunds\/[0-9a-f-]{36}\/stripe-resends\/([0-9a-f-]{36})\/confirm$/.exec(path);
      if (req.method() === 'POST' && confirm) {
        const no = approverOnly();
        if (no) return no;
        const resend = (f.refund['stripe'] as { resend: { requested_by: string } | null }).resend;
        if (resend?.requested_by === me.user_id)
          return send(route, 403, {
            error: 'sod_violation',
            rule: 'SOD_REFUND_RESEND_SELF_CONFIRM',
          });
        if (!f.steppedUp) {
          f.stepUps += 1;
          return send(route, 401, { error: 'step_up_required', max_age: 300 });
        }
        f.confirms += 1;
        f.refund = paid(f.refund, 're_1SQbT0208Resent');
        return send(route, 200, {
          resend: { id: confirm[1], status: 'confirmed', confirmed_by: me.user_id },
          refund: f.refund,
        });
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
          balance: f.refund['status'] === 'paid' ? '0.0000' : '-220.0000',
          requested: f.refund['status'] === 'requested' ? '220.0000' : '0.0000',
          available: '0.0000',
        });
      if (path === `/ar/refunds/${RF}`) return send(route, 200, { ...f.refund, replayed: false });
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}/sales/credit-notes?credit_note=${CN}&refund=${RF}`);
  await expect(page.locator('h1')).toHaveCount(1);
  const refund = page.getByRole('region', { name: 'Refund' });
  await expect(refund.getByRole('heading', { name: /Refund RF-000004/ })).toBeVisible();
  return refund;
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

for (const width of [1440, 390]) {
  test(`SS-UC11-14: an Approver checks an expired Stripe refund with Stripe and sees that nothing moved money, with the failed refund ids @ ${String(width)} [T-0208]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'approver');
    const refund = await open(page, width);
    await expect(refund.getByRole('status').first()).toContainText(
      'Approved more than 23 hours ago and not sent',
    );
    await refund.getByRole('button', { name: 'Check with Stripe' }).click();
    const outcome = refund.getByRole('region', { name: 'What Stripe holds' });
    await expect(outcome).toContainText('Stripe holds no refund that moved money for RF-000004');
    await expect(outcome).toContainText('re_1SQbT0208Failed');
    await expect(outcome).toContainText('no money left');
    await expect(outcome.getByRole('button', { name: 'Ask to send again' })).toBeVisible();
    expect(f.checks).toBe(1);
    await noAxeViolations(page);
    await evidence('SS-UC11-14', `stripe-check-nothing-at-stripe-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC11-14: a check that finds the refund at Stripe records it; the region shows it refunded [T-0208]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'approver');
  f.check = 'recorded';
  const refund = await open(page, 1440);
  await refund.getByRole('button', { name: 'Check with Stripe' }).click();
  const outcome = refund.getByRole('region', { name: 'What Stripe holds' });
  await expect(outcome).toContainText('Stripe had this refund (re_1SQbT0208Found)');
  await expect(outcome).toContainText('recorded it once');
  await expect(refund.getByRole('status').first()).toContainText(
    'Refunded to the card through Stripe on 2026-11-24 (Stripe refund re_1SQbT0208Found)',
  );
  await expect(refund.getByRole('button', { name: 'Check with Stripe' })).toHaveCount(0);
  await expect(refund.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);
  await noAxeViolations(page);
  await evidence('SS-UC11-14', 'stripe-check-recorded-1440');
  expect(f.checks).toBe(1);
  expect(f.errors).toEqual([]);
});

test('SS-UC11-14: when a resend is not possible the check says why, and lists Stripe refunds of cancelled refunds; an AR Clerk is not offered the check [T-0208]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  const refund = await open(page, 1440);
  await expect(refund.getByRole('status').first()).toContainText(
    'An Approver checks it with Stripe',
  );
  await expect(refund.getByRole('button', { name: 'Check with Stripe' })).toHaveCount(0);
  f.who = 'approver';
  f.check = 'not_resendable';
  await page.reload();
  await refund.getByRole('button', { name: 'Check with Stripe' }).click();
  const outcome = refund.getByRole('region', { name: 'What Stripe holds' });
  await expect(outcome).toContainText('cannot be sent again now');
  await expect(outcome).toContainText('re_1SQbT0208Stray');
  await expect(outcome).toContainText('cancelled refund');
  await expect(outcome.getByRole('button', { name: 'Ask to send again' })).toHaveCount(0);
  await noAxeViolations(page);
  expect(f.errors).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`SS-UC11-15: one Approver asks to send it again with a reason; the same person cannot confirm; another person confirms behind the step-up and it is sent @ ${String(width)} [T-0208]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'approver');
    const refund = await open(page, width);
    await refund.getByRole('button', { name: 'Check with Stripe' }).click();
    const outcome = refund.getByRole('region', { name: 'What Stripe holds' });
    await outcome.getByRole('button', { name: 'Ask to send again' }).click();
    const form = refund.getByRole('form', { name: 'Ask to send this refund again' });
    // A reason is required (the API's rule, 1–500 characters).
    await form.getByRole('button', { name: 'Ask to send again' }).click();
    await expect(form.getByRole('alert')).toContainText('Say why it should be sent again');
    await expect(form.getByLabel('Why send it again')).toBeFocused();
    expect(f.resendAsks).toEqual([]);
    await form
      .getByLabel('Why send it again')
      .fill('Checked the payment in Stripe: no refund was made');
    await form.getByRole('button', { name: 'Ask to send again' }).click();
    const waiting = refund.getByRole('group', { name: 'Resend waiting for a second person' });
    await expect(waiting).toContainText('You asked to send it again');
    await expect(waiting).toContainText('Checked the payment in Stripe: no refund was made');
    await expect(waiting).toContainText('another Approver, Finance Admin or Owner');
    await expect(waiting.getByRole('button', { name: 'Confirm and send again' })).toHaveCount(0);
    expect(f.resendAsks).toHaveLength(1);
    expect(f.resendAsks[0]?.reason).toBe('Checked the payment in Stripe: no refund was made');
    await noAxeViolations(page);
    await evidence('SS-UC11-15', `stripe-resend-asked-requester-view-${String(width)}`);

    // A different person confirms: the step-up first, then the send.
    f.who = 'financeAdmin';
    await page.reload();
    await expect(waiting).toContainText('Ana Kim asked to send it again');
    await expect(waiting).toContainText('You can confirm it: you did not ask for it.');
    await waiting.getByRole('button', { name: 'Confirm and send again' }).click();
    const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('sends 220.00 back to the card again, through Stripe');
    await expect(prompt.getByRole('heading', { name: 'Confirm it’s you' })).toBeFocused();
    expect(f.stepUps).toBe(1);
    expect(f.confirms).toBe(0);
    await noAxeViolations(page);
    await evidence('SS-UC11-15', `stripe-resend-confirm-step-up-${String(width)}`);
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toHaveCount(0);

    f.steppedUp = true;
    await waiting.getByRole('button', { name: 'Confirm and send again' }).click();
    await expect(refund.getByRole('status').first()).toContainText(
      'Refunded to the card through Stripe on 2026-11-24 (Stripe refund re_1SQbT0208Resent)',
    );
    await expect(waiting).toHaveCount(0);
    expect(f.confirms).toBe(1);
    await noAxeViolations(page);
    await evidence('SS-UC11-15', `stripe-resend-confirmed-sent-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC11-15: while their resend waits, the person who asked is offered neither the confirm nor the check, and nothing is sent [T-0208]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'approver');
  f.refund = {
    ...f.refund,
    stripe: {
      ...EXPIRED,
      resend: {
        id: id(0x20851),
        requested_by: ME.approver.user_id,
        requested_by_name: 'Ana Kim',
        requested_at: '2026-11-24T01:30:00.000Z',
        reason: 'No refund at Stripe',
      },
    },
  };
  // The browser hides the button from the person who asked; the API is still the authority.
  const refund = await open(page, 1440);
  const waiting = refund.getByRole('group', { name: 'Resend waiting for a second person' });
  await expect(waiting).toContainText('You asked to send it again');
  await expect(waiting.getByRole('button', { name: 'Confirm and send again' })).toHaveCount(0);
  await expect(refund.getByRole('button', { name: 'Check with Stripe' })).toHaveCount(0);
  expect(f.confirms).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-UC11-16: a waiting resend shows who asked, when and why, to everyone who can read the refund [T-0208]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'clerk');
  f.refund = {
    ...f.refund,
    stripe: {
      ...EXPIRED,
      resend: {
        id: id(0x20851),
        requested_by: ME.approver.user_id,
        requested_by_name: 'Ana Kim',
        requested_at: '2026-11-24T01:30:00.000Z',
        reason: 'Checked the payment in Stripe: no refund was made',
      },
    },
  };
  const refund = await open(page, 1440);
  const waiting = refund.getByRole('group', { name: 'Resend waiting for a second person' });
  await expect(refund.getByRole('status').first()).toContainText(
    'Someone asked to send it again; it waits for a second person to confirm it.',
  );
  await expect(waiting).toContainText('Ana Kim asked to send it again on 24 Nov 2026, 12:30 pm');
  await expect(waiting).toContainText('Checked the payment in Stripe: no refund was made');
  await expect(waiting).toContainText('another Approver, Finance Admin or Owner');
  // A clerk reads it; only Approvers act on it.
  await expect(waiting.getByRole('button', { name: 'Confirm and send again' })).toHaveCount(0);
  await noAxeViolations(page);
  await evidence('SS-UC11-16', 'stripe-resend-waiting-clerk-view-1440');
  expect(f.errors).toEqual([]);
});
