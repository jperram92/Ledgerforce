/**
 * Remittance account screen, part of setup wizard step 8 (T-0183, SS-PLAT-149, ADR-0079,
 * ADR-0080, ADR-0086). The bank account printed on invoices for bank transfer changes by
 * maker-checker: a Finance Admin asks for the change (after a fresh sign-in), is told beforehand
 * that someone else has to approve it, and cannot approve it; the Owner approves it (after a fresh
 * sign-in) and it is in force at once; a rejection needs a reason. Every account is masked to its
 * last 3 digits. Vite serves the app; each test fakes the API with `page.route`, using the
 * response shapes of GET /companies, GET /setup/wizard, GET /setup/bank-accounts, GET /sod/settings
 * and the ADR-0080 routes under /setup/remittance-account. The fake applies the ADR-0080 rules
 * (step-up, SoD with the small-team exception, one pending change) and derives step 8's missing
 * list with @ledgerforce/setup's wording.
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
const CO = id(0x183c1);
const TODAY = '2026-11-16';
const CLEAR_NUMBERS = ['12345678', '87654321'];
const REMITTANCE_MISSING = 'No remittance bank account has been chosen for bank transfer';

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0183', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: id(0x1831), display_name: 'Fran Admin', role: 'finance_admin' as const },
  owner: { user_id: id(0x1832), display_name: 'Olive Owner', role: 'owner' as const },
  accountant: { user_id: id(0x1833), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1834), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};
type Who = keyof typeof ME;

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

interface Account {
  id: string;
  name: string;
  gl_account_id: string;
  gl_account_code: string;
  gl_account_name: string;
  currency: string;
  bsb: string;
  account_name: string;
  account_number: string;
  apca_user_id: string | null;
  aba_user_name: string | null;
  aba_fi_mnemonic: string | null;
  status: string;
}

const account = (n: number, name: string, last3: string, status = 'active'): Account => ({
  id: id(0x18390 + n),
  name,
  gl_account_id: id(0x18380 + n),
  gl_account_code: `10${String(n)}0`,
  gl_account_name: `${name} account`,
  currency: 'AUD',
  bsb: '062-000',
  account_name: 'Harbour & Co Pty Ltd',
  account_number: `***${last3}`,
  apca_user_id: null,
  aba_user_name: null,
  aba_fi_mnemonic: null,
  status,
});
const OPERATING = account(1, 'Operating', '678');
const RESERVE = account(2, 'Reserve', '321');
const OLD = account(3, 'Old cheque', '999', 'archived');

const masked = (a: Account | undefined) =>
  a && {
    id: a.id,
    name: a.name,
    bsb: a.bsb,
    account_name: a.account_name,
    account_number: a.account_number,
    currency: a.currency,
    status: a.status,
  };

interface Change {
  id: string;
  target: string | null;
  previous: string | null;
  status: 'requested' | 'approved' | 'rejected';
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

interface Fake {
  who: Who;
  errors: string[];
  writes: { method: string; path: string; key: string | null; body: Record<string, unknown> }[];
  accounts: Account[];
  current: string | null;
  changes: Change[];
  smallTeam: boolean;
  /** One-off `401 step_up_required` answers for the next write to a path ending like this. */
  stepUp: string[];
  reads: number;
}

const pendingOf = (f: Fake) => f.changes.find((c) => c.status === 'requested') ?? null;
const viewOf = (f: Fake, c: Change, replayed = false) => ({
  id: c.id,
  company_id: CO,
  status: c.status,
  replayed,
  bank_account: masked(f.accounts.find((a) => a.id === c.target)) ?? null,
  previous_bank_account: masked(f.accounts.find((a) => a.id === c.previous)) ?? null,
  requested_by: c.requested_by,
  requested_at: c.requested_at,
  decided_by: c.decided_by,
  decided_at: c.decided_at,
  reason: c.reason,
});

function missing8(f: Fake): string[] {
  return f.current ? [] : [REMITTANCE_MISSING];
}

async function fakeApi(page: Page, who: Who): Promise<Fake> {
  const f: Fake = {
    who,
    errors: [],
    writes: [],
    accounts: [OPERATING, RESERVE, OLD],
    current: null,
    changes: [],
    smallTeam: false,
    stepUp: [],
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
      const me = ME[f.who];
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
        if (path === '/sod/settings')
          return send(route, 200, {
            small_team_mode: f.smallTeam,
            thresholds: {
              bill_self_approval: '1000.0000',
              credit_note_self_approval: '500.0000',
              journal_approval: '5000.0000',
              batch_two_releasers: '20000.0000',
            },
            report_timezone: 'Australia/Sydney',
            set_at: '2026-11-01T00:00:00.000Z',
            placeholder_defaults: false,
          });
        expect(url.searchParams.get('company_id')).toBe(CO);
        if (path === '/setup/remittance-account') {
          const p = pendingOf(f);
          return send(route, 200, {
            account: masked(f.accounts.find((a) => a.id === f.current)) ?? null,
            pending: p && viewOf(f, p),
          });
        }
        if (path === '/setup/bank-accounts')
          return send(route, 200, {
            company_id: CO,
            base_currency: 'AUD',
            kms_configured: true,
            accounts: f.accounts,
            gl_accounts: [],
          });
        if (path === '/setup/billing')
          return send(route, 200, {
            company_id: CO,
            series: [],
            formats: [],
            invoice: {
              brand_colour: '#0A5C8A',
              brand_accent_colour: null,
              default_payment_terms_days: 14,
              accepted_payment_methods: ['bank_transfer'],
              has_logo: false,
            },
            stripe: null,
            clearing_accounts: [],
          });
        if (path === '/setup/wizard')
          return send(route, 200, {
            company_id: CO,
            as_of: TODAY,
            complete: false,
            steps: TITLES.map((title, i) => {
              const miss = i === 7 ? missing8(f) : [];
              return {
                step: i + 1,
                title,
                status: i === 7 ? 'in_progress' : i < 7 ? 'complete' : 'not_started',
                locked: i > 7,
                valid: miss.length === 0,
                missing: miss,
                outcome: i < 7 ? 'completed' : null,
                reason: null,
                completed_at: i < 7 ? '2026-11-16T00:00:00Z' : null,
                completed_by: i < 7 ? ME.fa.user_id : null,
              };
            }),
          });
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      f.writes.push({ method, path, key: req.headers()['idempotency-key'] ?? null, body });
      const denied = need('settings.setup.manage');
      if (denied) return denied;
      expect(body['company_id']).toBe(CO);
      const m = /^\/setup\/remittance-account\/changes\/([^/]+)(?:\/(approve|reject))?$/.exec(path);
      if (!m) return send(route, 404, { error: 'not_found' });
      const changeId = m[1] ?? '';
      const action = m[2] ?? (method === 'PUT' ? 'request' : '');
      const stepUpAt = f.stepUp.indexOf(action);
      if (action !== 'reject' && stepUpAt >= 0) {
        f.stepUp.splice(stepUpAt, 1);
        return send(route, 401, { error: 'step_up_required', max_age: 300 });
      }
      const now = new Date().toISOString();
      if (action === 'request') {
        const target = body['bank_account_id'] as string | null;
        const a = f.accounts.find((x) => x.id === target);
        if (target !== null && !a) return send(route, 404, { error: 'BANK_ACCOUNT_NOT_FOUND' });
        if (a && a.status !== 'active')
          return send(route, 422, { error: 'BANK_ACCOUNT_ARCHIVED', message: 'archived' });
        if (target === f.current) return send(route, 422, { error: 'NO_CHANGE', message: 'same' });
        const p = pendingOf(f);
        if (p) return send(route, 409, { error: 'CHANGE_PENDING', message: `${p.id} waiting` });
        const c: Change = {
          id: changeId,
          target,
          previous: f.current,
          status: 'requested',
          requested_by: me.user_id,
          requested_at: now,
          decided_by: null,
          decided_at: null,
          reason: null,
        };
        f.changes.push(c);
        return send(route, 201, viewOf(f, c));
      }
      const c = f.changes.find((x) => x.id === changeId);
      if (!c) return send(route, 404, { error: 'CHANGE_NOT_FOUND', message: 'not found' });
      if (c.status !== 'requested')
        return send(route, 409, { error: 'NOT_PENDING', message: `change is ${c.status}` });
      if (action === 'approve') {
        if (c.requested_by === me.user_id) {
          const exception = body['sod_exception'] as { reason?: string } | undefined;
          if (!(f.smallTeam && exception?.reason))
            return send(route, 403, {
              error: 'sod_violation',
              rule: 'SOD_REMITTANCE_SELF_APPROVAL',
              small_team_exception_required: f.smallTeam,
            });
        }
        Object.assign(c, { status: 'approved', decided_by: me.user_id, decided_at: now });
        f.current = c.target;
        return send(route, 200, viewOf(f, c));
      }
      const reason = body['reason'];
      if (typeof reason !== 'string' || reason.trim() === '')
        return send(route, 400, { error: 'invalid_request', message: 'a reason is required' });
      Object.assign(c, {
        status: 'rejected',
        decided_by: me.user_id,
        decided_at: now,
        reason: reason.trim(),
      });
      return send(route, 200, viewOf(f, c));
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
  // Masked everywhere: no clear account number is ever on the page.
  const html = await page.content();
  for (const n of CLEAR_NUMBERS) expect(html).not.toContain(n);
}

const stepItem = (page: Page, n: number) =>
  page
    .getByRole('list', { name: 'Setup steps' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('heading', { level: 3, name: new RegExp(`^Step ${String(n)}:`) }),
    });

const region = (page: Page, name: string) => page.getByRole('region', { name });
const OPERATING_OPTION = 'Operating: BSB 062-000, account ending 678';

for (const width of [1440, 390]) {
  test(`SS-PLAT-149: the Finance Admin asks for the remittance account and cannot approve it; the Owner approves it after a fresh sign-in @ ${String(width)} [T-0183]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    f.stepUp.push('request', 'approve');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 8)).toContainText(REMITTANCE_MISSING);
    await stepItem(page, 8).getByRole('link', { name: 'Numbering and billing' }).click();
    await page.getByRole('link', { name: 'Remittance account' }).click();
    await expect(page).toHaveURL(/\/settings\/remittance-account$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Remittance account' })).toBeVisible();
    await expect(region(page, 'On your invoices')).toContainText('No remittance account yet');
    // Told before asking that a second person approves, and that they cannot.
    const ask = region(page, 'Ask for a change');
    await expect(ask).toContainText('Someone else with the Owner or Finance Admin role');
    await expect(ask).toContainText('you cannot approve your own request');
    // Archived accounts cannot be chosen; nothing to remove yet.
    const choice = page.getByLabel('Bank account to print on invoices');
    await expect(choice.getByRole('option', { name: /Old cheque/ })).toHaveCount(0);
    await expect(choice.getByRole('option', { name: /remove/i })).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-PLAT-149', `remittance-empty-${String(width)}`);

    await choice.selectOption({ label: OPERATING_OPTION });
    await page.getByRole('button', { name: 'Ask for this change' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Confirm it’s you' })).toBeFocused();
    await expect(page.getByText(/where customers send their money/)).toBeVisible();
    if (width === 1440) {
      await assertPage(page, width);
      await evidence('SS-PLAT-149', 'remittance-request-step-up-1440');
    }
    await page.getByRole('button', { name: 'Not now' }).click();
    expect(f.changes).toEqual([]);

    // Back from the fresh sign-in: press again.
    await page.getByLabel('Bank account to print on invoices').selectOption({
      label: OPERATING_OPTION,
    });
    await page.getByRole('button', { name: 'Ask for this change' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Change asked for.' })).toContainText(
      'Someone else with the Owner or Finance Admin role has to approve it',
    );
    const waiting = region(page, 'Waiting for approval');
    await expect(waiting).toContainText('Operating: BSB 062-000, account ending 678');
    await expect(waiting).toContainText('Asked by you');
    await expect(waiting).toContainText('You asked for this change, so you can’t approve it');
    await expect(waiting.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(region(page, 'Ask for a change')).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-PLAT-149', `remittance-requested-${String(width)}`);

    // The Owner, a second person, approves after a fresh sign-in.
    f.who = 'owner';
    await page.reload();
    const pending = region(page, 'Waiting for approval');
    await expect(pending).toContainText('Asked by someone else');
    await expect(pending).toContainText('Invoices print it as soon as it is approved');
    await assertPage(page, width);
    await evidence('SS-PLAT-149', `remittance-to-approve-${String(width)}`);
    await pending.getByRole('button', { name: 'Approve this change' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Confirm it’s you' })).toBeFocused();
    await expect(page.getByText(/puts this bank account on your invoices/)).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.getByRole('button', { name: 'Approve this change' }).click();
    await expect(
      page.getByRole('status').filter({
        hasText: 'Approved. Invoices now print Operating: BSB 062-000, account ending 678.',
      }),
    ).toBeVisible();
    await expect(region(page, 'On your invoices')).toContainText(
      'Operating: BSB 062-000, account ending 678, in the name of Harbour & Co Pty Ltd (AUD)',
    );
    await expect(region(page, 'Waiting for approval')).toHaveCount(0);
    // Now the account in force can be removed, and is not offered again.
    const next = page.getByLabel('Bank account to print on invoices');
    await expect(next.getByRole('option', { name: /remove/i })).toHaveCount(1);
    await expect(next.getByRole('option', { name: OPERATING_OPTION })).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-PLAT-149', `remittance-approved-${String(width)}`);

    const writes = f.writes.map((w) => [w.method, w.path.replace(/[0-9a-f-]{36}/, ':id'), w.body]);
    expect(writes).toEqual([
      [
        'PUT',
        '/setup/remittance-account/changes/:id',
        { company_id: CO, bank_account_id: OPERATING.id },
      ],
      [
        'PUT',
        '/setup/remittance-account/changes/:id',
        { company_id: CO, bank_account_id: OPERATING.id },
      ],
      ['POST', '/setup/remittance-account/changes/:id/approve', { company_id: CO }],
      ['POST', '/setup/remittance-account/changes/:id/approve', { company_id: CO }],
    ]);
    // A fresh change id and Idempotency-Key per attempt; the approval names the requested change.
    const [r1, r2, a1, a2] = f.writes.map((w) => w.path);
    expect(r1).not.toBe(r2);
    expect(a1).toBe(`${r2 ?? ''}/approve`);
    expect(a2).toBe(a1);
    const keys = f.writes.map((w) => w.key ?? '');
    expect(keys.every((k) => k.length >= 8)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);

    await page.getByRole('link', { name: 'Back to Numbering and billing' }).click();
    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 8)).toContainText('Nothing is missing');
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-149: a rejection needs a reason; the account in force stays [T-0183]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'owner');
  f.current = OPERATING.id;
  f.changes.push({
    id: id(0x183f1),
    target: RESERVE.id,
    previous: OPERATING.id,
    status: 'requested',
    requested_by: ME.fa.user_id,
    requested_at: '2026-11-16T01:00:00.000Z',
    decided_by: null,
    decided_at: null,
    reason: null,
  });
  await open(page, '/settings/remittance-account', 1440);
  const waiting = region(page, 'Waiting for approval');
  await expect(waiting).toContainText('Reserve: BSB 062-000, account ending 321');
  await expect(waiting).toContainText('Instead of Operating: BSB 062-000, account ending 678');
  await waiting.getByRole('button', { name: 'Reject this change' }).click();
  await expect(waiting.getByText('Write why you are rejecting this change.')).toBeVisible();
  expect(f.writes).toEqual([]);
  await waiting.getByLabel('Why you are rejecting it').fill('  Not our account  ');
  await assertPage(page, 1440);
  await evidence('SS-PLAT-149', 'remittance-reject-reason-1440');
  await waiting.getByRole('button', { name: 'Reject this change' }).click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'Rejected. Invoices still print Operating: BSB 062-000, account ending 678.',
    }),
  ).toBeVisible();
  await expect(region(page, 'Waiting for approval')).toHaveCount(0);
  expect(f.current).toBe(OPERATING.id);
  expect(f.writes.map((w) => [w.path, w.body])).toEqual([
    [
      `/setup/remittance-account/changes/${id(0x183f1)}/reject`,
      { company_id: CO, reason: 'Not our account' },
    ],
  ]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-149: in small-team mode the requester may approve their own change with a reason; refusals are in plain words [T-0183]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  f.smallTeam = true;
  f.changes.push({
    id: id(0x183f2),
    target: OPERATING.id,
    previous: null,
    status: 'requested',
    requested_by: ME.fa.user_id,
    requested_at: '2026-11-16T01:00:00.000Z',
    decided_by: null,
    decided_at: null,
    reason: null,
  });
  await open(page, '/settings/remittance-account', 1440);
  const waiting = region(page, 'Waiting for approval');
  await expect(waiting).toContainText('small-team mode');
  await expect(waiting).toContainText('every Owner and Finance Admin is told');
  const approve = waiting.getByRole('button', { name: 'Approve my own change' });
  await expect(approve).toBeDisabled();
  await waiting.getByLabel('Why you are approving your own change').fill('Only one of us');
  await assertPage(page, 1440);
  await evidence('SS-PLAT-149', 'remittance-small-team-1440');
  await approve.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Approved. Invoices now print Operating' }),
  ).toBeVisible();
  expect(f.writes.map((w) => w.body)).toEqual([
    { company_id: CO, sod_exception: { reason: 'Only one of us' } },
  ]);

  // Asking for the same account again, or while another change waits, is said in plain words.
  await page.getByLabel('Bank account to print on invoices').selectOption({
    label: 'Reserve: BSB 062-000, account ending 321',
  });
  f.changes.push({
    id: id(0x183f3),
    target: null,
    previous: OPERATING.id,
    status: 'requested',
    requested_by: ME.owner.user_id,
    requested_at: '2026-11-16T02:00:00.000Z',
    decided_by: null,
    decided_at: null,
    reason: null,
  });
  await page.getByRole('button', { name: 'Ask for this change' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Another change is already waiting for approval',
  );
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-149: when the API does not allow the self-approval, the requester is told why in plain words [T-0183]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.smallTeam = true;
  f.changes.push({
    id: id(0x183f4),
    target: OPERATING.id,
    previous: null,
    status: 'requested',
    requested_by: ME.fa.user_id,
    requested_at: '2026-11-16T01:00:00.000Z',
    decided_by: null,
    decided_at: null,
    reason: null,
  });
  await open(page, '/settings/remittance-account', 1440);
  // Small-team mode was switched off after the page loaded: the API refuses.
  f.smallTeam = false;
  const waiting = region(page, 'Waiting for approval');
  await waiting.getByLabel('Why you are approving your own change').fill('Only one of us');
  await waiting.getByRole('button', { name: 'Approve my own change' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'You asked for this change, so you can’t approve it as well',
  );
  expect(f.current).toBeNull();
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-149: an Accountant sees the remittance account and a pending change read-only, masked [T-0183]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'accountant');
  f.current = OPERATING.id;
  f.changes.push({
    id: id(0x183f5),
    target: null,
    previous: OPERATING.id,
    status: 'requested',
    requested_by: ME.fa.user_id,
    requested_at: '2026-11-16T01:00:00.000Z',
    decided_by: null,
    decided_at: null,
    reason: null,
  });
  await open(page, '/settings/remittance-account', 1440);
  await expect(region(page, 'On your invoices')).toContainText('account ending 678');
  await expect(region(page, 'Waiting for approval')).toContainText('Remove the remittance account');
  await expect(page.locator('main').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText(/Only the Owner or a Finance Admin/)).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-149', 'remittance-read-only-1440');
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-149: without settings.read, the remittance account is forbidden [T-0183]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/remittance-account', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('region', { name: 'On your invoices' })).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-149: the remittance account is listed on the Settings page [T-0183]', async ({
  page,
}) => {
  await fakeApi(page, 'fa');
  await open(page, '/settings', 1440);
  await page.getByRole('link', { name: 'Remittance account' }).click();
  await expect(page).toHaveURL(/\/settings\/remittance-account$/);
});
