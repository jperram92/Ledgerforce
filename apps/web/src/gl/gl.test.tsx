/**
 * SS-PLAT-93..95 — the GL screens in the app shell (T-0082), against a fake of the routes of
 * T-0029 and ADR-0042. Playwright (tests/e2e/web/gl.spec.ts) proves the same screens in Chromium
 * with axe and screenshots; these tests pin the behaviour quickly.
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import type { AppEnv } from '../env.tsx';

const PRIYA = 'u-priya';
const MEI = 'u-mei';
const access = (role: keyof typeof ROLE_TEMPLATES) => ({
  roles: [role],
  permissions: [...ROLE_TEMPLATES[role].permissions],
});
const ME = {
  accountant: { tenant_id: 't1', user_id: PRIYA, display_name: 'Priya Shah' },
  approver: { tenant_id: 't1', user_id: MEI, display_name: 'Mei Tan' },
};

const acct = (id: string, code: string, name: string, type: string, extra = {}) => ({
  id,
  company_id: 'c1',
  code,
  name,
  type,
  subtype: 'x',
  normal_balance: 'debit',
  currency: null,
  postable: true,
  is_control: false,
  status: 'active',
  system_roles: [] as string[],
  ...extra,
});
const CHART = {
  companies: [{ id: 'c1', name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
  accounts: [
    acct('a-bank', '1010', 'Operating account', 'asset'),
    acct('a-ar', '1200', 'Trade debtors', 'asset', {
      is_control: true,
      system_roles: ['AR_CONTROL'],
    }),
    acct('a-cye', '3300', 'Current year earnings', 'equity', {
      postable: false,
      system_roles: ['CURRENT_YEAR_EARNINGS'],
    }),
    acct('a-rent', '6200', 'Rent', 'expense'),
  ],
};

const DOC = {
  id: 'mj-1',
  company_id: 'c1',
  status: 'draft',
  entry_date: '2026-10-24',
  memo: 'Accrued rent',
  lines: [
    { account: { id: 'a-rent' }, debit: '1250.5000', memo: 'October' },
    { account: { id: 'a-bank' }, credit: '1250.5000' },
  ],
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
  people: { [PRIYA]: 'Priya Shah' },
};
const PREVIEW = {
  entry_date: '2026-10-24',
  requested_date: '2026-10-24',
  redirected: false,
  needs_override: false,
  base_currency: 'AUD',
  total: '1250.5000',
  lines: [
    {
      line_no: 1,
      account_id: 'a-rent',
      account_code: '6200',
      account_name: 'Rent',
      account_type: 'expense',
      debit: '1250.5000',
      credit: '0.0000',
      memo: 'October',
    },
    {
      line_no: 2,
      account_id: 'a-bank',
      account_code: '1010',
      account_name: 'Operating account',
      account_type: 'asset',
      debit: '0.0000',
      credit: '1250.5000',
      memo: null,
    },
  ],
};
const ROW = {
  id: 'mj-1',
  company_id: 'c1',
  status: 'draft',
  entry_date: '2026-10-24',
  memo: 'Accrued rent',
  line_count: 2,
  amount: '1250.5000',
  total: null,
  approval_required: null,
  created_by: PRIYA,
  created_by_name: 'Priya Shah',
  submitted_by_name: null,
  approved_by_name: null,
  posted_by_name: null,
  entry_no: null,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (req: { url: URL; body: unknown }) => Response | Promise<Response>;
interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function start(
  path: string,
  who: 'accountant' | 'approver' | 'auditor' | 'ar_clerk',
  routes: Record<string, Handler> = {},
) {
  const calls: Call[] = [];
  const me = who === 'approver' ? ME.approver : ME.accountant;
  const all: Record<string, Handler> = {
    'GET /auth/me': () => json(200, me),
    'GET /auth/me/access': () => json(200, access(who)),
    'GET /accounts': () => json(200, CHART),
    'GET /manual-journals': () => json(200, { journals: [ROW] }),
    'GET /manual-journals/mj-1': () => json(200, DOC),
    'GET /manual-journals/mj-1/preview': () => json(200, PREVIEW),
    ...routes,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://app.test');
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      body,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    const h = all[`${method} ${url.pathname}`];
    return h ? h({ url, body }) : json(404, { error: 'not_found' });
  });
  const env: AppEnv = { apiBase: '', fetch, goExternal: vi.fn() };
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<App env={env} history={history} />);
  return { calls, history };
}

describe('SS-PLAT-93: chart of accounts', () => {
  it('is listed on Reports and shows accounts by type with roles and controls in words', async () => {
    const u = userEvent.setup();
    start('/reports', 'accountant');
    await u.click(await screen.findByRole('link', { name: 'Chart of accounts' }));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Chart of accounts',
    );
    const assets = await screen.findByRole('table', { name: 'Assets' });
    const rows = within(assets).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '1010Operating accountx—',
      '1200Trade debtorsxControl account: only its ledger posts here · AR_CONTROL',
    ]);
    expect(within(screen.getByRole('table', { name: 'Equity' })).getByText(/Not postable/));
    expect(screen.getByRole('heading', { level: 2, name: /Expenses/ }).textContent).toBe(
      'Expenses — money spent',
    );
  });

  it('a clerk without gl.account.read sees the forbidden state and no request is made', async () => {
    const { calls } = start('/accounting/chart', 'ar_clerk');
    expect(
      await screen.findByRole('heading', { level: 2, name: "You can't see the chart of accounts" }),
    ).toBeTruthy();
    expect(calls.some((c) => c.path === '/accounts')).toBe(false);
  });

  it('shows the empty state when the company has no chart yet', async () => {
    start('/accounting/chart', 'accountant', {
      'GET /accounts': () => json(200, { companies: CHART.companies, accounts: [] }),
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No chart of accounts yet' }),
    ).toBeTruthy();
  });
});

describe('SS-PLAT-94: manual journals', () => {
  it('lists journals with status words and right-set amounts; preparers get New', async () => {
    start('/accounting/journals', 'accountant');
    const table = await screen.findByRole('table', { name: 'Manual journals' });
    const row = within(table).getAllByRole('row')[1];
    expect(row?.textContent).toContain('Accrued rent');
    expect(row?.textContent).toContain('Draft');
    expect(row?.textContent).toContain('Priya Shah');
    expect(row?.querySelector('[data-amount]')?.getAttribute('data-amount')).toBe('1250.50');
    expect(screen.getByRole('link', { name: 'New manual journal' })).toBeTruthy();
  });

  it('an Auditor reads the list but cannot start a journal', async () => {
    start('/accounting/journals', 'auditor');
    await screen.findByRole('table', { name: 'Manual journals' });
    expect(screen.queryByRole('link', { name: 'New manual journal' })).toBeNull();
    expect(screen.getByText(/Only an Accountant, a Finance Admin or the Owner/)).toBeTruthy();
  });

  it('creates a draft with an Idempotency-Key and decimal-string amounts, then opens it', async () => {
    const u = userEvent.setup();
    const { calls, history } = start('/accounting/journals/new', 'accountant', {
      'POST /manual-journals': () => json(201, { ...DOC, replayed: false }),
    });
    await u.clear(await screen.findByLabelText('Date'));
    await u.type(screen.getByLabelText('Date'), '2026-10-24');
    await u.type(screen.getByLabelText('What is this journal for?'), 'Accrued rent');
    await u.selectOptions(screen.getByLabelText('Line 1 account'), 'a-rent');
    await u.type(screen.getByLabelText('Line 1 debit'), '1250.50');
    await u.selectOptions(screen.getByLabelText('Line 2 account'), 'a-bank');
    await u.type(screen.getByLabelText('Line 2 credit'), '1250.50');
    await u.click(screen.getByRole('button', { name: 'Save draft and show the journal' }));
    await waitFor(() => expect(history.location.pathname).toBe('/accounting/journals/mj-1'));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      company_id: 'c1',
      entry_date: '2026-10-24',
      memo: 'Accrued rent',
      lines: [
        { account_id: 'a-rent', debit: '1250.50' },
        { account_id: 'a-bank', credit: '1250.50' },
      ],
    });
    expect(post?.headers['idempotency-key']).toMatch(/^mj-[0-9a-f-]{36}$/);
  });

  it('shows the problems with the form before sending anything', async () => {
    const u = userEvent.setup();
    const { calls } = start('/accounting/journals/new', 'accountant');
    await u.type(await screen.findByLabelText('Line 1 debit'), '1,000');
    await u.click(screen.getByRole('button', { name: 'Save draft and show the journal' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Line 1: choose an account.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('an Approver approves a journal that needs approval, naming the preparer', async () => {
    const u = userEvent.setup();
    const submitted = {
      ...DOC,
      status: 'submitted',
      submitted_by: PRIYA,
      total: '1250.5000',
      approval_required: true,
    };
    let doc: Record<string, unknown> = submitted;
    const { calls } = start('/accounting/journals/mj-1', 'approver', {
      'GET /manual-journals/mj-1': () => json(200, doc),
      'POST /manual-journals/mj-1/approve': () => {
        doc = { ...submitted, status: 'approved', approved_by: MEI };
        return json(200, { id: 'mj-1', status: 'approved' });
      },
    });
    expect((await screen.findByRole('list', { name: 'People involved' })).textContent).toContain(
      'Prepared by Priya Shah',
    );
    expect(screen.getByText('Your turn: approve or send back')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('status')).textContent).toBe('Approved. It can be posted now.');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/manual-journals/mj-1/approve',
    ]);
  });
});

describe('SS-PLAT-95: show me the journal', () => {
  it('shows the engine preview, balanced, before submitting; Submit sends the draft', async () => {
    const u = userEvent.setup();
    const { calls } = start('/accounting/journals/mj-1', 'accountant', {
      'POST /manual-journals/mj-1/submit': () =>
        json(200, {
          id: 'mj-1',
          status: 'submitted',
          total: '1250.5000',
          approval_required: false,
          sensitive_accounts: false,
        }),
    });
    const region = await screen.findByRole('region', { name: 'Journal' });
    expect(await within(region).findByText('Balanced')).toBeTruthy();
    expect(region.textContent).toContain('6200Rent');
    expect(within(region).getAllByText('money spent').length).toBe(1);
    await u.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/submit'))).toBe(true),
    );
  });

  it('marks the refused CONTROL_ACCOUNT line, explains it and withholds Submit', async () => {
    const refused = {
      ...DOC,
      lines: [
        { account: { id: 'a-rent' }, debit: '300.0000' },
        { account: { id: 'a-ar' }, credit: '300.0000', memo: 'write off' },
      ],
    };
    start('/accounting/journals/mj-1', 'accountant', {
      'GET /manual-journals/mj-1': () => json(200, refused),
      'GET /manual-journals/mj-1/preview': () =>
        json(422, {
          error: 'posting_refused',
          code: 'CONTROL_ACCOUNT',
          line: 2,
          message: 'line 2: account 1200 is a control account',
        }),
    });
    const region = await screen.findByRole('region', { name: 'Journal' });
    const table = await within(region).findByRole('table', { name: 'Lines of this draft' });
    const rows = within(table).getAllByRole('row');
    expect(rows[2]?.textContent).toContain('Refused');
    expect(rows[1]?.textContent).not.toContain('Refused');
    expect(within(region).getByRole('alert').textContent).toBe(
      'Line 2 uses 1200 Trade debtors, a control account. Only the sales or purchases ledger posts to it, so the ledger and its total never drift apart. Choose another account, or record this as an invoice, bill, receipt or payment.',
    );
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Change the draft' })).toBeTruthy();
  });
});
