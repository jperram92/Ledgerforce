/**
 * Approval amounts screen for setup wizard step 10 (T-0186, SS-PLAT-131, design §6.5, ADR-0026,
 * ADR-0085). The Owner follows the wizard's link, sees the suggested amounts (nothing saved yet),
 * changes one, gives a reason and saves with an Idempotency-Key; afterwards the wizard says nothing
 * is missing for step 10. Vite serves the app; each test fakes the API with `page.route`, using
 * the response shapes of GET /companies, GET /setup/wizard and GET/POST /sod/settings. Amounts
 * travel as decimal strings.
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
const CO = id(0x186c2);
const TODAY = '2026-11-16';

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0186', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

// The worker's Vite cache is removed after its tests; left behind it fills the disk (DL-0820).
let cacheDir = '';

test.beforeAll(async () => {
  server = await createViteServer({
    root: WEB,
    configFile: false,
    cacheDir: (cacheDir = mkdtempSync(join(tmpdir(), 'lf-web-'))),
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
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

const ME = {
  owner: { user_id: id(0x18601), display_name: 'Olive Owner', role: 'owner' as const },
  fa: { user_id: id(0x18602), display_name: 'Fran Admin', role: 'finance_admin' as const },
  clerk: { user_id: id(0x18603), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
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

const DEFAULTS = {
  bill_self_approval: '1000.0000',
  credit_note_self_approval: '1000.0000',
  journal_approval: '5000.0000',
  batch_two_releasers: '10000.0000',
};

interface Fake {
  errors: string[];
  writes: { key: string | null; body: Record<string, unknown> }[];
  settings: {
    small_team_mode: boolean;
    thresholds: Record<string, string>;
    report_timezone: string;
    set_at: string | null;
    placeholder_defaults: boolean;
  };
  refuse: { status: number; body: unknown } | null;
  reads: number;
}

const fixed4 = (v: string) => {
  const [i = '0', f = ''] = v.split('.');
  return `${i}.${f.padEnd(4, '0')}`;
};

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    writes: [],
    settings: {
      small_team_mode: false,
      thresholds: { ...DEFAULTS },
      report_timezone: 'Australia/Sydney',
      set_at: null,
      placeholder_defaults: true,
    },
    refuse: null,
    reads: 0,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|setup|sod)(\/|$)/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
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
        return send(route, 200, [{ id: CO, name: 'Harbour & Co', base_currency: 'AUD' }]);
      if (method === 'GET') {
        const denied = need('settings.read');
        if (denied) return denied;
        f.reads += 1;
        if (path === '/sod/settings') return send(route, 200, f.settings);
        if (path === '/setup/wizard') {
          const miss10 = f.settings.set_at
            ? []
            : ['Approval thresholds (segregation-of-duties settings) have not been saved'];
          return send(route, 200, {
            company_id: CO,
            as_of: TODAY,
            complete: false,
            steps: TITLES.map((title, i) => ({
              step: i + 1,
              title,
              status: i === 9 ? 'in_progress' : 'complete',
              locked: false,
              valid: i === 9 ? miss10.length === 0 : true,
              missing: i === 9 ? miss10 : [],
              outcome: i === 9 ? null : 'completed',
              reason: null,
              completed_at: i === 9 ? null : '2026-11-16T00:00:00Z',
              completed_by: i === 9 ? null : ME.owner.user_id,
            })),
          });
        }
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      f.writes.push({ key: req.headers()['idempotency-key'] ?? null, body });
      if (path !== '/sod/settings' || method !== 'POST')
        return send(route, 404, { error: 'not_found' });
      const denied = need('settings.sod.manage');
      if (denied) return denied;
      if (!req.headers()['idempotency-key'])
        return send(route, 400, { error: 'idempotency_key_required' });
      if (f.refuse) {
        const r = f.refuse;
        f.refuse = null;
        return send(route, r.status, r.body);
      }
      const t = body['thresholds'] as Record<string, string>;
      const next = {
        small_team_mode: body['small_team_mode'] as boolean,
        thresholds: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fixed4(v)])),
        report_timezone: body['report_timezone'] as string,
      };
      const same =
        f.settings.set_at !== null &&
        JSON.stringify(next) ===
          JSON.stringify({
            small_team_mode: f.settings.small_team_mode,
            thresholds: f.settings.thresholds,
            report_timezone: f.settings.report_timezone,
          });
      if (same) return send(route, 200, f.settings);
      f.settings = { ...next, set_at: '2026-11-16T01:00:00Z', placeholder_defaults: false };
      return send(route, 201, f.settings);
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
  if (width < 600) {
    const box = await page.locator('main h1').boundingBox();
    expect(box?.x).toBe(16);
  }
}

const stepItem = (page: Page, n: number) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
    });

for (const width of [1440, 390]) {
  test(`SS-PLAT-131: Approval amounts: the Owner follows step 10's link, changes the journal amount with a reason and saves @ ${String(width)} [T-0186]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'owner');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 10)).toContainText(
      'Approval thresholds (segregation-of-duties settings) have not been saved',
    );
    await stepItem(page, 10).getByRole('link', { name: 'Approval amounts' }).click();
    await expect(page).toHaveURL(/\/settings\/approvals$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Approval amounts' })).toBeVisible();
    await expect(
      page.getByText(/Nothing has been saved yet: these are the suggested/),
    ).toBeVisible();
    await expect(page.getByLabel('Manual journals need approval above ($)')).toHaveValue(
      '5,000.00',
    );
    await assertPage(page, width);
    await evidence('SS-PLAT-131', `approvals-suggested-${String(width)}`);

    await page.getByLabel('Manual journals need approval above ($)').fill('7,500');
    await page.getByLabel('Reason for the change').fill('Owner reviews journals above $7,500');
    await page.getByRole('button', { name: 'Save approval amounts' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Approval amounts saved.' }),
    ).toBeVisible();
    await expect(page.getByText(/Nothing has been saved yet/)).toHaveCount(0);
    await expect(page.getByLabel('Manual journals need approval above ($)')).toHaveValue(
      '7,500.00',
    );
    await assertPage(page, width);
    await evidence('SS-PLAT-131', `approvals-saved-${String(width)}`);

    expect(f.writes).toEqual([
      {
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: {
          thresholds: {
            bill_self_approval: '1000.00',
            credit_note_self_approval: '1000.00',
            journal_approval: '7500',
            batch_two_releasers: '10000.00',
          },
          small_team_mode: false,
          report_timezone: 'Australia/Sydney',
          reason: 'Owner reviews journals above $7,500',
        },
      },
    ]);
    expect(f.settings.thresholds['journal_approval']).toBe('7500.0000');

    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 10)).toContainText('Nothing is missing');
    if (width === 1440) await evidence('SS-PLAT-131', 'wizard-step-10-ready-1440');
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-131: Approval amounts refusals are said in plain words; a repeat says nothing changed [T-0186]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'owner');
  await open(page, '/settings/approvals', 1440);
  // No reason: said, not sent.
  await page.getByRole('button', { name: 'Save approval amounts' }).click();
  await expect(page.getByRole('alert')).toContainText('Say why the approval amounts');
  // Not a plain amount: said, not sent.
  await page.getByLabel('Bills: someone else approves a bill above ($)').fill('1e3');
  await page.getByLabel('Reason for the change').fill('Set up');
  await page.getByRole('button', { name: 'Save approval amounts' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Write "Bills: someone else approves a bill above" as a plain amount',
  );
  expect(f.writes).toEqual([]);
  // The API refuses: said in words, nothing saved.
  await page.getByLabel('Bills: someone else approves a bill above ($)').fill('1,000');
  f.refuse = { status: 400, body: { error: 'invalid_sod_settings' } };
  await page.getByRole('button', { name: 'Save approval amounts' }).click();
  await expect(page.getByRole('alert')).toContainText('The approval amounts could not be saved');
  expect(f.settings.set_at).toBeNull();
  // Saved, then the same values again: nothing changed.
  await page.getByRole('button', { name: 'Save approval amounts' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Approval amounts saved.' }),
  ).toBeVisible();
  await page.getByLabel('Reason for the change').fill('Checked again');
  await page.getByRole('button', { name: 'Save approval amounts' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Nothing changed: these approval amounts' }),
  ).toBeVisible();
  const keys = f.writes.map((w) => w.key ?? '');
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(3);
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-131: a Finance Admin sees the approval amounts read-only [T-0186]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  await open(page, '/settings/approvals', 1440);
  await expect(page.getByText('$10,000.00')).toBeVisible();
  await expect(page.getByText(/Nothing has been saved yet/)).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByText('Only the Owner can change the approval amounts.')).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-131', 'approvals-read-only-1440');
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-131: without settings.read, Approval amounts is forbidden [T-0186]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/approvals', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByLabel('Reason for the change')).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});
