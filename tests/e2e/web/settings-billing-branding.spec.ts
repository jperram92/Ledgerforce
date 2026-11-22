/**
 * Invoice logo, accent colour and Stripe payout settings on the Numbering and billing screen
 * (T-0195, SS-PLAT-171, SS-PLAT-172, SS-PLAT-173, ADR-0100, RQ-0182). Vite serves the app; each
 * test fakes the API with `page.route` using the ADR-0085/ADR-0100 shapes: GET /setup/billing
 * with the payout lists, GET/PUT /setup/billing/logo and PUT /setup/billing/stripe with the
 * payout fields. The logo fixtures are real PNG files (packages/modules/ar/src/testing/logos).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';
import { ROLE_TEMPLATES } from '../../../packages/shared/src/rbac/index.ts';
import { genericnessProbe } from '../fixtures/genericness.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const WEB = join(ROOT, 'apps', 'web');
const LOGO = readFileSync(
  join(ROOT, 'packages', 'modules', 'ar', 'src', 'testing', 'logos', 'logo-plain.png'),
);
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CO = id(0x195c1);
const CLEARING = id(0x1951210);
const OPERATING = id(0x1951010);
const MERCHANT = id(0x1956120);
const BANKFEES = id(0x1956110);
const STRIPE = id(0x195a001);

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0195', timezoneId: 'Australia/Sydney', locale: 'en-AU' });

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
  fa: { user_id: id(0x1951), display_name: 'Fran Admin', role: 'finance_admin' as const },
  accountant: { user_id: id(0x1952), display_name: 'Ada Count', role: 'accountant' as const },
  clerk: { user_id: id(0x1953), display_name: 'Cal Clerk', role: 'ar_clerk' as const },
};

interface Stripe {
  clearing_account_id: string;
  fee_account_id: string | null;
  payout_account_id: string | null;
  stripe_party_id: string | null;
}

interface Fake {
  errors: string[];
  writes: { method: string; path: string; key: string | null; body: Record<string, unknown> }[];
  invoice: {
    brand_colour: string;
    brand_accent_colour: string | null;
    default_payment_terms_days: number;
    accepted_payment_methods: string[];
    has_logo: boolean;
  };
  logo: Buffer | null;
  stripe: Stripe;
  refuse: Map<string, { status: number; body: unknown }>;
  reads: number;
  logoReads: number;
}

async function fakeApi(page: Page, who: keyof typeof ME): Promise<Fake> {
  const f: Fake = {
    errors: [],
    writes: [],
    invoice: {
      brand_colour: '#0A5C8A',
      brand_accent_colour: null,
      default_payment_terms_days: 14,
      accepted_payment_methods: ['bank_transfer', 'stripe'],
      has_logo: false,
    },
    logo: null,
    stripe: {
      clearing_account_id: CLEARING,
      fee_account_id: null,
      payout_account_id: null,
      stripe_party_id: null,
    },
    refuse: new Map(),
    reads: 0,
    logoReads: 0,
  };
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|403|404|413|422)/.test(m.text()))
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
        if (path === '/setup/billing/logo') {
          f.logoReads += 1;
          if (!f.logo) return send(route, 404, { error: 'LOGO_NOT_SET' });
          return route.fulfill({
            status: 200,
            body: f.logo,
            headers: {
              'content-type': 'image/png',
              'content-security-policy': "default-src 'none'; sandbox",
              'x-content-type-options': 'nosniff',
            },
          });
        }
        f.reads += 1;
        if (path === '/setup/billing')
          return send(route, 200, {
            company_id: CO,
            series: [
              {
                code: 'ar_invoice_document',
                prefix: 'INV-',
                pad_width: 6,
                next_number: 'INV-000108',
                issued: true,
                status: 'active',
              },
            ],
            formats: [
              { code: 'STANDARD', name: 'Standard invoice', posted: true, status: 'active' },
            ],
            invoice: f.invoice,
            stripe: f.stripe,
            clearing_accounts: [{ id: CLEARING, code: '1210', name: 'Stripe clearing' }],
            fee_accounts: [
              { id: BANKFEES, code: '6110', name: 'Bank fees' },
              { id: MERCHANT, code: '6120', name: 'Merchant fees' },
            ],
            payout_accounts: [
              {
                id: OPERATING,
                code: '1010',
                name: 'Operating account',
                bank_account_name: 'Operating',
              },
            ],
            stripe_parties: [{ id: STRIPE, name: 'Stripe Payments Australia Pty Ltd' }],
          });
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
      if (path === '/setup/billing/invoice' && method === 'PUT') {
        const accent = body['brand_accent_colour'];
        f.invoice = {
          ...f.invoice,
          brand_colour: String(body['brand_colour']).toUpperCase(),
          ...(accent === undefined
            ? {}
            : { brand_accent_colour: accent === null ? null : String(accent).toUpperCase() }),
        };
        return send(route, 200, { invoice: f.invoice, changed: true });
      }
      if (path === '/setup/billing/logo' && method === 'PUT') {
        const l = body['logo'] as { content_type: string; content_base64: string } | null;
        f.logo = l ? Buffer.from(l.content_base64, 'base64') : null;
        f.invoice = { ...f.invoice, has_logo: f.logo !== null };
        return send(route, 200, { invoice: f.invoice, changed: true });
      }
      if (path === '/setup/billing/stripe' && method === 'PUT') {
        const pick = (k: keyof Stripe) =>
          typeof body[k] === 'string' ? (body[k] as string) : f.stripe[k];
        f.stripe = {
          clearing_account_id: String(body['clearing_account_id']),
          fee_account_id: pick('fee_account_id'),
          payout_account_id: pick('payout_account_id'),
          stripe_party_id: pick('stripe_party_id'),
        };
        return send(route, 200, { stripe: f.stripe, changed: true });
      }
      return send(route, 404, { error: 'not_found' });
    },
  );
  return f;
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  await page.goto(`${origin}/settings/billing`);
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

/** The image has loaded and has pixels (not a broken image). */
const loaded = (page: Page, alt: string) =>
  expect
    .poll(() => page.getByAltText(alt).evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

for (const width of [1440, 390]) {
  test(`SS-PLAT-171: the Finance Admin sets the accent colour and uploads, replaces and removes the invoice logo @ ${String(width)} [T-0195]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, width);
    const logo = page.getByRole('region', { name: 'Invoice logo' });
    await expect(logo.getByText('No logo yet: invoices show the company name only.')).toBeVisible();

    await page.getByLabel('Accent colour (optional)').fill('#f2a900');
    await page.getByRole('button', { name: 'Save invoice settings' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Invoice settings saved.' }),
    ).toBeVisible();

    // An SVG is refused before anything is sent.
    const file = page.getByLabel('Logo file');
    await file.setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
    });
    await expect(page.getByRole('alert')).toHaveText(
      'Choose a PNG or JPEG file. SVG and other formats are not accepted: export the logo as PNG.',
    );
    await expect(file).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'Save logo' }).click();

    await file.setInputFiles({ name: 'harbour-logo.png', mimeType: 'image/png', buffer: LOGO });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await loaded(page, 'The logo you chose, not saved yet');
    await assertPage(page, width);
    await evidence('SS-PLAT-171', `logo-chosen-${String(width)}`);
    await page.getByRole('button', { name: 'Save logo' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Logo saved. It is printed on invoices from now on.' }),
    ).toBeVisible();
    await loaded(page, 'The invoice logo now saved');
    await expect(page.getByAltText('The logo you chose, not saved yet')).toHaveCount(0);
    await assertPage(page, width);
    await evidence('SS-PLAT-171', `logo-saved-${String(width)}`);

    // The API's refusal of a file is said in plain words.
    f.refuse.set('/setup/billing/logo', {
      status: 400,
      body: {
        error: 'INVALID_INVOICE_SETTINGS',
        message: 'the logo file has data after the end of the image',
      },
    });
    await file.setInputFiles({ name: 'odd.png', mimeType: 'image/png', buffer: LOGO });
    await page.getByRole('button', { name: 'Save logo' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'The logo file has data after the end of the image.',
    );

    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Logo removed. Invoices show the company name only.' }),
    ).toBeVisible();
    await expect(logo.getByText('No logo yet: invoices show the company name only.')).toBeVisible();

    expect(f.writes.map((w) => [w.method, w.path])).toEqual([
      ['PUT', '/setup/billing/invoice'],
      ['PUT', '/setup/billing/logo'],
      ['PUT', '/setup/billing/logo'],
      ['PUT', '/setup/billing/logo'],
    ]);
    expect(f.writes[0]?.body).toEqual({
      company_id: CO,
      brand_colour: '#0A5C8A',
      brand_accent_colour: '#f2a900',
      default_payment_terms_days: 14,
      accepted_payment_methods: ['bank_transfer', 'stripe'],
    });
    expect(f.writes[1]?.body).toEqual({
      company_id: CO,
      logo: { content_type: 'image/png', content_base64: LOGO.toString('base64') },
    });
    expect(f.writes[3]?.body).toEqual({ company_id: CO, logo: null });
    const keys = f.writes.map((w) => w.key ?? '');
    expect(keys.every((k) => k.length >= 8)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(f.errors).toEqual([]);
  });

  test(`SS-PLAT-172: the Finance Admin chooses the Stripe payout bank account, fees account and supplier @ ${String(width)} [T-0195]`, async ({
    page,
    evidence,
  }) => {
    const f = await fakeApi(page, 'fa');
    await open(page, width);
    const payouts = page.getByRole('form', { name: 'Stripe payouts' });
    await expect(payouts).toContainText('Stripe payouts cannot be recorded until');
    await payouts.getByRole('button', { name: 'Save Stripe payout settings' }).click();
    await expect(payouts.getByRole('alert')).toContainText('Choose at least one');
    expect(f.writes).toEqual([]);

    await payouts
      .getByLabel('Payout bank account')
      .selectOption({ label: '1010 Operating account (Operating)' });
    await payouts.getByLabel('Stripe fees account').selectOption({ label: '6110 Bank fees' });
    await payouts
      .getByLabel('Stripe supplier')
      .selectOption({ label: 'Stripe Payments Australia Pty Ltd' });
    // The API refuses the fees account: said in words, nothing saved.
    f.refuse.set('/setup/billing/stripe', {
      status: 422,
      body: { error: 'INVALID_FEE_ACCOUNT', message: 'no' },
    });
    await payouts.getByRole('button', { name: 'Save Stripe payout settings' }).click();
    await expect(payouts.getByRole('alert')).toContainText(
      'Choose an expense account of this company that takes postings',
    );
    await payouts.getByLabel('Stripe fees account').selectOption({ label: '6120 Merchant fees' });
    await payouts.getByRole('button', { name: 'Save Stripe payout settings' }).click();
    await expect(
      payouts.getByRole('status').filter({ hasText: 'Stripe payout settings saved.' }),
    ).toBeVisible();
    await expect(payouts).toContainText('Payouts can be recorded.');
    await expect(payouts.getByLabel('Stripe fees account')).toHaveValue(MERCHANT);
    await assertPage(page, width);
    await evidence('SS-PLAT-172', `stripe-payouts-saved-${String(width)}`);

    expect(f.writes.map((w) => w.body)).toEqual([
      {
        company_id: CO,
        clearing_account_id: CLEARING,
        payout_account_id: OPERATING,
        fee_account_id: BANKFEES,
        stripe_party_id: STRIPE,
      },
      {
        company_id: CO,
        clearing_account_id: CLEARING,
        payout_account_id: OPERATING,
        fee_account_id: MERCHANT,
        stripe_party_id: STRIPE,
      },
    ]);
    expect(f.stripe).toEqual({
      clearing_account_id: CLEARING,
      fee_account_id: MERCHANT,
      payout_account_id: OPERATING,
      stripe_party_id: STRIPE,
    });
    expect(f.errors).toEqual([]);
  });
}

test('SS-PLAT-173: an Accountant sees the logo, accent colour and payout settings read-only [T-0195]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'accountant');
  f.invoice = { ...f.invoice, brand_accent_colour: '#F2A900', has_logo: true };
  f.logo = LOGO;
  f.stripe = {
    clearing_account_id: CLEARING,
    fee_account_id: MERCHANT,
    payout_account_id: OPERATING,
    stripe_party_id: STRIPE,
  };
  await open(page, 1440);
  await loaded(page, 'The invoice logo now saved');
  await expect(page.getByText('#F2A900')).toBeVisible();
  const payouts = page.getByRole('definition');
  await expect(payouts.filter({ hasText: '1010 Operating account (Operating)' })).toBeVisible();
  await expect(payouts.filter({ hasText: '6120 Merchant fees' })).toBeVisible();
  await expect(payouts.filter({ hasText: 'Stripe Payments Australia Pty Ltd' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByLabel('Logo file')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save|Add|Remove/ })).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-PLAT-173', 'branding-payouts-read-only-1440');
  expect(f.logoReads).toBeGreaterThan(0);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('SS-PLAT-173: without settings.read neither the settings nor the logo are read [T-0195]', async ({
  page,
  evidence,
}) => {
  const f = await fakeApi(page, 'clerk');
  await open(page, 1440);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await expect(page.getByLabel('Logo file')).toHaveCount(0);
  await expect(page.getByRole('img')).toHaveCount(0);
  await assertPage(page, 1440);
  await evidence('SS-PLAT-173', 'branding-forbidden-1440');
  expect(f.reads).toBe(0);
  expect(f.logoReads).toBe(0);
  expect(f.errors).toEqual([]);
});
