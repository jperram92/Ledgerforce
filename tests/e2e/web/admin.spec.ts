/**
 * T-0093 — the admin screens of apps/web, end to end in Chromium.
 *
 *  - SS-PLAT-78: people and roles — list, invite, role grant and the self-grant refusal shown,
 *    offboard with a successor, permission-aware actions, loading / error / forbidden states, and
 *    a step-up challenge routed to /auth/step-up.
 *  - SS-PLAT-79: the weekly control-exceptions report and the Owner's acknowledgement.
 *  - SS-PLAT-80: the audit log viewer — filters, keyset pages, details, read-only.
 *
 * Every screen at 1440 and 390 with axe WCAG 2.2 AA (0 violations), the genericness probes, no
 * horizontal scroll and no console errors. The app is served in-process by Vite (as
 * shell.spec.ts) and the API is faked per test with `page.route`; the contracts faked are the
 * ones the API's own db tests prove (users.lifecycle, users.list, user roles, sod, audit-log).
 * Times are shown in Australia/Sydney. Screenshots go to .agent/evidence/T-0093/.
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
const LENA = id(0x9303);
const PRIYA = id(0x9304);
const GUS = id(0x9305);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0093', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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

type Who = 'owner' | 'finance_admin' | 'auditor' | 'clerk';
const ME: Record<Who, { user_id: string; display_name: string; roles: string[] }> = {
  owner: { user_id: SAM, display_name: 'Sam Nguyen', roles: ['owner'] },
  finance_admin: { user_id: MEI, display_name: 'Mei Tan', roles: ['approver', 'finance_admin'] },
  auditor: { user_id: id(0x9306), display_name: 'Ada Brooks', roles: ['auditor'] },
  clerk: { user_id: LENA, display_name: 'Lena Ortiz', roles: ['ap_clerk'] },
};
const permissionsOf = (roles: string[]) =>
  [
    ...new Set(roles.flatMap((r) => ROLE_TEMPLATES[r as keyof typeof ROLE_TEMPLATES].permissions)),
  ].sort();

interface Person {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'invited' | 'disabled';
  created_at: string;
  disabled_at: string | null;
  successor_user_id: string | null;
  disable_reason: string | null;
  roles: string[];
}
const person = (
  pid: string,
  name: string,
  roles: string[],
  status: Person['status'] = 'active',
): Person => ({
  id: pid,
  email: `${(name.split(' ')[0] ?? 'x').toLowerCase()}@harbour.example`,
  display_name: name,
  status,
  created_at: '2026-09-01T00:00:00.000Z',
  disabled_at: status === 'disabled' ? '2026-10-02T03:00:00.000Z' : null,
  successor_user_id: status === 'disabled' ? MEI : null,
  disable_reason: status === 'disabled' ? 'Contract ended' : null,
  roles,
});

const entry = (
  n: number,
  at: string,
  actor: string | null,
  action: string,
  type: string,
  eid: string,
  after: unknown,
  before: unknown = null,
) => ({
  id: String(n),
  occurred_at: at,
  actor_type: actor === null ? 'system' : 'user',
  actor_user_id: actor,
  action,
  entity_type: type,
  entity_id: eid,
  before,
  after,
  ip: actor === null ? null : '203.0.113.24',
  user_agent: actor === null ? null : 'Mozilla/5.0 (Macintosh) Firefox/131.0',
  request_id: actor === null ? null : `req-${String(n)}`,
  api_token_id: null,
});
const AUDIT = [
  entry(58, '2026-10-24T23:12:00.000Z', SAM, 'POST /users/:userId/roles', 'user_role', 'r-58', {
    user_id: LENA,
    role: 'ap_clerk',
  }),
  entry(
    57,
    '2026-10-24T05:40:00.000Z',
    MEI,
    'POST /sod/exceptions/weekly/acknowledge',
    'sod_exception_week',
    '2026-10-12',
    { exceptions: 1 },
  ),
  entry(
    56,
    '2026-10-23T22:03:00.000Z',
    null,
    'period.status_changed',
    'fiscal_period',
    'FY27-P03',
    { status: 'ar_locked' },
    { status: 'open' },
  ),
  entry(
    55,
    '2026-10-23T01:15:00.000Z',
    SAM,
    'POST /users/:userId/offboard',
    'app_user',
    GUS,
    { status: 'disabled', reason: 'Contract ended' },
    { status: 'active' },
  ),
  entry(54, '2026-10-22T04:30:00.000Z', LENA, 'user.joined', 'app_user', LENA, {
    status: 'active',
  }),
  entry(53, '2026-10-21T21:00:00.000Z', SAM, 'POST /users', 'app_user', LENA, {
    status: 'invited',
    roles: ['ap_clerk'],
  }),
  entry(
    52,
    '2026-10-21T02:10:00.000Z',
    MEI,
    'POST /users/:userId/roles/:role/revoke',
    'user_role',
    'r-41',
    { role: 'accountant', active: false, reason: 'Moved to approvals' },
    { role: 'accountant', active: true },
  ),
  entry(51, '2026-10-20T00:05:00.000Z', SAM, 'POST /sod/settings', 'sod_settings', 's-3', {
    small_team_mode: true,
  }),
];

const WEEK = {
  week_start: '2026-10-19',
  timezone: 'Australia/Sydney',
  acknowledged_at: null as string | null,
  exceptions: [
    {
      id: 'x-1',
      rule: 'SOD_BILL_SELF_APPROVAL',
      subject_type: 'bill',
      subject_id: 'BILL-000045',
      step: 'bill.approve',
      actor_user_id: SAM,
      kind: 'recorded_exception',
      reviewer_user_id: null,
      reason: 'Mei on leave; supplier needed paying this week',
      occurred_at: '2026-10-21T01:30:00.000Z',
      acknowledged: false,
    },
    {
      id: 'x-2',
      rule: 'SOD_BANK_DETAIL_SELF_VERIFY',
      subject_type: 'bank_detail_change',
      subject_id: 'BDC-0007',
      step: 'bank_detail_change.verify',
      actor_user_id: SAM,
      kind: 'external_reviewer',
      reviewer_user_id: MEI,
      reason: 'Phoned Saltbush Supplies on their listed number',
      occurred_at: '2026-10-23T04:10:00.000Z',
      acknowledged: false,
    },
  ],
};

interface Fake {
  who: Who;
  people: Person[];
  week: typeof WEEK;
  posts: { path: string; body: unknown }[];
  errors: string[];
  /** Per-path overrides: answer this instead (status + body), or hold the response. */
  override: Map<string, { status: number; body: unknown } | 'hold'>;
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = {
    who,
    people: [
      person(LENA, 'Lena Ortiz', ['ap_clerk']),
      person(MEI, 'Mei Tan', ['approver', 'finance_admin']),
      person(PRIYA, 'Priya Shah', ['accountant'], 'invited'),
      person(GUS, 'Gus Webb', [], 'disabled'),
      person(SAM, 'Sam Nguyen', ['owner']),
      person(id(0x9306), 'Ada Brooks', ['auditor']),
    ].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    week: structuredClone(WEEK),
    posts: [],
    errors: [],
    override: new Map(),
  };
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
    (url) => url.origin === origin && /^\/(auth|users|sod|audit-log)(\/|$)/.test(url.pathname),
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
      const body: unknown = method === 'POST' ? req.postDataJSON() : undefined;
      if (method === 'POST') f.posts.push({ path, body });
      if (path === '/users' && method === 'GET') return send(route, 200, f.people);
      if (path === '/users' && method === 'POST') {
        const b = body as { email: string; display_name: string; roles: string[] };
        const p = { ...person(id(0x9399), b.display_name, b.roles, 'invited'), email: b.email };
        f.people.push(p);
        f.people.sort((a, c) => a.display_name.localeCompare(c.display_name));
        return send(route, 201, {
          id: p.id,
          email: p.email,
          display_name: p.display_name,
          status: 'invited',
          roles: b.roles,
        });
      }
      const m = /^\/users\/([^/]+)(\/.*)?$/.exec(path);
      if (m) {
        const target = f.people.find((p) => p.id === m[1]);
        if (!target) return send(route, 404, { error: 'not_found' });
        const rest = m[2] ?? '';
        if (rest === '' && method === 'GET') return send(route, 200, target);
        if (rest === '/roles' && method === 'POST') {
          const role = (body as { role: string }).role;
          if (target.id === me.user_id) return send(route, 403, { error: 'self_grant' });
          target.roles = [...new Set([...target.roles, role])].sort();
          return send(route, 201, {
            id: 'r-new',
            user_id: target.id,
            role,
            granted_at: new Date().toISOString(),
          });
        }
        const rv = /^\/roles\/([^/]+)\/revoke$/.exec(rest);
        if (rv && method === 'POST') {
          target.roles = target.roles.filter((r) => r !== rv[1]);
          return send(route, 200, { user_id: target.id, role: rv[1], revoked: true });
        }
        if (rest === '/offboard' && method === 'POST') {
          const b = body as { reason: string; successor_user_id?: string };
          const revoked = target.roles.length;
          Object.assign(target, {
            status: 'disabled',
            roles: [],
            disabled_at: new Date().toISOString(),
            disable_reason: b.reason,
            successor_user_id: b.successor_user_id ?? null,
          });
          return send(route, 200, {
            user_id: target.id,
            status: 'disabled',
            changed: true,
            sessions_revoked: 2,
            tokens_revoked: 1,
            roles_revoked: revoked,
            successor_user_id: b.successor_user_id ?? null,
            approvals_assignee: b.successor_user_id ?? null,
            pending: { period_reopen_requests: [] },
          });
        }
      }
      if (path === '/sod/exceptions/weekly') {
        const wk = url.searchParams.get('week_start') ?? f.week.week_start;
        return send(
          route,
          200,
          wk === f.week.week_start
            ? f.week
            : { ...f.week, week_start: wk, acknowledged_at: null, exceptions: [] },
        );
      }
      if (path === '/sod/exceptions/weekly/acknowledge') {
        f.week.acknowledged_at = '2026-10-25T00:20:00.000Z';
        f.week.exceptions = f.week.exceptions.map((e) => ({ ...e, acknowledged: true }));
        return send(route, 201, {
          week_start: f.week.week_start,
          exceptions: f.week.exceptions.length,
        });
      }
      if (path === '/audit-log') {
        const q = url.searchParams;
        let rows = AUDIT.filter(
          (e) =>
            (!q.get('actor') || e.actor_user_id === q.get('actor')) &&
            (!q.get('action') ||
              e.action.toLowerCase().includes((q.get('action') ?? '').toLowerCase())) &&
            (!q.get('entity_type') || e.entity_type === q.get('entity_type')) &&
            (!q.get('before') || Number(e.id) < Number(q.get('before'))),
        );
        const limit = Number(q.get('limit') ?? '5');
        const more = rows.length > limit;
        rows = rows.slice(0, limit);
        return send(route, 200, {
          entries: rows,
          next_before: more ? (rows.at(-1)?.id ?? null) : null,
        });
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
}

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { style: 'none', width: 0 };
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  });
}

test.describe('SS-PLAT-78 people and roles', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-78: the Owner sees people with roles and status @ ${String(width)} [T-0093]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, '/settings', width);
      await page.getByRole('link', { name: 'People and roles' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('People and roles');
      await expect(
        page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }),
      ).toHaveAttribute('aria-current', 'page');
      const table = page.getByRole('table', { name: 'People' });
      await expect(table.getByRole('row')).toHaveCount(7);
      await expect(table.getByRole('row', { name: /Mei Tan/ })).toContainText(
        'Approver, Finance Admin',
      );
      await expect(table.getByRole('row', { name: /Gus Webb/ })).toContainText('Disabled');
      await expect(table.getByRole('row', { name: /Priya Shah/ })).toContainText('Invited');
      await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-78', `people-list-owner-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-78: the Owner invites someone by keyboard [T-0093]', async ({ page, evidence }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, '/settings/users', 1440);
    await page.getByLabel('Full name').focus();
    expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
    await page.keyboard.type('Noah Clarke');
    await page.keyboard.press('Tab');
    await page.keyboard.type('noah@harbour.example');
    await page.keyboard.press('Tab');
    await page.keyboard.type('https://id.harbour.example');
    await page.keyboard.press('Tab');
    await page.keyboard.type('noah.clarke');
    await page.keyboard.press('Tab'); // Owner
    await page.keyboard.press('Tab'); // Finance Admin
    await page.keyboard.press('Tab'); // Accountant
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Accountant' })).toBeChecked();
    await evidence('SS-PLAT-78', 'invite-form-filled-1440');
    await page.getByRole('button', { name: 'Send invitation' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText(
      'Invited Noah Clarke. They become active the first time they sign in, after setting up two-step sign-in.',
    );
    await expect(
      page.getByRole('table', { name: 'People' }).getByRole('row', { name: /Noah Clarke/ }),
    ).toContainText('Invited');
    expect(f.posts).toEqual([
      {
        path: '/users',
        body: {
          email: 'noah@harbour.example',
          display_name: 'Noah Clarke',
          idp_issuer: 'https://id.harbour.example',
          idp_subject: 'noah.clarke',
          roles: ['accountant'],
        },
      },
    ]);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-78', 'invite-sent-1440');
    expect(f.errors).toEqual([]);
  });

  test('SS-PLAT-78: an Auditor reads the list but is told who can change it [T-0093]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'auditor');
    await open(page, '/settings/users', 390);
    await expect(page.getByRole('table', { name: 'People' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
    await expect(page.getByText('Only the Owner can invite people or disable them.')).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-78', 'people-list-auditor-390');
  });

  test('SS-PLAT-78: a clerk without users.read sees the forbidden state [T-0093]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'clerk');
    for (const width of [1440, 390]) {
      await open(page, '/settings/users', width);
      await expect(
        page.getByRole('heading', { level: 2, name: "You can't see the people list" }),
      ).toBeVisible();
      await expect(
        page.getByText(/Only the Owner, a Finance Admin or an Auditor can see/),
      ).toBeVisible();
      await assertPage(page, width);
      await evidence('SS-PLAT-78', `people-forbidden-${String(width)}`);
    }
  });

  test('SS-PLAT-78: loading and error states, with Try again [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    f.override.set('GET /users', 'hold');
    await open(page, '/settings/users', 1440);
    await expect(page.getByText('Loading people…')).toBeVisible();
    await evidence('SS-PLAT-78', 'people-loading-1440');
    f.override.set('GET /users', { status: 503, body: { error: 'down' } });
    await open(page, '/settings/users', 390);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('We could not load the people list');
    await assertPage(page, 390);
    await evidence('SS-PLAT-78', 'people-error-390');
    f.override.delete('GET /users');
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('table', { name: 'People' })).toBeVisible();
  });

  test('SS-PLAT-78: the Owner tries to give themselves a role and sees the refusal [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, `/settings/users/${SAM}`, 1440);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sam Nguyen');
    await expect(
      page.getByText("You can't change your own roles: another Owner or Finance Admin has to."),
    ).toBeVisible();
    await page.getByLabel('Role to give').selectOption({ label: 'Approver' });
    await page.getByRole('button', { name: 'Give role' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      "You can't give yourself a role. Another Owner or Finance Admin has to do it, so nobody widens their own access.",
    );
    expect(f.posts).toEqual([{ path: `/users/${SAM}/roles`, body: { role: 'approver' } }]);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Disable this person' }),
    ).toBeVisible();
    await expect(
      page.getByText("You can't disable yourself. Ask another Owner to do it."),
    ).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-78', 'self-grant-refused-1440');
  });

  test('SS-PLAT-78: a Finance Admin gives and removes a role, but not the Owner role [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'finance_admin');
    await open(page, `/settings/users/${LENA}`, 390);
    const give = page.getByLabel('Role to give');
    await expect(give.getByRole('option', { name: 'Owner' })).toHaveCount(0);
    await give.selectOption({ label: 'Approver' });
    await page.getByRole('button', { name: 'Give role' }).click();
    await expect(page.getByRole('status')).toHaveText('Gave Lena Ortiz the Approver role.');
    await expect(page.getByRole('list', { name: 'Current roles' })).toContainText('Approver');
    await page
      .getByLabel('Reason for removing a role (kept in the audit log)')
      .fill('Moved to purchasing only');
    await page.getByRole('button', { name: 'Remove Approver' }).click();
    await expect(page.getByRole('status')).toHaveText('Removed the Approver role from Lena Ortiz.');
    expect(f.posts).toEqual([
      { path: `/users/${LENA}/roles`, body: { role: 'approver' } },
      {
        path: `/users/${LENA}/roles/approver/revoke`,
        body: { reason: 'Moved to purchasing only' },
      },
    ]);
    // Offboarding is the Owner's (users.manage): not offered to a Finance Admin.
    await expect(page.getByRole('heading', { name: 'Disable this person' })).toHaveCount(0);
    await assertPage(page, 390);
    await evidence('SS-PLAT-78', 'role-removed-finance-admin-390');
  });

  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-78: the Owner offboards a leaver with a successor @ ${String(width)} [T-0093]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, `/settings/users/${LENA}`, width);
      await page.getByLabel('Why are they leaving?').fill('Resigned; last day Friday 24 October');
      await page.getByLabel('Who takes over their approvals').selectOption({ label: 'Mei Tan' });
      await page.getByRole('button', { name: 'Disable Lena Ortiz' }).click();
      const confirm = page.getByRole('group', { name: 'Confirm' });
      await expect(confirm).toContainText(
        "Lena Ortiz loses access now. You can invite them again later, but this can't be undone.",
      );
      await assertPage(page, width);
      await evidence('SS-PLAT-78', `offboard-confirm-${String(width)}`);
      await confirm.getByRole('button', { name: 'Yes, disable Lena Ortiz now' }).click();
      await expect(page.getByRole('status')).toHaveText(
        'Lena Ortiz is disabled. Revoked 2 sessions, 1 API token and 1 role. Approvals now go to Mei Tan.',
      );
      expect(f.posts).toEqual([
        {
          path: `/users/${LENA}/offboard`,
          body: { reason: 'Resigned; last day Friday 24 October', successor_user_id: MEI },
        },
      ]);
      await assertPage(page, width);
      await evidence('SS-PLAT-78', `offboard-done-${String(width)}`);
      await page.getByRole('link', { name: 'All people' }).click();
      await expect(
        page.getByRole('table', { name: 'People' }).getByRole('row', { name: /Lena Ortiz/ }),
      ).toContainText('Disabled');
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-78: a disabled person shows when, why and who took over [T-0093]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'owner');
    await open(page, `/settings/users/${GUS}`, 1440, 'dark');
    await expect(page.getByRole('heading', { level: 2, name: 'Disabled' })).toBeVisible();
    await expect(
      page.getByText(/Reason: Contract ended\..*Their approvals go to Mei Tan\./),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Give role' })).toHaveCount(0);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-78', 'disabled-person-1440-dark');
  });

  test('SS-PLAT-78: a step-up challenge goes to /auth/step-up and returns here [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    f.override.set(`POST /users/${LENA}/offboard`, {
      status: 401,
      body: { error: 'step_up_required', max_age: 300 },
    });
    await open(page, `/settings/users/${LENA}`, 1440);
    await page.getByLabel('Why are they leaving?').fill('Resigned');
    await page.getByRole('button', { name: 'Disable Lena Ortiz' }).click();
    await page.getByRole('button', { name: 'Yes, disable Lena Ortiz now' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirm it is you (test stand-in)' }),
    ).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/auth/step-up');
    expect(url.searchParams.get('max_age')).toBe('300');
    expect(url.searchParams.get('return_to')).toBe(`/settings/users/${LENA}`);
    await evidence('SS-PLAT-78', 'step-up-redirect-1440');
  });
});

test.describe('SS-PLAT-79 weekly control exceptions', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-79: the Owner reviews and acknowledges the week @ ${String(width)} [T-0093]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'owner');
      await open(page, '/reports', width);
      await page.getByRole('link', { name: 'Weekly control exceptions' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekly control exceptions');
      await expect(
        page.getByRole('heading', { level: 2, name: 'Week of Monday 19 October 2026' }),
      ).toBeVisible();
      const table = page.getByRole('table', { name: 'Exceptions' });
      await expect(table.getByRole('row')).toHaveCount(3);
      await expect(table).toContainText('Approved a bill they had entered, above the bill limit');
      await expect(table).toContainText('Checked by an outside reviewer: Mei Tan');
      await expect(page.locator('[data-open-item]')).toHaveText('Your turn: acknowledge this week');
      await expect(page.locator('[data-open-item]')).toHaveAttribute('data-due', '2026-10-26');
      await assertPage(page, width);
      await evidence('SS-PLAT-79', `exceptions-week-owner-${String(width)}`);
      await page
        .getByLabel('Note for the record (optional)')
        .fill('Both reviewed with Mei on Friday.');
      await page.getByRole('button', { name: 'Acknowledge this week' }).click();
      await expect(page.getByRole('status')).toHaveText('Acknowledged on 25 Oct 2026, 11:20 am.');
      await expect(table.getByRole('row').nth(1)).toContainText('Yes');
      expect(f.posts).toEqual([
        {
          path: '/sod/exceptions/weekly/acknowledge',
          body: { week_start: '2026-10-19', note: 'Both reviewed with Mei on Friday.' },
        },
      ]);
      await assertPage(page, width);
      await evidence('SS-PLAT-79', `exceptions-acknowledged-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-79: an Auditor sees whose turn it is, with no button [T-0093]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'auditor');
    await open(page, '/reports/control-exceptions', 1440);
    await expect(page.locator('[data-open-item]')).toHaveText(
      'Waiting for the Owner to acknowledge this week',
    );
    await expect(page.getByRole('button', { name: 'Acknowledge this week' })).toHaveCount(0);
    await assertPage(page, 1440);
    await evidence('SS-PLAT-79', 'exceptions-auditor-1440');
  });

  test('SS-PLAT-79: an empty week, an error and the forbidden state [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, '/reports/control-exceptions', 390);
    await page.getByRole('link', { name: 'Previous week' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Week of Monday 12 October 2026' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'No exceptions this week' }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-79', 'exceptions-empty-week-390');
    f.override.set('GET /sod/exceptions/weekly', { status: 503, body: { error: 'down' } });
    await open(page, '/reports/control-exceptions', 1440);
    await expect(page.getByRole('alert')).toContainText("We could not load this week's exceptions");
    await assertPage(page, 1440);
    await evidence('SS-PLAT-79', 'exceptions-error-1440');
    f.who = 'clerk';
    await open(page, '/reports/control-exceptions', 390);
    await expect(
      page.getByRole('heading', { level: 2, name: "You can't see this report" }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-79', 'exceptions-forbidden-390');
  });
});

test.describe('SS-PLAT-80 audit log viewer', () => {
  for (const width of [1440, 390] as const) {
    test(`SS-PLAT-80: newest entries first, with details @ ${String(width)} [T-0093]`, async ({
      page,
      evidence,
    }) => {
      const f = await fakeApi(page, 'auditor');
      await open(page, '/reports', width);
      await page.getByRole('link', { name: 'Audit log' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
      const table = page.getByRole('table', { name: 'Audit entries' });
      await expect(table.getByRole('row')).toHaveCount(6);
      await expect(table.getByRole('row').nth(1)).toContainText('25 Oct 2026, 10:12 am');
      await expect(table.getByRole('row').nth(1)).toContainText('Sam Nguyen');
      await expect(table.getByRole('row').nth(3)).toContainText('LedgerForce (system)');
      await table.getByText('Show details').first().click();
      await expect(table.getByRole('row').nth(1)).toContainText('"role": "ap_clerk"');
      await expect(table.getByRole('row').nth(1)).toContainText('203.0.113.24');
      // Read-only: nothing on the page can change an entry.
      await expect(page.getByRole('button', { name: /edit|delete|remove|undo/i })).toHaveCount(0);
      await assertPage(page, width);
      await evidence('SS-PLAT-80', `audit-log-${String(width)}`);
      expect(f.errors).toEqual([]);
    });
  }

  test('SS-PLAT-80: filters live in the address; older entries page by keyset [T-0093]', async ({
    page,
    evidence,
  }) => {
    await fakeApi(page, 'owner');
    await open(page, '/reports/audit-log', 1440);
    await page.getByRole('button', { name: 'Older entries' }).click();
    await expect(page).toHaveURL(/before=54$/);
    const table = page.getByRole('table', { name: 'Audit entries' });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Older entries' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to newest' })).toBeVisible();
    await assertPage(page, 1440);
    await evidence('SS-PLAT-80', 'audit-log-older-page-1440');
    await page.getByRole('link', { name: 'Back to newest' }).click();
    await page.getByLabel('Person').selectOption({ label: 'Sam Nguyen' });
    await page.getByLabel('Action contains').fill('users');
    await page.getByLabel('From').fill('2026-10-20');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?actor=${SAM}&action=users&from=2026-10-20$`));
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(page.getByLabel('Action contains')).toHaveValue('users');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-80', 'audit-log-filtered-1440');
  });

  test('SS-PLAT-80: no match, an invalid filter and the forbidden state [T-0093]', async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'finance_admin');
    await open(page, '/reports/audit-log?action=journal', 390);
    await expect(page.getByRole('heading', { level: 2, name: 'No entries match' })).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-80', 'audit-log-empty-390');
    f.override.set('GET /audit-log', { status: 400, body: { error: 'invalid_filter' } });
    await open(page, '/reports/audit-log?from=2026-10-23&to=2026-10-20', 1440);
    await expect(page.getByRole('alert')).toContainText('Check the filters');
    await assertPage(page, 1440);
    await evidence('SS-PLAT-80', 'audit-log-invalid-filter-1440');
    f.who = 'clerk';
    await open(page, '/reports/audit-log', 390, 'dark');
    await expect(
      page.getByRole('heading', { level: 2, name: "You can't see the audit log" }),
    ).toBeVisible();
    await assertPage(page, 390);
    await evidence('SS-PLAT-80', 'audit-log-forbidden-390-dark');
  });
});
