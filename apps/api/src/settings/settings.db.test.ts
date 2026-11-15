/**
 * Setup settings over HTTP for wizard steps 1 and 3 (T-0176, SS-PLAT-129, ADR-0081, RQ-0161)
 * against a real PostgreSQL as lf_app.
 * - `GET /setup/company` (settings.read), `PUT /setup/company` and
 *   `POST /setup/company/fiscal-years` (settings.setup.manage, Idempotency-Key, audited).
 * - `GET /setup/tax` (settings.read), `PUT /setup/tax` and `POST /setup/tax/codes/standard`
 *   (settings.tax.manage, Idempotency-Key, audited).
 * - The same values again change nothing (200); the base currency is locked once a journal
 *   exists (DL-0641); an overlapping fiscal year is 409; another tenant's company is 404.
 * - After saving, the wizard's steps 1 and 3 have nothing missing.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const VALID_ABN = '51824753556';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let c = ''; // a new, empty company set up through the routes
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
const wizardMissing = async (step: number, company = c) => {
  const r = await call('GET', `/setup/wizard?company_id=${company}&as_of=2026-11-14`, 'fa');
  const w = (await r.json()) as { steps: { step: number; missing: string[] }[] };
  return w.steps.find((s) => s.step === step)?.missing;
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000017601');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000017602');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@settings.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  c = await f.inTenant(async (trx) => {
    const row = await trx
      .insertInto('app.company')
      .values({ name: 'Bay Street Studio', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
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

describe('SS-PLAT-129: company details and fiscal years over HTTP (wizard step 1)', () => {
  it('SS-PLAT-129 GET /setup/company shows the details, the fiscal years and whether the base currency is locked [T-0176]', async () => {
    const r = await call('GET', `/setup/company?company_id=${c}`, 'accountant');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      company_id: c,
      name: 'Bay Street Studio',
      legal_name: null,
      abn: null,
      base_currency: 'AUD',
      base_currency_locked: false,
      fiscal_years: [],
    });
    const fixture = await json(await call('GET', `/setup/company?company_id=${f.companyId}`, 'fa'));
    expect(fixture['fiscal_years']).toEqual([
      { label: 'FY2027', start_date: '2026-07-01', end_date: '2027-06-30' },
    ]);
  });

  it('SS-PLAT-129 PUT /setup/company saves the legal name, ABN and base currency once; the same values again change nothing [T-0176]', async () => {
    const before = await audits('company');
    const body = {
      company_id: c,
      legal_name: 'Bay Street Studio Pty Ltd',
      abn: '51 824 753 556',
      base_currency: 'AUD',
    };
    const r = await call('PUT', '/setup/company', 'fa', { body });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({
      legal_name: 'Bay Street Studio Pty Ltd',
      abn: VALID_ABN,
      base_currency: 'AUD',
      changed: true,
    });
    expect(await audits('company')).toBe(before + 1);
    const again = await call('PUT', '/setup/company', 'fa', { body });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('company')).toBe(before + 1);
  });

  it('SS-PLAT-129 POST /setup/company/fiscal-years adds a year of twelve periods; the same start again is a replay [T-0176]', async () => {
    expect(await wizardMissing(1)).toEqual(['No fiscal year has been set up (fiscal year start)']);
    const r = await call('POST', '/setup/company/fiscal-years', 'fa', {
      body: { company_id: c, start: '2026-07-01' },
    });
    expect(r.status).toBe(201);
    expect(await json(r)).toEqual({
      label: 'FY2027',
      start_date: '2026-07-01',
      end_date: '2027-06-30',
      periods: 12,
      replayed: false,
    });
    const again = await call('POST', '/setup/company/fiscal-years', 'fa', {
      body: { company_id: c, start: '2026-07-01' },
    });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ label: 'FY2027', replayed: true });
    expect(await wizardMissing(1)).toEqual([]);
  });

  it('SS-PLAT-129 refusals: overlap 409, bad ABN checksum 422, malformed 400, no key 400, base currency locked 409 [T-0176]', async () => {
    const overlap = await call('POST', '/setup/company/fiscal-years', 'fa', {
      body: { company_id: c, start: '2027-01-01' },
    });
    expect(overlap.status).toBe(409);
    expect((await json(overlap))['error']).toBe('FISCAL_YEAR_OVERLAP');
    const notFirst = await call('POST', '/setup/company/fiscal-years', 'fa', {
      body: { company_id: c, start: '2027-07-15' },
    });
    expect(notFirst.status).toBe(400);

    const base = { company_id: c, legal_name: 'Bay Street Studio Pty Ltd', base_currency: 'AUD' };
    const checksum = await call('PUT', '/setup/company', 'fa', {
      body: { ...base, abn: '51824753557' },
    });
    expect(checksum.status).toBe(422);
    expect((await json(checksum))['error']).toBe('INVALID_ABN');
    const short = await call('PUT', '/setup/company', 'fa', { body: { ...base, abn: '123' } });
    expect(short.status).toBe(400);
    const noName = await call('PUT', '/setup/company', 'fa', {
      body: { ...base, legal_name: '  ', abn: VALID_ABN },
    });
    expect(noName.status).toBe(400);
    const noKey = await call('PUT', '/setup/company', 'fa', {
      key: null,
      body: { ...base, abn: VALID_ABN },
    });
    expect(noKey.status).toBe(400);
    expect((await json(noKey))['error']).toBe('idempotency_key_required');

    // A journal makes the base currency part of posted history (DL-0641).
    await f.inTenant((trx) =>
      f.insertEntry(trx, [
        { code: '6200', debit: '10.0000' },
        { code: '1010', credit: '10.0000' },
      ]),
    );
    const view = await json(await call('GET', `/setup/company?company_id=${f.companyId}`, 'fa'));
    expect(view['base_currency_locked']).toBe(true);
    const locked = await call('PUT', '/setup/company', 'fa', {
      body: {
        company_id: f.companyId,
        legal_name: 'Harbour & Co Pty Ltd',
        abn: VALID_ABN,
        base_currency: 'NZD',
      },
    });
    expect(locked.status).toBe(409);
    expect((await json(locked))['error']).toBe('BASE_CURRENCY_LOCKED');
    const sameCurrency = await call('PUT', '/setup/company', 'fa', {
      body: {
        company_id: f.companyId,
        legal_name: 'Harbour & Co Pty Ltd',
        abn: VALID_ABN,
        base_currency: 'AUD',
      },
    });
    expect(sameCurrency.status).toBe(200);
  });

  it('SS-PLAT-129 permissions and tenancy: Accountant may read not write, AR clerk may not read, another tenant is 404 [T-0176]', async () => {
    const body = { company_id: c, legal_name: 'X Pty Ltd', abn: VALID_ABN, base_currency: 'AUD' };
    expect((await call('PUT', '/setup/company', 'accountant', { body })).status).toBe(403);
    expect(
      (
        await call('POST', '/setup/company/fiscal-years', 'accountant', {
          body: { company_id: c, start: '2027-07-01' },
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', `/setup/company?company_id=${c}`, 'clerk')).status).toBe(403);
    expect((await call('GET', `/setup/company?company_id=${other.companyId}`, 'fa')).status).toBe(
      404,
    );
    expect(
      (
        await call('PUT', '/setup/company', 'fa', {
          body: { ...body, company_id: other.companyId },
        })
      ).status,
    ).toBe(404);
  });
});

describe('SS-PLAT-129: tax settings and the standard tax codes over HTTP (wizard step 3)', () => {
  it('SS-PLAT-129 GET /setup/tax shows nothing set and no codes for a new company [T-0176]', async () => {
    const r = await call('GET', `/setup/tax?company_id=${c}`, 'accountant');
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body).toMatchObject({ company_id: c, settings: null, codes: [] });
    expect(body['as_of']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('SS-PLAT-129 PUT /setup/tax and POST /setup/tax/codes/standard complete step 3; repeats change nothing [T-0176]', async () => {
    expect(await wizardMissing(3)).toEqual([
      'No tax code is in force on 2026-11-14',
      'The GST accounting basis (cash or accrual) has not been set',
      'The BAS reporting frequency (monthly, quarterly or annual) has not been set',
    ]);
    const before = await audits('tax_settings');
    const body = {
      company_id: c,
      effective_from: '2026-07-01',
      gst_basis: 'accrual',
      bas_frequency: 'quarterly',
    };
    const r = await call('PUT', '/setup/tax', 'fa', { body });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      settings: { effective_from: '2026-07-01', gst_basis: 'accrual', bas_frequency: 'quarterly' },
      changed: true,
    });
    expect(await audits('tax_settings')).toBe(before + 1);
    const again = await call('PUT', '/setup/tax', 'fa', { body });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('tax_settings')).toBe(before + 1);

    const seed = await call('POST', '/setup/tax/codes/standard', 'fa', {
      body: { company_id: c },
    });
    expect(seed.status).toBe(201);
    const inserted = (await json(seed))['inserted'];
    expect(inserted).toBeGreaterThan(0);
    const reseed = await call('POST', '/setup/tax/codes/standard', 'fa', {
      body: { company_id: c },
    });
    expect(reseed.status).toBe(200);
    expect(await json(reseed)).toEqual({ inserted: 0 });
    expect(await wizardMissing(3)).toEqual([]);

    const view = await json(await call('GET', `/setup/tax?company_id=${c}`, 'fa'));
    expect(view['settings']).toEqual({
      effective_from: '2026-07-01',
      gst_basis: 'accrual',
      bas_frequency: 'quarterly',
    });
    const codes = view['codes'] as { code: string; rate: string; status: string }[];
    expect(codes).toHaveLength(inserted as number);
    expect(codes.find((x) => x.code === 'GST')).toMatchObject({
      code: 'GST',
      rate: '0.10000000',
      status: 'active',
    });
  });

  it('SS-PLAT-129 tax refusals and permissions: not a month start 400, Accountant 403, another tenant 404 [T-0176]', async () => {
    const body = {
      company_id: c,
      effective_from: '2026-07-15',
      gst_basis: 'cash',
      bas_frequency: 'monthly',
    };
    const bad = await call('PUT', '/setup/tax', 'fa', { body });
    expect(bad.status).toBe(400);
    expect((await json(bad))['error']).toBe('INVALID_TAX_SETTINGS');
    const ok = { ...body, effective_from: '2026-08-01' };
    expect((await call('PUT', '/setup/tax', 'accountant', { body: ok })).status).toBe(403);
    expect(
      (
        await call('POST', '/setup/tax/codes/standard', 'accountant', {
          body: { company_id: c },
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', `/setup/tax?company_id=${c}`, 'clerk')).status).toBe(403);
    expect(
      (await call('PUT', '/setup/tax', 'fa', { body: { ...ok, company_id: other.companyId } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/setup/tax/codes/standard', 'fa', {
          body: { company_id: other.companyId },
        })
      ).status,
    ).toBe(404);
  });
});
