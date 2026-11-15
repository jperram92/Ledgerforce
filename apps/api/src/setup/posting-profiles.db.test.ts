/**
 * The posting-profile matrix over HTTP (T-0187, ADR-0082, SS-PLAT-133) against a real PostgreSQL
 * as lf_app.
 * - `GET /posting-profiles/matrix?company_id=&as_of=` (settings.read) returns every active party ×
 *   product cell resolved (account, tax code, or gap), the profiles and the account choices.
 * - `PUT /posting-profiles/overrides` (settings.chart.manage, Idempotency-Key) sets one
 *   combination's override, audited when it changes something; a repeat answers changed:false.
 * - A filled gap leaves the wizard's step 7 missing list; another tenant's company is 404.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, type SeededProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const AS_OF = '2026-11-05';
let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let p: SeededProfiles;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
  clerk: { id: randomUUID(), roles: ['ar_clerk'] },
};
const party = (code: string) => p.partyProfiles.get(code) ?? '';
const product = (code: string) => p.productProfiles.get(code) ?? '';

interface Account {
  id: string;
  code: string;
  name: string;
}
interface Matrix {
  company_id: string;
  as_of: string;
  parties: {
    id: string;
    code: string;
    name: string;
    kind: string;
    control_account: Account | null;
    default_tax_code: string;
  }[];
  products: { id: string; code: string; name: string; revenue_account: Account | null }[];
  cells: {
    party_profile_id: string;
    product_profile_id: string;
    purpose: string;
    account: Account | null;
    account_source: string | null;
    tax_code: string | null;
    tax_code_source: string | null;
    override: boolean;
    gap: { reason: string; message: string } | null;
  }[];
  choices: (Account & { type: string })[];
}

function call(
  method: string,
  path: string,
  who: string,
  init: { key?: string; body?: unknown } = {},
) {
  const h: Record<string, string> = {};
  const cookie = cookies.get(who);
  if (cookie) h.cookie = `lf_session=${cookie}`;
  h['sec-fetch-site'] = 'same-origin';
  if (init.body !== undefined) h['content-type'] = 'application/json';
  if (init.key) h['idempotency-key'] = init.key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const matrix = (who = 'fa', company = f.companyId) =>
  call('GET', `/posting-profiles/matrix?company_id=${company}&as_of=${AS_OF}`, who);
const put = (body: Record<string, unknown>, who = 'fa', key: string | null = randomUUID()) =>
  call('PUT', '/posting-profiles/overrides', who, {
    ...(key === null ? {} : { key }),
    body: {
      company_id: f.companyId,
      party_profile_id: party('DOMESTIC_CUSTOMER'),
      product_profile_id: product('HARDWARE'),
      ...body,
    },
  });
const step7 = async () => {
  const r = await call('GET', `/setup/wizard?company_id=${f.companyId}&as_of=${AS_OF}`, 'fa');
  expect(r.status).toBe(200);
  const w = (await r.json()) as { steps: { step: number; missing: string[] }[] };
  return w.steps.find((s) => s.step === 7)?.missing ?? [];
};
const audits = async () =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'posting_profile_override' AND entity_id = $1`,
      [`${party('DOMESTIC_CUSTOMER')}:${product('HARDWARE')}`],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018711');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000018712');
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@profiles.test`, who],
    );
    for (const role of person.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
  }
  p = await f.inTenant(async (trx) => {
    await seedTaxCodes(trx, f.companyId);
    const seeded = await seedPostingProfiles(
      trx,
      f.companyId,
      auServicesSmb,
      new Map(Object.entries(f.acct)),
    );
    // Hardware sales archived: every customer × HARDWARE sale has no revenue account (a gap).
    await trx
      .updateTable('app.account')
      .set({ status: 'archived' })
      .where('id', '=', f.acct['4140'] ?? '')
      .execute();
    return seeded;
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, person] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: person.id,
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

describe('SS-PLAT-133: posting-profile matrix over HTTP', () => {
  it('SS-PLAT-133 GET returns the profiles, every cell resolved or marked as a gap, and the account choices', async () => {
    const r = await matrix();
    expect(r.status).toBe(200);
    const m = (await r.json()) as Matrix;
    expect(m.company_id).toBe(f.companyId);
    expect(m.as_of).toBe(AS_OF);
    expect(m.cells).toHaveLength(m.parties.length * m.products.length);
    const cell = (a: string, b: string) =>
      m.cells.find((c) => c.party_profile_id === party(a) && c.product_profile_id === product(b));
    expect(cell('DOMESTIC_CUSTOMER', 'PROFESSIONAL_SERVICES')).toMatchObject({
      purpose: 'sale',
      account: { id: f.acct['4110'], code: '4110' },
      account_source: 'product',
      tax_code: 'GST',
      override: false,
      gap: null,
    });
    expect(cell('DOMESTIC_CUSTOMER', 'HARDWARE')).toMatchObject({
      account: null,
      gap: { reason: 'account' },
    });
    expect(m.parties.find((x) => x.code === 'DOMESTIC_CUSTOMER')).toMatchObject({
      kind: 'customer',
      control_account: { code: '1200' },
    });
    expect(m.choices.map((a) => a.code)).toContain('4110');
    expect(m.choices.map((a) => a.code)).not.toContain('1200');
    expect(await step7()).toContainEqual(
      expect.stringMatching(/^Posting-profile gap: DOMESTIC_CUSTOMER × HARDWARE \(sale\)/),
    );
  });

  it('SS-PLAT-133 the Accountant reads the matrix; an AR clerk without settings.read is refused', async () => {
    expect((await matrix('accountant')).status).toBe(200);
    const r = await matrix('clerk');
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toMatch(/settings\.read/);
  });

  it('SS-PLAT-133 PUT refuses without an Idempotency-Key, without settings.chart.manage, and with an unusable account, unknown profile or tax code', async () => {
    expect((await put({ revenue_account_id: f.acct['4110'] }, 'fa', null)).status).toBe(400);
    const acct = await put({ revenue_account_id: f.acct['4110'] }, 'accountant');
    expect(acct.status).toBe(403);
    expect(JSON.stringify(await acct.json())).toMatch(/settings\.chart\.manage/);
    const control = await put({ revenue_account_id: f.acct['1200'] });
    expect(control.status).toBe(422);
    expect(await control.json()).toMatchObject({ error: 'PROFILE_ACCOUNT' });
    const unknown = await put({ party_profile_id: randomUUID(), revenue_account_id: null });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'PROFILE_UNKNOWN' });
    const tax = await put({ tax_code: 'NO-SUCH-CODE' });
    expect(tax.status).toBe(422);
    expect(await tax.json()).toMatchObject({ error: 'PROFILE_TAX_CODE' });
    const bad = await put({ revenue_account_id: 42 });
    expect(bad.status).toBe(400);
    expect(await audits()).toBe(0);
  });

  it('SS-PLAT-133 PUT fills the gap once (audited), a repeat changes nothing, and step 7 no longer lists it', async () => {
    const key = randomUUID();
    const first = await put({ revenue_account_id: f.acct['4110'] }, 'fa', key);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      party_profile_id: party('DOMESTIC_CUSTOMER'),
      product_profile_id: product('HARDWARE'),
      revenue_account_id: f.acct['4110'],
      tax_code: null,
      changed: true,
    });
    expect(await audits()).toBe(1);
    const again = await put({ revenue_account_id: f.acct['4110'] }, 'fa', key);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ changed: false });
    expect(await audits()).toBe(1);

    const m = (await (await matrix()).json()) as Matrix;
    expect(
      m.cells.find(
        (c) =>
          c.party_profile_id === party('DOMESTIC_CUSTOMER') &&
          c.product_profile_id === product('HARDWARE'),
      ),
    ).toMatchObject({
      account: { code: '4110' },
      account_source: 'override',
      override: true,
      gap: null,
    });
    const missing = await step7();
    expect(missing.some((x) => x.includes('DOMESTIC_CUSTOMER × HARDWARE'))).toBe(false);
    expect(missing.some((x) => x.includes('OVERSEAS_CUSTOMER × HARDWARE'))).toBe(true);
  });

  it('SS-PLAT-133 another tenant’s company is 404, and malformed requests are 400', async () => {
    const r = await matrix('fa', other.companyId);
    expect(r.status).toBe(404);
    const w = await call('PUT', '/posting-profiles/overrides', 'fa', {
      key: randomUUID(),
      body: {
        company_id: other.companyId,
        party_profile_id: party('DOMESTIC_CUSTOMER'),
        product_profile_id: product('HARDWARE'),
        revenue_account_id: f.acct['4110'],
      },
    });
    expect(w.status).toBe(404);
    expect((await call('GET', '/posting-profiles/matrix?company_id=nope', 'fa')).status).toBe(400);
    expect(
      (await call('GET', `/posting-profiles/matrix?company_id=${f.companyId}&as_of=5 Nov`, 'fa'))
        .status,
    ).toBe(400);
  });
});
