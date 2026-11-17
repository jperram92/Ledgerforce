/**
 * Bank accounts screen: change the ABA details of a company bank account, or archive it (T-0193,
 * SS-PLAT-153, ADR-0094, RQ-0176). A Finance Admin confirms their sign-in, sets the APCA user id,
 * ABA user name and bank mnemonic of the payroll account, and archives the operating account
 * after a confirmation that says what archiving does (including the remittance account on
 * invoices). Vite serves the app; each test fakes the API with `page.route`, using the shapes of
 * GET /companies and the ADR-0084/ADR-0094 routes under /setup/bank-accounts.
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
const CO = id(0x193c1);
const GL_OPERATING = id(0x19301);
const GL_PAYROLL = id(0x19302);
const OPERATING = id(0x19381);
const PAYROLL = id(0x19382);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0193', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: id(0x1931), display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1932), display_name: 'Ada Count', role: 'accountant' as const },
};

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

const accountsAtStart = (): Account[] => [
  {
    id: OPERATING,
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
  },
  {
    id: PAYROLL,
    name: 'Payroll',
    gl_account_id: GL_PAYROLL,
    gl_account_code: '1020',
    gl_account_name: 'Payroll account',
    currency: 'AUD',
    bsb: '062-001',
    account_name: 'Harbour & Co Pty Ltd',
    account_number: '***432',
    apca_user_id: null,
    aba_user_name: null,
    aba_fi_mnemonic: null,
    status: 'active',
  },
];

interface Fake {
  errors: string[];
  writes: { method: string; path: string; key: string | null; body: Record<string, unknown> }[];
  accounts: Account[];
  /** The designated remittance account (ADR-0079); archiving it releases it (ADR-0086). */
  remittance: string | null;
  /** One-off refusals of the next write, used before the fake's own rules. */
  refuse: { status: number; body: unknown }[];
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    writes: [],
    accounts: accountsAtStart(),
    remittance: OPERATING,
    refuse: [],
  };
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
        if (path === '/setup/bank-accounts')
          return send(route, 200, {
            company_id: CO,
            base_currency: 'AUD',
            kms_configured: true,
            accounts: f.accounts,
            gl_accounts: GL.map((g) => ({
              ...g,
              in_use: f.accounts.some((a) => a.status === 'active' && a.gl_account_id === g.id),
            })),
          });
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      f.writes.push({ method, path, key: req.headers()['idempotency-key'] ?? null, body });
      const denied = need('settings.setup.manage');
      if (denied) return denied;
      expect(body['company_id']).toBe(CO);
      const r = f.refuse.shift();
      if (r) return send(route, r.status, r.body);
      const m = /^\/setup\/bank-accounts\/([^/]+)\/(aba|archive)$/.exec(path);
      const account = f.accounts.find((a) => a.id === m?.[1]);
      if (!m || !account) return send(route, 404, { error: 'UNKNOWN_BANK_ACCOUNT' });
      if (m[2] === 'aba' && method === 'PUT') {
        const v = {
          apca_user_id: String(body['apca_user_id']),
          aba_user_name: String(body['aba_user_name']),
          aba_fi_mnemonic: String(body['aba_fi_mnemonic']),
        };
        if (!/^\d{6}$/.test(v.apca_user_id))
          return send(route, 400, {
            error: 'invalid_request',
            message: 'APCA user id must be 6 digits',
          });
        if (account.status !== 'active')
          return send(route, 409, { error: 'BANK_ACCOUNT_ARCHIVED', message: 'archived' });
        const changed =
          account.apca_user_id !== v.apca_user_id ||
          account.aba_user_name !== v.aba_user_name ||
          account.aba_fi_mnemonic !== v.aba_fi_mnemonic;
        Object.assign(account, v);
        return send(route, 200, { account, changed });
      }
      if (m[2] === 'archive' && method === 'POST') {
        const changed = account.status === 'active';
        const released = changed && f.remittance === account.id;
        if (released) f.remittance = null;
        account.status = 'archived';
        return send(route, 200, { account, changed, remittance_released: released });
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}/settings/bank-accounts`);
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

const change = (page: Page) =>
  page.getByRole('region', { name: 'Change ABA details or archive an account' });

for (const width of [1440, 390]) {
  test(`SS-PLAT-153: the Finance Admin sets the payroll account's ABA details, then archives the operating account after a confirmation @ ${String(width)} [T-0193]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, width);
    const section = change(page);
    await expect(section).toBeVisible();

    await section
      .getByLabel('Bank account to change')
      .selectOption({ label: 'Payroll (ending 432)' });
    // The fields start from what is stored (nothing yet for Payroll).
    await expect(section.getByLabel('APCA user id', { exact: true })).toHaveValue('');
    await section.getByLabel('APCA user id', { exact: true }).fill('654321');
    await section.getByLabel('ABA user name', { exact: true }).fill('HARBOUR PAYROLL');
    await section.getByLabel('Bank mnemonic', { exact: true }).fill('wbc');
    await assertPage(page, width);
    await evidence('SS-PLAT-153', `bank-accounts-aba-form-${String(width)}`);
    await section.getByRole('button', { name: 'Save ABA details' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'ABA details saved for Payroll.' }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: 'Bank accounts' });
    const payroll = table.getByRole('row', { name: /Payroll/ });
    await expect(payroll).toContainText('654321');
    await expect(payroll).toContainText('HARBOUR PAYROLL');
    await assertPage(page, width);
    await evidence('SS-PLAT-153', `bank-accounts-aba-saved-${String(width)}`);

    // The same values again: said, not hidden.
    await section.getByRole('button', { name: 'Save ABA details' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Payroll already had these ABA details.' }),
    ).toBeVisible();

    // Archive the operating account: a confirmation first, which says what it does.
    await section
      .getByLabel('Bank account to change')
      .selectOption({ label: 'Operating (ending 678)' });
    await expect(section.getByLabel('APCA user id', { exact: true })).toHaveValue('123456');
    await section.getByRole('button', { name: 'Archive this account' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Archive Operating?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('BSB 062-000, account ending 678');
    await expect(confirm).toContainText('printed on your invoices');
    // The earlier save message is gone: only the question is on screen.
    await expect(section.getByRole('status')).toHaveCount(0);
    await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await assertPage(page, width);
    await evidence('SS-PLAT-153', `bank-accounts-archive-confirm-${String(width)}`);
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Operating archived.' })).toContainText(
      'It was the account printed on your invoices',
    );
    await expect(table.getByRole('row', { name: /Operating/ })).toContainText('Archived');
    // An archived account is no longer offered for changes; its GL account is free again.
    await expect(section.getByRole('option', { name: 'Operating (ending 678)' })).toHaveCount(0);
    await expect(page.getByRole('option', { name: '1010 Operating account' })).toBeEnabled();
    await assertPage(page, width);
    await evidence('SS-PLAT-153', `bank-accounts-archived-${String(width)}`);

    expect(f.writes.map((w) => ({ ...w, key: w.key ? 'key' : null }))).toEqual([
      {
        method: 'PUT',
        path: `/setup/bank-accounts/${PAYROLL}/aba`,
        key: 'key',
        body: {
          company_id: CO,
          apca_user_id: '654321',
          aba_user_name: 'HARBOUR PAYROLL',
          aba_fi_mnemonic: 'WBC',
        },
      },
      {
        method: 'PUT',
        path: `/setup/bank-accounts/${PAYROLL}/aba`,
        key: 'key',
        body: {
          company_id: CO,
          apca_user_id: '654321',
          aba_user_name: 'HARBOUR PAYROLL',
          aba_fi_mnemonic: 'WBC',
        },
      },
      {
        method: 'POST',
        path: `/setup/bank-accounts/${OPERATING}/archive`,
        key: 'key',
        body: { company_id: CO },
      },
    ]);
    expect(new Set(f.writes.map((w) => w.key)).size).toBe(3);
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-153: changing or archiving asks for a fresh sign-in first; "Keep it" archives nothing [T-0193]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'fa');
  await open(page, 1440);
  const section = change(page);
  await section
    .getByLabel('Bank account to change')
    .selectOption({ label: 'Payroll (ending 432)' });
  await section.getByLabel('APCA user id', { exact: true }).fill('654321');
  await section.getByLabel('ABA user name', { exact: true }).fill('HARBOUR PAYROLL');
  await section.getByLabel('Bank mnemonic', { exact: true }).fill('WBC');
  f.refuse.push({ status: 401, body: { error: 'step_up_required', max_age: 300 } });
  await section.getByRole('button', { name: 'Save ABA details' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Confirm it’s you' })).toBeFocused();
  await expect(page.getByText(/changes your company’s bank details/)).toBeVisible();
  // While the sign-in prompt is up, nothing else on the page competes with it.
  await expect(page.getByRole('button', { name: 'Add bank account' })).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-PLAT-153', 'bank-accounts-change-step-up-1440');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toHaveCount(0);
  await expect(change(page).getByRole('button', { name: 'Save ABA details' })).toBeVisible();

  await change(page)
    .getByLabel('Bank account to change')
    .selectOption({ label: 'Operating (ending 678)' });
  await change(page).getByRole('button', { name: 'Archive this account' }).click();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(f.writes.filter((w) => w.path.endsWith('/archive'))).toEqual([]);
  expect(f.accounts.map((a) => a.status)).toEqual(['active', 'active']);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-153: refusals are said in plain words and nothing changes [T-0193]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  await open(page, 1440);
  const section = change(page);
  // Nothing chosen or filled: the form says what is needed and sends nothing.
  await section.getByRole('button', { name: 'Save ABA details' }).click();
  await expect(
    section.getByText(
      'Choose the bank account and fill in the APCA user id, ABA user name and bank mnemonic.',
    ),
  ).toBeVisible();
  expect(f.writes).toEqual([]);

  await section
    .getByLabel('Bank account to change')
    .selectOption({ label: 'Payroll (ending 432)' });
  await section.getByLabel('APCA user id', { exact: true }).fill('12345');
  await section.getByLabel('ABA user name', { exact: true }).fill('HARBOUR PAYROLL');
  await section.getByLabel('Bank mnemonic', { exact: true }).fill('WBC');
  await section.getByRole('button', { name: 'Save ABA details' }).click();
  await expect(page.getByRole('alert')).toContainText('APCA user id must be 6 digits');

  f.refuse.push({ status: 409, body: { error: 'BANK_ACCOUNT_ARCHIVED', message: 'archived' } });
  await section.getByLabel('APCA user id', { exact: true }).fill('654321');
  await section.getByRole('button', { name: 'Save ABA details' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'This bank account has been archived, so its ABA details cannot change',
  );
  f.refuse.push({ status: 404, body: { error: 'UNKNOWN_BANK_ACCOUNT', message: 'x' } });
  await section.getByRole('button', { name: 'Save ABA details' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer one of this company');
  expect(f.accounts[1]?.apca_user_id).toBeNull();
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-153: an Accountant sees no way to change or archive an account [T-0193]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'accountant');
  await open(page, 1440);
  await expect(page.getByRole('table', { name: 'Bank accounts' })).toBeVisible();
  await expect(change(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Archive|Save ABA/ })).toHaveCount(0);
  await expect(
    page.getByText(
      /Only the Owner or a Finance Admin can add bank accounts, change their ABA details or archive them/,
    ),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});
