/**
 * Opening balances screen (T-0177, design §4.1 step 9, GP-037, SS-PLAT-132, RQ-0162, DL-0651).
 * A Finance Admin chooses the conversion date and the trial balance, AR and AP CSV files. The
 * screen shows the posting engine's journal preview (P4) and then posts it once. After that,
 * step 9 of the wizard can be completed.
 * Vite serves the app. Each test fakes the API with `page.route`, using the response shapes of
 * apps/api/src/setup/opening-balances.controller.ts (T-0080), GET /accounts (T-0082) and
 * GET /setup/wizard (ADR-0075). The fake answers with GP-037's journal; the browser computes
 * nothing.
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
const CO = id(0x177c);
const FRAN = id(0x1771);
const ACME = id(0x17a1);
const SUPP = id(0x17a2);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0177', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  accountant: { user_id: id(0x1772), display_name: 'Ada Count', role: 'accountant' as const },
};

/** The GP-037 files, as in apps/api/src/setup/opening-balances.db.test.ts. */
const TB = [
  'account_code,debit,credit',
  '1010,12400.00,',
  '1200,1925.00,',
  '1500,3000.00,',
  '1820,120.00,',
  '6230,2515.00,',
  '2000,,660.00',
  '2310,,300.00',
  '3200,,10000.00',
  '4110,,9000.00',
].join('\n');
const AR = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Acme Pty Ltd,INV-0991,2026-09-15,2026-10-15,1375.00,125.00',
  'Acme Pty Ltd,INV-1004,2026-10-15,2026-11-14,550.00,50.00',
].join('\n');
const AP = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Supplier Pty Ltd,B-77,2026-10-08,2026-11-07,-660.00,-60.00',
].join('\n');

const ACCOUNTS: [string, string, string][] = [
  ['1010', 'Operating account', 'asset'],
  ['1200', 'Trade debtors', 'asset'],
  ['1500', 'Computer equipment', 'asset'],
  ['1820', 'GST paid', 'asset'],
  ['6230', 'Office expenses', 'expense'],
  ['2000', 'Trade creditors', 'liability'],
  ['2310', 'GST collected', 'liability'],
  ['3200', 'Retained earnings', 'equity'],
  ['4110', 'Professional services revenue', 'revenue'],
];

/** GP-037 as the posting engine previews it (decimal strings, one side zero). */
const Z = '0.0000';
const PREVIEW = {
  balance_date: '2026-10-31',
  entry_date: '2026-10-31',
  total: '19960.0000',
  lines: [
    ['1010', '12400.0000', Z, null, null, 'Opening balance at conversion 2026-11-01'],
    ['1200', '1375.0000', Z, ACME, '2026-10-15', 'INV-0991 dated 2026-09-15'],
    ['1200', '550.0000', Z, ACME, '2026-11-14', 'INV-1004 dated 2026-10-15'],
    ['1500', '3000.0000', Z, null, null, null],
    ['1820', '120.0000', Z, null, null, null],
    ['6230', '2515.0000', Z, null, null, null],
    ['2000', Z, '660.0000', SUPP, '2026-11-07', 'B-77 dated 2026-10-08'],
    ['2310', Z, '300.0000', null, null, null],
    ['3200', Z, '10000.0000', null, null, null],
    ['4110', Z, '9000.0000', null, null, null],
  ].map(([account_code, debit, credit, party_id, due_date, memo], i) => ({
    line_no: i + 1,
    account_code,
    debit,
    credit,
    party_id,
    due_date,
    memo,
  })),
};

const POSTED = {
  id: id(0x17b0),
  company_id: CO,
  conversion_date: '2026-11-01',
  balance_date: '2026-10-31',
  entry_id: id(0x17b1),
  entry_no: 'OB-000001',
  items: [
    ['ar', ACME, 'INV-0991', '2026-09-15', '2026-10-15', 2, '1375.0000', '125.0000'],
    ['ar', ACME, 'INV-1004', '2026-10-15', '2026-11-14', 3, '550.0000', '50.0000'],
    ['ap', SUPP, 'B-77', '2026-10-08', '2026-11-07', 7, '-660.0000', '-60.0000'],
  ].map(([kind, party_id, document_no, document_date, due_date, line_no, amount, gst]) => ({
    kind,
    party_id,
    document_no,
    document_date,
    due_date,
    line_no,
    amount,
    gst_amount: gst,
  })),
};

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

interface Call {
  path: string;
  key: string | null;
  body: Record<string, unknown>;
}

interface Fake {
  errors: string[];
  previews: Call[];
  posts: Call[];
  gets: number;
  posted: boolean;
  refuse: Map<'preview' | 'post', { status: number; body: unknown }>;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    previews: [],
    posts: [],
    gets: 0,
    posted: false,
    refuse: new Map(),
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  const step = (n: number) => {
    const done = n <= 8;
    const missing = n === 9 && !f.posted ? [NO_OPENING] : [];
    return {
      step: n,
      title: TITLES[n - 1],
      status: done ? 'complete' : n === 9 ? 'in_progress' : 'not_started',
      locked: n > 9,
      valid: missing.length === 0,
      missing,
      outcome: done ? 'validated' : null,
      reason: null,
      completed_at: done ? '2026-11-13T23:00:00.000Z' : null,
      completed_by: done ? FRAN : null,
    };
  };
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|setup|accounts)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const me = ME[who];
      const perms: readonly string[] = ROLE_TEMPLATES[me.role].permissions;
      const need = (p: string) =>
        perms.includes(p) ? null : send(route, 403, { error: 'forbidden', permission: p });
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
      if (path === '/accounts')
        return (
          need('gl.account.read') ??
          send(route, 200, {
            companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
            accounts: ACCOUNTS.map(([code, name, type], i) => ({
              id: id(0x1800 + i),
              company_id: CO,
              code,
              name,
              type,
              subtype: type,
              normal_balance: type === 'asset' || type === 'expense' ? 'debit' : 'credit',
              currency: null,
              postable: true,
              is_control: code === '1200' || code === '2000',
              status: 'active',
              system_roles: [],
            })),
          })
        );
      if (path === '/setup/wizard' && req.method() === 'GET')
        return (
          need('settings.read') ??
          send(route, 200, {
            company_id: CO,
            as_of: '2026-11-15',
            complete: false,
            steps: TITLES.map((_, i) => step(i + 1)),
          })
        );
      if (path === '/setup/opening-balances' && req.method() === 'GET') {
        const denied = need('settings.chart.manage');
        if (denied) return denied;
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.gets += 1;
        return f.posted
          ? send(route, 200, POSTED)
          : send(route, 404, { error: 'no_opening_balance' });
      }
      if (path.startsWith('/setup/opening-balances') && req.method() === 'POST') {
        const denied = need('settings.chart.manage');
        if (denied) return denied;
        const call: Call = {
          path,
          key: req.headers()['idempotency-key'] ?? null,
          body: req.postDataJSON() as Record<string, unknown>,
        };
        const which = path.endsWith('/preview') ? 'preview' : 'post';
        (which === 'preview' ? f.previews : f.posts).push(call);
        const r = f.refuse.get(which);
        if (r) return send(route, r.status, r.body);
        if (which === 'preview') return send(route, 200, PREVIEW);
        if (!call.key) return send(route, 400, { error: 'idempotency_key_required' });
        if (f.posted) {
          const first = f.posts[0];
          return first?.key === call.key
            ? send(route, 200, { ...POSTED, replayed: true })
            : send(route, 422, {
                error: 'OPENING_EXISTS',
                message: 'the company already has an opening balance',
              });
        }
        f.posted = true;
        return send(route, 201, { ...POSTED, replayed: false });
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

const file = (name: string, text: string) => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(text, 'utf8'),
});

async function fillFiles(page: Page) {
  await page.getByLabel('Conversion date').fill('2026-11-01');
  await page.getByLabel(/^Trial balance/).setInputFiles(file('trial-balance.csv', TB));
  await page.getByLabel(/^Open customer invoices/).setInputFiles(file('ar-items.csv', AR));
  await page.getByLabel(/^Open supplier bills/).setInputFiles(file('ap-items.csv', AP));
}

const stepItem = (page: Page, n: number) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
    });

for (const width of [1440, 390]) {
  test(`SS-PLAT-132: Opening balances screen previews the engine's journal, posts it once, and step 9 becomes completable @ ${String(width)} [T-0177]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    // From the wizard: step 9 links to the screen.
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 9)).toContainText(NO_OPENING);
    await stepItem(page, 9).getByRole('link', { name: 'Opening balances' }).click();
    await expect(page).toHaveURL(/\/settings\/setup\/opening-balances$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Opening balances' })).toBeVisible();
    await expect(page.getByText('No opening balance has been posted yet.')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-132', `opening-balances-empty-${String(width)}`);

    await fillFiles(page);
    await page.getByRole('button', { name: 'Show the journal' }).click();
    const journal = page.getByRole('table', { name: 'Journal preview' });
    await expect(journal).toBeVisible();
    await expect(page.getByText(/Nothing is posted yet/)).toBeVisible();
    await expect(page.getByText(/dated 31 Oct 2026/).first()).toBeVisible();
    await expect(journal.getByRole('row')).toHaveCount(12);
    await expect(journal).toContainText('Trade debtors');
    await expect(journal).toContainText('INV-0991 dated 2026-09-15');
    await expect(journal).toContainText('Retained earnings');
    await expect(journal.locator('tfoot')).toContainText('Balanced');
    await expect(journal.locator('tfoot')).toContainText('19,960.00');
    expect(f.previews).toHaveLength(1);
    expect(f.previews[0]?.body).toEqual({
      company_id: CO,
      conversion_date: '2026-11-01',
      trial_balance_csv: TB,
      ar_items_csv: AR,
      ap_items_csv: AP,
    });
    expect(f.posts).toEqual([]);
    await assertPage(page, width);
    await evidence('SS-PLAT-132', `opening-balances-journal-preview-${String(width)}`);

    await page.getByRole('button', { name: 'Post the opening balance' }).click();
    await expect(
      page.getByRole('heading', { name: 'The opening balance is posted' }),
    ).toBeVisible();
    await expect(page.getByText(/Journal OB-000001, dated 31 Oct 2026/)).toBeVisible();
    const items = page.getByRole('table', { name: 'Open items brought across' });
    await expect(items.getByRole('row')).toHaveCount(4);
    await expect(items).toContainText('B-77');
    await expect(page.getByRole('button', { name: 'Post the opening balance' })).toHaveCount(0);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.key).toMatch(/^.{8,}$/);
    expect(f.posts[0]?.body).toEqual(f.previews[0]?.body);
    await assertPage(page, width);
    await evidence('SS-PLAT-132', `opening-balances-posted-${String(width)}`);

    await page.getByRole('link', { name: 'Back to the setup steps' }).click();
    await expect(page).toHaveURL(/\/settings\/setup$/);
    await expect(
      page.getByRole('button', { name: 'Complete step 9: Opening balances' }),
    ).toBeVisible();
    await expect(stepItem(page, 9)).not.toContainText(NO_OPENING);
    await assertPage(page, width);
    await evidence('SS-PLAT-132', `wizard-step-9-ready-${String(width)}`);
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-132: a refused file is explained with its line, and nothing is posted [T-0177]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  await open(page, '/settings/setup/opening-balances', 1440);
  // Without a trial balance nothing is sent.
  await page.getByLabel('Conversion date').fill('2026-11-01');
  await page.getByRole('button', { name: 'Show the journal' }).click();
  await expect(page.getByText('Choose the trial balance file first.')).toBeVisible();
  expect(f.previews).toEqual([]);

  f.refuse.set('preview', {
    status: 422,
    body: {
      error: 'INVALID_CSV',
      message: 'gst_amount 1400.00 is larger than the amount 1375.00',
      row: 2,
    },
  });
  await fillFiles(page);
  await page.getByRole('button', { name: 'Show the journal' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('LedgerForce did not accept the files');
  await expect(alert).toContainText('gst_amount 1400.00 is larger than the amount 1375.00');
  await expect(alert).toContainText('line 2');
  await expect(page.getByRole('table', { name: 'Journal preview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Post the opening balance' })).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-PLAT-132', 'opening-balances-refused-line-1440');

  // The engine refuses at posting time (the period closed meanwhile): said plainly, retried with a
  // new key only after the files change.
  f.refuse.delete('preview');
  await page.getByRole('button', { name: 'Show the journal' }).click();
  await expect(page.getByRole('table', { name: 'Journal preview' })).toBeVisible();
  f.refuse.set('post', {
    status: 422,
    body: { error: 'PERIOD_CLOSED', message: 'the period of 2026-10-31 is closed' },
  });
  await page.getByRole('button', { name: 'Post the opening balance' }).click();
  await expect(page.getByRole('alert')).toContainText('the period of 2026-10-31 is closed');
  await page.getByRole('button', { name: 'Post the opening balance' }).click();
  await expect(page.getByRole('alert')).toContainText('the period of 2026-10-31 is closed');
  expect(f.posts).toHaveLength(2);
  // Same inputs, same key: a retry can only replay, never double-post.
  expect(f.posts[0]?.key).toBe(f.posts[1]?.key);
  expect(f.posted).toBe(false);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-132: an Accountant without settings.chart.manage cannot import, and nothing is read [T-0177]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, '/settings/setup/opening-balances', 1440);
  await expect(
    page.getByRole('heading', { name: "You can't import opening balances" }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Trial balance/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show the journal' })).toHaveCount(0);
  expect(f.gets).toBe(0);
  expect(f.previews).toEqual([]);
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});
