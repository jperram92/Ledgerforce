/**
 * Supplier payment screens (T-0087, UC-06): releasing a payment batch with step-up (SS-UC06-10)
 * and verifying a supplier's new bank details (SS-UC06-09, screen half). Vite serves the app;
 * each test fakes the API with `page.route`, using the response shapes of GET/POST
 * /ap/payment-batches[/:id[/release]] and GET/POST /bank-detail-changes[/:id/verify|reject]
 * (apps/api, T-0054, T-0053, T-0153). The fake answers like the real guards: 401
 * step_up_required until the session has stepped up through /auth/step-up, and 403
 * sod_violation with the rule. Account numbers only ever arrive masked.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ROLE_TEMPLATES, type RoleId } from '../../../packages/shared/src/rbac/index.ts';
import { genericnessProbe } from '../fixtures/genericness.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x87c1);
const BATCH = id(0x87b1);
const CHANGE = id(0x87d1);
const PEOPLE = {
  riley: { user_id: id(0x8701), display_name: 'Riley Releaser', roles: ['approver'] },
  casey: { user_id: id(0x8702), display_name: 'Casey Clerk', roles: ['ap_clerk', 'approver'] },
  clerk: { user_id: id(0x8703), display_name: 'Cam Clerk', roles: ['ap_clerk'] },
  olivia: { user_id: id(0x8704), display_name: 'Olivia Owner', roles: ['owner'] },
  oscar: { user_id: id(0x8705), display_name: 'Oscar Owner', roles: ['owner'] },
  avery: { user_id: id(0x8706), display_name: 'Avery AR', roles: ['ar_clerk'] },
} as const satisfies Record<string, { user_id: string; display_name: string; roles: RoleId[] }>;
type Who = keyof typeof PEOPLE;

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0087', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

interface Fake {
  errors: string[];
  steppedUp: boolean;
  stepUps: string[];
  releases: string[];
  verifies: { id: string; body: unknown }[];
  rejects: { id: string; body: unknown }[];
  batch: Record<string, unknown>;
  requestedBy: string;
  refuseRelease: { status: number; body: unknown } | null;
}

function batchOf(createdBy: string) {
  return {
    id: BATCH,
    batch_no: 'PB-0012',
    status: 'draft',
    payment_date: '2026-11-20',
    account_id: id(0x87a1),
    total: '18450.0000',
    payment_count: 2,
    releases_required: 2,
    created_by: createdBy,
    created_by_name: 'Casey Clerk',
    releases: [] as unknown[],
    payments: [
      {
        bill_id: id(0x8711),
        bill_no: 'BILL-0041',
        party_id: id(0x8721),
        party_name: 'Paper Co Pty Ltd',
        amount: '12500.0000',
        bank_account_id: id(0x8731),
        bank_account: { bsb: '062-000', account_number: '***001' },
      },
      {
        bill_id: id(0x8712),
        bill_no: 'BILL-0042',
        party_id: id(0x8722),
        party_name: 'Harbour Freight Pty Ltd',
        amount: '5950.0000',
        bank_account_id: id(0x8732),
        bank_account: { bsb: '033-000', account_number: '***417' },
      },
    ],
    excluded: [
      {
        bill_id: id(0x8713),
        bill_no: 'BILL-0043',
        party_id: id(0x8723),
        party_name: 'Fresh Details Pty Ltd',
        amount: '800.0000',
        reason: 'BANK_DETAILS_COOLING_OFF',
        payable_from: '2026-11-14T23:00:00.000Z',
      },
      {
        bill_id: id(0x8714),
        bill_no: 'BILL-0044',
        party_id: id(0x8724),
        party_name: 'New Supplier Pty Ltd',
        amount: '120.0000',
        reason: 'NO_VERIFIED_BANK_DETAILS',
        payable_from: null,
      },
    ],
    confirmation: null,
  };
}

async function fakeApi(
  page: Page,
  who: Who,
  opts: { createdBy?: string; requestedBy?: string } = {},
): Promise<Fake> {
  const me = PEOPLE[who];
  const f: Fake = {
    errors: [],
    steppedUp: false,
    stepUps: [],
    releases: [],
    verifies: [],
    rejects: [],
    batch: batchOf(opts.createdBy ?? PEOPLE.casey.user_id),
    requestedBy: opts.requestedBy ?? PEOPLE.clerk.user_id,
    refuseRelease: null,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const perms = [
    ...new Set(me.roles.flatMap((r: RoleId) => [...ROLE_TEMPLATES[r].permissions])),
  ] as string[];
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const changeOf = () => ({
    id: CHANGE,
    party_id: id(0x8721),
    party_name: 'Paper Co Pty Ltd',
    status: 'requested',
    bank_account: { bsb: '062-000', account_name: 'Paper Co', account_number: '***321' },
    previous_bank_account: { bsb: '062-000', account_name: 'Paper Co', account_number: '***001' },
    requested_by: f.requestedBy,
    requested_by_name: f.requestedBy === PEOPLE.olivia.user_id ? 'Olivia Owner' : 'Cam Clerk',
    requested_at: '2026-11-13T22:05:00.000Z',
    decided_by_name: null,
    decided_at: null,
    payable_from: null,
  });
  let verified = false;
  await page.route(
    (url) =>
      url.origin === origin &&
      /^\/(auth|companies|ap\/payment-batches|bank-detail-changes)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: me.roles, permissions: perms });
      if (path === '/auth/step-up') {
        // The IdP round trip (ADR-0025): the session steps up and comes back to return_to.
        f.stepUps.push(url.search);
        f.steppedUp = true;
        const back = url.searchParams.get('return_to') ?? '/';
        return route.fulfill({ status: 302, headers: { location: `${origin}${back}` } });
      }
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (path.startsWith('/ap/')) {
        expect(url.searchParams.get('company_id')).toBe(CO);
        if (req.method() === 'GET' && !perms.includes('ap.read'))
          return send(route, 403, { error: 'forbidden', permission: 'ap.read' });
        if (path === '/ap/payment-batches')
          return send(route, 200, {
            batches: [
              {
                id: BATCH,
                batch_no: 'PB-0012',
                status: f.batch['status'],
                payment_date: '2026-11-20',
                total: '18450.0000',
                payment_count: 2,
                excluded_count: 2,
                releases_required: 2,
                release_count: (f.batch['releases'] as unknown[]).length,
                created_by_name: 'Casey Clerk',
                created_at: '2026-11-13T21:00:00.000Z',
              },
            ],
          });
        if (path === `/ap/payment-batches/${BATCH}`) return send(route, 200, f.batch);
        if (path === `/ap/payment-batches/${BATCH}/release` && req.method() === 'POST') {
          if (!perms.includes('ap.payment_batch.release'))
            return send(route, 403, { error: 'forbidden', permission: 'ap.payment_batch.release' });
          if (!f.steppedUp) return send(route, 401, { error: 'step_up_required', max_age: 300 });
          if (f.refuseRelease) return send(route, f.refuseRelease.status, f.refuseRelease.body);
          f.releases.push(me.user_id);
          const releases = [
            ...(f.batch['releases'] as unknown[]),
            {
              released_by: me.user_id,
              released_by_name: me.display_name,
              released_at: '2026-11-13T23:10:00.000Z',
            },
          ];
          f.batch = {
            ...f.batch,
            releases,
            status: releases.length >= 2 ? 'released' : 'partially_released',
          };
          return send(route, 200, f.batch);
        }
      }
      if (path === '/bank-detail-changes') {
        if (!perms.includes('parties.bank_account.read'))
          return send(route, 403, { error: 'forbidden', permission: 'parties.bank_account.read' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        return send(route, 200, { changes: verified ? [] : [changeOf()] });
      }
      const m = /^\/bank-detail-changes\/([^/]+)\/(verify|reject)$/.exec(path);
      if (m && req.method() === 'POST') {
        if (!perms.includes('parties.bank_account.verify'))
          return send(route, 403, {
            error: 'forbidden',
            permission: 'parties.bank_account.verify',
          });
        if (m[2] === 'reject') {
          f.rejects.push({ id: m[1] ?? '', body: req.postDataJSON() });
          verified = true;
          return send(route, 200, { id: CHANGE, status: 'rejected' });
        }
        if (!f.steppedUp) return send(route, 401, { error: 'step_up_required', max_age: 300 });
        if (f.requestedBy === me.user_id)
          return send(route, 403, { error: 'sod_violation', rule: 'SOD_BANK_DETAIL_SELF_VERIFY' });
        f.verifies.push({ id: m[1] ?? '', body: req.postDataJSON() });
        verified = true;
        return send(route, 200, {
          id: CHANGE,
          status: 'verified',
          payable_from: '2026-11-14T23:12:00.000Z',
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
  if (width < 600) {
    // 16 px gutter: main's content starts at least 16 px from each edge.
    const box = await page.locator('main h1').boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(16);
  }
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

for (const width of [1440, 390]) {
  test(`SS-UC06-10 Release screen with step-up prompt @ ${String(width)} [T-0087]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'riley');
    await open(page, '/purchases/payment-batches', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Payment batches' })).toBeVisible();
    const list = page.getByRole('table', { name: 'Payment batches' });
    await expect(list.getByRole('row')).toHaveCount(2);
    await expect(list.getByRole('row').nth(1)).toContainText('Waiting for release');
    await expect(list.getByRole('row').nth(1)).toContainText('18,450.00');
    await expect(list.getByRole('row').nth(1)).toContainText('2 left out');
    await list.getByRole('link', { name: 'PB-0012' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Payment batch PB-0012' }),
    ).toBeVisible();
    const paid = page.getByRole('table', { name: 'Payments in this batch' });
    await expect(paid.getByRole('row')).toHaveCount(3);
    await expect(paid.getByRole('row').nth(1)).toContainText('Paper Co Pty Ltd');
    await expect(paid.getByRole('row').nth(1)).toContainText('BILL-0041');
    await expect(paid.getByRole('row').nth(1)).toContainText('BSB 062-000, account ending 001');
    await expect(paid.getByRole('row').nth(1)).toContainText('12,500.00');
    const left = page.getByRole('table', { name: 'Left out of this batch' });
    await expect(left.getByRole('row')).toHaveCount(3);
    await expect(left.getByRole('row').nth(1)).toContainText('Fresh Details Pty Ltd');
    await expect(left.getByRole('row').nth(1)).toContainText(
      'Bank details changed recently. They can be paid from 15 Nov 2026, 10:00 am, in a later batch.',
    );
    await expect(left.getByRole('row').nth(2)).toContainText('No verified bank details');
    await expect(page.getByText('0 of 2 releases given')).toBeVisible();
    await expect(page.getByText(/needs two different people/)).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC06-10', `batch-awaiting-release-${String(width)}`);

    await page.getByRole('button', { name: 'Release payment batch' }).click();
    const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('sends money out of your bank account');
    await expect(page.getByRole('button', { name: 'Release payment batch' })).toHaveCount(0);
    expect(f.releases).toEqual([]);
    await assertPage(page, width);
    await evidence('SS-UC06-10', `release-step-up-prompt-${String(width)}`);

    await prompt.getByRole('button', { name: 'Confirm my sign-in' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Payment batch PB-0012' }),
    ).toBeVisible();
    expect(f.stepUps).toEqual([
      `?max_age=300&return_to=${encodeURIComponent(`/purchases/payment-batches/${BATCH}`)}`,
    ]);
    await page.getByRole('button', { name: 'Release payment batch' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'You released' })).toBeVisible();
    await expect(page.getByText('1 of 2 releases given')).toBeVisible();
    await expect(page.getByText('Waiting for the second release').first()).toBeVisible();
    await expect(page.getByText(/You already gave one release/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Release payment batch' })).toBeDisabled();
    expect(f.releases).toEqual([PEOPLE.riley.user_id]);
    await assertPage(page, width);
    await evidence('SS-UC06-10', `batch-first-release-given-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0087: the person who built the batch is told before trying that someone else releases it', async ({
  page,
}) => {
  const f = await fakeApi(page, 'casey');
  await open(page, `/purchases/payment-batches/${BATCH}`, 1440);
  await expect(page.getByText(/^You created this batch\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release payment batch' })).toBeDisabled();
  expect(f.releases).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0087: a separation-of-duties refusal from the API is explained in plain words', async ({
  page,
}) => {
  const f = await fakeApi(page, 'riley');
  f.steppedUp = true;
  f.refuseRelease = {
    status: 403,
    body: { error: 'sod_violation', rule: 'SOD_BATCH_SAME_RELEASER' },
  };
  await open(page, `/purchases/payment-batches/${BATCH}`, 1440);
  await page.getByRole('button', { name: 'Release payment batch' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'the second release has to come from someone else',
  );
  await expect(page.getByText('0 of 2 releases given')).toBeVisible();
  expect(f.errors).toEqual([]);
});

test('T-0087: an AP Clerk sees the batch but no release button', async ({ page }) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, `/purchases/payment-batches/${BATCH}`, 1440);
  await expect(page.getByRole('table', { name: 'Payments in this batch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release payment batch' })).toHaveCount(0);
  await expect(page.getByText(/An Approver or the Owner releases payment batches/)).toBeVisible();
  expect(f.errors).toEqual([]);
});

test('T-0087: someone without access to payables is told so, and nothing is listed', async ({
  page,
}) => {
  const f = await fakeApi(page, 'avery');
  await open(page, '/purchases/payment-batches', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Payment batches' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

const NOTE =
  'Called Paper Co on 02 9000 0000 from our 2025 contract; Jo confirmed the new account.';

for (const width of [1440, 390]) {
  test(`SS-UC06-09 Bank-detail change needs a different verifier: verification screen with step-up @ ${String(width)} [T-0087]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'oscar');
    await open(page, '/purchases/bank-details', width);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Supplier bank details to verify' }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: 'Waiting for verification' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row').nth(1)).toContainText('Paper Co Pty Ltd');
    await expect(table.getByRole('row').nth(1)).toContainText('Cam Clerk');
    const review = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
    await expect(review).toContainText('BSB 062-000, account ending 321');
    await expect(review).toContainText('BSB 062-000, account ending 001');
    await assertPage(page, width);
    await evidence('SS-UC06-09', `bank-details-to-verify-${String(width)}`);

    await review.getByLabel('How you confirmed it with the supplier').fill(NOTE);
    await review.getByRole('button', { name: 'Verify new bank details' }).click();
    const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
    await expect(prompt).toContainText('decides where future payments go');
    await assertPage(page, width);
    await evidence('SS-UC06-09', `bank-details-step-up-prompt-${String(width)}`);
    await prompt.getByRole('button', { name: 'Confirm my sign-in' }).click();

    const back = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
    await expect(back.getByLabel('How you confirmed it with the supplier')).toHaveValue(NOTE);
    await back.getByRole('button', { name: 'Verify new bank details' }).click();
    const done = page.getByRole('status').filter({ hasText: 'Verified' });
    await expect(done).toContainText('Paper Co Pty Ltd');
    await expect(done).toContainText('15 Nov 2026, 10:12 am');
    await expect(page.getByText('Nothing waiting for verification')).toBeVisible();
    expect(f.verifies).toEqual([{ id: CHANGE, body: { confirmation_note: NOTE } }]);
    await assertPage(page, width);
    await evidence('SS-UC06-09', `bank-details-verified-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0087: the Owner who asked for the change is told someone else verifies it', async ({
  page,
}) => {
  const f = await fakeApi(page, 'olivia', { requestedBy: PEOPLE.olivia.user_id });
  await open(page, '/purchases/bank-details', 1440);
  const review = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
  await expect(review.getByText(/^You asked for this change\./)).toBeVisible();
  await expect(review.getByRole('button', { name: 'Verify new bank details' })).toHaveCount(0);
  expect(f.verifies).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0087: a change can be rejected with a reason, without step-up', async ({ page }) => {
  const f = await fakeApi(page, 'oscar');
  await open(page, '/purchases/bank-details', 1440);
  const review = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
  await review.getByText('Reject this change instead').click();
  await review.getByLabel('Why you are rejecting it').fill('Paper Co says they did not ask.');
  await review.getByRole('button', { name: 'Reject change' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rejected' })).toBeVisible();
  expect(f.rejects).toEqual([{ id: CHANGE, body: { reason: 'Paper Co says they did not ask.' } }]);
  expect(f.errors).toEqual([]);
});

test('T-0087: an Approver sees the changes but only the Owner verifies them', async ({ page }) => {
  const f = await fakeApi(page, 'riley');
  await open(page, '/purchases/bank-details', 1440);
  await expect(page.getByRole('table', { name: 'Waiting for verification' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify new bank details' })).toHaveCount(0);
  await expect(page.getByText(/Only the Owner verifies bank details/).first()).toBeVisible();
  expect(f.errors).toEqual([]);
});
