/**
 * Bank accounts screen for setup wizard step 4 (T-0185, SS-PLAT-130, ADR-0084). A Finance Admin
 * follows step 4's link, adds the operating account with its APCA user id and ABA user name, and
 * sees it listed with the number masked to the last 3 digits; afterwards step 4 says nothing is
 * missing. Vite serves the app; each test fakes the API with `page.route`, using the shapes of
 * GET /companies, GET /setup/wizard and the ADR-0084 routes under /setup/bank-accounts. The fake
 * masks as the API does and derives step 4's missing list with @ledgerforce/setup's wording.
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
const CO = id(0x185c1);
const GL_OPERATING = id(0x18501);
const GL_PAYROLL = id(0x18502);
const TODAY = '2026-11-15';
const NUMBER = '12345678';

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0185', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: id(0x1851), display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1852), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1853), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
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

const GL = [
  { id: GL_OPERATING, code: '1010', name: 'Operating account', currency: 'AUD' },
  { id: GL_PAYROLL, code: '1020', name: 'Payroll account', currency: null },
];

interface Fake {
  errors: string[];
  writes: { path: string; key: string | null; body: Record<string, unknown> }[];
  accounts: Account[];
  kms: boolean;
  /** One-off refusals of the next POST, used before the fake's own rules. */
  refuse: { status: number; body: unknown }[];
  reads: number;
}

function missing4(f: Fake): string[] {
  const active = f.accounts.filter((a) => a.status === 'active');
  const out: string[] = [];
  if (active.length === 0) out.push('No bank account has been added');
  if (!active.some((a) => a.apca_user_id && a.aba_user_name))
    out.push('No bank account has an APCA user id and ABA user name (batch payments)');
  return out;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = { errors: [], writes: [], accounts: [], kms: true, refuse: [], reads: 0 };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|403|404|409|422|503)/.test(m.text()))
      f.errors.push(m.text());
  });
  page.on('pageerror', (e) => f.errors.push(String(e)));
  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body });
  await page.route(
    (url) => url.origin === origin && /^\/(auth|companies|setup)(\/|$)/.test(url.pathname),
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
        if (path !== '/setup/wizard') expect(url.searchParams.get('company_id')).toBe(CO);
        f.reads += 1;
        if (path === '/setup/bank-accounts')
          return send(route, 200, {
            company_id: CO,
            base_currency: 'AUD',
            kms_configured: f.kms,
            accounts: f.accounts,
            gl_accounts: GL.map((g) => ({
              ...g,
              in_use: f.accounts.some((a) => a.status === 'active' && a.gl_account_id === g.id),
            })),
          });
        if (path === '/setup/wizard')
          return send(route, 200, {
            company_id: CO,
            as_of: TODAY,
            complete: false,
            steps: TITLES.map((title, i) => {
              const miss = i === 3 ? missing4(f) : [];
              return {
                step: i + 1,
                title,
                status: i === 0 ? 'in_progress' : 'not_started',
                locked: i > 0,
                valid: miss.length === 0,
                missing: miss,
                outcome: null,
                reason: null,
                completed_at: null,
                completed_by: null,
              };
            }),
          });
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      f.writes.push({ path, key: req.headers()['idempotency-key'] ?? null, body });
      const denied = need('settings.setup.manage');
      if (denied) return denied;
      expect(body['company_id']).toBe(CO);
      const r = f.refuse.shift();
      if (r) return send(route, r.status, r.body);
      if (path === '/setup/bank-accounts' && method === 'POST') {
        if (!f.kms) return send(route, 503, { error: 'kms_not_configured' });
        const gl = GL.find((g) => g.id === body['gl_account_id']);
        if (!gl) return send(route, 404, { error: 'UNKNOWN_GL_ACCOUNT' });
        if (f.accounts.some((a) => a.gl_account_id === gl.id))
          return send(route, 409, { error: 'GL_ACCOUNT_IN_USE', message: 'in use' });
        const number = String(body['account_number']).replace(/\s+/g, '');
        const digits = String(body['bsb']).replace(/[\s-]/g, '');
        if (!/^\d{6}$/.test(digits))
          return send(route, 400, {
            error: 'invalid_request',
            message: `BSB must be 6 digits, got "${String(body['bsb'])}"`,
          });
        const opt = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : null);
        const account: Account = {
          id: id(0x18590 + f.accounts.length),
          name: String(body['name']).trim(),
          gl_account_id: gl.id,
          gl_account_code: gl.code,
          gl_account_name: gl.name,
          currency: String(body['currency']),
          bsb: `${digits.slice(0, 3)}-${digits.slice(3)}`,
          account_name: String(body['account_name']).trim(),
          account_number: `***${number.slice(-3)}`,
          apca_user_id: opt('apca_user_id'),
          aba_user_name: opt('aba_user_name'),
          aba_fi_mnemonic: opt('aba_fi_mnemonic'),
          status: 'active',
        };
        f.accounts.push(account);
        return send(route, 201, { account, replayed: false });
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

async function fillOperating(page: Page) {
  await page.getByLabel('GL account').selectOption({ label: '1010 Operating account' });
  await page.getByLabel('Name', { exact: true }).fill('Operating');
  await page.getByLabel('BSB').fill('062 000');
  await page.getByLabel('Account number').fill(NUMBER);
  await page.getByLabel('Account name').fill('Harbour & Co Pty Ltd');
  await page.getByLabel('APCA user id (optional)').fill('123456');
  await page.getByLabel('ABA user name (optional)').fill('HARBOUR CO');
  await page.getByLabel('Bank mnemonic (optional)').fill('CBA');
}

const operating: Account = {
  id: id(0x18580),
  name: 'Operating',
  gl_account_id: GL_OPERATING,
  gl_account_code: '1010',
  gl_account_name: 'Operating account',
  currency: 'AUD',
  bsb: '062-000',
  account_name: 'Harbour & Co Pty Ltd',
  account_number: '***678',
  apca_user_id: '123456',
  aba_user_name: 'HARBOUR CO',
  aba_fi_mnemonic: 'CBA',
  status: 'active',
};

for (const width of [1440, 390]) {
  test(`SS-PLAT-130: the Finance Admin follows step 4's link, adds the operating account with its ABA details and sees it masked @ ${String(width)} [T-0185]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 4)).toContainText('No bank account has been added');
    await stepItem(page, 4).getByRole('link', { name: 'Bank accounts' }).click();
    await expect(page).toHaveURL(/\/settings\/bank-accounts$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Bank accounts' })).toBeVisible();
    await expect(page.getByText('No bank account yet.')).toBeVisible();
    await expect(page.getByLabel('Currency')).toHaveValue('AUD');
    await assertPage(page, width);
    await evidence('SS-PLAT-130', `bank-accounts-empty-${String(width)}`);

    await fillOperating(page);
    await page.getByRole('button', { name: 'Add bank account' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Operating added: BSB 062-000, account ending 678.' }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: 'Bank accounts' });
    const row = table.getByRole('row', { name: /Operating/ });
    await expect(row).toContainText('ending 678');
    await expect(row).toContainText('1010 Operating account');
    await expect(row).toContainText('123456');
    await expect(row).toContainText('HARBOUR CO');
    // The full number is shown nowhere and is not kept in the form after sending.
    await expect(page.getByText(NUMBER)).toHaveCount(0);
    await expect(page.getByLabel('Account number')).toHaveValue('');
    expect(await page.content()).not.toContain(NUMBER);
    // A GL account that already has a bank account cannot be chosen again.
    await expect(page.getByRole('option', { name: /1010 Operating account/ })).toBeDisabled();
    await assertPage(page, width);
    await evidence('SS-PLAT-130', `bank-accounts-added-${String(width)}`);

    expect(f.writes).toEqual([
      {
        path: '/setup/bank-accounts',
        key: expect.stringMatching(/^.{8,}$/) as unknown,
        body: {
          company_id: CO,
          gl_account_id: GL_OPERATING,
          name: 'Operating',
          bsb: '062 000',
          account_number: NUMBER,
          account_name: 'Harbour & Co Pty Ltd',
          currency: 'AUD',
          apca_user_id: '123456',
          aba_user_name: 'HARBOUR CO',
          aba_fi_mnemonic: 'CBA',
        },
      },
    ]);

    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 4)).toContainText('Nothing is missing');
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-130: adding asks for a fresh sign-in first, and keeps nothing typed while away [T-0185]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  f.refuse.push({ status: 401, body: { error: 'step_up_required', max_age: 300 } });
  await open(page, '/settings/bank-accounts', 1440);
  await fillOperating(page);
  await page.getByRole('button', { name: 'Add bank account' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Confirm it’s you' })).toBeFocused();
  await expect(page.getByText(/changes your company’s bank details/)).toBeVisible();
  await expect(page.getByText(/type the account number again/)).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-130', 'bank-accounts-step-up-1440');
  expect(
    await page.evaluate(
      () => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }),
    ),
  ).not.toContain(NUMBER);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add bank account' })).toBeVisible();
  expect(f.accounts).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-130: refusals are said in plain words and nothing is added [T-0185]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  await open(page, '/settings/bank-accounts', 1440);
  // Nothing filled: the form says what is needed and sends nothing.
  await page.getByRole('button', { name: 'Add bank account' }).click();
  await expect(
    page.getByText(
      'Choose the GL account and fill in the name, BSB, account number and account name.',
    ),
  ).toBeVisible();
  expect(f.writes).toEqual([]);

  await fillOperating(page);
  await page.getByLabel('BSB').fill('06200');
  await page.getByRole('button', { name: 'Add bank account' }).click();
  await expect(page.getByRole('alert')).toContainText('BSB must be 6 digits');

  f.refuse.push({ status: 409, body: { error: 'GL_ACCOUNT_IN_USE', message: 'in use' } });
  await page.getByLabel('BSB').fill('062000');
  await page.getByLabel('Account number').fill(NUMBER);
  await page.getByRole('button', { name: 'Add bank account' }).click();
  await expect(page.getByRole('alert')).toContainText('This GL account already has a bank account');
  f.refuse.push({ status: 422, body: { error: 'GL_ACCOUNT_NOT_BANK', message: 'x' } });
  await page.getByLabel('Account number').fill(NUMBER);
  await page.getByRole('button', { name: 'Add bank account' }).click();
  await expect(page.getByRole('alert')).toContainText('bank account in the chart');
  expect(f.accounts).toEqual([]);
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-130: without a key service the screen says numbers cannot be stored and offers no form [T-0185]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.kms = false;
  await open(page, '/settings/bank-accounts', 1440);
  await expect(page.getByText(/cannot store bank account numbers/)).toBeVisible();
  await expect(page.getByLabel('Account number')).toHaveCount(0);
  await assertPage(page, 1440);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-130: an Accountant sees the bank accounts read-only, masked [T-0185]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'accountant');
  f.accounts.push(operating);
  await open(page, '/settings/bank-accounts', 1440);
  const table = page.getByRole('table', { name: 'Bank accounts' });
  await expect(table.getByRole('row', { name: /Operating/ })).toContainText('ending 678');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add/ })).toHaveCount(0);
  await expect(
    page.getByText(/Only the Owner or a Finance Admin can add bank accounts/),
  ).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-130', 'bank-accounts-read-only-1440');
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-130: without settings.read, Bank accounts is forbidden [T-0185]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/bank-accounts', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Bank accounts' })).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-130: Bank accounts is listed on the Settings page [T-0185]', async ({ page }) => {
  await fakeApi(page, 'fa');
  await open(page, '/settings', 1440);
  await page.getByRole('link', { name: 'Bank accounts' }).click();
  await expect(page).toHaveURL(/\/settings\/bank-accounts$/);
});
