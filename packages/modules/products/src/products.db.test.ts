/**
 * SS-PLAT-103 — posting profiles and products in the database (T-0038, design §4.4), against a
 * real PostgreSQL as lf_app: the template's 3 party and 5 product profiles are seeded onto the
 * company's chart, Salesforce Product2.Family / Account.Type values resolve to profiles, parties
 * and products carry their profiles, and misdirected profiles are refused.
 */
import { sql } from 'kysely';
import { auServicesSmb } from '@ledgerforce/gl';
import { AU_SERVICES_BINDINGS } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { AU_TAX_CODES } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPartyProfile,
  createProduct,
  createProductProfile,
  ProfileError,
  partyProfileForAccountType,
  productProfileForFamily,
  seedPostingProfiles,
  setPartyProfiles,
} from './profiles.ts';

let f: LedgerFixture;
let seeded: Awaited<ReturnType<typeof seedPostingProfiles>>;
let acme = '';

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003801');
  seeded = await f.inTenant((trx) =>
    seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct))),
  );
  acme = await f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return p.id;
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-103: Posting profiles and products', () => {
  it('SS-PLAT-103 seeds 3 party and 5 product profiles onto the chart', async () => {
    expect([...seeded.partyProfiles.keys()]).toEqual([
      'DOMESTIC_CUSTOMER',
      'OVERSEAS_CUSTOMER',
      'DOMESTIC_SUPPLIER',
    ]);
    expect(seeded.productProfiles.size).toBe(5);
    const rows = await f.inTenant((trx) =>
      sql<{ code: string; revenue: string; cogs: string | null }>`
        SELECT p.code, r.code AS revenue, c.code AS cogs
          FROM app.product_posting_profile p
          JOIN app.account r ON r.id = p.revenue_account_id
          LEFT JOIN app.account c ON c.id = p.cogs_account_id
         WHERE p.company_id = ${f.companyId} ORDER BY p.code`.execute(trx),
    );
    expect(rows.rows).toContainEqual({ code: 'HARDWARE', revenue: '4140', cogs: '5100' });
  });

  it('SS-PLAT-103 template revenue accounts agree with the golden product bindings', () => {
    // The golden postings (human-owned expectations) name product:<PROFILE>.revenue bindings.
    for (const [binding, target] of Object.entries(AU_SERVICES_BINDINGS)) {
      const m = /^product:([A-Z_]+)\.revenue$/.exec(binding);
      if (!m || !target || !('code' in target)) continue;
      const profile = auServicesSmb.productProfiles.find((p) => p.code === m[1]);
      expect(profile?.revenueAccount, binding).toBe(target.code);
    }
  });

  it('SS-PLAT-103 default tax codes are catalogue codes', () => {
    const codes = new Set(AU_TAX_CODES.map((t) => t.code));
    for (const p of [...auServicesSmb.partyProfiles, ...auServicesSmb.productProfiles]) {
      expect(codes.has(p.defaultTaxCode), `${p.code} → ${p.defaultTaxCode}`).toBe(true);
    }
  });

  it('SS-PLAT-103 Salesforce Product2.Family and Account.Type resolve to profiles', async () => {
    const hw = await f.inTenant((trx) => productProfileForFamily(trx, f.companyId, 'Hardware'));
    expect(hw).toBe(seeded.productProfiles.get('HARDWARE'));
    const direct = await f.inTenant((trx) =>
      partyProfileForAccountType(trx, f.companyId, 'Customer - Direct'),
    );
    expect(direct).toBe(seeded.partyProfiles.get('DOMESTIC_CUSTOMER'));
    expect(
      await f.inTenant((trx) => productProfileForFamily(trx, f.companyId, 'Unknown family')),
    ).toBeUndefined();
  });

  it('SS-PLAT-103 a party carries a customer and a supplier profile, each of its own kind', async () => {
    const customer = seeded.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '';
    const supplier = seeded.partyProfiles.get('DOMESTIC_SUPPLIER') ?? '';
    await f.inTenant((trx) =>
      setPartyProfiles(trx, f.companyId, acme, {
        customerProfileId: customer,
        supplierProfileId: supplier,
      }),
    );
    const swapped = await errorOf(
      f.inTenant((trx) =>
        setPartyProfiles(trx, f.companyId, acme, { customerProfileId: supplier }),
      ),
    );
    expect(swapped).toBeInstanceOf(ProfileError);
    expect(swapped?.code).toBe('PROFILE_KIND');
  });

  it('SS-PLAT-103 refuses a customer profile on the AP control account and a revenue profile on an expense account', async () => {
    const wrongControl = await errorOf(
      f.inTenant((trx) =>
        createPartyProfile(trx, f.companyId, {
          code: 'BAD_CUSTOMER',
          name: 'Bad',
          kind: 'customer',
          controlAccountId: f.acct['2000'] ?? '',
          defaultTaxCode: 'GST',
        }),
      ),
    );
    expect(wrongControl?.code).toBe('PROFILE_ACCOUNT');
    const wrongRevenue = await errorOf(
      f.inTenant((trx) =>
        createProductProfile(trx, f.companyId, {
          code: 'BAD_PRODUCT',
          name: 'Bad',
          revenueAccountId: f.acct['6200'] ?? '',
          defaultTaxCode: 'GST',
        }),
      ),
    );
    expect(wrongRevenue?.code).toBe('PROFILE_ACCOUNT');
    const otherCompanyAccount = await errorOf(
      f.inTenant((trx) =>
        createProductProfile(trx, f.companyId, {
          code: 'OTHER_CO',
          name: 'Other',
          revenueAccountId: f.otherAcct['4110'] ?? '',
          defaultTaxCode: 'GST',
        }),
      ),
    );
    expect(otherCompanyAccount?.code).toBe('PROFILE_ACCOUNT');
  });

  it('SS-PLAT-103 products carry a product profile; SKUs and Salesforce ids are unique per company', async () => {
    const profile = seeded.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
    const id = await f.inTenant((trx) =>
      createProduct(trx, f.companyId, {
        sku: 'CONSULT-HR',
        name: 'Consulting (hourly)',
        productProfileId: profile,
        unitPrice: '220.00',
        salesforceProduct2Id: '01t5g00000ABCDEFGH',
      }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const dup = await errorOf(
      f.inTenant((trx) =>
        createProduct(trx, f.companyId, {
          sku: 'CONSULT-HR',
          name: 'Duplicate',
          productProfileId: profile,
        }),
      ),
    );
    expect(dup?.message).toMatch(/duplicate key|unique/);
    const badPrice = await errorOf(
      f.inTenant((trx) =>
        createProduct(trx, f.companyId, {
          sku: 'NEG',
          name: 'Negative',
          productProfileId: profile,
          unitPrice: '-1.00',
        }),
      ),
    );
    expect(badPrice?.code).toBe('INVALID_PRODUCT');
  });
});
