/**
 * T-0082 — the GL screens of apps/web, end to end in Chromium.
 *
 *  - SS-PLAT-93: chart of accounts — by type with glosses, controls and roles in words; states.
 *  - SS-PLAT-94: manual journals — list, a draft written by keyboard, submit, approval by another
 *    person, post; permission-aware actions; loading / empty / error / forbidden states.
 *  - SS-PLAT-95: "show me the journal" — the engine's preview before posting, and a line on a
 *    control account refused with the CONTROL_ACCOUNT reason.
 *
 * Every screen at 1440 and 390 with axe WCAG 2.2 AA (0 violations), the genericness probes, no
 * horizontal scroll and no console errors. The app is served in-process by Vite (as
 * admin.spec.ts) and the API is faked per test with `page.route`; the contracts faked are the
 * ones apps/api proves in gl-screens.db.test.ts and manual-journals.db.test.ts. The fake's
 * preview stands in for the posting engine (it returns the stored lines and refuses control
 * accounts with the engine's code and line). Screenshots go to .agent/evidence/T-0082/.
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
const PRIYA = id(0x8201);
const MEI = id(0x8202);
const ADA = id(0x8203);
const LENA = id(0x8204);
const CO = id(0x82c1);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0082', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

type Who = 'accountant' | 'approver' | 'auditor' | 'clerk';
const ME: Record<
  Who,
  { user_id: string; display_name: string; role: keyof typeof ROLE_TEMPLATES }
> = {
  accountant: { user_id: PRIYA, display_name: 'Priya Shah', role: 'accountant' },
  approver: { user_id: MEI, display_name: 'Mei Tan', role: 'approver' },
  auditor: { user_id: ADA, display_name: 'Ada Brooks', role: 'auditor' },
  clerk: { user_id: LENA, display_name: 'Lena Ortiz', role: 'ar_clerk' },
};
const NAMES: Record<string, string> = Object.fromEntries(
  Object.values(ME).map((m) => [m.user_id, m.display_name]),
);

const TEMPLATE: [string, string, string, string, string[], boolean?, boolean?][] = [
  ['1010', 'Operating account', 'asset', 'bank', []],
  ['1020', 'Business saver', 'asset', 'bank', []],
  ['1200', 'Trade debtors', 'asset', 'receivable', ['AR_CONTROL'], true],
  ['1300', 'Prepayments', 'asset', 'current_asset', []],
  ['1820', 'GST paid', 'asset', 'current_asset', ['GST_PAID']],
  ['2000', 'Trade creditors', 'liability', 'payable', ['AP_CONTROL'], true],
  ['2310', 'GST collected', 'liability', 'current_liability', ['GST_COLLECTED']],
  ['2900', 'Suspense', 'liability', 'current_liability', ['SUSPENSE']],
  ['3000', "Owner's capital", 'equity', 'equity', []],
  [
    '3300',
    'Current year earnings',
    'equity',
    'current_year_earnings',
    ['CURRENT_YEAR_EARNINGS'],
    false,
    false,
  ],
  ['4110', 'Professional services', 'revenue', 'operating_revenue', []],
  ['6200', 'Rent', 'expense', 'operating_expense', []],
  ['6500', 'Bad debts', 'expense', 'operating_expense', []],
  ['6600', 'Depreciation', 'expense', 'operating_expense', []],
];
const ACCOUNTS = TEMPLATE.map(([code, name, type, subtype, roles, control, postable], i) => ({
  id: id(0x8300 + i),
  company_id: CO,
  code,
  name,
  type,
  subtype,
  normal_balance: type === 'asset' || type === 'expense' ? 'debit' : 'credit',
  currency: null,
  postable: postable ?? true,
  is_control: control ?? false,
  status: 'active',
  system_roles: roles,
}));
const acct = (code: string) => {
  const a = ACCOUNTS.find((x) => x.code === code);
  if (!a) throw new Error(code);
  return a;
};

interface StoredLine {
  account: { id: string };
  debit?: string;
  credit?: string;
  memo?: string;
}
interface Doc {
  id: string;
  company_id: string;
  status: 'draft' | 'submitted' | 'approved' | 'posted';
  entry_date: string;
  memo: string | null;
  lines: StoredLine[];
  created_by: string;
  submitted_by: string | null;
  total: string | null;
  approval_required: boolean | null;
  sensitive_accounts: boolean | null;
  approved_by: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  posted_by: string | null;
  journal_entry_id: string | null;
  entry_no: string | null;
  created_at: number;
}

const draft = (n: number, memo: string, lines: StoredLine[], at: number): Doc => ({
  id: id(0x8400 + n),
  company_id: CO,
  status: 'draft',
  entry_date: '2026-10-24',
  memo,
  lines,
  created_by: PRIYA,
  submitted_by: null,
  total: null,
  approval_required: null,
  sensitive_accounts: null,
  approved_by: null,
  rejected_by: null,
  rejection_reason: null,
  posted_by: null,
  journal_entry_id: null,
  entry_no: null,
  created_at: at,
});

const two = (dr: string, cr: string, amount: string, memo?: string): StoredLine[] => [
  { account: { id: acct(dr).id }, debit: amount, ...(memo ? { memo } : {}) },
  { account: { id: acct(cr).id }, credit: amount },
];

function seedDocs(): Doc[] {
  const posted: Doc = {
    ...draft(1, 'September depreciation', two('6600', '1010', '412.5000'), 1),
    status: 'posted',
    submitted_by: PRIYA,
    posted_by: PRIYA,
    total: '412.5000',
    approval_required: false,
    sensitive_accounts: false,
    journal_entry_id: id(0x8501),
    entry_no: 'MJ-000041',
  };
  const waiting: Doc = {
    ...draft(2, 'Insurance prepaid for the year', two('1300', '1010', '7800.0000'), 2),
    status: 'submitted',
    submitted_by: PRIYA,
    total: '7800.0000',
    approval_required: true,
    sensitive_accounts: false,
  };
  const rent = draft(3, 'Accrued rent, October', two('6200', '2900', '1250.5000', 'October'), 3);
  const writeOff = draft(
    4,
    'Write off Saltbush invoice INV-0091',
    [
      { account: { id: acct('6500').id }, debit: '300.0000' },
      { account: { id: acct('1200').id }, credit: '300.0000', memo: 'INV-0091' },
    ],
    4,
  );
  return [posted, waiting, rent, writeOff];
}

interface Fake {
  who: Who;
  docs: Doc[];
  posts: { method: string; path: string; body: unknown; key: string | null }[];
  errors: string[];
  override: Map<string, { status: number; body: unknown } | 'hold'>;
}

const viewOf = (d: Doc) => {
  const { created_at: _at, ...v } = d;
  void _at;
  return v;
};

/** NUMERIC(19,4) text of a typed amount, as the engine returns it ("5400.00" → "5400.0000"). */
const fixed = (s: string | undefined): string => {
  if (s === undefined || s === '') return '0.0000';
  const [int = '0', frac = ''] = s.split('.');
  return `${int}.${frac.padEnd(4, '0').slice(0, 4)}`;
};

/** The fake's stand-in for the engine's preview of a stored journal. */
function previewOf(d: Doc): { status: number; body: unknown } {
  if (d.status === 'posted')
    return {
      status: 422,
      body: { error: 'posting_refused', code: 'ALREADY_POSTED', line: null, entry_no: d.entry_no },
    };
  const bad = d.lines.findIndex((l) => ACCOUNTS.find((a) => a.id === l.account.id)?.is_control);
  if (bad >= 0)
    return {
      status: 422,
      body: {
        error: 'posting_refused',
        code: 'CONTROL_ACCOUNT',
        line: bad + 1,
        message: `line ${String(bad + 1)}: control account`,
      },
    };
  const lines = d.lines.map((l, i) => {
    const a = ACCOUNTS.find((x) => x.id === l.account.id);
    return {
      line_no: i + 1,
      account_id: l.account.id,
      account_code: a?.code ?? '',
      account_name: a?.name ?? '',
      account_type: a?.type ?? '',
      debit: fixed(l.debit),
      credit: fixed(l.credit),
      memo: l.memo ?? null,
    };
  });
  return {
    status: 200,
    body: {
      entry_date: d.entry_date,
      requested_date: d.entry_date,
      redirected: false,
      needs_override: false,
      base_currency: 'AUD',
      total: lines.find((l) => l.debit !== '0.0000')?.debit ?? '0.0000',
      lines,
    },
  };
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = { who, docs: seedDocs(), posts: [], errors: [], override: new Map() };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|403|404|409|422|503)/.test(m.text())) {
      f.errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });

  await page.route(
    (url) => url.origin === origin && /^\/(auth|accounts|manual-journals)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      const o = f.override.get(`${method} ${path}`);
      if (o === 'hold') return;
      if (o) return send(route, o.status, o.body);
      const me = ME[f.who];
      const perms = [...ROLE_TEMPLATES[me.role].permissions];
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, { roles: [me.role], permissions: perms });
      const need = (p: string) =>
        perms.includes(p as never) ? null : send(route, 403, { error: 'forbidden', permission: p });
      const body: unknown = method === 'GET' ? undefined : req.postDataJSON();
      if (method !== 'GET')
        f.posts.push({ method, path, body, key: req.headers()['idempotency-key'] ?? null });
      if (path === '/accounts')
        return (
          need('gl.account.read') ??
          send(route, 200, {
            companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
            accounts: ACCOUNTS,
          })
        );
      if (path === '/manual-journals' && method === 'GET') {
        const st = url.searchParams.get('status');
        return (
          need('gl.journal.read') ??
          send(route, 200, {
            journals: [...f.docs]
              .filter((d) => !st || d.status === st)
              .sort((a, b) => b.created_at - a.created_at)
              .map((d) => ({
                id: d.id,
                company_id: d.company_id,
                status: d.status,
                entry_date: d.entry_date,
                memo: d.memo,
                line_count: d.lines.length,
                amount: fixed(d.lines.find((l) => l.debit !== undefined)?.debit),
                total: d.total,
                approval_required: d.approval_required,
                created_by: d.created_by,
                created_by_name: NAMES[d.created_by] ?? '',
                submitted_by_name: d.submitted_by ? (NAMES[d.submitted_by] ?? '') : null,
                approved_by_name: d.approved_by ? (NAMES[d.approved_by] ?? '') : null,
                posted_by_name: d.posted_by ? (NAMES[d.posted_by] ?? '') : null,
                entry_no: d.entry_no,
              })),
          })
        );
      }
      if (path === '/manual-journals' && method === 'POST') {
        const b = body as {
          company_id: string;
          entry_date: string;
          memo?: string;
          lines: { account_id: string; debit?: string; credit?: string; memo?: string }[];
        };
        const doc = draft(
          10 + f.docs.length,
          b.memo ?? '',
          b.lines.map((l) => ({
            account: { id: l.account_id },
            ...(l.debit ? { debit: l.debit } : { credit: l.credit ?? '' }),
            ...(l.memo ? { memo: l.memo } : {}),
          })),
          100 + f.docs.length,
        );
        doc.entry_date = b.entry_date;
        f.docs.push(doc);
        return send(route, 201, { ...viewOf(doc), replayed: false });
      }
      const m = /^\/manual-journals\/([^/]+)(\/[a-z]+)?$/.exec(path);
      const doc = m ? f.docs.find((d) => d.id === m[1]) : undefined;
      if (!m || !doc) return send(route, 404, { error: 'not_found' });
      const rest = m[2] ?? '';
      if (rest === '' && method === 'GET')
        return (
          need('gl.journal.read') ??
          send(route, 200, {
            ...viewOf(doc),
            people: Object.fromEntries(
              [doc.created_by, doc.submitted_by, doc.approved_by, doc.posted_by]
                .filter((x): x is string => x !== null)
                .map((x) => [x, NAMES[x] ?? '']),
            ),
          })
        );
      if (rest === '/preview') {
        const p = previewOf(doc);
        return need('gl.journal.read') ?? send(route, p.status, p.body);
      }
      if (rest === '/submit') {
        const p = previewOf(doc);
        if (p.status !== 200) return send(route, p.status, p.body);
        const total = (p.body as { total: string }).total;
        doc.status = 'submitted';
        doc.submitted_by = ME[f.who].user_id;
        doc.total = total;
        doc.approval_required = Number.parseInt(total, 10) > 5000;
        doc.sensitive_accounts = false;
        return send(route, 200, {
          id: doc.id,
          status: 'submitted',
          total,
          approval_required: doc.approval_required,
          sensitive_accounts: false,
        });
      }
      if (rest === '/approve') {
        const denied = need('gl.journal.approve');
        if (denied) return denied;
        doc.status = 'approved';
        doc.approved_by = ME[f.who].user_id;
        return send(route, 200, { id: doc.id, status: 'approved' });
      }
      if (rest === '/post') {
        if (doc.status === 'submitted' && doc.approval_required)
          return send(route, 409, { error: 'approval_required', message: 'needs approval' });
        doc.status = 'posted';
        doc.posted_by = ME[f.who].user_id;
        doc.entry_no = 'MJ-000042';
        doc.journal_entry_id = id(0x8502);
        return send(route, 200, {
          id: doc.id,
          status: 'posted',
          entry_id: doc.journal_entry_id,
          entry_no: doc.entry_no,
          entry_date: doc.entry_date,
          replayed: false,
        });
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

const RENT = id(0x8403);
const WAITING = id(0x8402);
const WRITE_OFF = id(0x8404);
const POSTED = id(0x8401);

async function open(page: Page, path: string, width: number, scheme: 'light' | 'dark' = 'light') {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: scheme });
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
  // P12: at most one primary action per view.
  expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  // P3: money cells right-aligned (on wide screens) with tabular figures, two decimals.
  for (const cell of await page.locator('main [data-amount]').all()) {
    const style = await cell.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { nums: cs.fontVariantNumeric };
    });
    expect(style.nums).toContain('tabular-nums');
    expect(await cell.getAttribute('data-amount')).toMatch(/^-?\d+\.\d{2}$/);
  }
}

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { width: 0 };
    return { width: Number.parseFloat(getComputedStyle(el).outlineWidth) };
  });
}

test.describe('SS-PLAT-93 chart of accounts', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-93: an Accountant reads the chart by type @ ${String(width)} [T-0082]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'accountant');
      await open(page, '/reports', width);
      await page.getByRole('link', { name: 'Chart of accounts' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chart of accounts');
      await expect(
        page.getByRole('heading', { level: 2, name: 'Assets — what the business owns' }),
      ).toBeVisible();
      const assets = page.getByRole('table', { name: 'Assets' });
      await expect(assets.getByRole('row')).toHaveCount(6);
      await expect(assets.getByRole('row', { name: /Trade debtors/ })).toContainText(
        'Control account: only its ledger posts here; AR_CONTROL',
      );
      await expect(
        page.getByRole('table', { name: 'Equity' }).getByRole('row', { name: /Current year/ }),
      ).toContainText('Not postable');
      await assertPage(page, width);
      await evidence('SS-PLAT-93', `chart-of-accounts-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-93: loading, error, empty and forbidden states [T-0082]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    f.override.set('GET /accounts', 'hold');
    await open(page, '/accounting/chart', 1440);
    await expect(page.getByText('Loading the chart of accounts…')).toBeVisible();
    await evidence('SS-PLAT-93', 'chart-loading-1440');
    f.override.set('GET /accounts', { status: 503, body: { error: 'down' } });
    await open(page, '/accounting/chart', 390);
    await expect(page.getByRole('alert')).toContainText('We could not load the chart of accounts');
    await assertPage(page, 390);
    await evidence('SS-PLAT-93', 'chart-error-390');
    f.override.set('GET /accounts', {
      status: 200,
      body: {
        companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
        accounts: [],
      },
    });
    await open(page, '/accounting/chart', 1440);
    await expect(
      page.getByRole('heading', { level: 2, name: 'No chart of accounts yet' }),
    ).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-93', 'chart-empty-1440');
    f.who = 'clerk';
    for (const width of [1440, 390]) {
      await open(page, '/accounting/chart', width);
      await expect(
        page.getByRole('heading', { level: 2, name: "You can't see the chart of accounts" }),
      ).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-93', `chart-forbidden-${String(width)}`);
    }
  });
});

test.describe('SS-PLAT-94 manual journals', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-94: the journal list, newest first @ ${String(width)} [T-0082]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'accountant');
      await open(page, '/reports', width);
      await page.getByRole('link', { name: 'Manual journals' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manual journals');
      const table = page.getByRole('table', { name: 'Manual journals' });
      await expect(table.getByRole('row')).toHaveCount(5);
      await expect(table.getByRole('row').nth(1)).toContainText('Write off Saltbush');
      await expect(table.getByRole('row', { name: /Insurance prepaid/ })).toContainText(
        'Waiting for approval',
      );
      await expect(table.getByRole('row', { name: /MJ-000041/ })).toContainText('Posted');
      await expect(
        table.getByRole('row', { name: /Insurance prepaid/ }).locator('[data-amount]'),
      ).toHaveAttribute('data-amount', '7800.00');
      await expect(page.getByRole('link', { name: 'New manual journal' })).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-94', `journal-list-${String(width)}`);
      await page.getByLabel('Show').selectOption({ label: 'Drafts' });
      await expect(page).toHaveURL(/status=draft$/);
      await expect(table.getByRole('row')).toHaveCount(3);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-94: an Accountant writes a draft by keyboard and sees its journal [T-0082]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, '/accounting/journals/new', 1440);
    const date = page.getByLabel('Date', { exact: true });
    await date.focus();
    expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
    await date.fill('2026-10-31');
    // Tab inside a date input moves between its day, month and year parts: go to the memo.
    await page.getByLabel('What is this journal for?').focus();
    await page.keyboard.type('Depreciation, October');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Line 1 account')).toBeFocused();
    await page.getByLabel('Line 1 account').selectOption({ label: '6600 Depreciation' });
    await page.keyboard.press('Tab');
    await page.keyboard.type('5400.00');
    await page.getByLabel('Line 2 account').focus();
    await page.getByLabel('Line 2 account').selectOption({ label: '1010 Operating account' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('5400.00');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-94', 'journal-form-filled-1440');
    await page.getByRole('button', { name: 'Save draft and show the journal' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manual journal');
    expect(f.posts[0]).toEqual({
      method: 'POST',
      path: '/manual-journals',
      key: expect.stringMatching(/^mj-[0-9a-f-]{36}$/) as unknown as string,
      body: {
        company_id: CO,
        entry_date: '2026-10-31',
        memo: 'Depreciation, October',
        lines: [
          { account_id: acct('6600').id, debit: '5400.00' },
          { account_id: acct('1010').id, credit: '5400.00' },
        ],
      },
    });
    const journal = page.getByRole('region', { name: 'Journal' });
    await expect(journal.getByText('Balanced')).toBeVisible();
    await expect(page.locator('[data-open-item]')).toHaveText(
      'Your turn: check the journal, then submit it',
    );
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Submitted. It needs an approval before it posts.',
    );
    await expect(page.locator('[data-open-item]')).toHaveText(
      'Waiting for an Approver or the Owner to approve it',
    );
    await expect(page.getByRole('button', { name: 'Post to the ledger' })).toHaveCount(0);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-94', 'journal-submitted-waiting-1440');
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-94: the draft form at 390, with the problems shown before saving [T-0082]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, `/accounting/journals/${RENT}/edit`, 390);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Change manual journal');
    await expect(page.getByLabel('Line 1 debit')).toHaveValue('1250.5000');
    await page.getByLabel('Line 2 credit').fill('1,250.50');
    await page.getByRole('button', { name: 'Save draft and show the journal' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Line 2: write amounts as digits with up to 4 decimals and no commas, like 1250.50.',
    );
    expect(f.posts).toEqual([]);
    await assertPage(page, 390);
    await evidence('SS-PLAT-94', 'journal-form-problems-390');
  });

  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-94: an Approver approves, then the Accountant posts @ ${String(width)} [T-0082]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'approver');
      await open(page, `/accounting/journals/${WAITING}`, width);
      await expect(page.getByRole('list', { name: 'People involved' })).toContainText(
        'Prepared by Priya Shah',
      );
      await expect(page.locator('[data-open-item]')).toHaveText('Your turn: approve or send back');
      await expect(page.locator('[data-open-item]')).toHaveAttribute('data-due', '2026-10-24');
      await expect(
        page.getByRole('region', { name: 'Journal' }).getByText('Balanced'),
      ).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-94', `journal-approver-${String(width)}`);
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByRole('status')).toHaveText('Approved. It can be posted now.');
      await expect(page.getByRole('list', { name: 'People involved' })).toContainText(
        'Approved by Mei Tan (you)',
      );
      f.who = 'accountant';
      await open(page, `/accounting/journals/${WAITING}`, width);
      await page.getByRole('button', { name: 'Post to the ledger' }).click();
      await expect(page.getByRole('status')).toHaveText('Posted as MJ-000042 on 2026-10-24.');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manual journal MJ-000042');
      await expect(page.getByRole('region', { name: 'Journal' })).toContainText(
        'Posted journals never change.',
      );
      expect(f.posts.map((p) => p.path)).toEqual([
        `/manual-journals/${WAITING}/approve`,
        `/manual-journals/${WAITING}/post`,
      ]);
      await assertPage(page, width);
      await evidence('SS-PLAT-94', `journal-posted-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-94: an Auditor reads but cannot act; loading, empty, error and forbidden [T-0082]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'auditor');
    await open(page, '/accounting/journals', 1440, 'dark');
    await expect(page.getByRole('table', { name: 'Manual journals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New manual journal' })).toHaveCount(0);
    await expect(
      page.getByText('Only an Accountant, a Finance Admin or the Owner can write manual journals.'),
    ).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-94', 'journal-list-auditor-1440-dark');
    await open(page, `/accounting/journals/${WAITING}`, 390);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByText(/Only an Approver or the Owner can approve it/)).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-94', 'journal-auditor-390');
    f.override.set('GET /manual-journals', 'hold');
    await open(page, '/accounting/journals', 1440);
    await expect(page.getByText('Loading manual journals…')).toBeVisible();
    await evidence('SS-PLAT-94', 'journal-list-loading-1440');
    f.override.set('GET /manual-journals', { status: 503, body: { error: 'down' } });
    await open(page, '/accounting/journals', 390);
    await expect(page.getByRole('alert')).toContainText('We could not load the manual journals');
    await assertPage(page, 390);
    await evidence('SS-PLAT-94', 'journal-list-error-390');
    f.override.set('GET /manual-journals', { status: 200, body: { journals: [] } });
    await open(page, '/accounting/journals', 1440);
    await expect(
      page.getByRole('heading', { level: 2, name: 'No manual journals yet' }),
    ).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-94', 'journal-list-empty-1440');
    f.who = 'clerk';
    await open(page, '/accounting/journals', 390);
    await expect(
      page.getByRole('heading', { level: 2, name: "You can't see manual journals" }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-94', 'journal-list-forbidden-390');
  });
});

test.describe('SS-PLAT-95 show me the journal', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-95: the draft's journal from the engine, before submitting @ ${String(width)} [T-0082]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'accountant');
      await open(page, `/accounting/journals/${RENT}`, width);
      const journal = page.getByRole('region', { name: 'Journal' });
      await expect(journal.getByText('Balanced')).toBeVisible();
      const table = journal.getByRole('table', { name: 'Journal preview' });
      await expect(table.getByRole('row').nth(1)).toContainText('6200Rentmoney spent');
      await expect(table.getByRole('row').nth(2)).toContainText(
        '2900Suspensewhat the business owes',
      );
      await expect(table.locator('tbody [data-amount]').first()).toHaveAttribute(
        'data-amount',
        '1250.50',
      );
      await expect(journal).toContainText('Nothing is posted yet.');
      await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-95', `journal-preview-${String(width)}`);
      expect(f.errors).toEqual([]);
    });

    test(`SS-PLAT-95: a control-account line is refused with the reason @ ${String(width)} [T-0082]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'accountant');
      await open(page, `/accounting/journals/${WRITE_OFF}`, width);
      const journal = page.getByRole('region', { name: 'Journal' });
      const lines = journal.getByRole('table', { name: 'Lines of this draft' });
      await expect(lines.getByRole('row').nth(2)).toContainText('Refused');
      await expect(lines.getByRole('row').nth(1)).not.toContainText('Refused');
      await expect(journal.getByRole('alert')).toHaveText(
        'Line 2 uses 1200 Trade debtors, a control account. Only the sales or purchases ledger posts to it, so the ledger and its total never drift apart. Choose another account, or record this as an invoice, bill, receipt or payment.',
      );
      await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Change the draft' })).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-95', `journal-refused-control-account-${String(width)}`);
      expect(f.posts).toEqual([]);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-95: a posted journal shows the entry it posted [T-0082]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'auditor');
    await open(page, `/accounting/journals/${POSTED}`, 1440);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manual journal MJ-000041');
    const journal = page.getByRole('region', { name: 'Journal' });
    await expect(journal.getByRole('table', { name: 'Journal MJ-000041' })).toContainText(
      '6600Depreciation',
    );
    await expect(journal.getByText('Balanced')).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', { name: /delete|submit|approve|post/i }),
    ).toHaveCount(0);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-95', 'journal-posted-entry-1440');
  });
});
