/**
 * T-0209 — failed security notices in apps/web, end to end in Chromium (ADR-0097, RQ-0179).
 *
 *  - SS-PLAT-161: Settings → Failed security notices lists each notice the dispatcher could not
 *    deliver (what changed, account ending, masked recipient, tries, what went wrong, next try)
 *    with a Retry now button for the Owner and a Finance Admin (Idempotency-Key per press); the
 *    Auditor sees it read-only; an Accountant is refused; empty, error and refusal states.
 *
 * Every screen at 1440 and 390 with axe WCAG 2.2 AA (0 violations), the genericness probes, no
 * horizontal scroll and no console errors. The app is served in-process by Vite (as
 * sync-issues.spec.ts) and the API is faked per test with `page.route`; the contract faked is the
 * one apps/api/src/security-notices/security-notices.db.test.ts proves. Times in Australia/Sydney.
 * Screenshots go to .agent/evidence/T-0209/.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';
import { genericnessProbe } from '../fixtures/genericness.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0209', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

// The worker's Vite cache is removed after its tests; left behind it fills the disk (DL-0820).
let cacheDir = '';

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

type Who = 'owner' | 'fa' | 'auditor' | 'accountant';
const ME: Record<Who, { user_id: string; display_name: string; roles: string[] }> = {
  owner: { user_id: id(0x2091), display_name: 'Sam Nguyen', roles: ['owner'] },
  fa: { user_id: id(0x2092), display_name: 'Mei Tan', roles: ['finance_admin'] },
  auditor: { user_id: id(0x2093), display_name: 'Ada Brooks', roles: ['auditor'] },
  accountant: { user_id: id(0x2094), display_name: 'Priya Shah', roles: ['accountant'] },
};
const permissionsOf = (roles: string[]) =>
  [
    ...new Set(roles.flatMap((r) => ROLE_TEMPLATES[r as keyof typeof ROLE_TEMPLATES].permissions)),
  ].sort();

interface Notice {
  kind: 'remittance_account_changed' | 'bank_details_changed';
  id: string;
  context: string;
  account_last3: string | null;
  recipient: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string;
  last_smtp_code: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: string;
  retry_requested: boolean;
}

const REMIT = id(0x20a1);
const SUPPLIER = id(0x20a2);

const seed = (): Notice[] => [
  {
    kind: 'remittance_account_changed',
    id: REMIT,
    context: 'Harbour & Co Pty Ltd',
    account_last3: '321',
    recipient: 'o•••@harbour.example',
    created_at: '2026-11-19T22:00:00.000Z',
    attempts: 11,
    last_attempt_at: '2026-11-21T22:00:00.000Z',
    last_smtp_code: 550,
    last_error_code: 'EENVELOPE',
    last_error_message: '550 5.1.1 <o•••@harbour.example>: Recipient address rejected',
    next_attempt_at: '2026-11-22T04:00:00.000Z',
    retry_requested: false,
  },
  {
    kind: 'bank_details_changed',
    id: SUPPLIER,
    context: 'Office Supplies Pty Ltd',
    account_last3: '654',
    recipient: 'a•••@office-supplies.example',
    created_at: '2026-11-21T01:00:00.000Z',
    attempts: 4,
    last_attempt_at: '2026-11-21T01:07:00.000Z',
    last_smtp_code: 421,
    last_error_code: 'EENVELOPE',
    last_error_message: '421 4.7.0 Try again later',
    next_attempt_at: '2026-11-21T01:15:00.000Z',
    retry_requested: false,
  },
];

interface Fake {
  who: Who;
  notices: Notice[];
  posts: { path: string; key: string | undefined }[];
  errors: string[];
  override: Map<string, { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: Who, notices = seed()): Promise<Fake> {
  const f: Fake = { who, notices, posts: [], errors: [], override: new Map() };
  page.on('console', (m) => {
    // The fake answers 4xx/5xx on purpose in some tests; Chromium logs those as failed resources.
    if (m.type() === 'error' && !/status of (403|409|500)/.test(m.text())) f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|users|security-notices)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      const o = f.override.get(`${method} ${path}`);
      if (o) return send(route, o.status, o.body);
      const me = ME[f.who];
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, {
          roles: me.roles,
          permissions: f.who === 'owner' ? [...ALL_PERMISSIONS].sort() : permissionsOf(me.roles),
        });
      if (path === '/users') return send(route, 200, []);
      const may = (p: string) => (permissionsOf(ME[f.who].roles) as readonly string[]).includes(p);
      if (path === '/security-notices/failed' && method === 'GET') {
        if (!may('security_notices.read'))
          return send(route, 403, { error: 'forbidden', permission: 'security_notices.read' });
        return send(route, 200, { notices: f.notices });
      }
      const m = /^\/security-notices\/([a-z_]+)\/([^/]+)\/retry$/.exec(path);
      if (m && method === 'POST') {
        const key = req.headers()['idempotency-key'];
        f.posts.push({ path, key });
        if (!may('security_notices.retry'))
          return send(route, 403, { error: 'forbidden', permission: 'security_notices.retry' });
        if (!key) return send(route, 400, { error: 'idempotency_key_required' });
        const n = f.notices.find((x) => x.kind === m[1] && x.id === m[2]);
        if (!n) return send(route, 404, { error: 'not_found' });
        const created = !n.retry_requested;
        n.retry_requested = true;
        return send(route, created ? 201 : 200, n);
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
  expect(await page.locator('html').getAttribute('lang')).toBe('en-AU');
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
  const probe = await page.evaluate(genericnessProbe);
  expect(probe).toEqual({ shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 });
  expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  for (const t of await page.locator('main .word[data-status]').allTextContents()) {
    expect(t.trim()).not.toBe('');
  }
  // Never a clear address or account number on this screen.
  expect(await page.locator('main').innerText()).not.toMatch(/oscar|accounts@|\d{6,}/);
}

test.describe('SS-PLAT-161 failed security notices', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-161: the Owner opens the failed notices from Settings @ ${String(width)} [T-0209]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, '/settings', width);
      await page.getByRole('link', { name: 'Failed security notices' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Failed security notices');
      const table = page.getByRole('table', { name: 'Failed security notices' });
      await expect(table.getByRole('row')).toHaveCount(3);
      const first = table.getByRole('row').nth(1);
      await expect(first).toContainText(
        'Remittance account of Harbour & Co Pty Ltd changed, new account ending in 321',
      );
      await expect(first).toContainText('o•••@harbour.example');
      await expect(first).toContainText('11');
      await expect(first).toContainText("The recipient's mail server refused the email");
      await expect(first).toContainText('550');
      await expect(first).toContainText('22 Nov 2026');
      const second = table.getByRole('row').nth(2);
      await expect(second).toContainText('Bank details of Office Supplies Pty Ltd changed');
      await expect(second).toContainText('asked us to try again later');
      await expect(page.getByRole('button', { name: /^Retry now/ })).toHaveCount(2);
      await assertPage(page, width);
      await evidence('SS-PLAT-161', `failed-notices-owner-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-161: a Finance Admin retries one notice now by keyboard [T-0209]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/security-notices', 1440);
    const retry = page.getByRole('button', {
      name: 'Retry now: Remittance account of Harbour & Co Pty Ltd changed, new account ending in 321',
    });
    await retry.focus();
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement ?? document.body);
      return Number.parseFloat(cs.outlineWidth);
    });
    expect(ring).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'The notice to o•••@harbour.example will be sent within a minute.',
    );
    const row = page
      .getByRole('table', { name: 'Failed security notices' })
      .getByRole('row')
      .nth(1);
    await expect(row).toContainText('Will be sent within a minute');
    await expect(row.getByRole('button')).toHaveCount(0);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.path).toBe(`/security-notices/remittance_account_changed/${REMIT}/retry`);
    expect(f.posts[0]?.key).toMatch(/^security-notice-retry-[0-9a-f-]{36}$/);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-161', 'failed-notices-retried-1440');
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-161: a refused retry is explained next to the list [T-0209]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    f.override.set(`POST /security-notices/bank_details_changed/${SUPPLIER}/retry`, {
      status: 409,
      body: { error: 'security_notice_not_failed' },
    });
    await open(page, '/settings/security-notices', 390);
    await page.getByRole('button', { name: /^Retry now: Bank details of Office Supplies/ }).click();
    await expect(page.getByRole('alert')).toContainText('This notice is no longer failing');
    await assertPage(page, 390);
    await evidence('SS-PLAT-161', 'failed-notices-refused-390');
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-161: the Auditor sees the list without the retry action [T-0209]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'auditor');
    await open(page, '/settings/security-notices', 1440);
    await expect(
      page.getByRole('table', { name: 'Failed security notices' }).getByRole('row'),
    ).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Retry now/ })).toHaveCount(0);
    await expect(
      page.getByText('Only the Owner or a Finance Admin can retry a notice.'),
    ).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-161', 'failed-notices-auditor-1440');
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-161: an Accountant is refused; empty and error states [T-0209]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/settings/security-notices', 390);
    await expect(page.getByRole('heading', { name: "You can't see this list" })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await assertPage(page, 390);
    await evidence('SS-PLAT-161', 'failed-notices-forbidden-390');

    f.who = 'owner';
    f.notices = [];
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No failed security notices' })).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-161', 'failed-notices-empty-390');

    f.override.set('GET /security-notices/failed', { status: 500, body: { error: 'boom' } });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'We could not load the failed notices' }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-161', 'failed-notices-error-390');
    expect(f.errors).toEqual([]);
  });
});
