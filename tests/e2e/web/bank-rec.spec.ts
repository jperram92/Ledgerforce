/**
 * Bank reconciliation screens (T-0088, UC-08, SS-UC08-08). The Accountant imports the November
 * statement, finds matches, creates a transaction from the bank-fee line, and completes the
 * reconciliation report. Vite serves the app; each test fakes the API with `page.route`, using the
 * response shapes of the T-0149 routes under /bank-rec (apps/api/src/bank/bank-rec.controller.ts),
 * GET /companies, GET /accounts and GET /auth/me[/access].
 */
import { mkdtempSync, readFileSync } from 'node:fs';
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
const CSV = readFileSync(resolve(ROOT, 'packages/modules/bank/fixtures/harbour-2026-11.csv'));
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x88c1);
const BANK = id(0x88b1);
const OCT = id(0x8810);
const NOV = id(0x8811);
const GL_BANK = id(0x8a10);
const GL_FEES = id(0x8a61);
const GL_INTEREST = id(0x8a49);
const RULE = id(0x88e1);
const SUGGESTION = id(0x88e2);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0088', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  accountant: { user_id: id(0x8801), display_name: 'Ada Count', role: 'accountant' as const },
  auditor: { user_id: id(0x8802), display_name: 'Dee Audit', role: 'auditor' as const },
  clerk: { user_id: id(0x8803), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

/** The November statement lines as the module stores them (Harbour CSV fixture). */
const NOV_LINES: [string, string, string, string | null][] = [
  ['2026-11-02', '1375.0000', 'Direct credit Acme Pty Ltd', 'INV-000123'],
  ['2026-11-02', '-10.0000', 'Account fee', null],
  ['2026-11-03', '-4.5000', 'Card purchase Blue Cup Cafe', null],
  ['2026-11-03', '-4.5000', 'Card purchase Blue Cup Cafe', null],
  ['2026-11-05', '-2200.0000', 'BPAY Office Rent Pty', 'RENT-NOV'],
  ['2026-11-10', '550.5500', 'Stripe payout', 'po_1Q2w3E'],
  ['2026-11-15', '-1234.5600', 'Transfer to ATO', 'PAYG-1125'],
  ['2026-11-20', '12.3400', 'Interest', null],
  ['2026-11-28', '-89.9000', 'Telstra direct debit November, mobile', 'TLS-889'],
  ['2026-11-30', '10000.0000', 'Deposit Harbour & Co Pty Ltd', 'CAP-01'],
];

interface FakeLine {
  id: string;
  statement_id: string;
  line_no: number;
  posted_on: string;
  amount: string;
  description: string;
  reference: string | null;
  status: 'unmatched' | 'matched';
  match: {
    id: string;
    journal_entry_id: string;
    entry_no: string;
    method: string;
    source_kind: string;
  } | null;
  suggestions: Record<string, unknown>[];
}

interface Fake {
  errors: string[];
  posts: { path: string; key: string | null; body: Record<string, unknown> }[];
  imported: boolean;
  lines: FakeLine[];
  reconciled: string | null;
  refuse: Map<string, { status: number; body: unknown }>;
}

const lineId = (i: number) => id(0x8900 + i);

async function fakeApi(page: Page, who: keyof typeof ME, opts: { imported?: boolean } = {}) {
  const f: Fake = {
    errors: [],
    posts: [],
    imported: opts.imported ?? false,
    lines: NOV_LINES.map(([posted_on, amount, description, reference], i) => ({
      id: lineId(i),
      statement_id: NOV,
      line_no: i + 1,
      posted_on,
      amount,
      description,
      reference,
      status: 'unmatched',
      match: null,
      suggestions: [],
    })),
    reconciled: null,
    refuse: new Map(),
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const statements = () => [
    ...(f.imported
      ? [
          {
            id: NOV,
            file_name: 'harbour-2026-11.csv',
            format: 'csv',
            period_start: null,
            period_end: null,
            opening_balance: null,
            closing_balance: null,
            lines_total: 10,
            lines_unmatched: f.lines.filter((l) => l.status === 'unmatched').length,
            imported_at: '2026-12-01T22:05:00.000Z',
            reconciliation_id: f.reconciled,
          },
        ]
      : []),
    {
      id: OCT,
      file_name: 'harbour-2026-10.camt053.xml',
      format: 'camt053',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      opening_balance: '3000.0000',
      closing_balance: '5000.0000',
      lines_total: 7,
      lines_unmatched: 0,
      imported_at: '2026-11-01T21:10:00.000Z',
      reconciliation_id: id(0x88f0),
    },
  ];
  const report = (closing: string | null) => {
    const ties = closing === '13394.43';
    const deposit = f.lines[9];
    return {
      company_id: CO,
      bank_account_id: BANK,
      statement_id: NOV,
      gl_account_id: GL_BANK,
      currency: 'AUD',
      as_of: '2026-11-30',
      start_date: '2026-10-01',
      statement_closing_balance: ties ? '13394.4300' : '13000.0000',
      book_balance: '3394.4300',
      unreconciled_lines:
        deposit && deposit.status === 'unmatched'
          ? [
              {
                id: deposit.id,
                statement_id: NOV,
                posted_on: deposit.posted_on,
                description: deposit.description,
                reference: deposit.reference,
                status: 'unmatched',
                amount: deposit.amount,
              },
            ]
          : [],
      unreconciled_lines_total: '10000.0000',
      unreconciled_book_items: [],
      unreconciled_book_total: '0.0000',
      adjusted_statement_balance: ties ? '3394.4300' : '3000.0000',
      difference: ties ? '0.0000' : '-394.4300',
      balanced: ties,
      unreconciled_count: 1,
      reconciliation_id: f.reconciled,
    };
  };
  await page.route(
    (url) =>
      url.origin === origin && /^\/(auth|companies|accounts|bank-rec)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
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
      if (path === '/accounts') {
        if (!perms.includes('gl.account.read')) return send(route, 403, { error: 'forbidden' });
        const acct = (aid: string, code: string, name: string, type: string, subtype: string) => ({
          id: aid,
          company_id: CO,
          code,
          name,
          type,
          subtype,
          normal_balance: type === 'expense' || type === 'asset' ? 'debit' : 'credit',
          currency: null,
          postable: true,
          is_control: false,
          status: 'active',
          system_roles: [],
        });
        return send(route, 200, {
          companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
          accounts: [
            acct(GL_BANK, '1010', 'Operating account', 'asset', 'bank'),
            acct(GL_INTEREST, '4900', 'Interest income', 'income', 'other_income'),
            acct(GL_FEES, '6110', 'Bank fees', 'expense', 'operating'),
          ],
        });
      }
      if (method === 'GET' && !perms.includes('bank.read'))
        return send(route, 403, { error: 'forbidden', permission: 'bank.read' });
      if (method === 'GET') expect(url.searchParams.get('company_id')).toBe(CO);
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
      if (path === `/bank-rec/accounts/${BANK}/statements` && method === 'GET')
        return send(route, 200, { statements: statements() });
      if (path === `/bank-rec/accounts/${BANK}/lines`) {
        if (url.searchParams.get('statement_id') !== NOV) return send(route, 200, { lines: [] });
        return send(route, 200, { lines: f.lines });
      }
      if (path === `/bank-rec/statements/${NOV}/report`)
        return send(route, 200, report(url.searchParams.get('closing_balance')));
      if (method === 'POST') {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        f.posts.push({ path, key: req.headers()['idempotency-key'] ?? null, body });
        const need = path.endsWith('/statements') ? 'bank.statement.import' : 'bank.reconcile';
        if (!perms.includes(need))
          return send(route, 403, { error: 'forbidden', permission: need });
        const r = f.refuse.get(path);
        if (r) return send(route, r.status, r.body);
        if (path === `/bank-rec/accounts/${BANK}/statements`) {
          f.imported = true;
          return send(route, 201, {
            outcome: 'imported',
            statement_id: NOV,
            lines_in_file: 10,
            lines_created: 10,
            lines_duplicate: 0,
            message: '10 new lines imported; 0 lines already imported and skipped.',
            replayed: false,
          });
        }
        if (path === `/bank-rec/accounts/${BANK}/matching-runs`) {
          const acme = f.lines[0];
          const fee = f.lines[1];
          if (acme && fee) {
            acme.status = 'matched';
            acme.match = {
              id: id(0x88d1),
              journal_entry_id: id(0x88d2),
              entry_no: 'RCT-000041',
              method: 'auto_exact',
              source_kind: 'customer_receipt',
            };
            fee.suggestions = [
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
            ];
          }
          return send(route, 200, { lines_considered: 10, auto_matched: 1, suggested: 1 });
        }
        const tm = /^\/bank-rec\/lines\/([^/]+)\/transaction$/.exec(path);
        const line = f.lines.find((l) => l.id === tm?.[1]);
        if (tm && line) {
          line.status = 'matched';
          line.suggestions = [];
          line.match = {
            id: id(0x88d3),
            journal_entry_id: id(0x88d4),
            entry_no: 'MJ-000007',
            method: body['from_suggestion_id'] ? 'rule' : 'created',
            source_kind: 'bank_transaction',
          };
          return send(route, 201, {
            match_id: id(0x88d3),
            manual_journal_id: id(0x88d5),
            entry_id: id(0x88d4),
            entry_no: 'MJ-000007',
            replayed: false,
          });
        }
        if (path === `/bank-rec/statements/${NOV}/reconciliation`) {
          f.reconciled = id(0x88f1);
          return send(route, 201, {
            reconciliation_id: f.reconciled,
            report: report(
              typeof body['closing_balance'] === 'string' ? body['closing_balance'] : null,
            ),
            replayed: false,
          });
        }
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
  // The full account number never reaches the page (design §6.6).
  expect(await page.locator('body').innerText()).not.toContain('12345678');
}

for (const width of [1440, 390]) {
  test(`SS-UC08-08: Reconciliation screens @ ${String(width)} [T-0088]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    const w = String(width);

    // 1. Import the November statement.
    await open(page, '/bank/statements', width);
    await expect(page.getByRole('heading', { level: 1, name: 'Bank statements' })).toBeVisible();
    await expect(page.getByLabel('Bank account')).toContainText(
      'Operating, BSB 062-000, account ending 678',
    );
    const list = page.getByRole('table', { name: 'Imported statements' });
    await expect(list.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Statement file').setInputFiles({
      name: 'harbour-2026-11.csv',
      mimeType: 'text/csv',
      buffer: CSV,
    });
    await page.getByRole('button', { name: 'Import statement' }).click();
    await expect(page.getByRole('status')).toContainText('10 new lines imported');
    await expect(list.getByRole('row')).toHaveCount(3);
    await expect(list.getByRole('row').nth(1)).toContainText('harbour-2026-11.csv');
    await expect(list.getByRole('row').nth(1)).toContainText('10 to match');
    await expect(list.getByRole('row').nth(2)).toContainText('Reconciled');
    const imp = f.posts.find((p) => p.path.endsWith('/statements'));
    expect(imp?.key).toMatch(/^.{8,}$/);
    expect(imp?.body).toEqual({
      company_id: CO,
      file_name: 'harbour-2026-11.csv',
      content_base64: CSV.toString('base64'),
    });
    await assertPage(page, width);
    await evidence('SS-UC08-08', `statement-imported-${w}`);

    // 2. Match: find matches; the receipt matches, the fee gets the rule suggestion.
    await page.getByRole('link', { name: 'Match lines', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Match statement lines' }),
    ).toBeVisible();
    const lines = page.getByRole('table', { name: 'Statement lines' });
    await expect(lines.getByRole('row')).toHaveCount(11);
    await page.getByRole('button', { name: 'Find matches' }).click();
    await expect(page.getByRole('status')).toContainText('1 line matched, 1 suggestion');
    const acme = lines.getByRole('row').nth(1);
    await expect(acme).toContainText('Matched');
    await expect(acme).toContainText('RCT-000041');
    await expect(acme.getByRole('cell').filter({ hasText: '1,375.00' })).toHaveCount(1);
    const fee = lines.getByRole('row').nth(2);
    await expect(fee).toContainText('Suggested: 6110 Bank fees');
    await expect(fee).toContainText('(10.00)');
    await assertPage(page, width);
    await evidence('SS-UC08-08', `match-lines-suggestion-${w}`);

    // 3. Create the transaction from the fee line, accepting the rule's account.
    await fee.getByRole('link', { name: /Create transaction/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Create a transaction' }),
    ).toBeVisible();
    await expect(page.getByLabel('Account')).toHaveValue(GL_FEES);
    await expect(page.getByLabel('Amount')).toHaveValue('10.0000');
    await assertPage(page, width);
    await evidence('SS-UC08-08', `create-transaction-form-${w}`);
    await page.getByRole('button', { name: 'Post transaction' }).click();
    await expect(page.getByRole('status')).toContainText('Posted as MJ-000007');
    expect(f.posts.at(-1)).toEqual({
      path: `/bank-rec/lines/${lineId(1)}/transaction`,
      key: expect.stringMatching(/^.{8,}$/) as unknown,
      body: {
        company_id: CO,
        from_suggestion_id: SUGGESTION,
        lines: [{ account_id: GL_FEES, amount: '10.0000' }],
      },
    });
    await page.getByRole('link', { name: 'Back to the statement lines' }).click();
    await expect(lines.getByRole('row').nth(2)).toContainText('MJ-000007');

    // 4. Reconciliation report: give the closing balance, see it tie, complete it.
    await page.getByRole('link', { name: 'Reconciliation report' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Reconciliation report' }),
    ).toBeVisible();
    await page.getByLabel('Closing balance on the statement').fill('13,394.43');
    await page.getByRole('button', { name: 'Show report' }).click();
    const figures = page.getByRole('table', { name: 'Reconciliation' });
    await expect(figures).toContainText('13,394.43');
    await expect(figures).toContainText('3,394.43');
    await expect(page.getByText('The statement ties to the books')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Unreconciled statement lines' })).toContainText(
      'Deposit Harbour & Co Pty Ltd',
    );
    await assertPage(page, width);
    await evidence('SS-UC08-08', `reconciliation-report-ties-${w}`);
    await page.getByRole('button', { name: 'Complete reconciliation' }).click();
    await expect(page.getByText(/^Reconciled\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete reconciliation' })).toHaveCount(0);
    expect(f.posts.at(-1)).toMatchObject({
      path: `/bank-rec/statements/${NOV}/reconciliation`,
      body: { company_id: CO, closing_balance: '13394.43' },
    });
    await assertPage(page, width);
    await evidence('SS-UC08-08', `reconciliation-completed-${w}`);
    expect(f.errors).toEqual([]);
  });
}

test('T-0088: a refused transaction explains why and the line stays unmatched', async ({
  page,
}) => {
  const f = await fakeApi(page, 'accountant', { imported: true });
  f.refuse.set(`/bank-rec/lines/${lineId(9)}/transaction`, {
    status: 422,
    body: {
      error: 'APPROVAL_REQUIRED',
      message: 'manual journal needs an approval before it posts (design §6.5 rule 4)',
    },
  });
  await open(
    page,
    `/bank/match/transaction?account=${BANK}&statement=${NOV}&line=${lineId(9)}`,
    1440,
  );
  await page.getByLabel('Account').selectOption(GL_INTEREST);
  await expect(page.getByLabel('Amount')).toHaveValue('10000.0000');
  await page.getByRole('button', { name: 'Post transaction' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('needs an approval before it posts');
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(f.lines[9]?.status).toBe('unmatched');
  expect(f.posts.at(-1)?.body).toEqual({
    company_id: CO,
    lines: [{ account_id: GL_INTEREST, amount: '10000.0000' }],
  });
  expect(f.errors).toEqual([]);
});

test('T-0088: an AR Clerk is told they cannot see bank reconciliation, and nothing is listed', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk', { imported: true });
  await open(page, '/bank/statements', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await open(page, `/bank/match?account=${BANK}&statement=${NOV}`, 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('T-0088: an Auditor sees statements, lines and the report but no import or matching actions', async ({
  page,
}) => {
  const f = await fakeApi(page, 'auditor', { imported: true });
  await open(page, '/bank/statements', 1440);
  await expect(page.getByRole('table', { name: 'Imported statements' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import statement' })).toHaveCount(0);
  await open(page, `/bank/match?account=${BANK}&statement=${NOV}`, 1440);
  await expect(page.getByRole('table', { name: 'Statement lines' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find matches' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Create transaction/ })).toHaveCount(0);
  expect(f.posts).toEqual([]);
  expect(f.errors).toEqual([]);
});
