/**
 * Posting-profile matrix resolution and gap check (T-0039, design §4.4, DL-0267), against a real
 * PostgreSQL as lf_app. Party profile × product profile resolves to accounts and a tax code, with
 * overrides only where a combination differs from the product default; the gap check lists every
 * combination that could occur but has no usable account or tax code.
 */
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileGaps, resolvePosting, setOverride } from './matrix.ts';
import { seedPostingProfiles, type SeededProfiles } from './profiles.ts';

let f: LedgerFixture;
let p: SeededProfiles;
const DATE = '2026-11-05';
const party = (code: string) => p.partyProfiles.get(code) ?? '';
const product = (code: string) => p.productProfiles.get(code) ?? '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003901');
  p = await f.inTenant(async (trx) => {
    await seedTaxCodes(trx, f.companyId);
    return seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const resolve = (partyCode: string, productCode: string, purpose: 'sale' | 'purchase') =>
  f.inTenant((trx) =>
    resolvePosting(trx, f.companyId, {
      partyProfileId: party(partyCode),
      productProfileId: product(productCode),
      purpose,
      date: DATE,
    }),
  );

describe('Posting-profile matrix (T-0039)', () => {
  it('resolves a sale to the product revenue account, the party control account and a tax code', async () => {
    const r = await resolve('DOMESTIC_CUSTOMER', 'PROFESSIONAL_SERVICES', 'sale');
    expect(r).toEqual({
      ok: true,
      accountId: f.acct['4110'],
      accountSource: 'product',
      controlAccountId: f.acct['1200'],
      taxCode: 'GST',
      taxCodeSource: 'product',
    });
  });

  it('an overseas customer gets the GST-free export code: an exemption beats the taxable default', async () => {
    const r = await resolve('OVERSEAS_CUSTOMER', 'PROFESSIONAL_SERVICES', 'sale');
    expect(r).toMatchObject({ ok: true, taxCode: 'GST-FREE-EXPORT', taxCodeSource: 'party' });
  });

  it('a purchase uses the expense account, or COGS when the product profile has no expense account', async () => {
    expect(await resolve('DOMESTIC_SUPPLIER', 'SUBSCRIPTION', 'purchase')).toMatchObject({
      ok: true,
      accountId: f.acct['6310'],
      controlAccountId: f.acct['2000'],
    });
    expect(await resolve('DOMESTIC_SUPPLIER', 'HARDWARE', 'purchase')).toMatchObject({
      ok: true,
      accountId: f.acct['5100'],
      accountSource: 'product',
    });
  });

  it('an override applies only to its combination', async () => {
    await f.inTenant((trx) =>
      setOverride(trx, f.companyId, {
        partyProfileId: party('OVERSEAS_CUSTOMER'),
        productProfileId: product('TRAINING'),
        revenueAccountId: f.acct['4110'] ?? '',
      }),
    );
    expect(await resolve('OVERSEAS_CUSTOMER', 'TRAINING', 'sale')).toMatchObject({
      ok: true,
      accountId: f.acct['4110'],
      accountSource: 'override',
    });
    expect(await resolve('DOMESTIC_CUSTOMER', 'TRAINING', 'sale')).toMatchObject({
      accountId: f.acct['4130'],
      accountSource: 'product',
    });
  });

  it('refuses a purpose that does not fit the party profile kind', async () => {
    expect(await resolve('DOMESTIC_SUPPLIER', 'TRAINING', 'sale')).toMatchObject({
      ok: false,
      gap: { code: 'PROFILE_GAP', reason: 'kind' },
    });
  });
});

describe('SS-UC01-06: Posting-profile gap flagged, not posted', () => {
  it('SS-UC01-06 a fresh AU template has no gaps', async () => {
    expect(await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE))).toEqual([]);
  });

  it('SS-UC01-06 a combination with no usable revenue account resolves to PROFILE_GAP and is listed by the gap check', async () => {
    // Hardware sales account archived: every customer × HARDWARE sale has no revenue account.
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', f.acct['4140'] ?? '')
        .execute(),
    );
    const r = await resolve('DOMESTIC_CUSTOMER', 'HARDWARE', 'sale');
    expect(r).toMatchObject({
      ok: false,
      gap: {
        code: 'PROFILE_GAP',
        partyProfile: 'DOMESTIC_CUSTOMER',
        productProfile: 'HARDWARE',
        purpose: 'sale',
        reason: 'account',
      },
    });
    const gaps = await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE));
    expect(
      gaps.map((g) => `${g.partyProfile}×${g.productProfile}:${g.purpose}:${g.reason}`),
    ).toEqual([
      'DOMESTIC_CUSTOMER×HARDWARE:sale:account',
      'OVERSEAS_CUSTOMER×HARDWARE:sale:account',
    ]);
    // An override closes the gap for one combination only.
    await f.inTenant((trx) =>
      setOverride(trx, f.companyId, {
        partyProfileId: party('DOMESTIC_CUSTOMER'),
        productProfileId: product('HARDWARE'),
        revenueAccountId: f.acct['4110'] ?? '',
      }),
    );
    const after = await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE));
    expect(after.map((g) => `${g.partyProfile}×${g.productProfile}`)).toEqual([
      'OVERSEAS_CUSTOMER×HARDWARE',
    ]);
  });

  it('SS-UC01-06 a tax code not in force is a gap', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.tax_code')
        .set({ status: 'inactive' })
        .where('company_id', '=', f.companyId)
        .where('code', '=', 'GST-FREE-EXPORT')
        .execute(),
    );
    const gaps = await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE));
    const tax = gaps.filter((g) => g.reason === 'tax_code').map((g) => g.productProfile);
    expect(tax).toEqual([
      'PROFESSIONAL_SERVICES',
      'REIMBURSABLE_EXPENSE',
      'SUBSCRIPTION',
      'TRAINING',
    ]);
    expect(gaps.every((g) => g.code === 'PROFILE_GAP')).toBe(true);
  });
});
