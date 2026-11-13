/**
 * Close checklist screen (T-0090, UC-10, SS-UC10-10). The Finance Admin opens October mid-close and
 * sees each step's state with who completed it and when. Then they complete the next step. Vite
 * serves the app; each test fakes the API with `page.route`, using the response shapes of
 * GET /companies, GET /periods, GET/POST /periods/:id/close-checklist[/:step] (apps/api, T-0148).
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
const CO = id(0x90c1);
const SEPT = id(0x9009);
const OCT = id(0x9010);
const FRAN = id(0x9011);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0090', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  accountant: { user_id: id(0x9012), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x9013), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

const STEPS = [
  'ar_lock',
  'ap_lock',
  'bank_recs',
  'accruals',
  'tb_review',
  'soft_close',
  'hard_lock',
];
const STATUS_OF: Record<string, string> = {
  ar_lock: 'ar_locked',
  ap_lock: 'ap_locked',
  soft_close: 'soft_closed',
  hard_lock: 'hard_locked',
};

interface Fake {
  errors: string[];
  posts: { step: string; key: string | null; body: unknown }[];
  done: Map<string, { at: string; status: string }>;
  status: string;
  refuse: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    posts: [],
    // October mid-close: AR and AP locked by Fran on 3 and 4 November (Sydney).
    done: new Map([
      ['ar_lock', { at: '2026-11-02T22:15:00.000Z', status: 'ar_locked' }],
      ['ap_lock', { at: '2026-11-03T23:40:00.000Z', status: 'ap_locked' }],
    ]),
    status: 'ap_locked',
    refuse: new Map(),
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const checklist = () => ({
    period: {
      id: OCT,
      name: 'October 2026',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      status: f.status,
    },
    steps: STEPS.map((step) => {
      const d = f.done.get(step);
      return {
        step,
        completed_by: d ? FRAN : null,
        completed_by_name: d ? 'Fran Admin' : null,
        completed_at: d?.at ?? null,
        period_status: d?.status ?? null,
      };
    }),
  });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|periods)(\/|$)/.test(url.pathname),
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
      if (req.method() === 'GET' && !perms.includes('reports.run'))
        return send(route, 403, { error: 'forbidden', permission: 'reports.run' });
      if (path === '/periods') {
        expect(url.searchParams.get('company_id')).toBe(CO);
        return send(route, 200, {
          periods: [
            {
              id: SEPT,
              name: 'September 2026',
              start_date: '2026-09-01',
              end_date: '2026-09-30',
              status: 'hard_locked',
            },
            {
              id: OCT,
              name: 'October 2026',
              start_date: '2026-10-01',
              end_date: '2026-10-31',
              status: f.status,
            },
          ],
        });
      }
      if (path === `/periods/${OCT}/close-checklist` && req.method() === 'GET') {
        expect(url.searchParams.get('company_id')).toBe(CO);
        return send(route, 200, checklist());
      }
      const m = /^\/periods\/([^/]+)\/close-checklist\/([a-z_]+)$/.exec(path);
      if (m && req.method() === 'POST') {
        if (!perms.includes('period.lock'))
          return send(route, 403, { error: 'forbidden', permission: 'period.lock' });
        const step = m[2] ?? '';
        f.posts.push({
          step,
          key: req.headers()['idempotency-key'] ?? null,
          body: req.postDataJSON(),
        });
        const r = f.refuse.get(step);
        if (r) return send(route, r.status, r.body);
        const at = '2026-11-05T01:30:00.000Z';
        f.status = STATUS_OF[step] ?? f.status;
        f.done.set(step, { at, status: f.status });
        return send(route, 201, {
          step,
          completed_by: FRAN,
          completed_at: at,
          period_status: f.status,
          replayed: false,
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
  test(`SS-UC10-10: Close checklist screen @ ${String(width)} [T-0090]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, `/accounting/close?period=${OCT}`, width);
    await expect(page.getByRole('heading', { level: 1, name: 'Month-end close' })).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveValue(OCT);
    const table = page.getByRole('table', { name: 'Close checklist' });
    await expect(table.getByRole('row')).toHaveCount(8);
    const row = (n: number) => table.getByRole('row').nth(n);
    await expect(row(1)).toContainText('Lock sales');
    await expect(row(1)).toContainText('Done');
    await expect(row(1)).toContainText('Fran Admin');
    await expect(row(1)).toContainText('3 Nov 2026');
    await expect(row(2)).toContainText('4 Nov 2026');
    await expect(row(3)).toContainText('Next');
    await expect(row(4)).toContainText('Waiting');
    await expect(page.getByText(/^October 2026: Purchases locked\./)).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC10-10', `close-checklist-mid-close-${String(width)}`);

    await page.getByRole('button', { name: 'Complete: Bank reconciliations' }).click();
    await expect(row(3)).toContainText('Done');
    await expect(row(4)).toContainText('Next');
    expect(f.posts).toEqual([
      {
        step: 'bank_recs',
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: { company_id: CO },
      },
    ]);
    await assertPage(page, width);
    await evidence('SS-UC10-10', `close-checklist-step-completed-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0090: a refused step explains why, naming the unreconciled bank accounts', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.refuse.set('bank_recs', {
    status: 422,
    body: {
      error: 'BANK_UNRECONCILED',
      message: 'bank reconciliations are not complete to 2026-10-31: Operating (3 lines)',
      accounts: [{ bankAccountId: id(0x9020), name: 'Operating', unreconciledLines: 3 }],
    },
  });
  await open(page, `/accounting/close?period=${OCT}`, 1440);
  await page.getByRole('button', { name: 'Complete: Bank reconciliations' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Operating');
  await expect(alert).toContainText('3 lines');
  await expect(
    page.getByRole('table', { name: 'Close checklist' }).getByRole('row').nth(3),
  ).toContainText('Next');
  expect(f.errors).toEqual([]);
});

test('T-0090: an Accountant sees the checklist but cannot complete steps', async ({ page }) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, `/accounting/close?period=${OCT}`, 1440);
  await expect(page.getByRole('table', { name: 'Close checklist' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Complete/ })).toHaveCount(0);
  await expect(page.getByText(/Owner or Finance Admin/)).toBeVisible();
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0090: a user without reports.run is told so, and nothing is listed', async ({ page }) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/accounting/close', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Close checklist' })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('T-0090: without a period in the address, the latest period that is not hard-locked is shown', async ({
  page,
}) => {
  await fakeApi(page, 'fa');
  await open(page, '/accounting/close', 1440);
  await expect(page.getByLabel('Period')).toHaveValue(OCT);
  await expect(page.getByRole('table', { name: 'Close checklist' })).toBeVisible();
});
