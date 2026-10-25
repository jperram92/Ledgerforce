/**
 * T-0081 — the apps/web shell, end to end in Chromium.
 *
 *  - SS-PLAT-52: a visitor without a session lands on sign-in; sign-in sends the whole page to the
 *    API's `/t/<slug>/auth/login`; sign-out (keyboard) POSTs `/auth/logout` and lands on sign-in;
 *    a failing session check shows an error with Retry, not a redirect loop.
 *  - SS-PLAT-53: the authenticated shell at 1440 and 390, light and dark: every section in the
 *    navigation with the current one marked, empty states, keyboard path with visible focus,
 *    not-found, axe WCAG 2.2 AA with 0 violations, genericness probes clean, no horizontal scroll.
 *
 * The app is served in-process by Vite (`createViteServer` from `vitest/node`, as
 * ui-system.spec.ts does) and the API is faked per test with `page.route` (RQ-0025 F5): the
 * contract faked is T-0011's (`/auth/me`, `/auth/logout`, `/t/:slug/auth/login`), which
 * SS-PLAT-41/42 prove against the real API. Screenshots go to .agent/evidence/T-0081/.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { genericnessProbe } from '../fixtures/genericness.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const SAM = { tenant_id: 't-harbour', user_id: 'u-sam', display_name: 'Sam Nguyen' };
const SECTIONS = [
  { name: 'Timeline', path: '/', h1: 'Your money over time', empty: 'Nothing on your timeline yet' },
  { name: 'Sales', path: '/sales', h1: 'Sales', empty: 'No invoices yet' },
  { name: 'Purchases', path: '/purchases', h1: 'Purchases', empty: 'No bills yet' },
  { name: 'Bank', path: '/bank', h1: 'Bank', empty: 'No bank statements yet' },
  { name: 'Reports', path: '/reports', h1: 'Reports', empty: 'No reports to show yet' },
  { name: 'Settings', path: '/settings', h1: 'Settings', empty: 'Nothing to set up here yet' },
] as const;

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0081' });

test.beforeAll(async () => {
  server = await createViteServer({
    root: WEB,
    configFile: false,
    // One dependency cache per worker: parallel workers must not race on a shared .vite folder.
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

interface FakeApi {
  /** What `/auth/me` answers next. */
  me: 'signed-in' | 'signed-out' | 'unavailable';
  logoutCalls: string[];
  loginCalls: string[];
  errors: string[];
  external: string[];
}

/** Fakes the T-0011 auth API on the app's own origin and records calls and page errors. */
async function fakeApi(page: Page, me: FakeApi['me']): Promise<FakeApi> {
  const api: FakeApi = { me, logoutCalls: [], loginCalls: [], errors: [], external: [] };
  page.on('console', (m) => {
    // The fake answers 401/503 on purpose; Chromium logs those as failed resources.
    if (m.type() === 'error' && !/status of (401|503)/.test(m.text())) api.errors.push(m.text());
  });
  page.on('pageerror', (e) => api.errors.push(String(e)));
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) api.external.push(r.url());
  });
  await page.route(`${origin}/auth/me`, (route) => {
    if (api.me === 'signed-in') return route.fulfill({ status: 200, json: SAM });
    if (api.me === 'unavailable') return route.fulfill({ status: 503, json: { error: 'down' } });
    return route.fulfill({ status: 401, json: { error: 'unauthenticated' } });
  });
  await page.route(`${origin}/auth/logout`, (route) => {
    api.logoutCalls.push(route.request().method());
    api.me = 'signed-out';
    return route.fulfill({ status: 204 });
  });
  await page.route(`${origin}/t/*/auth/login`, (route) => {
    api.loginCalls.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>Identity provider</title><h1>Identity provider (test stand-in)</h1></html>',
    });
  });
  return api;
}

async function open(page: Page, path: string, width: number, scheme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${origin}${path}`);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}

/** Page basics, axe WCAG 2.2 AA, no horizontal scroll and the genericness probes. */
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
}

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { style: 'none', width: 0 };
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  });
}

test.describe('SS-PLAT-52 sign-in and session handling', () => {
  test('SS-PLAT-52: a visitor without a session signs in through the tenant login URL [T-0081]', async ({
    page,
    evidence,
  }) => {
    const api = await fakeApi(page, 'signed-out');
    await open(page, '/sales', 1440, 'light');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to LedgerForce' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-52', 'sign-in-1440-light');

    const box = page.getByRole('textbox', { name: "Your organisation's sign-in name" });
    await box.fill('harbour co');
    await box.press('Enter');
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Use lower-case letters, numbers and hyphens only')).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-52', 'sign-in-invalid-name-1440');
    expect(api.loginCalls).toEqual([]);

    await box.fill('Harbour-Co');
    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Identity provider (test stand-in)' })).toBeVisible();
    expect(api.loginCalls).toEqual(['/t/harbour-co/auth/login']);
    expect(api.errors).toEqual([]);
    expect(api.external).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`SS-PLAT-52: sign-in page @ 390 ${scheme} [T-0081]`, async ({ page, evidence }) => {
      const api = await fakeApi(page, 'signed-out');
      await open(page, '/sign-in', 390, scheme);
      await expect(page.getByRole('textbox', { name: "Your organisation's sign-in name" })).toBeVisible();
      await assertPage(page, 390);
      await evidence('SS-PLAT-52', `sign-in-390-${scheme}`);
      expect(api.errors).toEqual([]);
    });
  }

  test('SS-PLAT-52: sign-out from the user menu by keyboard ends the session [T-0081]', async ({
    page,
    evidence,
  }) => {
    const api = await fakeApi(page, 'signed-in');
    await open(page, '/', 1440, 'light');
    const menu = page.getByRole('button', { name: /Sam Nguyen/ });
    await menu.focus();
    await page.keyboard.press('Enter');
    const signOut = page.getByRole('menuitem', { name: 'Sign out' });
    await expect(signOut).toBeFocused();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-52', 'user-menu-open-1440');
    await page.keyboard.press('Enter');
    await expect(page.getByText('You have signed out.')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(api.logoutCalls).toEqual(['POST']);
    await evidence('SS-PLAT-52', 'signed-out-1440');
    // The back button must not show the shell again: the session check now answers 401.
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to LedgerForce' })).toBeVisible();
    expect(api.errors).toEqual([]);
  });

  test('SS-PLAT-52: a failing session check shows an error with Retry, not a loop [T-0081]', async ({
    page,
    evidence,
  }) => {
    const api = await fakeApi(page, 'unavailable');
    await open(page, '/', 1440, 'light');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('We could not check your sign-in');
    expect(new URL(page.url()).pathname).toBe('/');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-52', 'session-check-error-1440');
    api.me = 'signed-in';
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    expect(api.errors).toEqual([]);
  });
});

test.describe('SS-PLAT-53 authenticated shell, navigation and states', () => {
  for (const width of [1440, 390] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`SS-PLAT-53: shell home @ ${String(width)} ${scheme} [T-0081]`, async ({
        page,
        evidence,
      }) => {
        const api = await fakeApi(page, 'signed-in');
        await open(page, '/', width, scheme);
        const nav = page.getByRole('navigation', { name: 'Sections' });
        await expect(nav.getByRole('link')).toHaveText(SECTIONS.map((s) => s.name));
        await expect(nav.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your money over time');
        await expect(page.getByRole('heading', { level: 2, name: 'Nothing on your timeline yet' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Sam Nguyen/ })).toBeVisible();
        await assertPage(page, width);
        await evidence('SS-PLAT-53', `shell-home-${String(width)}-${scheme}`);
        expect(api.errors).toEqual([]);
        expect(api.external).toEqual([]);
      });
    }
  }

  test('SS-PLAT-53: every section renders its empty state and becomes current [T-0081]', async ({
    page,
    evidence,
  }) => {
    const api = await fakeApi(page, 'signed-in');
    await open(page, '/', 1440, 'light');
    const nav = page.getByRole('navigation', { name: 'Sections' });
    for (const s of SECTIONS) {
      await nav.getByRole('link', { name: s.name }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.h1);
      expect(new URL(page.url()).pathname).toBe(s.path);
      await expect(nav.locator('[aria-current="page"]')).toHaveText([s.name]);
      const empty = page.getByRole('heading', { level: 2, name: s.empty });
      await expect(empty).toBeVisible();
      await expect(page).toHaveTitle(s.name === 'Timeline' ? 'Timeline – LedgerForce' : `${s.name} – LedgerForce`);
      await assertPage(page, 1440);
      if (s.name !== 'Timeline') await evidence('SS-PLAT-53', `section-${s.name.toLowerCase()}-1440`);
    }
    expect(api.errors).toEqual([]);
  });

  test('SS-PLAT-53: keyboard path: skip link, navigation and focus on the new heading [T-0081]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'signed-in');
    await open(page, '/', 1440, 'light');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    expect(await focusRing(page)).toEqual({ style: 'solid', width: 2 });
    // Tab on through the navigation to Purchases and follow it with Enter.
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const purchases = nav.getByRole('link', { name: 'Purchases' });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      if (await purchases.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(purchases).toBeFocused();
    const ring = await focusRing(page);
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await evidence('SS-PLAT-53', 'keyboard-focus-nav-1440');
    await page.keyboard.press('Enter');
    const h1 = page.getByRole('heading', { level: 1, name: 'Purchases' });
    await expect(h1).toBeFocused();
    await expect(purchases).toHaveAttribute('aria-current', 'page');
  });

  test('SS-PLAT-53: an unknown path shows not-found inside the shell [T-0081]', async ({
    page,
    evidence,
  }) => {
    const api = await fakeApi(page, 'signed-in');
    await open(page, '/no-such-page', 390, 'light');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-53', 'not-found-390');
    await page.getByRole('link', { name: 'Go to your timeline' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your money over time');
    expect(api.errors).toEqual([]);
  });

  test('SS-PLAT-53: user menu at 390 dark stays inside the screen [T-0081]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'signed-in');
    await open(page, '/', 390, 'dark');
    await page.getByRole('button', { name: /Sam Nguyen/ }).click();
    const item = page.getByRole('menuitem', { name: 'Sign out' });
    await expect(item).toBeVisible();
    const box = await page.getByRole('menu').boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
    await assertPage(page, 390);
    await evidence('SS-PLAT-53', 'user-menu-390-dark');
  });
});
