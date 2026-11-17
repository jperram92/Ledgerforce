/**
 * Numbering and billing screen for setup wizard step 8 (T-0186, SS-PLAT-131, ADR-0085). A Finance
 * Admin follows the wizard's link, sets up the invoice and credit-note numbers, adds the standard
 * billing formats, saves the brand colour, payment terms and payment methods, and chooses the
 * Stripe clearing account; afterwards the wizard says nothing is missing for step 8. Vite serves
 * the app; each test fakes the API with `page.route`, using the response shapes of GET /companies,
 * GET /setup/wizard and the ADR-0085 routes under /setup/billing. The fake derives step 8's
 * missing list from its own state with the wording of @ledgerforce/setup's validator.
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
const CO = id(0x186c1);
const CLEARING = id(0x1861210);
const SAVER = id(0x1861020);
const TODAY = '2026-11-16';
const INV = 'ar_invoice_document';
const CN = 'ar_credit_note_document';

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0186', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: id(0x1861), display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1862), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1863), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
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

/** A subset of the AU catalogue (documents' AU_BILLING_FORMATS) as GET /setup/billing lists it. */
const STANDARD_FORMATS = [
  { code: 'BATCH', name: 'Batch billing run', posted: true, status: 'active' },
  { code: 'CREDIT_NOTE', name: 'Credit note', posted: true, status: 'active' },
  { code: 'PROFORMA', name: 'Pro-forma / quote', posted: false, status: 'active' },
  { code: 'STANDARD', name: 'Standard invoice', posted: true, status: 'active' },
];

interface Series {
  code: string;
  prefix: string;
  pad_width: number;
  next_number: string;
  issued: boolean;
  status: string;
}

interface Fake {
  errors: string[];
  writes: { method: string; path: string; key: string | null; body: Record<string, unknown> }[];
  series: Series[];
  formats: typeof STANDARD_FORMATS;
  invoice: {
    brand_colour: string | null;
    brand_accent_colour: null;
    default_payment_terms_days: number | null;
    accepted_payment_methods: string[] | null;
    has_logo: boolean;
  };
  stripe: { clearing_account_id: string } | null;
  /** T-0183: an approved remittance account is in force (it is set on its own screen). */
  remittance: boolean;
  refuse: Map<string, { status: number; body: unknown }>;
  reads: number;
}

function missing8(f: Fake): string[] {
  const out: string[] = [];
  if (!f.series.some((s) => s.code === INV && s.status === 'active'))
    out.push(`No invoice number series (${INV}) has been set up`);
  if (f.formats.length === 0) out.push('No billing format has been set up');
  if (!f.invoice.brand_colour) out.push('Invoice branding (a brand colour) has not been set');
  if (f.invoice.default_payment_terms_days === null)
    out.push('Default payment terms have not been set');
  if (!f.invoice.accepted_payment_methods?.length)
    out.push('No accepted payment method (bank transfer or Stripe) has been chosen');
  if (f.invoice.accepted_payment_methods?.includes('stripe') && !f.stripe)
    out.push('Stripe is an accepted payment method but Stripe is not set up (no clearing account)');
  if (f.invoice.accepted_payment_methods?.includes('bank_transfer') && !f.remittance)
    out.push('No remittance bank account has been chosen for bank transfer');
  return out;
}

const pad = (prefix: string, n: number, width: number) =>
  `${prefix}${String(n).padStart(width, '0')}`;

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    writes: [],
    series: [],
    formats: [],
    invoice: {
      brand_colour: null,
      brand_accent_colour: null,
      default_payment_terms_days: null,
      accepted_payment_methods: null,
      has_logo: false,
    },
    stripe: null,
    // Approved beforehand on the remittance account screen (T-0183, maker-checker).
    remittance: true,
    refuse: new Map(),
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
        expect(url.searchParams.get('company_id')).toBe(CO);
        f.reads += 1;
        if (path === '/setup/billing')
          return send(route, 200, {
            company_id: CO,
            series: [...f.series].sort((a, b) => a.code.localeCompare(b.code)),
            formats: f.formats,
            invoice: f.invoice,
            stripe: f.stripe,
            clearing_accounts: [
              { id: SAVER, code: '1020', name: 'Business saver' },
              { id: CLEARING, code: '1210', name: 'Stripe clearing' },
            ],
          });
        if (path === '/setup/wizard') {
          const miss = (n: number) => (n === 8 ? missing8(f) : []);
          return send(route, 200, {
            company_id: CO,
            as_of: TODAY,
            complete: false,
            steps: TITLES.map((title, i) => ({
              step: i + 1,
              title,
              status: i === 7 ? 'in_progress' : i < 7 ? 'complete' : 'not_started',
              locked: i > 7,
              valid: miss(i + 1).length === 0,
              missing: miss(i + 1),
              outcome: i < 7 ? 'completed' : null,
              reason: null,
              completed_at: i < 7 ? '2026-11-16T00:00:00Z' : null,
              completed_by: i < 7 ? ME.fa.user_id : null,
            })),
          });
        }
        return send(route, 404, { error: 'not_found' });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      f.writes.push({ method, path, key: req.headers()['idempotency-key'] ?? null, body });
      const denied = need('settings.setup.manage');
      if (denied) return denied;
      expect(body['company_id']).toBe(CO);
      const r = f.refuse.get(path);
      if (r) {
        f.refuse.delete(path);
        return send(route, r.status, r.body);
      }
      if (path === '/setup/billing/series' && method === 'PUT') {
        const code = String(body['code']);
        const prefix = String(body['prefix']);
        const width = Number(body['pad_width']);
        const now = f.series.find((s) => s.code === code);
        if (now?.issued && (now.prefix !== prefix || now.pad_width !== width))
          return send(route, 409, { error: 'NUMBER_SERIES_IN_USE', message: 'in use' });
        const next: Series = {
          code,
          prefix,
          pad_width: width,
          next_number: pad(prefix, 1, width),
          issued: false,
          status: 'active',
        };
        const changed = !now || now.prefix !== prefix || now.pad_width !== width;
        f.series = [...f.series.filter((s) => s.code !== code), now && !changed ? now : next];
        return send(route, 200, { series: now && !changed ? now : next, changed });
      }
      if (path === '/setup/billing/formats/standard' && method === 'POST') {
        const inserted = f.formats.length === 0 ? STANDARD_FORMATS.length : 0;
        f.formats = [...STANDARD_FORMATS];
        return send(route, inserted ? 201 : 200, { inserted });
      }
      if (path === '/setup/billing/invoice' && method === 'PUT') {
        const colour = String(body['brand_colour']);
        if (!/^#[0-9a-f]{6}$/i.test(colour))
          return send(route, 400, {
            error: 'INVALID_INVOICE_SETTINGS',
            message: 'the brand colour must be #RRGGBB',
          });
        const methods = (body['accepted_payment_methods'] as string[]).slice().sort();
        f.invoice = {
          ...f.invoice,
          brand_colour: colour.toUpperCase(),
          default_payment_terms_days: Number(body['default_payment_terms_days']),
          accepted_payment_methods: methods,
        };
        return send(route, 200, { invoice: f.invoice, changed: true });
      }
      if (path === '/setup/billing/stripe' && method === 'PUT') {
        const acct = String(body['clearing_account_id']);
        if (acct !== CLEARING && acct !== SAVER)
          return send(route, 422, { error: 'INVALID_CLEARING_ACCOUNT', message: 'no' });
        const changed = f.stripe?.clearing_account_id !== acct;
        f.stripe = { clearing_account_id: acct };
        return send(route, 200, { stripe: f.stripe, changed });
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

for (const width of [1440, 390]) {
  test(`SS-PLAT-131: Numbering and billing: the Finance Admin follows step 8's link and sets up numbers, formats, invoices and Stripe @ ${String(width)} [T-0186]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, '/settings/setup', width);
    await expect(stepItem(page, 8)).toContainText(
      'No invoice number series (ar_invoice_document) has been set up',
    );
    await stepItem(page, 8).getByRole('link', { name: 'Numbering and billing' }).click();
    await expect(page).toHaveURL(/\/settings\/billing$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Numbering and billing' }),
    ).toBeVisible();
    await expect(page.getByText('Not set up yet: invoices cannot be numbered.')).toBeVisible();
    await expect(page.getByText('No billing formats yet.')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-131', `billing-empty-${String(width)}`);

    // Invoice numbers: the suggested prefix and digits, previewed before saving.
    await expect(page.getByLabel('Invoice number prefix')).toHaveValue('INV-');
    await expect(page.getByText('Numbers will look like INV-000001.')).toBeVisible();
    await page.getByRole('button', { name: 'Save invoice numbering' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Invoice numbering saved: the next is INV-000001.' }),
    ).toBeVisible();
    await page.getByLabel('Credit note number prefix').fill('CR-');
    await page.getByLabel('Credit note number digits').fill('5');
    await expect(page.getByText('Numbers will look like CR-00001.')).toBeVisible();
    await page.getByRole('button', { name: 'Save credit note numbering' }).click();
    await expect(page.getByText('The first credit note will be CR-00001.')).toBeVisible();

    await page.getByRole('button', { name: 'Add the standard billing formats' }).click();
    await expect(
      page.getByRole('status').filter({
        hasText: `${String(STANDARD_FORMATS.length)} billing formats added.`,
      }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Billing formats' })).toContainText(
      'Standard invoice',
    );

    // Stripe is only asked for once card payments are accepted.
    await expect(page.getByText(/Only needed when customers can pay by card/)).toBeVisible();
    await page.getByLabel('Brand colour').fill('#0a5c8a');
    await page.getByLabel('Payment terms (days)').fill('14');
    await page.getByRole('checkbox', { name: /^Bank transfer/ }).check();
    await page.getByRole('checkbox', { name: /^Card through Stripe/ }).check();
    await page.getByRole('button', { name: 'Save invoice settings' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Invoice settings saved.' }),
    ).toBeVisible();
    await page
      .getByLabel('Stripe clearing account')
      .selectOption({ label: '1210 Stripe clearing' });
    await page.getByRole('button', { name: 'Save Stripe clearing account' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Stripe clearing account saved.' }),
    ).toBeVisible();
    await expect(page.getByText('Stripe clearing account: 1210 Stripe clearing.')).toBeVisible();
    await assertPage(page, width);
    await evidence('SS-PLAT-131', `billing-saved-${String(width)}`);

    expect(f.writes.map((w) => [w.method, w.path, w.body])).toEqual([
      ['PUT', '/setup/billing/series', { company_id: CO, code: INV, prefix: 'INV-', pad_width: 6 }],
      ['PUT', '/setup/billing/series', { company_id: CO, code: CN, prefix: 'CR-', pad_width: 5 }],
      ['POST', '/setup/billing/formats/standard', { company_id: CO }],
      [
        'PUT',
        '/setup/billing/invoice',
        {
          company_id: CO,
          brand_colour: '#0a5c8a',
          default_payment_terms_days: 14,
          accepted_payment_methods: ['bank_transfer', 'stripe'],
        },
      ],
      ['PUT', '/setup/billing/stripe', { company_id: CO, clearing_account_id: CLEARING }],
    ]);
    const keys = f.writes.map((w) => w.key ?? '');
    expect(keys.every((k) => k.length >= 8)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);

    await page.getByRole('link', { name: 'Back to Set up your company' }).click();
    await expect(stepItem(page, 8)).toContainText('Nothing is missing');
    await expect(
      page.getByRole('button', { name: 'Complete step 8: Numbering and billing' }),
    ).toBeVisible();
    if (width === 1440) await evidence('SS-PLAT-131', 'wizard-step-8-ready-1440');
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-131: Numbering and billing refusals are said in plain words, and incomplete forms send nothing [T-0186]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'fa');
  f.series.push({
    code: CN,
    prefix: 'CN-',
    pad_width: 6,
    next_number: 'CN-000042',
    issued: true,
    status: 'active',
  });
  f.refuse.set('/setup/billing/series', {
    status: 409,
    body: { error: 'NUMBER_SERIES_IN_USE', message: 'in use' },
  });
  await open(page, '/settings/billing', 1440);
  // An issued series is shown, not offered for change.
  await expect(page.getByText(/The next credit note will be CN-000042\. The prefix/)).toBeVisible();
  await expect(page.getByLabel('Credit note number prefix')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save invoice numbering' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'A document has already been given a number from this series',
  );
  await page.getByLabel('Invoice number digits').fill('30');
  await page.getByRole('button', { name: 'Save invoice numbering' }).click();
  await expect(
    page.getByText('Write the number of digits as a whole number from 1 to 18.'),
  ).toBeVisible();

  // Nothing chosen: said, not sent.
  await page.getByRole('button', { name: 'Save invoice settings' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /at least one way/ })).toBeVisible();
  await page.getByLabel('Brand colour').fill('navy');
  await page.getByLabel('Payment terms (days)').fill('30');
  await page.getByRole('checkbox', { name: /^Bank transfer/ }).check();
  await page.getByRole('button', { name: 'Save invoice settings' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The brand colour must be #RRGGBB.' }),
  ).toBeVisible();
  expect(f.writes.map((w) => w.path)).toEqual(['/setup/billing/series', '/setup/billing/invoice']);
  expect(f.invoice.brand_colour).toBeNull();
  await assertPage(page, 1440);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-131: an Accountant sees Numbering and billing read-only [T-0186]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'accountant');
  f.series.push({
    code: INV,
    prefix: 'INV-',
    pad_width: 6,
    next_number: 'INV-000108',
    issued: true,
    status: 'active',
  });
  f.formats = [...STANDARD_FORMATS];
  f.invoice = {
    ...f.invoice,
    brand_colour: '#0A5C8A',
    default_payment_terms_days: 14,
    accepted_payment_methods: ['bank_transfer', 'stripe'],
  };
  f.stripe = { clearing_account_id: CLEARING };
  await open(page, '/settings/billing', 1440);
  await expect(page.getByText(/The next invoice will be INV-000108/)).toBeVisible();
  await expect(page.getByText('14 days after the invoice date')).toBeVisible();
  await expect(page.getByText('bank transfer or card through Stripe')).toBeVisible();
  await expect(page.getByText('Stripe clearing account: 1210 Stripe clearing.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save|Add/ })).toHaveCount(0);
  await expect(page.getByText(/Only the Owner or a Finance Admin can change/)).toBeVisible();
  await assertPage(page, 1440);
  await evidence('SS-PLAT-131', 'billing-read-only-1440');
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-131: without settings.read, Numbering and billing is forbidden [T-0186]', async ({
  page,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, '/settings/billing', 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByLabel('Invoice number prefix')).toHaveCount(0);
  expect(f.reads).toBe(0);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-131: Numbering and billing and Approval amounts are listed on the Settings page [T-0186]', async ({
  page,
}) => {
  await fakeApi(page, 'fa');
  await open(page, '/settings', 1440);
  await expect(page.getByRole('link', { name: 'Approval amounts' })).toBeVisible();
  await page.getByRole('link', { name: 'Numbering and billing' }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
});
