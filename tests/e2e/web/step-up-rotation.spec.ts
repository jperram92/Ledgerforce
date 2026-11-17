/**
 * SS-PLAT-141 (T-0192, ADR-0087, RQ-0169): a step-up rotates the session id and cookie, and the
 * person loses nothing. Vite serves the app; `page.route` fakes the API and checks the browser's
 * `lf_session` cookie on every call, as the real API does: the old cookie works until the step-up
 * callback rotates it, and is refused (401 session_expired) from then on; only the new cookie
 * carries the fresh step-up. The fake plays both hops of the real round trip: `/auth/step-up`
 * (stands in for the identity provider's page, which sends the browser on to `/auth/callback`)
 * and `/auth/callback` (303 to `return_to` with `Set-Cookie: lf_session=<new>`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ROLE_TEMPLATES, type RoleId } from '../../../packages/shared/src/rbac/index.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(0x9201);
const CO = id(0x92c1);
const BATCH = id(0x92b1);
const CHANGE = id(0x92d1);
// Cookie values shaped like the API's `<tenant>.<session>.<secret>` (test values, not secrets).
const OLD = `${TENANT}.${id(0x9211)}.${'o'.repeat(43)}`;
const NEW = `${TENANT}.${id(0x9212)}.${'n'.repeat(43)}`;
const ME = { user_id: id(0x9205), display_name: 'Oscar Owner', roles: ['owner'] as RoleId[] };
const CLERK = id(0x9203);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0192', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

interface Fake {
  errors: string[];
  /** Every API call: method, path and the lf_session cookie it carried. */
  calls: { method: string; path: string; session: string | null }[];
  rotated: boolean;
  releases: string[];
  verifies: unknown[];
  refusedOld: string[];
}

function batch(releases: unknown[]) {
  return {
    id: BATCH,
    batch_no: 'PB-0192',
    status: releases.length === 0 ? 'draft' : 'partially_released',
    payment_date: '2026-11-20',
    account_id: id(0x92a1),
    total: '12500.0000',
    payment_count: 1,
    releases_required: 2,
    created_by: CLERK,
    created_by_name: 'Casey Clerk',
    releases,
    payments: [
      {
        bill_id: id(0x9221),
        bill_no: 'BILL-0192',
        party_id: id(0x9231),
        party_name: 'Paper Co Pty Ltd',
        amount: '12500.0000',
        bank_account_id: id(0x9241),
        bank_account: { bsb: '062-000', account_number: '***001' },
      },
    ],
    excluded: [],
    confirmation: null,
  };
}

async function sessionOf(req: Request): Promise<string | null> {
  const header = (await req.allHeaders())['cookie'] ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'lf_session') return v.join('=');
  }
  return null;
}

async function fakeApi(page: Page, context: BrowserContext): Promise<Fake> {
  const f: Fake = {
    errors: [],
    calls: [],
    rotated: false,
    releases: [],
    verifies: [],
    refusedOld: [],
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  await context.addCookies([
    { name: 'lf_session', value: OLD, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
  const perms = [...ROLE_TEMPLATES.owner.permissions] as string[];
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  let releases: unknown[] = [];
  let verified = false;
  await page.route(
    (url) =>
      url.origin === origin &&
      /^\/(auth|companies|ap\/payment-batches|bank-detail-changes)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const session = await sessionOf(req);
      f.calls.push({ method: req.method(), path, session });

      // The callback: the real one checks the IdP answer, then rotates (ADR-0087).
      if (path === '/auth/callback') {
        if (session !== OLD || url.searchParams.get('state') !== 'state-192')
          return send(route, 400, { error: 'invalid_request' });
        f.rotated = true;
        return route.fulfill({
          status: 303,
          headers: {
            location: `${origin}${url.searchParams.get('return_to') ?? '/'}`,
            'set-cookie': `lf_session=${NEW}; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      }

      // Session check, as SessionService.verify: the old cookie ends at the rotation.
      const live = session === NEW ? f.rotated : session === OLD ? !f.rotated : false;
      if (!live) {
        if (session === OLD) f.refusedOld.push(`${req.method()} ${path}`);
        return send(route, 401, { error: session === OLD ? 'session_expired' : 'unauthenticated' });
      }
      // Only the rotated session carries the fresh step-up.
      const steppedUp = session === NEW;

      if (path === '/auth/step-up') {
        // The identity provider's page: after the second factor it sends the browser back to
        // the callback (a fresh navigation, so this fake sees the callback request too).
        const back = url.searchParams.get('return_to') ?? '/';
        const q = new URLSearchParams({ state: 'state-192', return_to: back });
        const to = JSON.stringify(`${origin}/auth/callback?${q.toString()}`);
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><title>Identity provider</title><script>location.replace(${to})</script>`,
        });
      }
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: TENANT,
          user_id: ME.user_id,
          display_name: ME.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: ME.roles, permissions: perms });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (path === '/ap/payment-batches')
        return send(route, 200, {
          batches: [
            {
              id: BATCH,
              batch_no: 'PB-0192',
              status: batch(releases)['status'],
              payment_date: '2026-11-20',
              total: '12500.0000',
              payment_count: 1,
              excluded_count: 0,
              releases_required: 2,
              release_count: releases.length,
              created_by_name: 'Casey Clerk',
              created_at: '2026-11-13T21:00:00.000Z',
            },
          ],
        });
      if (path === `/ap/payment-batches/${BATCH}`) return send(route, 200, batch(releases));
      if (path === `/ap/payment-batches/${BATCH}/release` && req.method() === 'POST') {
        if (!steppedUp) return send(route, 401, { error: 'step_up_required', max_age: 300 });
        f.releases.push(session ?? '');
        releases = [
          {
            released_by: ME.user_id,
            released_by_name: ME.display_name,
            released_at: '2026-11-13T23:10:00.000Z',
          },
        ];
        return send(route, 200, batch(releases));
      }
      if (path === '/bank-detail-changes')
        return send(route, 200, {
          changes: verified
            ? []
            : [
                {
                  id: CHANGE,
                  party_id: id(0x9231),
                  party_name: 'Paper Co Pty Ltd',
                  status: 'requested',
                  bank_account: {
                    bsb: '062-000',
                    account_name: 'Paper Co',
                    account_number: '***321',
                  },
                  previous_bank_account: {
                    bsb: '062-000',
                    account_name: 'Paper Co',
                    account_number: '***001',
                  },
                  requested_by: CLERK,
                  requested_by_name: 'Cam Clerk',
                  requested_at: '2026-11-13T22:05:00.000Z',
                  decided_by_name: null,
                  decided_at: null,
                  payable_from: null,
                },
              ],
        });
      if (path === `/bank-detail-changes/${CHANGE}/verify` && req.method() === 'POST') {
        if (!steppedUp) return send(route, 401, { error: 'step_up_required', max_age: 300 });
        f.verifies.push(req.postDataJSON());
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

async function sessionCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(origin)).find((c) => c.name === 'lf_session')?.value;
}

test('SS-PLAT-141 Step-up rotates the session: the release screen stays put and the retried release succeeds with the new cookie [T-0192]', async ({
  page,
  context,
  evidence,
}) => {
  const f = await fakeApi(page, context);
  const here = `/purchases/payment-batches/${BATCH}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}${here}`);
  const heading = page.getByRole('heading', { level: 1, name: 'Payment batch PB-0192' });
  await expect(heading).toBeVisible();

  await page.getByRole('button', { name: 'Release payment batch' }).click();
  const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
  await expect(prompt).toBeVisible();
  expect(f.releases).toEqual([]);
  await evidence('SS-PLAT-141', 'release-step-up-prompt-old-session');
  const before = f.calls.length;
  await prompt.getByRole('button', { name: 'Confirm my sign-in' }).click();

  // Back on the same screen, with the rotated cookie in the browser.
  await expect(heading).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(here);
  expect(f.rotated).toBe(true);
  expect(await sessionCookie(context)).toBe(NEW);

  await page.getByRole('button', { name: 'Release payment batch' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'You released' })).toBeVisible();
  await expect(page.getByText('1 of 2 releases given')).toBeVisible();
  expect(f.releases).toEqual([NEW]);
  // After the callback no API call carried the old cookie, and none was refused.
  const afterCallback = f.calls.slice(before).filter((c) => c.path !== '/auth/step-up');
  expect(afterCallback.filter((c) => c.path !== '/auth/callback').length).toBeGreaterThan(0);
  expect(
    afterCallback.filter((c) => c.path !== '/auth/callback').every((c) => c.session === NEW),
  ).toBe(true);
  expect(f.refusedOld).toEqual([]);
  expect(new URL(page.url()).pathname).toBe(here);
  await evidence('SS-PLAT-141', 'release-succeeds-on-rotated-session');
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-141 Step-up rotates the session: the typed verification note survives and the retried verify succeeds [T-0192]', async ({
  page,
  context,
  evidence,
}) => {
  const note = 'Called Paper Co on 02 9000 0000 from our contract; Jo confirmed the new account.';
  const f = await fakeApi(page, context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/purchases/bank-details`);
  const review = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
  await review.getByLabel('How you confirmed it with the supplier').fill(note);
  await review.getByRole('button', { name: 'Verify new bank details' }).click();
  const prompt = page.getByRole('region', { name: 'Confirm it’s you' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Confirm my sign-in' }).click();

  const back = page.getByRole('region', { name: 'Check Paper Co Pty Ltd' });
  await expect(back.getByLabel('How you confirmed it with the supplier')).toHaveValue(note);
  expect(new URL(page.url()).pathname).toBe('/purchases/bank-details');
  expect(await sessionCookie(context)).toBe(NEW);
  await back.getByRole('button', { name: 'Verify new bank details' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Verified' })).toContainText(
    'Paper Co Pty Ltd',
  );
  expect(f.verifies).toEqual([{ confirmation_note: note }]);
  expect(f.refusedOld).toEqual([]);
  await evidence('SS-PLAT-141', 'bank-detail-verified-on-rotated-session-390');
  expect(f.errors).toEqual([]);
});
