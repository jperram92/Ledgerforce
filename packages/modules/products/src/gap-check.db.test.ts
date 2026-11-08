/**
 * T-0039 — posting-profile resolution and gap check against PostgreSQL, as lf_app inside a tenant
 * transaction (design §4.4, RQ-0097, DL-0260). Loads the T-0038 AU template, links parties and
 * products, and proves the resolver and the gap check read the stored matrix (overrides, slots,
 * archived profiles), write nothing and never see another tenant's profiles.
 *
 * SS-UC01-06 (gap refused, nothing posted, gap listed), SS-PLAT-104, SS-PLAT-105.
 */
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auTaxCodes, loadTaxCodes } from '@ledgerforce/tax';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostingProfileResolutionError } from './matrix.ts';
import { createProduct, loadPostingProfileTemplate } from './posting-profiles.ts';
import { postingProfileGapCheck, resolvePartyProductPosting } from './profile-resolution.ts';
import { auServicesSmbProfiles } from './profiles.template.ts';

const T = '01900000-0000-7000-8000-0000000039aa';
const OTHER = '01900000-0000-7000-8000-0000000039bb';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
let otherTenantCompanyId: string;
const ids: Record<string, string> = {};
const id = (key: string): string => {
  const v = ids[key];
  if (v === undefined) throw new Error(`fixture ${key} was not created`);
  return v;
};

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2], tenant = T) =>
  withTenant(db, tenant, fn);
const scalar = async (q: ReturnType<typeof sql<{ v: string }>>, tenant = T) =>
  inTenant(async (trx) => (await q.execute(trx)).rows[0]?.v, tenant);

const refusal = async (p: Promise<unknown>): Promise<PostingProfileResolutionError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PostingProfileResolutionError) return e;
    throw e;
  }
  throw new Error('expected a PostingProfileResolutionError, nothing was thrown');
};

const party = async (name: string, customer?: string, supplier?: string) => {
  const c = customer
    ? await scalar(
        sql`SELECT id AS v FROM app.party_posting_profile WHERE company_id = ${companyId} AND code = ${customer}`,
      )
    : null;
  const s = supplier
    ? await scalar(
        sql`SELECT id AS v FROM app.party_posting_profile WHERE company_id = ${companyId} AND code = ${supplier}`,
      )
    : null;
  const id =
    await scalar(sql`INSERT INTO app.party (company_id, legal_name, customer_posting_profile_id, supplier_posting_profile_id)
                              VALUES (${companyId}, ${name}, ${c ?? null}, ${s ?? null}) RETURNING id AS v`);
  if (!id) throw new Error('party not created');
  return id;
};

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  for (const [tenant, name] of [
    [T, 'Harbour & Co Pty Ltd'],
    [OTHER, 'Other Tenant Pty Ltd'],
  ] as const) {
    const c = await inTenant(async (trx) => {
      await trx.insertInto('app.tenant').values({ id: tenant, name }).execute();
      const row = await trx
        .insertInto('app.company')
        .values({ name, base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await loadChartTemplate(trx, row.id, auServicesSmb);
      await loadTaxCodes(trx, row.id, auTaxCodes);
      await loadPostingProfileTemplate(trx, row.id, auServicesSmbProfiles);
      return row.id;
    }, tenant);
    if (tenant === T) companyId = c;
    else otherTenantCompanyId = c;
  }
  // Override: overseas customers' professional services go to 4130 (Training) instead of 4110.
  await inTenant((trx) =>
    sql`INSERT INTO app.posting_profile_override (company_id, party_posting_profile_id, product_posting_profile_id, slot, account_id)
        SELECT ${companyId}, pp.id, rp.id, 'revenue', a.id
          FROM app.party_posting_profile pp, app.product_posting_profile rp, app.account a
         WHERE pp.company_id = ${companyId} AND pp.code = 'OVERSEAS_CUSTOMER'
           AND rp.company_id = ${companyId} AND rp.code = 'PROFESSIONAL_SERVICES'
           AND a.company_id = ${companyId} AND a.code = '4130'`.execute(trx),
  );
  // Every template product profile has a revenue account, so add one with no slots at all.
  await inTenant((trx) =>
    sql`INSERT INTO app.product_posting_profile (company_id, code, name)
        VALUES (${companyId}, 'DEMO_KIT', 'Demo kit')`.execute(trx),
  );
  ids.domestic = await party('Acme Pty Ltd', 'DOMESTIC_CUSTOMER', 'DOMESTIC_SUPPLIER');
  ids.overseas = await party('Kiwi Ltd', 'OVERSEAS_CUSTOMER');
  ids.noProfile = await party('Walk-in customer');
  for (const [key, name, profile, tax] of [
    ['consulting', 'Consulting', 'PROFESSIONAL_SERVICES', undefined],
    ['laptop', 'Laptop', 'HARDWARE', 'GST'],
    ['plain', 'Unprofiled thing', undefined, undefined],
    ['demo', 'Demo kit', 'DEMO_KIT', undefined],
  ] as const) {
    ids[key] = (
      await inTenant((trx) =>
        createProduct(trx, {
          companyId,
          name,
          productPostingProfileCode: profile,
          defaultTaxCode: tax,
        }),
      )
    ).id;
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

const resolve = (q: {
  partyId: string;
  productId: string;
  direction: 'sale' | 'purchase';
  slot: 'revenue' | 'discount' | 'cogs' | 'expense' | 'asset';
  lineTaxCode?: string;
}) => inTenant((trx) => resolvePartyProductPosting(trx, { companyId, ...q }));

describe('SS-UC01-06: Posting-profile gap flagged, not posted', () => {
  it('OVERSEAS_CUSTOMER × DEMO_KIT has no revenue account: refused by name, nothing posted, listed by the gap check', async () => {
    const e = await refusal(
      resolve({
        partyId: id('overseas'),
        productId: id('demo'),
        direction: 'sale',
        slot: 'revenue',
      }),
    );
    expect(e.code).toBe('PROFILE_GAP');
    expect(e.details).toEqual({
      direction: 'sale',
      partyProfile: 'OVERSEAS_CUSTOMER',
      productProfile: 'DEMO_KIT',
      slot: 'revenue',
    });
    expect(
      await scalar(
        sql`SELECT count(*)::text AS v FROM app.journal_entry WHERE company_id = ${companyId}`,
      ),
    ).toBe('0');
    const gaps = await inTenant((trx) =>
      postingProfileGapCheck(trx, { companyId, slots: ['revenue'] }),
    );
    expect(
      gaps.map((g) => `${g.partyProfile.code} × ${g.productProfile.code}.${g.slot}`),
    ).toContain('OVERSEAS_CUSTOMER × DEMO_KIT.revenue');
  });
});

describe('SS-PLAT-104: resolution from the stored matrix', () => {
  it('product slot, override and supplier side resolve to the stored accounts', async () => {
    expect(
      await resolve({
        partyId: id('domestic'),
        productId: id('consulting'),
        direction: 'sale',
        slot: 'revenue',
      }),
    ).toMatchObject({
      account: { code: '4110' },
      source: 'product_profile',
      controlRole: 'AR_CONTROL',
      taxCode: 'GST',
      taxCodeSource: 'party_profile',
    });
    expect(
      await resolve({
        partyId: id('overseas'),
        productId: id('consulting'),
        direction: 'sale',
        slot: 'revenue',
      }),
    ).toMatchObject({
      account: { code: '4130' },
      source: 'override',
      taxCode: 'FRE',
    });
    expect(
      await resolve({
        partyId: id('domestic'),
        productId: id('laptop'),
        direction: 'purchase',
        slot: 'asset',
      }),
    ).toMatchObject({
      account: { code: '1500' },
      controlRole: 'AP_CONTROL',
      taxCode: 'GST',
      taxCodeSource: 'party_profile_and_product',
    });
  });

  it('missing links and differing tax defaults are refused by name', async () => {
    expect(
      (
        await refusal(
          resolve({
            partyId: id('noProfile'),
            productId: id('consulting'),
            direction: 'sale',
            slot: 'revenue',
          }),
        )
      ).message,
    ).toBe('NO_PARTY_PROFILE: party Walk-in customer has no customer posting profile (sale)');
    expect(
      (
        await refusal(
          resolve({
            partyId: id('overseas'),
            productId: id('consulting'),
            direction: 'purchase',
            slot: 'expense',
          }),
        )
      ).code,
    ).toBe('NO_PARTY_PROFILE');
    expect(
      (
        await refusal(
          resolve({
            partyId: id('domestic'),
            productId: id('plain'),
            direction: 'sale',
            slot: 'revenue',
          }),
        )
      ).message,
    ).toBe('NO_PRODUCT_PROFILE: product Unprofiled thing has no product posting profile');
    // Laptop defaults to GST, OVERSEAS_CUSTOMER to FRE: no precedence is assumed (RQ-0097) …
    expect(
      (
        await refusal(
          resolve({
            partyId: id('overseas'),
            productId: id('laptop'),
            direction: 'sale',
            slot: 'revenue',
          }),
        )
      ).message,
    ).toBe(
      'TAX_CODE_CONFLICT: party posting profile OVERSEAS_CUSTOMER defaults to FRE but product Laptop defaults to GST; choose the tax code on the line',
    );
    // … unless the line names its code.
    expect(
      await resolve({
        partyId: id('overseas'),
        productId: id('laptop'),
        direction: 'sale',
        slot: 'revenue',
        lineTaxCode: 'FRE',
      }),
    ).toMatchObject({
      account: { code: '4190' },
      source: 'product_profile',
      taxCode: 'FRE',
      taxCodeSource: 'line',
    });
  });

  it('an archived product profile is refused', async () => {
    await inTenant((trx) =>
      sql`UPDATE app.product_posting_profile SET status = 'archived' WHERE company_id = ${companyId} AND code = 'FREIGHT'`.execute(
        trx,
      ),
    );
    const freight = (
      await inTenant((trx) =>
        createProduct(trx, { companyId, name: 'Courier', productPostingProfileCode: 'FREIGHT' }),
      )
    ).id;
    expect(
      (
        await refusal(
          resolve({
            partyId: id('domestic'),
            productId: freight,
            direction: 'sale',
            slot: 'revenue',
          }),
        )
      ).message,
    ).toBe('PROFILE_ARCHIVED: product posting profile FREIGHT is archived');
  });

  it("another tenant's party or product is not found", async () => {
    const otherParty = await inTenant(
      async (trx) =>
        (
          await sql<{
            id: string;
          }>`INSERT INTO app.party (company_id, legal_name) VALUES (${otherTenantCompanyId}, 'Theirs') RETURNING id`.execute(
            trx,
          )
        ).rows[0]?.id ?? 'missing',
      OTHER,
    );
    await expect(
      resolve({
        partyId: otherParty,
        productId: id('consulting'),
        direction: 'sale',
        slot: 'revenue',
      }),
    ).rejects.toThrow(/party .* not found/);
  });
});

describe('SS-PLAT-105: gap check over the stored matrix', () => {
  it('lists revenue/expense gaps of active profiles only; adding an override removes one; writes nothing', async () => {
    const before = await inTenant((trx) =>
      postingProfileGapCheck(trx, { companyId, slots: ['revenue', 'expense'] }),
    );
    const names = before.map(
      (g) => `${g.direction} ${g.partyProfile.code} × ${g.productProfile.code}.${g.slot}`,
    );
    // FREIGHT is archived by the test above, so it is not listed.
    expect(names).toEqual([
      'purchase DOMESTIC_SUPPLIER × DEMO_KIT.expense',
      'purchase DOMESTIC_SUPPLIER × HARDWARE.expense',
      'purchase DOMESTIC_SUPPLIER × REIMBURSABLE_EXPENSE.expense',
      'sale DOMESTIC_CUSTOMER × DEMO_KIT.revenue',
      'sale OVERSEAS_CUSTOMER × DEMO_KIT.revenue',
    ]);
    expect(before[1]?.message).toBe(
      'PROFILE_GAP: no expense account for DOMESTIC_SUPPLIER × HARDWARE (purchase): product posting profile HARDWARE has no expense account and there is no override',
    );
    await inTenant((trx) =>
      sql`INSERT INTO app.posting_profile_override (company_id, party_posting_profile_id, product_posting_profile_id, slot, account_id)
          SELECT ${companyId}, pp.id, rp.id, 'expense', a.id
            FROM app.party_posting_profile pp, app.product_posting_profile rp, app.account a
           WHERE pp.company_id = ${companyId} AND pp.code = 'DOMESTIC_SUPPLIER'
             AND rp.company_id = ${companyId} AND rp.code = 'REIMBURSABLE_EXPENSE'
             AND a.company_id = ${companyId} AND a.code = '5000'`.execute(trx),
    );
    const after = await inTenant((trx) =>
      postingProfileGapCheck(trx, { companyId, slots: ['revenue', 'expense'] }),
    );
    expect(after.map((g) => `${g.partyProfile.code} × ${g.productProfile.code}.${g.slot}`)).toEqual(
      [
        'DOMESTIC_SUPPLIER × DEMO_KIT.expense',
        'DOMESTIC_SUPPLIER × HARDWARE.expense',
        'DOMESTIC_CUSTOMER × DEMO_KIT.revenue',
        'OVERSEAS_CUSTOMER × DEMO_KIT.revenue',
      ],
    );
    expect(
      await scalar(
        sql`SELECT count(*)::text AS v FROM app.journal_entry WHERE company_id = ${companyId}`,
      ),
    ).toBe('0');
  });

  it("all direction slots by default; another tenant's gap check sees only its own profiles", async () => {
    const all = await inTenant((trx) => postingProfileGapCheck(trx, { companyId }));
    expect(new Set(all.map((g) => g.slot))).toEqual(
      new Set(['revenue', 'discount', 'cogs', 'asset', 'expense']),
    );
    const otherIds = new Set(
      (
        await inTenant(
          (trx) => postingProfileGapCheck(trx, { companyId: otherTenantCompanyId }),
          OTHER,
        )
      ).map((g) => g.partyProfile.id),
    );
    for (const g of all) expect(otherIds.has(g.partyProfile.id)).toBe(false);
    // Asking for the other tenant's company from this tenant finds no profiles at all.
    expect(
      await inTenant((trx) => postingProfileGapCheck(trx, { companyId: otherTenantCompanyId })),
    ).toEqual([]);
  });
});
