/**
 * Journal preview before a transaction is created from a bank line (T-0150, UC-08 step 4,
 * SS-UC08-08, UI principle P4). The Accountant opens "Create a transaction" for the November
 * account-fee line: the screen shows the journal the posting engine would post (from
 * `POST /bank-rec/lines/:id/transaction/preview`, apps/api/src/bank/bank-rec.controller.ts) before
 * "Post transaction", refreshes it when the account changes, and explains a refused preview
 * without offering to post. Vite serves the app; the API is faked with `page.route` using the
 * route's response shapes. The fake answers with fixed journals: the browser does no arithmetic.
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
const CO = id(0x150c1);
const BANK = id(0x150b1);
const NOV = id(0x15011);
const FEE_LINE = id(0x15021);
const GL_BANK = id(0x15a10);
const GL_FEES = id(0x15a61);
const GL_INTEREST = id(0x15a49);
const RULE = id(0x150e1);
const SUGGESTION = id(0x150e2);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0150', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

const ACCOUNTS: Record<string, { code: string; name: string; type: string }> = {
  [GL_BANK]: { code: '1010', name: 'Operating account', type: 'asset' },
  [GL_INTEREST]: { code: '4900', name: 'Interest income', type: 'revenue' },
  [GL_FEES]: { code: '6110', name: 'Bank fees', type: 'expense' },
};

/** The journal the engine would post for the fee line: fixed answers, no arithmetic here. */
function previewOf(accountId: string, amount: string) {
  const a = ACCOUNTS[accountId];
  if (!a || amount !== '10.0000') return null;
  const line = (no: number, aid: string, debit: string, credit: string, memo: string | null) => {
    const x = ACCOUNTS[aid];
    return {
      line_no: no,
      account_id: aid,
      account_code: x?.code,
      account_name: x?.name,
      account_type: x?.type,
      debit,
      credit,
      memo,
    };
  };
  return {
    entry_date: '2026-11-02',
    requested_date: '2026-11-02',
    redirected: false,
    needs_override: false,
    base_currency: 'AUD',
    total: '10.0000',
    lines: [
      line(1, GL_BANK, '0.0000', '10.0000', 'Account fee'),
      line(2, accountId, '10.0000', '0.0000', null),
    ],
  };
}

interface Call {
  path: string;
  key: string | null;
  body: Record<string, unknown>;
}

async function fakeApi(page: Page) {
  const f = { errors: [] as string[], posts: [] as Call[], posted: false };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) =>
      url.origin === origin && /^\/(auth|companies|accounts|bank-rec)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const perms: readonly string[] = ROLE_TEMPLATES.accountant.permissions;
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: id(0x15001),
          display_name: 'Ada Count',
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: ['accountant'], permissions: perms });
      if (path === '/companies')
        return send(route, 200, [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }]);
      if (path === '/accounts')
        return send(route, 200, {
          companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
          accounts: Object.entries(ACCOUNTS).map(([aid, a]) => ({
            id: aid,
            company_id: CO,
            code: a.code,
            name: a.name,
            type: a.type,
            subtype: 'other',
            normal_balance: a.type === 'expense' || a.type === 'asset' ? 'debit' : 'credit',
            currency: null,
            postable: true,
            is_control: false,
            status: 'active',
            system_roles: [],
          })),
        });
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
              id: NOV,
              file_name: 'harbour-2026-11.csv',
              format: 'csv',
              period_start: null,
              period_end: null,
              opening_balance: null,
              closing_balance: null,
              lines_total: 1,
              lines_unmatched: f.posted ? 0 : 1,
              imported_at: '2026-12-01T22:05:00.000Z',
              reconciliation_id: null,
            },
          ],
        });
      if (path === `/bank-rec/accounts/${BANK}/lines`)
        return send(route, 200, {
          lines: [
            {
              id: FEE_LINE,
              statement_id: NOV,
              line_no: 2,
              posted_on: '2026-11-02',
              amount: '-10.0000',
              description: 'Account fee',
              reference: null,
              status: f.posted ? 'matched' : 'unmatched',
              match: f.posted
                ? {
                    id: id(0x150d3),
                    journal_entry_id: id(0x150d4),
                    entry_no: 'MJ-000007',
                    method: 'rule',
                    source_kind: 'bank_transaction',
                  }
                : null,
              suggestions: f.posted
                ? []
                : [
                    {
                      id: SUGGESTION,
                      kind: 'rule',
                      source_kind: null,
                      journal_entry_id: null,
                      entry_no: null,
                      rule_id: RULE,
                      rule_name: 'Bank fees',
                      account_id: GL_FEES,
                      account_code: '6110',
                      account_name: 'Bank fees',
                    },
                  ],
            },
          ],
        });
      if (req.method() === 'POST') {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        f.posts.push({ path, key: req.headers()['idempotency-key'] ?? null, body });
        const counter = (
          body['lines'] as { account_id: string; amount: string }[] | undefined
        )?.[0];
        if (path === `/bank-rec/lines/${FEE_LINE}/transaction/preview`) {
          const p = counter ? previewOf(counter.account_id, counter.amount) : null;
          if (!p)
            return send(route, 422, {
              error: 'UNBALANCED',
              message: 'the journal does not balance: debits 9.0000, credits 10.0000',
            });
          return send(route, 200, p);
        }
        if (path === `/bank-rec/lines/${FEE_LINE}/transaction`) {
          f.posted = true;
          return send(route, 201, {
            match_id: id(0x150d3),
            manual_journal_id: id(0x150d5),
            entry_id: id(0x150d4),
            entry_no: 'MJ-000007',
            replayed: false,
          });
        }
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

const PAGE = `/bank/match/transaction?account=${BANK}&statement=${NOV}&line=${FEE_LINE}`;

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}${PAGE}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Create a transaction' })).toBeVisible();
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

const previews = (f: { posts: Call[] }) => f.posts.filter((p) => p.path.endsWith('/preview'));

for (const width of [1440, 390]) {
  test(`SS-UC08-08: the journal is shown before a transaction posts @ ${String(width)} [T-0150]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page);
    const w = String(width);
    await open(page, width);

    // The rule's account is preselected and the engine's journal is shown before posting.
    await expect(page.getByLabel('Account')).toHaveValue(GL_FEES);
    const journal = page.getByRole('table', { name: 'Journal preview' });
    await expect(journal).toBeVisible();
    await expect(journal.getByRole('row').nth(1)).toContainText('1010');
    await expect(journal.getByRole('row').nth(1)).toContainText('Operating account');
    await expect(journal.getByRole('row').nth(2)).toContainText('6110');
    await expect(journal.getByRole('row').nth(2)).toContainText('Bank fees');
    await expect(journal).toContainText('Balanced');
    await expect(page.getByText('Nothing is posted yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Post transaction' })).toBeEnabled();
    expect(previews(f).at(-1)).toEqual({
      path: `/bank-rec/lines/${FEE_LINE}/transaction/preview`,
      key: null,
      body: {
        company_id: CO,
        from_suggestion_id: SUGGESTION,
        lines: [{ account_id: GL_FEES, amount: '10.0000' }],
      },
    });
    expect(f.posts.filter((p) => !p.path.endsWith('/preview'))).toEqual([]);
    await assertPage(page, width);
    await evidence('SS-UC08-08', `transaction-journal-preview-${w}`);

    // Another account: the journal is built again for it (and the suggestion is not sent).
    await page.getByLabel('Account').selectOption(GL_INTEREST);
    await expect(journal.getByRole('row').nth(2)).toContainText('4900');
    await expect(journal.getByRole('row').nth(2)).toContainText('Interest income');
    expect(previews(f).at(-1)?.body).toEqual({
      company_id: CO,
      lines: [{ account_id: GL_INTEREST, amount: '10.0000' }],
    });

    // Back to the rule's account, then post: the post sends what the preview showed.
    await page.getByLabel('Account').selectOption(GL_FEES);
    await expect(journal.getByRole('row').nth(2)).toContainText('6110');
    await page.getByRole('button', { name: 'Post transaction' }).click();
    await expect(page.getByRole('status')).toContainText('Posted as MJ-000007');
    const post = f.posts.at(-1);
    expect(post).toEqual({
      path: `/bank-rec/lines/${FEE_LINE}/transaction`,
      key: expect.stringMatching(/^.{8,}$/) as unknown,
      body: {
        company_id: CO,
        from_suggestion_id: SUGGESTION,
        lines: [{ account_id: GL_FEES, amount: '10.0000' }],
      },
    });
    await assertPage(page, width);
    await evidence('SS-UC08-08', `transaction-posted-after-preview-${w}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-UC08-08: a refused journal preview explains why and offers no posting [T-0150]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page);
  await open(page, 1440);
  await expect(page.getByRole('table', { name: 'Journal preview' })).toBeVisible();
  await page.getByLabel('Amount').fill('9.00');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('We could not build the journal');
  await expect(alert).toContainText('the journal does not balance');
  await expect(page.getByRole('table', { name: 'Journal preview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Post transaction' })).toBeDisabled();
  await expect(page.getByText('You can post once the journal above is built.')).toBeVisible();
  expect(previews(f).at(-1)?.body).toMatchObject({
    lines: [{ account_id: GL_FEES, amount: '9.00' }],
  });
  await assertPage(page, 1440);
  await evidence('SS-UC08-08', 'transaction-preview-refused-1440');

  // Fixing the amount shows the journal again and posting is offered.
  await page.getByLabel('Amount').fill('10.0000');
  await expect(page.getByRole('table', { name: 'Journal preview' })).toContainText('Balanced');
  await expect(page.getByRole('button', { name: 'Post transaction' })).toBeEnabled();
  expect(f.posts.filter((p) => !p.path.endsWith('/preview'))).toEqual([]);
  expect(f.errors).toEqual([]);
});
