/**
 * SS-PLAT-97..99 — the Sync issues inbox screens in the app shell (T-0092), against a fake of the
 * T-0071 routes (`/sync-issues`, ADR-0040). Playwright (tests/e2e/web/sync-issues.spec.ts) proves
 * the same screens in Chromium with axe and screenshots; these tests pin the behaviour quickly.
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import type { AppEnv } from '../env.tsx';

const ME = { tenant_id: 't1', user_id: 'u-sam', display_name: 'Sam Nguyen' };
const OWNER = { roles: ['owner'], permissions: [...ALL_PERMISSIONS].sort() };
const AUDITOR = { roles: ['auditor'], permissions: [...ROLE_TEMPLATES.auditor.permissions] };
const CLERK = { roles: ['ar_clerk'], permissions: [...ROLE_TEMPLATES.ar_clerk.permissions] };

const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(0x9201);
const B = id(0x9202);

const issue = (iid: string, over: Record<string, unknown> = {}) => ({
  id: iid,
  company_id: null,
  event_id: id(0x9a00),
  handler: 'salesforce.writeback',
  connector: 'salesforce',
  status: 'open',
  attempts: 11,
  error: {
    name: 'SalesforceApiError',
    kind: 'rejected',
    code: 'ENTITY_IS_LOCKED',
    http_status: 400,
    retryable: false,
    message: 'salesforce write-back failed (rejected 400 ENTITY_IS_LOCKED): entity is locked',
  },
  payload_ref: { topic: 'invoice.posted', aggregate_type: 'invoice', aggregate_id: 'INV-001052' },
  retry_job_id: null,
  note: null,
  status_changed_by: null,
  status_changed_at: '2026-10-25T23:00:00.000Z',
  first_failed_at: '2026-10-25T09:00:00.000Z',
  last_failed_at: '2026-10-25T23:00:00.000Z',
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (req: { method: string; url: URL; body: unknown }) => Response | Promise<Response>;

function start(path: string, access: unknown, routes: Record<string, Handler> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const all: Record<string, Handler> = {
    'GET /auth/me': () => json(200, ME),
    'GET /auth/me/access': () => json(200, access),
    'GET /users': () => json(200, []),
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

describe('SS-PLAT-97: the inbox list', () => {
  it('lists open issues in plain words, from Settings, and pages forward and back', async () => {
    const u = userEvent.setup();
    const { calls, history } = start('/settings', OWNER, {
      'GET /sync-issues': ({ url }) =>
        url.searchParams.get('after')
          ? json(200, { issues: [issue(B, { attempts: 1 })], next_after: null })
          : json(200, { issues: [issue(A)], next_after: A }),
    });
    await u.click(await screen.findByRole('link', { name: 'Salesforce sync issues' }));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Salesforce sync issues',
    );
    const table = await screen.findByRole('table', { name: 'Sync issues' });
    const row = within(table).getAllByRole('row')[1];
    expect(row?.textContent).toContain('Invoice INV-001052');
    expect(row?.textContent).toContain('Salesforce refused the change');
    expect(row?.textContent).toContain('11');
    expect(row?.textContent).toContain('Needs a person');
    expect(
      screen
        .getByRole('navigation', { name: 'Filter by status' })
        .querySelector('[aria-current="page"]')?.textContent,
    ).toBe('Needs a person');
    expect(calls.filter((c) => c.path.startsWith('/sync-issues')).map((c) => c.path)).toEqual([
      '/sync-issues?status=open&limit=20',
    ]);
    await u.click(screen.getByRole('link', { name: 'Next page' }));
    await waitFor(() => {
      expect(history.location.search).toBe(`?status=open&after=${A}`);
    });
    await screen.findByText('Invoice INV-001052', { exact: false });
    expect(calls.at(-1)?.path).toBe(`/sync-issues?status=open&limit=20&after=${A}`);
    expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
    await u.click(screen.getByRole('link', { name: 'First page' }));
    await waitFor(() => {
      expect(history.location.search).toBe('?status=open');
    });
  });

  it('the status filter changes the address and the query; an empty filter says so', async () => {
    const u = userEvent.setup();
    const { calls, history } = start('/settings/sync-issues', AUDITOR, {
      'GET /sync-issues': ({ url }) =>
        url.searchParams.get('status') === 'ignored'
          ? json(200, { issues: [], next_after: null })
          : json(200, { issues: [issue(A)], next_after: null }),
    });
    await screen.findByRole('table', { name: 'Sync issues' });
    await u.click(screen.getByRole('link', { name: 'Ignored' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No ignored issues' }),
    ).toBeTruthy();
    expect(history.location.search).toBe('?status=ignored');
    await u.click(screen.getByRole('link', { name: 'All' }));
    await screen.findByRole('table', { name: 'Sync issues' });
    expect(calls.at(-1)?.path).toBe('/sync-issues?limit=20');
  });

  it('shows an error with Try again that recovers', async () => {
    const u = userEvent.setup();
    let fail = true;
    start('/settings/sync-issues', OWNER, {
      'GET /sync-issues': () =>
        fail ? json(503, { error: 'down' }) : json(200, { issues: [], next_after: null }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not load the sync issues');
    fail = false;
    await u.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Nothing needs a person' }),
    ).toBeTruthy();
  });

  it('a clerk without sync.issues.read sees a forbidden state and nothing is fetched', async () => {
    const { calls } = start('/settings/sync-issues', CLERK);
    expect(
      await screen.findByRole('heading', { level: 2, name: "You can't see the sync issues" }),
    ).toBeTruthy();
    expect(screen.getByText(/Owner, a Finance Admin, an Accountant or an Auditor/)).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/sync-issues'))).toBe(false);
  });
});

describe('SS-PLAT-98: one issue', () => {
  it('shows the error in plain words, the payload reference, attempts and the payload', async () => {
    start(`/settings/sync-issues/${A}`, OWNER, {
      [`GET /sync-issues/${A}`]: () =>
        json(200, {
          ...issue(A),
          payload: { invoice: { number: 'INV-001052', total: '1375.00' } },
        }),
    });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Invoice INV-001052 was not sent to Salesforce',
      }),
    ).toBeTruthy();
    const what = screen.getByRole('region', { name: 'What went wrong' });
    expect(what.textContent).toContain('Salesforce refused the change');
    expect(what.textContent).toContain('The record is locked in Salesforce');
    expect(what.textContent).toContain('ENTITY_IS_LOCKED');
    expect(what.textContent).toContain('400');
    expect(what.textContent).toContain('Retrying alone will not help');
    expect(screen.getByText(/Your books are not affected/)).toBeTruthy();
    const sent = screen.getByRole('region', { name: 'What it was sending' });
    expect(sent.textContent).toContain('invoice.posted');
    expect(sent.textContent).toContain('INV-001052');
    expect(sent.textContent).toContain(id(0x9a00));
    expect(sent.textContent).toContain('"total": "1375.00"');
    const tries = screen.getByRole('region', { name: 'Attempts' });
    expect(tries.textContent).toContain('Tried 11 times');
  });

  it('an unknown issue shows not found', async () => {
    start(`/settings/sync-issues/${B}`, OWNER);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sync issue not found' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All sync issues' })).toBeTruthy();
  });
});

describe('SS-PLAT-99: retry and ignore', () => {
  it('Retry asks first; Cancel sends nothing; Yes sends the retry and shows the new status', async () => {
    const u = userEvent.setup();
    let current = issue(A);
    const { calls } = start(`/settings/sync-issues/${A}`, OWNER, {
      [`GET /sync-issues/${A}`]: () => json(200, { ...current, payload: {} }),
      [`POST /sync-issues/${A}/retry`]: () => {
        current = issue(A, {
          status: 'retried',
          retry_job_id: 'job-1',
          status_changed_by: 'u-sam',
        });
        return json(200, current);
      },
    });
    await u.click(await screen.findByRole('button', { name: 'Retry' }));
    const confirm = screen.getByRole('group', { name: 'Confirm retry' });
    await u.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    await u.click(screen.getByRole('button', { name: 'Yes, send it again' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Retry sent. LedgerForce is sending it to Salesforce again now.',
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/sync-issues/${A}/retry`, body: undefined },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(screen.getByText(/A retry is already on its way/)).toBeTruthy();
  });

  it('Ignore takes an optional note after confirmation', async () => {
    const u = userEvent.setup();
    const { calls } = start(`/settings/sync-issues/${A}`, OWNER, {
      [`GET /sync-issues/${A}`]: () => json(200, { ...issue(A), payload: {} }),
      [`POST /sync-issues/${A}/ignore`]: ({ body }) =>
        json(200, issue(A, { status: 'ignored', note: (body as { note?: string }).note ?? null })),
    });
    await u.click(await screen.findByRole('button', { name: 'Ignore' }));
    await u.type(screen.getByLabelText('Why ignore it? (optional, kept in the audit log)'), 'Dup');
    await u.click(screen.getByRole('button', { name: 'Yes, ignore it' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Ignored. It stays here, and you can still retry it.',
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/sync-issues/${A}/ignore`, body: { note: 'Dup' } },
    ]);
  });

  it('an Auditor sees both actions disabled, each with a reason naming who can act', async () => {
    start(`/settings/sync-issues/${A}`, AUDITOR, {
      [`GET /sync-issues/${A}`]: () => json(200, { ...issue(A), payload: {} }),
    });
    for (const name of ['Retry', 'Ignore']) {
      const b = await screen.findByRole('button', { name });
      expect(b.hasAttribute('disabled')).toBe(true);
      const why = document.getElementById(b.getAttribute('aria-describedby') ?? '');
      expect(why?.textContent).toContain('Only the Owner, a Finance Admin or an Accountant');
    }
  });

  it('a 409 from a change elsewhere is said in plain words and the issue reloads', async () => {
    const u = userEvent.setup();
    let gets = 0;
    const { calls } = start(`/settings/sync-issues/${A}`, OWNER, {
      [`GET /sync-issues/${A}`]: () => {
        gets += 1;
        return json(200, { ...issue(A, gets > 1 ? { status: 'resolved' } : {}), payload: {} });
      },
      [`POST /sync-issues/${A}/ignore`]: () => json(409, { error: 'sync_issue_not_ignorable' }),
    });
    await u.click(await screen.findByRole('button', { name: 'Ignore' }));
    await u.click(screen.getByRole('button', { name: 'Yes, ignore it' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This issue changed');
    await waitFor(() => {
      expect(screen.getAllByText(/This was fixed/).length).toBeGreaterThan(0);
    });
    expect(calls.filter((c) => c.path === `/sync-issues/${A}`).length).toBe(2);
  });

  it('a step-up challenge leaves for /auth/step-up and comes back here', async () => {
    const u = userEvent.setup();
    const { goExternal } = start(`/settings/sync-issues/${A}`, OWNER, {
      [`GET /sync-issues/${A}`]: () => json(200, { ...issue(A), payload: {} }),
      [`POST /sync-issues/${A}/retry`]: () =>
        json(401, { error: 'step_up_required', max_age: 300 }),
    });
    await u.click(await screen.findByRole('button', { name: 'Retry' }));
    await u.click(screen.getByRole('button', { name: 'Yes, send it again' }));
    await waitFor(() => {
      expect(goExternal).toHaveBeenCalledWith(
        `/auth/step-up?max_age=300&return_to=${encodeURIComponent(`/settings/sync-issues/${A}`)}`,
      );
    });
  });
});
