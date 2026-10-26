/**
 * SS-PLAT-78..80 — the admin screens in the app shell (T-0093), against a fake of the API routes
 * of T-0012, T-0015, T-0016 and ADR-0034. Playwright (tests/e2e/web/admin.spec.ts) proves the same
 * screens in Chromium with axe and screenshots; these tests pin the behaviour quickly.
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import type { AppEnv } from '../env.tsx';

const SAM = 'u-sam';
const LENA = 'u-lena';
const MEI = 'u-mei';
const ME = { tenant_id: 't1', user_id: SAM, display_name: 'Sam Nguyen' };
const OWNER = { roles: ['owner'], permissions: [...ALL_PERMISSIONS].sort() };
const AUDITOR = { roles: ['auditor'], permissions: [...ROLE_TEMPLATES.auditor.permissions] };
const CLERK = { roles: ['ar_clerk'], permissions: [...ROLE_TEMPLATES.ar_clerk.permissions] };

const user = (id: string, name: string, roles: string[], status = 'active') => ({
  id,
  email: `${name.split(' ')[0]?.toLowerCase() ?? 'x'}@harbour.test`,
  display_name: name,
  status,
  created_at: '2026-10-01T00:00:00.000Z',
  disabled_at: null,
  successor_user_id: null,
  roles,
});
const USERS = [
  user(LENA, 'Lena Ortiz', ['ap_clerk']),
  user(MEI, 'Mei Tan', ['approver', 'finance_admin']),
  user(SAM, 'Sam Nguyen', ['owner']),
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (req: { method: string; url: URL; body: unknown }) => Response | Promise<Response>;

function start(path: string, access: unknown, routes: Record<string, Handler> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const all: Record<string, Handler> = {
    'GET /auth/me': () => json(200, ME),
    'GET /auth/me/access': () => json(200, access),
    'GET /users': () => json(200, USERS),
    ...routes,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://app.test');
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const h = all[`${method} ${url.pathname}`];
    return h ? h({ method, url, body }) : json(404, { error: 'not_found' });
  });
  const goExternal = vi.fn<(url: string) => void>();
  const env: AppEnv = { apiBase: '', fetch, goExternal };
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<App env={env} history={history} />);
  return { calls, goExternal, history };
}

describe('SS-PLAT-78: people and roles', () => {
  it('lists people with roles and status, and the Owner can invite someone', async () => {
    const u = userEvent.setup();
    const { calls } = start('/settings/users', OWNER, {
      'POST /users': ({ body }) =>
        json(201, { id: 'u-new', status: 'invited', ...(body as object) }),
    });
    const table = await screen.findByRole('table', { name: 'People' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Lena Ortizlena@harbour.testAP ClerkActive',
      'Mei Tanmei@harbour.testApprover, Finance AdminActive',
      'Sam Nguyensam@harbour.testOwnerActive',
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('People and roles');
    await u.type(screen.getByLabelText('Full name'), 'Priya Shah');
    await u.type(screen.getByLabelText('Email address'), 'priya@harbour.test');
    await u.type(
      screen.getByLabelText('Identity provider (issuer URL)'),
      'https://id.harbour.test',
    );
    await u.type(screen.getByLabelText('Their id at the identity provider'), 'priya');
    await u.click(screen.getByRole('checkbox', { name: 'Accountant' }));
    await u.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect((await screen.findByRole('status')).textContent).toContain('Invited Priya Shah');
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/users',
      body: {
        email: 'priya@harbour.test',
        display_name: 'Priya Shah',
        idp_issuer: 'https://id.harbour.test',
        idp_subject: 'priya',
        roles: ['accountant'],
      },
    });
  });

  it('an Auditor sees the list but no invite form, and is told who can invite', async () => {
    start('/settings/users', AUDITOR);
    await screen.findByRole('table', { name: 'People' });
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
    expect(screen.getByText('Only the Owner can invite people or disable them.')).toBeTruthy();
  });

  it('a clerk without users.read sees a forbidden state that names who can', async () => {
    const { calls } = start('/settings/users', CLERK);
    expect(
      await screen.findByRole('heading', { level: 2, name: "You can't see the people list" }),
    ).toBeTruthy();
    expect(screen.getByText(/Owner, a Finance Admin or an Auditor/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/users')).toBe(false);
  });

  it('shows loading, then an error with Try again that recovers', async () => {
    const u = userEvent.setup();
    let fail = true;
    start('/settings/users', OWNER, {
      'GET /users': () => (fail ? json(503, { error: 'down' }) : json(200, USERS)),
    });
    expect(await screen.findByText(/Loading people/)).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not load the people list');
    fail = false;
    await u.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'People' })).toBeTruthy();
  });

  it('a self-grant is refused by the API and its message is shown', async () => {
    const u = userEvent.setup();
    start(`/settings/users/${SAM}`, OWNER, {
      [`GET /users/${SAM}`]: () => json(200, { ...user(SAM, 'Sam Nguyen', ['owner']) }),
      [`POST /users/${SAM}/roles`]: () => json(403, { error: 'self_grant' }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Sam Nguyen' });
    expect(screen.getByText(/You can't change your own roles/)).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Role to give'), 'approver');
    await u.click(screen.getByRole('button', { name: 'Give role' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You can't give yourself a role. Another Owner or Finance Admin has to do it, so nobody widens their own access.",
    );
  });

  it('offboarding names a successor and reports what was revoked', async () => {
    const u = userEvent.setup();
    const { calls } = start(`/settings/users/${LENA}`, OWNER, {
      [`GET /users/${LENA}`]: () => json(200, user(LENA, 'Lena Ortiz', ['ap_clerk'])),
      [`POST /users/${LENA}/offboard`]: () =>
        json(200, {
          user_id: LENA,
          status: 'disabled',
          changed: true,
          sessions_revoked: 2,
          tokens_revoked: 1,
          roles_revoked: 1,
          successor_user_id: MEI,
          approvals_assignee: MEI,
        }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Lena Ortiz' });
    await u.type(screen.getByLabelText('Why are they leaving?'), 'Left the company');
    await u.selectOptions(screen.getByLabelText('Who takes over their approvals'), MEI);
    await u.click(screen.getByRole('button', { name: 'Disable Lena Ortiz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, disable Lena Ortiz now' }));
    const done = await screen.findByText(/Lena Ortiz is disabled/);
    expect(done.textContent).toBe(
      'Lena Ortiz is disabled. Revoked 2 sessions, 1 API token and 1 role. Approvals now go to Mei Tan.',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      reason: 'Left the company',
      successor_user_id: MEI,
    });
  });

  it('a step-up challenge sends the browser to /auth/step-up and back here', async () => {
    const u = userEvent.setup();
    const { goExternal } = start(`/settings/users/${LENA}`, OWNER, {
      [`GET /users/${LENA}`]: () => json(200, user(LENA, 'Lena Ortiz', ['ap_clerk'])),
      [`POST /users/${LENA}/offboard`]: () =>
        json(401, { error: 'step_up_required', max_age: 300 }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Lena Ortiz' });
    await u.type(screen.getByLabelText('Why are they leaving?'), 'Left');
    await u.click(screen.getByRole('button', { name: 'Disable Lena Ortiz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, disable Lena Ortiz now' }));
    await waitFor(() => {
      expect(goExternal).toHaveBeenCalledWith(
        `/auth/step-up?max_age=300&return_to=%2Fsettings%2Fusers%2F${LENA}`,
      );
    });
  });
});

const WEEK = {
  week_start: '2026-10-19',
  timezone: 'Australia/Sydney',
  acknowledged_at: null,
  exceptions: [
    {
      id: 'x1',
      rule: 'SOD_BILL_SELF_APPROVAL',
      subject_type: 'bill',
      subject_id: 'BILL-000045',
      step: 'bill.approve',
      actor_user_id: SAM,
      kind: 'recorded_exception',
      reviewer_user_id: null,
      reason: 'Only one person this week',
      occurred_at: '2026-10-21T01:00:00.000Z',
      acknowledged: false,
    },
  ],
};

describe('SS-PLAT-79: weekly control exceptions', () => {
  it('the Owner sees the week and acknowledges it', async () => {
    const u = userEvent.setup();
    let acked = false;
    const { calls } = start('/reports/control-exceptions?week=2026-10-19', OWNER, {
      'GET /sod/exceptions/weekly': () =>
        json(
          200,
          acked
            ? {
                ...WEEK,
                acknowledged_at: '2026-10-25T00:00:00.000Z',
                exceptions: WEEK.exceptions.map((e) => ({ ...e, acknowledged: true })),
              }
            : WEEK,
        ),
      'POST /sod/exceptions/weekly/acknowledge': () => {
        acked = true;
        return json(201, { week_start: '2026-10-19', exceptions: 1 });
      },
    });
    const table = await screen.findByRole('table', { name: 'Exceptions' });
    expect(within(table).getAllByRole('row')[1]?.textContent).toContain(
      'Approved a bill they had entered, above the bill limit',
    );
    expect(screen.getByText('Your turn: acknowledge this week')).toBeTruthy();
    await u.type(screen.getByLabelText('Note for the record (optional)'), 'Reviewed with Mei');
    await u.click(screen.getByRole('button', { name: 'Acknowledge this week' }));
    expect(await screen.findByText(/Acknowledged on/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      week_start: '2026-10-19',
      note: 'Reviewed with Mei',
    });
    expect(calls[calls.length - 1]?.path).toBe('/sod/exceptions/weekly?week_start=2026-10-19');
  });

  it('an Auditor sees that the Owner must acknowledge, with no button', async () => {
    start('/reports/control-exceptions?week=2026-10-19', AUDITOR, {
      'GET /sod/exceptions/weekly': () => json(200, WEEK),
    });
    await screen.findByRole('table', { name: 'Exceptions' });
    expect(screen.getByText('Waiting for the Owner to acknowledge this week')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Acknowledge this week' })).toBeNull();
  });

  it('an empty week says so; the week links move by seven days', async () => {
    const u = userEvent.setup();
    const { history } = start('/reports/control-exceptions?week=2026-10-19', OWNER, {
      'GET /sod/exceptions/weekly': ({ url }) =>
        json(200, { ...WEEK, week_start: url.searchParams.get('week_start'), exceptions: [] }),
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No exceptions this week' }),
    ).toBeTruthy();
    await u.click(screen.getByRole('link', { name: 'Previous week' }));
    await waitFor(() => {
      expect(history.location.search).toContain('week=2026-10-12');
    });
  });
});

describe('SS-PLAT-80: audit log viewer', () => {
  const entry = (id: string, action: string) => ({
    id,
    occurred_at: '2026-10-23T23:30:00.000Z',
    actor_type: 'user',
    actor_user_id: MEI,
    action,
    entity_type: 'user_role',
    entity_id: 'r-1',
    before: null,
    after: { role: 'approver' },
    ip: '203.0.113.9',
    user_agent: 'Firefox',
    request_id: 'req-1',
    api_token_id: null,
  });

  it('shows entries with names, filters through the URL and pages to older entries', async () => {
    const u = userEvent.setup();
    const { calls, history } = start('/reports/audit-log', AUDITOR, {
      'GET /audit-log': ({ url }) =>
        url.searchParams.get('before') === '7'
          ? json(200, { entries: [entry('6', 'user.joined')], next_before: null })
          : json(200, { entries: [entry('7', 'POST /users/:userId/roles')], next_before: '7' }),
    });
    const table = await screen.findByRole('table', { name: 'Audit entries' });
    expect(within(table).getAllByRole('row')[1]?.textContent).toContain('Mei Tan');
    expect(screen.queryByRole('button', { name: /edit|delete|remove/i })).toBeNull();
    await u.selectOptions(screen.getByLabelText('Person'), MEI);
    await u.type(screen.getByLabelText('Action contains'), 'roles');
    await u.type(screen.getByLabelText('From'), '2026-10-20');
    await u.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      expect(calls.at(-1)?.path).toBe(`/audit-log?actor=${MEI}&action=roles&from=2026-10-20`);
    });
    await u.click(screen.getByRole('button', { name: 'Older entries' }));
    expect(await screen.findByText('user.joined')).toBeTruthy();
    expect(history.location.search).toContain('before=7');
    expect(screen.queryByRole('button', { name: 'Older entries' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to newest' })).toBeTruthy();
  });

  it('a caller without audit_log.read gets the forbidden state and no request', async () => {
    const { calls } = start('/reports/audit-log', CLERK);
    expect(
      await screen.findByRole('heading', { level: 2, name: "You can't see the audit log" }),
    ).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/audit-log'))).toBe(false);
  });

  it('no matching entries shows the empty state', async () => {
    start('/reports/audit-log?action=nothing', OWNER, {
      'GET /audit-log': () => json(200, { entries: [], next_before: null }),
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'No entries match' })).toBeTruthy();
  });
});
