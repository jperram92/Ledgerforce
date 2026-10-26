/**
 * T-0092 — the Salesforce sync issues inbox of apps/web, end to end in Chromium.
 *
 *  - SS-PLAT-97: the inbox list — status filter in the address, keyset pages, plain-word errors,
 *    loading / empty / error / forbidden states.
 *  - SS-PLAT-98: one issue — error in plain words with the raw error, payload reference and the
 *    payload on demand, attempts, not found.
 *  - SS-PLAT-99: Retry and Ignore — confirmation first, offered by status, disabled with a
 *    reason for an Auditor, refusals in plain words, step-up routing.
 *
 * Every screen at 1440 and 390 with axe WCAG 2.2 AA (0 violations), the genericness probes, no
 * horizontal scroll and no console errors. The app is served in-process by Vite (as
 * admin.spec.ts) and the API is faked per test with `page.route`; the contract faked is the one
 * T-0071's db tests prove (apps/api/src/sync/sync-issues.db.test.ts, RQ-0047 S1–S2). Times are
 * shown in Australia/Sydney. Screenshots go to .agent/evidence/T-0092/.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';
import { genericnessProbe } from '../fixtures/genericness.ts';

const WEB = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web');
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const SAM = id(0x9301);
const MEI = id(0x9302);
const PRIYA = id(0x9304);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0092', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

type Who = 'owner' | 'accountant' | 'auditor' | 'clerk';
const ME: Record<Who, { user_id: string; display_name: string; roles: string[] }> = {
  owner: { user_id: SAM, display_name: 'Sam Nguyen', roles: ['owner'] },
  accountant: { user_id: PRIYA, display_name: 'Priya Shah', roles: ['accountant'] },
  auditor: { user_id: id(0x9306), display_name: 'Ada Brooks', roles: ['auditor'] },
  clerk: { user_id: id(0x9303), display_name: 'Lena Ortiz', roles: ['ap_clerk'] },
};
const permissionsOf = (roles: string[]) =>
  [
    ...new Set(roles.flatMap((r) => ROLE_TEMPLATES[r as keyof typeof ROLE_TEMPLATES].permissions)),
  ].sort();

type Status = 'open' | 'retried' | 'resolved' | 'ignored';
interface Issue {
  id: string;
  company_id: string | null;
  event_id: string;
  handler: string;
  connector: string;
  status: Status;
  attempts: number;
  error: {
    name: string;
    kind: string | null;
    code: string | null;
    http_status: number | null;
    retryable: boolean;
    message: string;
  };
  payload_ref: { topic: string; aggregate_type: string; aggregate_id: string };
  retry_job_id: string | null;
  note: string | null;
  status_changed_by: string | null;
  status_changed_at: string;
  first_failed_at: string;
  last_failed_at: string;
  payload: Record<string, unknown>;
}

const LOCKED = id(0x9201);
const ROW_LOCK = id(0x9202);
const LIMIT = id(0x9203);
const IGNORED = id(0x9204);
const RETRIED = id(0x9205);
const FIXED = id(0x9206);

function issue(
  iid: string,
  n: number,
  status: Status,
  type: string,
  ref: string,
  error: Issue['error'],
  attempts: number,
  over: Partial<Issue> = {},
): Issue {
  const last = new Date(Date.UTC(2026, 9, 25, 23, 0) - n * 3_600_000).toISOString();
  return {
    id: iid,
    company_id: null,
    event_id: id(0x9a00 + n),
    handler: 'salesforce.writeback',
    connector: 'salesforce',
    status,
    attempts,
    error,
    payload_ref: { topic: `${type}.posted`, aggregate_type: type, aggregate_id: ref },
    retry_job_id: status === 'retried' ? 'job-77' : null,
    note: null,
    status_changed_by: null,
    status_changed_at: last,
    first_failed_at: new Date(Date.parse(last) - 14 * 3_600_000).toISOString(),
    last_failed_at: last,
    payload: {
      writeBack: { version: 1, [type]: { number: ref, total: '1375.00', status: 'posted' } },
    },
    ...over,
  };
}

const sfError = (
  kind: string,
  status: number | null,
  code: string | null,
  detail: string,
  retryable: boolean,
) => ({
  name: 'SalesforceApiError',
  kind,
  code,
  http_status: status,
  retryable,
  message: `salesforce write-back failed (${kind}${status === null ? '' : ` ${String(status)}`}${code ? ` ${code}` : ''}): ${detail}`,
});

function seed(): Issue[] {
  const rows: Issue[] = [
    issue(
      LOCKED,
      0,
      'open',
      'invoice',
      'INV-001052',
      sfError(
        'rejected',
        400,
        'ENTITY_IS_LOCKED',
        'entity is locked, cannot edit Opportunity 006Hs00001Lm',
        false,
      ),
      1,
    ),
    issue(
      ROW_LOCK,
      1,
      'open',
      'payment',
      'RCPT-000318',
      {
        name: 'WriteBackRecordError',
        kind: null,
        code: null,
        http_status: null,
        retryable: true,
        message:
          'salesforce refused 1 record(s); first: LF_Payment__c RCPT-000318 UNABLE_TO_LOCK_ROW',
      },
      11,
    ),
    issue(
      LIMIT,
      2,
      'open',
      'account',
      'Kestrel Logistics',
      sfError(
        'request_limit',
        403,
        'REQUEST_LIMIT_EXCEEDED',
        'TotalRequests Limit exceeded.',
        true,
      ),
      11,
    ),
    issue(
      IGNORED,
      3,
      'ignored',
      'credit_note',
      'CN-000044',
      sfError('rejected', 400, 'INVALID_FIELD', 'No such column LF_Reason__c', false),
      1,
      { status_changed_by: MEI, note: 'Field added in the next package release' },
    ),
    issue(
      RETRIED,
      4,
      'retried',
      'invoice',
      'INV-001049',
      sfError('unavailable', 503, null, 'Service Unavailable', true),
      11,
      { status_changed_by: SAM },
    ),
    issue(
      FIXED,
      5,
      'resolved',
      'invoice',
      'INV-001040',
      sfError('session_expired', 401, 'INVALID_SESSION_ID', 'Session expired or invalid', true),
      11,
      { status_changed_by: SAM },
    ),
  ];
  // Older fixed issues, so "All" has a second page.
  for (let n = 0; n < 18; n++) {
    rows.push(
      issue(
        id(0x9300 + 0x20 + n),
        6 + n,
        'resolved',
        'invoice',
        `INV-0010${String(30 - n).padStart(2, '0')}`,
        sfError('unavailable', 503, null, 'Service Unavailable', true),
        11,
        { status_changed_by: MEI },
      ),
    );
  }
  return rows;
}

interface Fake {
  who: Who;
  issues: Issue[];
  posts: { path: string; body: unknown }[];
  gets: string[];
  errors: string[];
  override: Map<string, { status: number; body: unknown } | 'hold'>;
}

const view = (i: Issue) => {
  const rest: Partial<Issue> = { ...i };
  delete rest.payload;
  return rest;
};

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = { who, issues: seed(), posts: [], gets: [], errors: [], override: new Map() };
  page.on('console', (m) => {
    // The fake answers 4xx/5xx on purpose in some tests; Chromium logs those as failed resources.
    if (m.type() === 'error' && !/status of (401|403|404|409|503)/.test(m.text())) {
      f.errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });

  await page.route(
    (url) => url.origin === origin && /^\/(auth|users|sync-issues)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      if (path === '/auth/step-up') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><title>Identity provider</title><h1>Confirm it is you (test stand-in)</h1></html>',
        });
      }
      const o = f.override.get(`${method} ${path}`);
      if (o === 'hold') return; // never answered: the loading state stays
      if (o) return send(route, o.status, o.body);
      const me = ME[f.who];
      if (path === '/auth/me')
        return send(route, 200, {
          tenant_id: 't-harbour',
          user_id: me.user_id,
          display_name: me.display_name,
        });
      if (path === '/auth/me/access')
        return send(route, 200, {
          roles: me.roles,
          permissions: f.who === 'owner' ? [...ALL_PERMISSIONS].sort() : permissionsOf(me.roles),
        });
      if (path === '/users') {
        return send(route, 200, [
          { id: SAM, display_name: 'Sam Nguyen', email: 'sam@harbour.example', status: 'active' },
          { id: MEI, display_name: 'Mei Tan', email: 'mei@harbour.example', status: 'active' },
        ]);
      }
      const may = (p: string) => f.who === 'owner' || permissionsOf(ME[f.who].roles).includes(p);
      if (path === '/sync-issues' && method === 'GET') {
        f.gets.push(url.search);
        if (!may('sync.issues.read'))
          return send(route, 403, { error: 'forbidden', permission: 'sync.issues.read' });
        const q = url.searchParams;
        const status = q.get('status');
        const limit = Number(q.get('limit') ?? '50');
        let rows = f.issues.filter((i) => !status || i.status === status);
        const after = q.get('after');
        if (after) rows = rows.slice(rows.findIndex((i) => i.id === after) + 1);
        const page1 = rows.slice(0, limit);
        return send(route, 200, {
          issues: page1.map(view),
          next_after: rows.length > limit ? (page1.at(-1)?.id ?? null) : null,
        });
      }
      const m = /^\/sync-issues\/([^/]+)(\/retry|\/ignore)?$/.exec(path);
      if (m) {
        const target = f.issues.find((i) => i.id === m[1]);
        if (!target) return send(route, 404, { error: 'not_found' });
        if (!m[2] && method === 'GET') {
          if (!may('sync.issues.read'))
            return send(route, 403, { error: 'forbidden', permission: 'sync.issues.read' });
          return send(route, 200, target);
        }
        if (method !== 'POST') return send(route, 404, { error: 'not_found' });
        const body: unknown = req.postData() ? req.postDataJSON() : undefined;
        f.posts.push({ path, body });
        if (!may('sync.issues.manage'))
          return send(route, 403, { error: 'forbidden', permission: 'sync.issues.manage' });
        const now = '2026-10-26T00:15:00.000Z';
        if (m[2] === '/retry') {
          if (target.status === 'resolved')
            return send(route, 409, { error: 'sync_issue_not_retryable' });
          if (target.status !== 'retried')
            Object.assign(target, {
              status: 'retried',
              retry_job_id: 'job-new',
              status_changed_by: ME[f.who].user_id,
              status_changed_at: now,
            });
          return send(route, 200, view(target));
        }
        if (target.status === 'ignored') return send(route, 200, view(target));
        if (target.status !== 'open')
          return send(route, 409, { error: 'sync_issue_not_ignorable' });
        Object.assign(target, {
          status: 'ignored',
          note: (body as { note?: string } | undefined)?.note ?? null,
          status_changed_by: ME[f.who].user_id,
          status_changed_at: now,
        });
        return send(route, 200, view(target));
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

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
  // P2: every status word has text.
  for (const t of await page.locator('main .word[data-status]').allTextContents()) {
    expect(t.trim()).not.toBe('');
  }
}

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { style: 'none', width: 0 };
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  });
}

test.describe('SS-PLAT-97 sync issues inbox', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-97: an Accountant opens the inbox from Settings @ ${String(width)} [T-0092]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'accountant');
      await open(page, '/settings', width);
      await page.getByRole('link', { name: 'Salesforce sync issues' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Salesforce sync issues');
      await expect(
        page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }),
      ).toHaveAttribute('aria-current', 'page');
      const table = page.getByRole('table', { name: 'Sync issues' });
      await expect(table.getByRole('row')).toHaveCount(4);
      await expect(table.getByRole('row').nth(1)).toContainText('Invoice INV-001052');
      await expect(table.getByRole('row').nth(1)).toContainText('Salesforce refused the change');
      await expect(table.getByRole('row').nth(1)).toContainText('Needs a person');
      await expect(table.getByRole('row').nth(2)).toContainText(
        'Salesforce refused one or more records',
      );
      await expect(table.getByRole('row').nth(3)).toContainText(
        'Your Salesforce org reached its API limit',
      );
      await expect(
        page.getByRole('navigation', { name: 'Filter by status' }).getByRole('link', {
          name: 'Needs a person',
        }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(page.getByText('Your books are not affected')).toBeVisible();
      expect(f.gets).toEqual(['?status=open&limit=20']);
      await assertPage(page, width);
      await evidence('SS-PLAT-97', `inbox-open-accountant-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-97: filter by status and page through all issues [T-0092]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, '/settings/sync-issues', 1440);
    const filter = page.getByRole('navigation', { name: 'Filter by status' });
    await filter.getByRole('link', { name: 'Ignored' }).click();
    await expect(page).toHaveURL(/\?status=ignored$/);
    const table = page.getByRole('table', { name: 'Sync issues' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('Credit note CN-000044');
    await expect(table).toContainText('Ignored');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-97', 'inbox-ignored-filter-1440');
    await filter.getByRole('link', { name: 'All' }).click();
    await expect(table.getByRole('row')).toHaveCount(21);
    await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\?status=all&after=/);
    await expect(table.getByRole('row')).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await expect(filter.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-97', 'inbox-all-second-page-1440');
    await page.getByRole('link', { name: 'First page' }).click();
    await expect(page).toHaveURL(/\?status=all$/);
    await expect(table.getByRole('row')).toHaveCount(21);
    expect(f.gets.slice(-3)).toEqual([
      '?limit=20',
      expect.stringMatching(/^\?limit=20&after=01900000-/) as unknown as string,
      '?limit=20',
    ]);
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-97: loading, empty, error with Try again, and forbidden [T-0092]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    f.override.set('GET /sync-issues', 'hold');
    await open(page, '/settings/sync-issues', 1440);
    await expect(page.getByText('Loading sync issues…')).toBeVisible();
    await evidence('SS-PLAT-97', 'inbox-loading-1440');
    f.override.delete('GET /sync-issues');
    f.issues = f.issues.filter((i) => i.status !== 'open');
    await open(page, '/settings/sync-issues', 390);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Nothing needs a person' }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-97', 'inbox-empty-390');
    f.override.set('GET /sync-issues', { status: 503, body: { error: 'down' } });
    await open(page, '/settings/sync-issues', 390, 'dark');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('We could not load the sync issues');
    await assertPage(page, 390);
    await evidence('SS-PLAT-97', 'inbox-error-390-dark');
    f.override.delete('GET /sync-issues');
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Nothing needs a person' }),
    ).toBeVisible();
    f.who = 'clerk';
    for (const width of [1440, 390]) {
      await open(page, '/settings/sync-issues', width);
      await expect(
        page.getByRole('heading', { level: 2, name: "You can't see the sync issues" }),
      ).toBeVisible();
      await expect(
        page.getByText(/Only the Owner, a Finance Admin, an Accountant or an Auditor/),
      ).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-97', `inbox-forbidden-${String(width)}`);
    }
    expect(f.errors).toEqual([]);
  });
});

test.describe('SS-PLAT-98 one sync issue', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-98: error in plain words, payload reference and attempts @ ${String(width)} [T-0092]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, '/settings/sync-issues', width);
      await page.getByRole('link', { name: 'Invoice INV-001052' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Invoice INV-001052 was not sent to Salesforce',
      );
      const what = page.getByRole('region', { name: 'What went wrong' });
      await expect(what).toContainText('Salesforce refused the change');
      await expect(what).toContainText(
        'The record is locked in Salesforce, usually by an approval process. Unlock it there, then retry.',
      );
      await expect(what).toContainText('Retrying alone will not help');
      await expect(what).toContainText('ENTITY_IS_LOCKED');
      await expect(what).toContainText('HTTP 400');
      const sent = page.getByRole('region', { name: 'What it was sending' });
      await expect(sent).toContainText('invoice.posted');
      await expect(sent).toContainText('salesforce.writeback');
      await sent.getByText('Show the data it was sending').click();
      await expect(sent).toContainText('"total": "1375.00"');
      await expect(page.getByRole('region', { name: 'Attempts' })).toContainText(
        'Tried 1 time before it came here.',
      );
      await assertPage(page, width);
      await evidence('SS-PLAT-98', `issue-detail-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-98: a refused record names the Salesforce code; an unknown id is not found [T-0092]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'auditor');
    await open(page, `/settings/sync-issues/${ROW_LOCK}`, 1440, 'dark');
    const what = page.getByRole('region', { name: 'What went wrong' });
    await expect(what).toContainText('Salesforce refused one or more records');
    await expect(what).toContainText('Someone else was changing the same record');
    await expect(what).toContainText('UNABLE_TO_LOCK_ROW');
    await expect(what).toContainText('Retrying can help');
    await expect(page.getByRole('region', { name: 'Attempts' })).toContainText('Tried 11 times');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-98', 'issue-record-refused-1440-dark');
    await open(page, `/settings/sync-issues/${id(0x9999)}`, 390);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sync issue not found');
    await expect(page.getByRole('link', { name: 'All sync issues' })).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-98', 'issue-not-found-390');
  });
});

test.describe('SS-PLAT-99 retry and ignore', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-99: the Owner retries after confirming @ ${String(width)} [T-0092]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, `/settings/sync-issues/${LIMIT}`, width);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      const confirm = page.getByRole('group', { name: 'Confirm retry' });
      await expect(confirm).toContainText(
        'LedgerForce sends Account Kestrel Logistics to Salesforce again now.',
      );
      await expect(confirm.getByRole('button', { name: 'Yes, send it again' })).toBeFocused();
      await assertPage(page, width);
      await evidence('SS-PLAT-99', `retry-confirm-${String(width)}`);
      expect(f.posts).toEqual([]);
      await confirm.getByRole('button', { name: 'Yes, send it again' }).click();
      await expect(page.getByRole('status')).toHaveText(
        'Retry sent. LedgerForce is sending it to Salesforce again now.',
      );
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      await expect(
        page.getByText('A retry is already on its way.', { exact: false }),
      ).toBeVisible();
      expect(f.posts).toEqual([{ path: `/sync-issues/${LIMIT}/retry`, body: undefined }]);
      await assertPage(page, width);
      await evidence('SS-PLAT-99', `retry-sent-${String(width)}`);
      await page.getByRole('link', { name: 'All sync issues' }).click();
      await expect(page.getByRole('table', { name: 'Sync issues' }).getByRole('row')).toHaveCount(
        3,
      );
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-99: an Accountant ignores with a note, by keyboard; Cancel sends nothing [T-0092]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'accountant');
    await open(page, `/settings/sync-issues/${LOCKED}`, 1440);
    const ignore = page.getByRole('button', { name: 'Ignore', exact: true });
    await ignore.focus();
    expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Why ignore it? (optional, kept in the audit log)')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); // Cancel
    await expect(page.getByRole('group', { name: 'Confirm ignore' })).toHaveCount(0);
    await expect(ignore).toBeFocused();
    expect(f.posts).toEqual([]);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Opportunity closed; finance will update it by hand');
    await evidence('SS-PLAT-99', 'ignore-confirm-note-1440');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); // Yes, ignore it
    await expect(page.getByRole('status')).toHaveText(
      'Ignored. It stays here, and you can still retry it.',
    );
    await expect(
      page.getByText('Note: Opportunity closed; finance will update it by hand'),
    ).toBeVisible();
    await expect(page.getByText('set by you', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    expect(f.posts).toEqual([
      {
        path: `/sync-issues/${LOCKED}/ignore`,
        body: { note: 'Opportunity closed; finance will update it by hand' },
      },
    ]);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-99', 'ignored-1440');
    expect(f.errors).toEqual([]);
  });

  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-99: an Auditor sees the actions disabled with the reason @ ${String(width)} [T-0092]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'auditor');
      await open(page, `/settings/sync-issues/${LOCKED}`, width);
      for (const name of ['Retry', 'Ignore']) {
        const b = page.getByRole('button', { name, exact: true });
        await expect(b).toBeDisabled();
        const why = await b.getAttribute('aria-describedby');
        expect(why).not.toBeNull();
        const text = (await page.locator(`[id="${why ?? ''}"]`).textContent()) ?? '';
        expect(text.length).toBeGreaterThanOrEqual(20);
        expect(text).toContain('Only the Owner, a Finance Admin or an Accountant');
        await expect(page.locator(`[id="${why ?? ''}"]`)).toBeVisible();
      }
      await assertPage(page, width);
      await evidence('SS-PLAT-99', `actions-disabled-auditor-${String(width)}`);
      expect(f.posts).toEqual([]);
    });
  }

  test('SS-PLAT-99: status decides the actions; refusals in plain words; step-up [T-0092]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, `/settings/sync-issues/${IGNORED}`, 390);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Ignore', exact: true })).toHaveCount(0);
    await expect(
      page.getByText('It is already ignored. Retry it if it should go out after all.'),
    ).toBeVisible();
    await expect(page.getByText(/set by Mei Tan\. Note: Field added/)).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-99', 'ignored-issue-actions-390');
    await open(page, `/settings/sync-issues/${FIXED}`, 1440);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Invoice INV-001040 was sent to Salesforce after a retry',
    );
    await expect(page.getByRole('button', { name: /Retry|Ignore/ })).toHaveCount(0);
    await expect(
      page.getByText('This was fixed: Salesforce accepted the retry.', { exact: false }),
    ).toHaveCount(1);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-99', 'fixed-issue-1440');
    // The queue is down: 503 in plain words.
    f.override.set(`POST /sync-issues/${ROW_LOCK}/retry`, {
      status: 503,
      body: { error: 'queue_not_configured' },
    });
    await open(page, `/settings/sync-issues/${ROW_LOCK}`, 1440);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, send it again' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'LedgerForce cannot send retries right now: its job queue is not running. Ask whoever runs your LedgerForce server, then try again.',
    );
    await assertPage(page, 1440);
    await evidence('SS-PLAT-99', 'retry-queue-down-1440');
    // Changed in another tab: 409 in plain words and the issue reloads.
    f.override.delete(`POST /sync-issues/${ROW_LOCK}/retry`);
    await page.reload();
    await page.getByRole('button', { name: 'Ignore', exact: true }).click();
    const target = f.issues.find((i) => i.id === ROW_LOCK);
    if (target) target.status = 'resolved';
    await page.getByRole('button', { name: 'Yes, ignore it' }).click();
    await expect(page.getByRole('alert')).toContainText('This issue changed since you opened it');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Payment RCPT-000318 was sent to Salesforce after a retry',
    );
    await assertPage(page, 1440);
    await evidence('SS-PLAT-99', 'ignore-conflict-reloaded-1440');
    // A step-up challenge leaves for /auth/step-up and comes back here.
    f.override.set(`POST /sync-issues/${LOCKED}/retry`, {
      status: 401,
      body: { error: 'step_up_required', max_age: 300 },
    });
    await open(page, `/settings/sync-issues/${LOCKED}`, 1440);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, send it again' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirm it is you (test stand-in)' }),
    ).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/auth/step-up');
    expect(url.searchParams.get('return_to')).toBe(`/settings/sync-issues/${LOCKED}`);
    await evidence('SS-PLAT-99', 'step-up-redirect-1440');
    expect(f.errors).toEqual([]);
  });
});
