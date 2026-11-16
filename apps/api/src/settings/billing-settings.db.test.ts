/**
 * Numbering and billing over HTTP for wizard step 8 (T-0186, SS-PLAT-131, ADR-0085, RQ-0167)
 * against a real PostgreSQL as lf_app.
 * - `GET /setup/billing` (settings.read): series, billing formats, invoice settings, the Stripe
 *   clearing account and the accounts that may be it.
 * - `PUT /setup/billing/series`, `POST /setup/billing/formats/standard`,
 *   `PUT /setup/billing/invoice`, `PUT /setup/billing/stripe` (settings.setup.manage,
 *   Idempotency-Key, audited when something changed; the same values again change nothing).
 * - A series' prefix and width are fixed once a number is issued (409); the clearing account must
 *   be an active, postable, non-control asset account of the company (422); another tenant's
 *   company is 404.
 * - After saving, the wizard's step 8 has nothing missing.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { nextNumber } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let co = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
  clerk: { id: randomUUID(), roles: ['ar_clerk'] },
};

function call(
  method: string,
  path: string,
  who: string,
  init: { key?: string | null; body?: unknown } = {},
) {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
  const cookie = cookies.get(who);
  if (cookie) h.cookie = `lf_session=${cookie}`;
  if (init.body !== undefined) h['content-type'] = 'application/json';
  const key = init.key === undefined ? `k-${randomUUID()}` : init.key;
  if (key !== null && method !== 'GET') h['idempotency-key'] = key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const audits = async (entity: string) =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = $1',
      [entity],
    )
  ).rows[0]?.n ?? 0;
const wizardMissing = async (step: number) => {
  const r = await call('GET', `/setup/wizard?company_id=${co}&as_of=2026-11-14`, 'fa');
  const w = (await r.json()) as { steps: { step: number; missing: string[] }[] };
  return w.steps.find((s) => s.step === step)?.missing;
};
const acct = (code: string) => f.chart(co).acct[code] ?? '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018611');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000018612');
  co = f.companyId;
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@billing.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-131: numbering and billing over HTTP (wizard step 8)', () => {
  it('SS-PLAT-131 GET /setup/billing shows nothing set up yet and the accounts that may be the Stripe clearing account [T-0186]', async () => {
    const r = await call('GET', `/setup/billing?company_id=${co}`, 'accountant');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({
      company_id: co,
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
    });
    const candidates = b['clearing_accounts'] as { id: string; code: string; name: string }[];
    expect(candidates).toContainEqual({ id: acct('1210'), code: '1210', name: 'Stripe clearing' });
    const codes = candidates.map((a) => a.code);
    // Not the AR control account, not a contra-asset, not an expense.
    expect(codes).not.toContain('1200');
    expect(codes).not.toContain('1510');
    expect(codes.every((c) => c.startsWith('1'))).toBe(true);
    expect(await wizardMissing(8)).toEqual([
      'No invoice number series (ar_invoice_document) has been set up',
      'No billing format has been set up',
      'Invoice branding (a brand colour) has not been set',
      'Default payment terms have not been set',
      'No accepted payment method (bank transfer or Stripe) has been chosen',
    ]);
  });

  it('SS-PLAT-131 PUT /setup/billing/series creates the invoice and credit-note series; the same values again change nothing [T-0186]', async () => {
    const before = await audits('number_series');
    const body = { company_id: co, code: 'ar_invoice_document', prefix: 'INV-', pad_width: 6 };
    const r = await call('PUT', '/setup/billing/series', 'fa', { body });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      series: {
        code: 'ar_invoice_document',
        prefix: 'INV-',
        pad_width: 6,
        next_number: 'INV-000001',
        issued: false,
        status: 'active',
      },
      changed: true,
    });
    expect(await audits('number_series')).toBe(before + 1);
    const again = await call('PUT', '/setup/billing/series', 'fa', { body });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('number_series')).toBe(before + 1);
    const cn = await call('PUT', '/setup/billing/series', 'fa', {
      body: { company_id: co, code: 'ar_credit_note_document', prefix: 'CN-', pad_width: 6 },
    });
    expect(cn.status).toBe(200);
    const read = await json(await call('GET', `/setup/billing?company_id=${co}`, 'fa'));
    expect((read['series'] as { code: string }[]).map((s) => s.code)).toEqual([
      'ar_credit_note_document',
      'ar_invoice_document',
    ]);
  });

  it('SS-PLAT-131 a series is refused in plain words: unknown code, bad prefix, and a change after a number was issued [T-0186]', async () => {
    const bad = await call('PUT', '/setup/billing/series', 'fa', {
      body: { company_id: co, code: 'journal', prefix: 'J-', pad_width: 6 },
    });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: 'invalid_request' });
    const prefix = await call('PUT', '/setup/billing/series', 'fa', {
      body: { company_id: co, code: 'ar_invoice_document', prefix: 'INV 1', pad_width: 6 },
    });
    expect(prefix.status).toBe(400);
    expect(await json(prefix)).toMatchObject({ error: 'INVALID_NUMBER_SERIES' });
    await f.inTenant((trx) => nextNumber(trx, co, 'ar_credit_note_document'));
    const used = await call('PUT', '/setup/billing/series', 'fa', {
      body: { company_id: co, code: 'ar_credit_note_document', prefix: 'CR-', pad_width: 6 },
    });
    expect(used.status).toBe(409);
    expect(await json(used)).toMatchObject({ error: 'NUMBER_SERIES_IN_USE' });
    const read = await json(await call('GET', `/setup/billing?company_id=${co}`, 'fa'));
    expect(read['series']).toContainEqual({
      code: 'ar_credit_note_document',
      prefix: 'CN-',
      pad_width: 6,
      next_number: 'CN-000002',
      issued: true,
      status: 'active',
    });
  });

  it('SS-PLAT-131 POST /setup/billing/formats/standard adds the standard formats once [T-0186]', async () => {
    const r = await call('POST', '/setup/billing/formats/standard', 'fa', {
      body: { company_id: co },
    });
    expect(r.status).toBe(201);
    const { inserted } = await json(r);
    expect(inserted).toBeGreaterThan(0);
    const again = await call('POST', '/setup/billing/formats/standard', 'fa', {
      body: { company_id: co },
    });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ inserted: 0 });
    const read = await json(await call('GET', `/setup/billing?company_id=${co}`, 'fa'));
    const formats = read['formats'] as { code: string; name: string; posted: boolean }[];
    expect(formats).toHaveLength(inserted as number);
    expect(formats).toContainEqual({
      code: 'STANDARD',
      name: 'Standard invoice',
      posted: true,
      status: 'active',
    });
  });

  it('SS-PLAT-131 PUT /setup/billing/invoice saves the brand colour, terms and payment methods; a repeat changes nothing; bad values are refused [T-0186]', async () => {
    const before = await audits('ar_settings');
    const body = {
      company_id: co,
      brand_colour: '#0a5c8a',
      default_payment_terms_days: 14,
      accepted_payment_methods: ['stripe', 'bank_transfer'],
    };
    const r = await call('PUT', '/setup/billing/invoice', 'fa', { body });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      invoice: {
        brand_colour: '#0A5C8A',
        brand_accent_colour: null,
        default_payment_terms_days: 14,
        accepted_payment_methods: ['bank_transfer', 'stripe'],
        has_logo: false,
      },
      changed: true,
    });
    expect(await audits('ar_settings')).toBe(before + 1);
    const again = await call('PUT', '/setup/billing/invoice', 'fa', {
      body: { ...body, brand_colour: '#0A5C8A' },
    });
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('ar_settings')).toBe(before + 1);
    const colour = await call('PUT', '/setup/billing/invoice', 'fa', {
      body: { ...body, brand_colour: 'blue' },
    });
    expect(colour.status).toBe(400);
    expect(await json(colour)).toMatchObject({ error: 'INVALID_INVOICE_SETTINGS' });
    const missing = await call('PUT', '/setup/billing/invoice', 'fa', {
      body: { company_id: co, brand_colour: '#0A5C8A' },
    });
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({ error: 'invalid_request' });
    // Stripe is accepted but not set up yet: the wizard says so.
    expect(await wizardMissing(8)).toEqual([
      'Stripe is an accepted payment method but Stripe is not set up (no clearing account)',
    ]);
  });

  it('SS-PLAT-131 PUT /setup/billing/stripe sets the clearing account; unsuitable accounts are refused; then step 8 has nothing missing [T-0186]', async () => {
    // AR control, an expense, a contra-asset, another tenant's account, no account at all.
    for (const bad of [
      acct('1200'),
      acct('6110'),
      acct('1510'),
      other.chart(other.companyId).acct['1210'] ?? '',
      randomUUID(),
    ]) {
      expect(bad).not.toBe('');
      const r = await call('PUT', '/setup/billing/stripe', 'fa', {
        body: { company_id: co, clearing_account_id: bad },
      });
      expect(r.status, bad).toBe(422);
      expect(await json(r)).toMatchObject({ error: 'INVALID_CLEARING_ACCOUNT' });
    }
    const before = await audits('stripe_settings');
    const body = { company_id: co, clearing_account_id: acct('1210') };
    const r = await call('PUT', '/setup/billing/stripe', 'fa', { body });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ stripe: { clearing_account_id: acct('1210') }, changed: true });
    const again = await call('PUT', '/setup/billing/stripe', 'fa', { body });
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('stripe_settings')).toBe(before + 1);
    expect(await wizardMissing(8)).toEqual([]);
  });

  it("SS-PLAT-131 writes need settings.setup.manage and an Idempotency-Key; reads need settings.read; another tenant's company is 404 [T-0186]", async () => {
    const body = { company_id: co, code: 'ar_invoice_document', prefix: 'INV-', pad_width: 6 };
    const acc = await call('PUT', '/setup/billing/series', 'accountant', { body });
    expect(acc.status).toBe(403);
    expect(await json(acc)).toMatchObject({ permission: 'settings.setup.manage' });
    const clerk = await call('GET', `/setup/billing?company_id=${co}`, 'clerk');
    expect(clerk.status).toBe(403);
    for (const [method, path, b] of [
      ['PUT', '/setup/billing/series', body],
      ['POST', '/setup/billing/formats/standard', { company_id: co }],
      ['PUT', '/setup/billing/invoice', { company_id: co }],
      ['PUT', '/setup/billing/stripe', { company_id: co }],
    ] as const) {
      const r = await call(method, path, 'fa', { key: null, body: b });
      expect(r.status, path).toBe(400);
      expect(await json(r)).toEqual({ error: 'idempotency_key_required' });
    }
    const foreign = other.companyId;
    expect((await call('GET', `/setup/billing?company_id=${foreign}`, 'fa')).status).toBe(404);
    const r = await call('PUT', '/setup/billing/series', 'fa', {
      body: { ...body, company_id: foreign },
    });
    expect(r.status).toBe(404);
    expect(await json(r)).toMatchObject({ error: 'UNKNOWN_COMPANY' });
  });
});
