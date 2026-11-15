/**
 * Accept a candidate suggestion on the match screen (T-0160, UC-08 step 3, SS-UC08-08). The
 * December deposit of 500.00 ref CAP-02 agrees with two receipts, so matching only suggests them.
 * The Accountant presses "Accept" beside RCT-000042: the screen calls
 * `POST /bank-rec/lines/:id/suggestions/:suggestionId/accept` (apps/api/src/bank/
 * bank-rec.controller.ts) with an Idempotency-Key and shows the line as matched from a
 * suggestion. An Auditor (bank.read only) sees the suggestions but no Accept button. Vite serves
 * the app; the API is faked with `page.route` using the routes' response shapes.
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

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const WEB = resolve(ROOT, 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x160c1);
const BANK = id(0x160b1);
const DEC = id(0x16011);
const LINE = id(0x16021);
const S41 = id(0x160e1);
const S42 = id(0x160e2);
const E41 = id(0x160d1);
const E42 = id(0x160d2);
const R42 = id(0x160f2);
const MATCH = id(0x160a1);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0160', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

interface Call {
  path: string;
  key: string | null;
  body: Record<string, unknown>;
}

const candidate = (sid: string, entryId: string, entryNo: string) => ({
  id: sid,
  kind: 'candidate',
  source_kind: 'customer_receipt',
  journal_entry_id: entryId,
  entry_no: entryNo,
  rule_id: null,
  rule_name: null,
  account_id: null,
  account_code: null,
  account_name: null,
});

async function fakeApi(page: Page, role: 'accountant' | 'auditor') {
  const f = { errors: [] as string[], posts: [] as Call[], accepted: false };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|bank-rec)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const perms: readonly string[] = ROLE_TEMPLATES[role].permissions;
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: id(0x16001),
          display_name: role === 'auditor' ? 'Dee Audit' : 'Ada Count',
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: [role], permissions: perms });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (path === '/bank-rec/accounts')
        return send(route, 200, {
          accounts: [
            {
              id: BANK,
              name: 'Operating',
              bsb: '062-000',
              account_name: 'Harbour & Co Pty Ltd',
              account_number: '***678',
              currency: 'AUD',
              status: 'active',
            },
          ],
        });
      if (path === `/bank-rec/accounts/${BANK}/statements`)
        return send(route, 200, {
          statements: [
            {
              id: DEC,
              file_name: 'harbour-2026-12.csv',
              format: 'csv',
              period_start: null,
              period_end: null,
              opening_balance: null,
              closing_balance: null,
              lines_total: 1,
              lines_unmatched: f.accepted ? 0 : 1,
              imported_at: '2026-12-04T22:05:00.000Z',
              reconciliation_id: null,
            },
          ],
        });
      if (path === `/bank-rec/accounts/${BANK}/lines`)
        return send(route, 200, {
          lines: [
            {
              id: LINE,
              statement_id: DEC,
              line_no: 1,
              posted_on: '2026-12-03',
              amount: '500.0000',
              description: 'Deposit Acme 01 Pty Ltd',
              reference: 'CAP-02',
              status: f.accepted ? 'matched' : 'unmatched',
              match: f.accepted
                ? {
                    id: MATCH,
                    journal_entry_id: E42,
                    entry_no: 'RCT-000042',
                    method: 'suggestion',
                    source_kind: 'customer_receipt',
                  }
                : null,
              suggestions: f.accepted
                ? []
                : [candidate(S41, E41, 'RCT-000041'), candidate(S42, E42, 'RCT-000042')],
            },
          ],
        });
      if (req.method() === 'POST') {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        f.posts.push({ path, key: req.headers()['idempotency-key'] ?? null, body });
        if (path === `/bank-rec/lines/${LINE}/suggestions/${S42}/accept`) {
          f.accepted = true;
          return send(route, 200, {
            statement_line_id: LINE,
            suggestion_id: S42,
            match_id: MATCH,
            journal_entry_id: E42,
            source_kind: 'customer_receipt',
            source_id: R42,
            replayed: false,
          });
        }
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

const PAGE = `/bank/match?account=${BANK}&statement=${DEC}`;

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}${PAGE}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Match statement lines' }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Statement lines' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function assertPage(page: Page, width: number) {
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
  test(`SS-UC08-08: the Accountant accepts a suggested receipt and the line is matched @ ${String(width)} [T-0160]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    const w = String(width);
    await open(page, width);
    const row = page.getByRole('row', { name: /Deposit Acme 01 Pty Ltd/ });
    await expect(row).toContainText('To match');
    await expect(row).toContainText('Suggested: RCT-000041');
    await expect(row).toContainText('Suggested: RCT-000042');
    const accept42 = page.getByRole('button', {
      name: 'Accept RCT-000042 for Deposit Acme 01 Pty Ltd, 3 Dec 2026',
    });
    await expect(accept42).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Accept RCT-000041 for Deposit Acme 01 Pty Ltd, 3 Dec 2026',
      }),
    ).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-UC08-08', `suggestion-accept-offered-${w}`);

    // Keyboard path: focus the button and press Enter.
    await accept42.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Deposit Acme 01 Pty Ltd is matched to RCT-000042.',
    );
    await expect(row).toContainText('Matched');
    await expect(row).toContainText('RCT-000042');
    await expect(row).toContainText('matched from a suggestion');
    await expect(row).not.toContainText('Suggested:');
    await expect(page.getByRole('button', { name: /^Accept / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Unmatch / })).toBeVisible();
    expect(f.posts).toEqual([
      {
        path: `/bank-rec/lines/${LINE}/suggestions/${S42}/accept`,
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: { company_id: CO },
      },
    ]);
    await assertPage(page, width);
    await evidence('SS-UC08-08', `suggestion-accepted-matched-${w}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC08-08: an Auditor sees the suggestions but no Accept button [T-0160]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'auditor');
  await open(page, 1440);
  const row = page.getByRole('row', { name: /Deposit Acme 01 Pty Ltd/ });
  await expect(row).toContainText('Suggested: RCT-000041');
  await expect(row).toContainText('Suggested: RCT-000042');
  await expect(page.getByRole('button', { name: /^Accept / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find matches' })).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-UC08-08', 'suggestion-auditor-read-only-1440');
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});
