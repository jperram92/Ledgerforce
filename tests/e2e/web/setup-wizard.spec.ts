/**
 * Setup wizard screen (T-0091, design §4.1, SS-PLAT-127, SS-PLAT-128). The Finance Admin of a fresh
 * company on the AU template walks the ten steps to the end: each step shows its state and what is
 * missing in plain words, step 7's gap check shows no gaps, and step 9 is declared "no history".
 * Vite serves the app; each test fakes the API with `page.route`, using the response shapes of
 * GET /companies, GET /setup/wizard and POST /setup/wizard/steps/:n/complete (apps/api, T-0157,
 * ADR-0075). The fake derives status and lock exactly as `wizardOf` does (ADR-0067 rule 6).
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
const CO = id(0x91c1);
const FRAN = id(0x9111);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0091', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: FRAN, display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x9112), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x9113), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

/** The step titles of @ledgerforce/setup WIZARD_STEPS. */
const TITLES = [
  'Company details',
  'Chart of accounts',
  'Tax codes',
  'Bank accounts',
  'Connect Salesforce',
  'Import from Salesforce',
  'Posting profiles',
  'Numbering and billing',
  'Opening balances',
  'Users, roles and approvals',
];
const NO_OPENING =
  'No opening balance has been posted, and the company has not declared that it has no history';

interface Done {
  outcome: 'validated' | 'no_history';
  reason: string | null;
  at: string;
}

interface Fake {
  errors: string[];
  posts: { step: number; key: string | null; body: unknown }[];
  done: Map<number, Done>;
  /** What each step's validator finds missing now (the fake's module state). */
  missing: Map<number, string[]>;
  refuse: Map<number, { status: number; body: unknown }>;
  gets: number;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    posts: [],
    done: new Map(),
    // A fresh company on the AU template: everything is in place except the opening balance.
    missing: new Map([[9, [NO_OPENING]]]),
    refuse: new Map(),
    gets: 0,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const open = () => {
    for (let n = 1; n <= 10; n++) if (!f.done.has(n)) return n;
    return 11;
  };
  const view = (n: number) => {
    const d = f.done.get(n);
    const missing = d?.outcome === 'no_history' ? [] : (f.missing.get(n) ?? []);
    const o = open();
    return {
      step: n,
      title: TITLES[n - 1],
      status: d ? 'complete' : n === o ? 'in_progress' : 'not_started',
      locked: n > o,
      valid: missing.length === 0,
      missing,
      outcome: d?.outcome ?? null,
      reason: d?.reason ?? null,
      completed_at: d?.at ?? null,
      completed_by: d ? FRAN : null,
    };
  };
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|setup)(\/|$)/.test(url.pathname),
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
      if (path === '/setup/wizard' && req.method() === 'GET') {
        if (!perms.includes('settings.read'))
          return send(route, 403, { error: 'forbidden', permission: 'settings.read' });
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.gets += 1;
        return send(route, 200, {
          company_id: CO,
          as_of: '2026-11-15',
          complete: open() === 11,
          steps: TITLES.map((_, i) => view(i + 1)),
        });
      }
      const m = /^\/setup\/wizard\/steps\/(\d+)\/complete$/.exec(path);
      if (m && req.method() === 'POST') {
        if (!perms.includes('settings.setup.manage'))
          return send(route, 403, { error: 'forbidden', permission: 'settings.setup.manage' });
        const n = Number(m[1]);
        const body = req.postDataJSON() as { no_history_reason?: string };
        f.posts.push({ step: n, key: req.headers()['idempotency-key'] ?? null, body });
        const r = f.refuse.get(n);
        if (r) return send(route, r.status, r.body);
        if (f.done.has(n)) return send(route, 200, { ...view(n), replayed: true });
        const reason = body.no_history_reason?.trim();
        if (reason !== undefined && n !== 9)
          return send(route, 422, {
            error: 'NO_HISTORY_NOT_ALLOWED',
            message: 'only step 9 (Opening balances) can be completed without history',
          });
        if (n > open())
          return send(route, 409, {
            error: 'STEP_LOCKED',
            message: `step ${String(n)} is locked: complete step ${String(open())} (${TITLES[open() - 1] ?? ''}) first`,
          });
        const missing = f.missing.get(n) ?? [];
        if (reason === undefined && missing.length > 0)
          return send(route, 422, {
            error: 'STEP_INVALID',
            message: `step ${String(n)} (${TITLES[n - 1] ?? ''}) is not ready: ${missing.join('; ')}`,
            missing,
          });
        f.done.set(n, {
          outcome: reason === undefined ? 'validated' : 'no_history',
          reason: reason ?? null,
          at: `2026-11-14T0${String(n % 10)}:05:00.000Z`,
        });
        return send(route, 201, { ...view(n), replayed: false });
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
  if (width < 600) {
    // The 16px gutter on phones: the steps list starts 16px in from the left edge.
    const box = await page.getByRole('list', { name: 'Setup steps' }).boundingBox();
    expect(box?.x).toBe(16);
  }
}

/** The ten steps are the list items that carry a step heading (missing items nest inside). */
const steps = (page: Page) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3 }) });
const stepItem = (page: Page, n: number) =>
  steps(page).filter({
    has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
  });

for (const width of [1440, 390]) {
  test(`SS-PLAT-127: Setup wizard screen walks a fresh AU company through all ten steps @ ${String(width)} [T-0091]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up your company' }),
    ).toBeVisible();
    await expect(page.getByText('0 of 10 steps done. Now: step 1, Company details.')).toBeVisible();
    await expect(steps(page)).toHaveCount(10);
    await expect(stepItem(page, 1)).toContainText('Open now');
    await expect(stepItem(page, 1)).toContainText('Nothing is missing');
    await expect(stepItem(page, 2)).toContainText('Waits for step 1');
    // Where each setting is entered: an existing screen, or said plainly.
    await expect(stepItem(page, 2).getByRole('link', { name: 'Chart of accounts' })).toBeVisible();
    await expect(stepItem(page, 10).getByRole('link', { name: 'People and roles' })).toBeVisible();
    // T-0176: steps 1 and 3 link to their settings screens; T-0185: step 4 to Bank accounts.
    await expect(stepItem(page, 1).getByRole('link', { name: 'Company details' })).toBeVisible();
    await expect(stepItem(page, 3).getByRole('link', { name: 'Tax settings' })).toBeVisible();
    await expect(stepItem(page, 4).getByRole('link', { name: 'Bank accounts' })).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-127', `wizard-fresh-company-${String(width)}`);

    for (let n = 1; n <= 6; n++) {
      await page
        .getByRole('button', { name: `Complete step ${String(n)}: ${TITLES[n - 1] ?? ''}` })
        .click();
      await expect(stepItem(page, n)).toContainText('Done');
    }
    // Step 7: the posting-profile gap check finds no gaps on the AU template.
    await expect(stepItem(page, 7)).toContainText('Open now');
    await expect(stepItem(page, 7)).toContainText('Gap check: no gaps');
    await expect(
      page.getByText('6 of 10 steps done. Now: step 7, Posting profiles.'),
    ).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-127', `wizard-step-7-no-gaps-${String(width)}`);

    await page.getByRole('button', { name: 'Complete step 7: Posting profiles' }).click();
    await page.getByRole('button', { name: 'Complete step 8: Numbering and billing' }).click();
    await expect(stepItem(page, 9)).toContainText('Open now');
    await expect(stepItem(page, 9)).toContainText(NO_OPENING);
    await page
      .getByLabel('Why the company has no history')
      .fill('New company: started trading on 1 November 2026.');
    await page.getByRole('button', { name: 'Declare no history and complete step 9' }).click();
    await expect(stepItem(page, 9)).toContainText('Done: no history');
    await page
      .getByRole('button', { name: 'Complete step 10: Users, roles and approvals' })
      .click();
    await expect(page.getByText('Setup is complete: all 10 steps are done.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Complete step/ })).toHaveCount(0);
    expect(f.posts.map((p) => p.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(f.posts[0]).toEqual({
      step: 1,
      key: expect.stringMatching(/^.{8,}$/) as unknown,
      body: { company_id: CO },
    });
    expect(new Set(f.posts.map((p) => p.key)).size).toBe(10);
    await assertPage(page, width);
    await evidence('SS-PLAT-127', `wizard-complete-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-127: what is missing is listed in plain words, and Complete waits until nothing is [T-0091]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  f.done.set(1, { outcome: 'validated', reason: null, at: '2026-11-13T23:00:00.000Z' });
  f.done.set(2, { outcome: 'validated', reason: null, at: '2026-11-13T23:10:00.000Z' });
  // Step 2 regressed after it was completed: it stays done but says what is missing now.
  f.missing.set(2, ['System role gst_collected is not bound to an account']);
  f.missing.set(3, [
    'The GST accounting basis (cash or accrual) has not been set',
    'The BAS reporting frequency (monthly, quarterly or annual) has not been set',
  ]);
  await open(page, '/settings/setup', 1440);
  await expect(stepItem(page, 2)).toContainText('Done');
  await expect(stepItem(page, 2)).toContainText(
    'Something has changed since: System role gst_collected is not bound to an account',
  );
  await expect(stepItem(page, 3)).toContainText('Open now');
  await expect(stepItem(page, 3)).toContainText(
    'The GST accounting basis (cash or accrual) has not been set',
  );
  await expect(page.getByRole('button', { name: /^Complete step 3/ })).toHaveCount(0);
  await expect(page.getByText(/Step 3 can be completed once nothing is missing/)).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-127', 'wizard-missing-plain-words-1440');

  // The settings are entered elsewhere; Check again reads the wizard afresh.
  f.missing.delete(3);
  const before = f.gets;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('button', { name: 'Complete step 3: Tax codes' })).toBeVisible();
  expect(f.gets).toBeGreaterThan(before);
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0091: a refused step explains why: STEP_INVALID lists what is missing, STEP_LOCKED says which step comes first', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  // Someone removed the ABN in another tab after the screen was read.
  f.refuse.set(1, {
    status: 422,
    body: {
      error: 'STEP_INVALID',
      message: 'step 1 (Company details) is not ready: The ABN is missing',
      missing: ['The ABN is missing'],
    },
  });
  await open(page, '/settings/setup', 1440);
  await page.getByRole('button', { name: 'Complete step 1: Company details' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Step 1 is not ready');
  await expect(alert.getByRole('listitem')).toHaveText(['The ABN is missing']);
  await expect(stepItem(page, 1)).toContainText('Open now');

  f.refuse.set(1, {
    status: 409,
    body: { error: 'STEP_LOCKED', message: 'step 1 is locked: complete step 1 first' },
  });
  await page.getByRole('button', { name: 'Complete step 1: Company details' }).click();
  await expect(page.getByRole('alert')).toContainText('An earlier step is not done yet');
  expect(f.posts).toHaveLength(2);
  expect(f.posts[0]?.key).not.toBe(f.posts[1]?.key);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-128: step 9 is declared "no history" with a reason, which is shown afterwards [T-0091]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  for (let n = 1; n <= 8; n++)
    f.done.set(n, { outcome: 'validated', reason: null, at: '2026-11-13T23:00:00.000Z' });
  await open(page, '/settings/setup', 1440);
  await expect(stepItem(page, 9)).toContainText('Open now');
  await expect(stepItem(page, 9)).toContainText(NO_OPENING);
  await expect(page.getByRole('button', { name: /^Complete step 9/ })).toHaveCount(0);
  const declare = page.getByRole('button', { name: 'Declare no history and complete step 9' });
  // An empty reason is not sent: the reason is required and kept with the step.
  await declare.click();
  await expect(page.getByText('Write why the company has no history first.')).toBeVisible();
  expect(f.posts).toEqual([]);
  await page
    .getByLabel('Why the company has no history')
    .fill('New company: started trading on 1 November 2026.');
  await assertPage(page, 1440);
  await evidence('SS-PLAT-128', 'wizard-step-9-declare-no-history-1440');
  await declare.click();
  await expect(stepItem(page, 9)).toContainText(
    'Done: no history. Reason: New company: started trading on 1 November 2026.',
  );
  await expect(stepItem(page, 10)).toContainText('Open now');
  expect(f.posts).toEqual([
    {
      step: 9,
      key: expect.stringMatching(/^.{8,}$/) as unknown,
      body: {
        company_id: CO,
        no_history_reason: 'New company: started trading on 1 November 2026.',
      },
    },
  ]);
  await assertPage(page, 1440);
  await evidence('SS-PLAT-128', 'wizard-step-9-no-history-done-1440');
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-128: with an opening balance posted, step 9 refuses "no history" in plain words [T-0091]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  for (let n = 1; n <= 8; n++)
    f.done.set(n, { outcome: 'validated', reason: null, at: '2026-11-13T23:00:00.000Z' });
  f.refuse.set(9, {
    status: 422,
    body: {
      error: 'NO_HISTORY_NOT_ALLOWED',
      message: 'an opening balance has been posted, so the company has history',
    },
  });
  await open(page, '/settings/setup', 1440);
  await page.getByLabel('Why the company has no history').fill('We think there is none.');
  await page.getByRole('button', { name: 'Declare no history and complete step 9' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'an opening balance has been posted, so the company has history',
  );
  await expect(stepItem(page, 9)).toContainText('Open now');
  expect(f.errors).toEqual([]);
});

test('T-0091: an Accountant sees the steps but cannot complete them', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/settings/setup', 1440);
  await expect(page.getByRole('list', { name: 'Setup steps' })).toBeVisible();
  await expect(stepItem(page, 1)).toContainText('Open now');
  await expect(page.getByRole('button', { name: /^(Complete|Declare)/ })).toHaveCount(0);
  await expect(page.getByLabel('Why the company has no history')).toHaveCount(0);
  await expect(page.getByText(/Owner or a Finance Admin completes setup steps/)).toBeVisible();
  await assertPage(page, 1440);
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0091: a user without settings.read is told so, and no steps are listed', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/setup', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup steps' })).toHaveCount(0);
  expect(f.gets).toBe(0);
  expect(f.errors).toEqual([]);
});

test('T-0091: the wizard is listed on the Settings page', async ({ page }) => {
  await fakeApi(page, 'fa');
  await open(page, '/settings', 1440);
  await page.getByRole('link', { name: 'Set up your company' }).click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your company' })).toBeVisible();
});
