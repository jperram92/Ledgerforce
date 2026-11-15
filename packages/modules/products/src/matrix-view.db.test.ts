/**
 * The whole posting-profile matrix for the screen (T-0187, ADR-0082, SS-PLAT-133), against a real
 * PostgreSQL as lf_app. Each cell is resolved by the same rule as resolvePosting and agrees with
 * the gap check. fillOverride closes a gap, says whether it changed anything, and refuses
 * unusable accounts, unknown profiles and unknown tax codes.
 */
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileGaps } from './matrix.ts';
import { fillOverride, profileMatrix } from './matrix-view.ts';
import { ProfileError, seedPostingProfiles, type SeededProfiles } from './profiles.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let p: SeededProfiles;
const DATE = '2026-11-05';
const party = (code: string) => p.partyProfiles.get(code) ?? '';
const product = (code: string) => p.productProfiles.get(code) ?? '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018701');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000018702');
  p = await f.inTenant(async (trx) => {
    await seedTaxCodes(trx, f.companyId);
    return seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

const matrix = () =>
  f.inTenant(async (trx) => {
    const m = await profileMatrix(trx, f.companyId, DATE);
    if (!m) throw new Error('matrix not visible');
    return m;
  });
const cellOf = (m: Awaited<ReturnType<typeof matrix>>, partyCode: string, productCode: string) =>
  m.cells.find(
    (c) => c.partyProfileId === party(partyCode) && c.productProfileId === product(productCode),
  );

describe('SS-PLAT-133: posting-profile matrix read and override (module)', () => {
  it('SS-PLAT-133 lists every active party × product cell, resolved with its account and tax code', async () => {
    const m = await matrix();
    expect(m.date).toBe(DATE);
    expect(m.parties.map((x) => x.code)).toEqual([...p.partyProfiles.keys()].sort());
    expect(m.products.map((x) => x.code)).toEqual([...p.productProfiles.keys()].sort());
    expect(m.cells).toHaveLength(m.parties.length * m.products.length);
    expect(m.cells.every((c) => c.gap === null)).toBe(true);
    expect(cellOf(m, 'DOMESTIC_CUSTOMER', 'PROFESSIONAL_SERVICES')).toMatchObject({
      purpose: 'sale',
      account: { id: f.acct['4110'], code: '4110' },
      accountSource: 'product',
      taxCode: 'GST',
      override: false,
      gap: null,
    });
    expect(cellOf(m, 'DOMESTIC_SUPPLIER', 'HARDWARE')).toMatchObject({
      purpose: 'purchase',
      account: { id: f.acct['5100'], code: '5100' },
    });
    const domestic = m.parties.find((x) => x.code === 'DOMESTIC_CUSTOMER');
    expect(domestic).toMatchObject({ kind: 'customer', controlAccount: { code: '1200' } });
    expect(typeof domestic?.name).toBe('string');
    // Choices: postable revenue and expense accounts only, never a control account.
    const codes = m.choices.map((a) => a.code);
    expect(codes).toContain('4110');
    expect(codes).toContain('6310');
    expect(codes).not.toContain('1200');
    expect(codes).not.toContain('2000');
    expect(m.choices.every((a) => a.type === 'revenue' || a.type === 'expense')).toBe(true);
  });

  it('SS-PLAT-133 a gap cell carries the gap check reason, and the matrix agrees with profileGaps', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', f.acct['4140'] ?? '')
        .execute(),
    );
    const m = await matrix();
    expect(cellOf(m, 'DOMESTIC_CUSTOMER', 'HARDWARE')).toMatchObject({
      account: null,
      accountSource: null,
      gap: { reason: 'account' },
    });
    const gaps = await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE));
    const byCode = (id: string, list: readonly { id: string; code: string }[]) =>
      list.find((x) => x.id === id)?.code;
    expect(
      m.cells
        .filter((c) => c.gap)
        .map(
          (c) =>
            `${byCode(c.partyProfileId, m.parties) ?? ''}×${byCode(c.productProfileId, m.products) ?? ''}:${c.gap?.reason ?? ''}:${c.gap?.message ?? ''}`,
        ),
    ).toEqual(gaps.map((g) => `${g.partyProfile}×${g.productProfile}:${g.reason}:${g.message}`));
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('SS-PLAT-133 fillOverride closes the gap once; a repeat changes nothing', async () => {
    const input = {
      partyProfileId: party('DOMESTIC_CUSTOMER'),
      productProfileId: product('HARDWARE'),
      revenueAccountId: f.acct['4110'] ?? '',
    };
    const first = await f.inTenant((trx) => fillOverride(trx, f.companyId, input));
    expect(first.changed).toBe(true);
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ revenueAccountId: f.acct['4110'] });
    const again = await f.inTenant((trx) => fillOverride(trx, f.companyId, input));
    expect(again.changed).toBe(false);
    expect(again.before).toEqual(again.after);
    const m = await matrix();
    expect(cellOf(m, 'DOMESTIC_CUSTOMER', 'HARDWARE')).toMatchObject({
      account: { code: '4110' },
      accountSource: 'override',
      override: true,
      gap: null,
    });
    const gaps = await f.inTenant((trx) => profileGaps(trx, f.companyId, DATE));
    expect(gaps.map((g) => `${g.partyProfile}×${g.productProfile}`)).not.toContain(
      'DOMESTIC_CUSTOMER×HARDWARE',
    );
  });

  it('SS-PLAT-133 fillOverride refuses a control account, an unknown profile and an unknown tax code', async () => {
    const refusal = (input: Parameters<typeof fillOverride>[2]) =>
      f
        .inTenant((trx) => fillOverride(trx, f.companyId, input))
        .then(
          () => 'accepted',
          (e: unknown) => (e instanceof ProfileError ? e.code : String(e)),
        );
    const base = {
      partyProfileId: party('OVERSEAS_CUSTOMER'),
      productProfileId: product('HARDWARE'),
    };
    expect(await refusal({ ...base, revenueAccountId: f.acct['1200'] ?? '' })).toBe(
      'PROFILE_ACCOUNT',
    );
    expect(
      await refusal({ ...base, partyProfileId: other.companyId, revenueAccountId: null }),
    ).toBe('PROFILE_UNKNOWN');
    expect(await refusal({ ...base, taxCode: 'NO-SUCH-CODE' })).toBe('PROFILE_TAX_CODE');
  });

  it('SS-PLAT-133 another tenant’s company is not visible', async () => {
    expect(await f.inTenant((trx) => profileMatrix(trx, other.companyId, DATE))).toBeNull();
  });
});
