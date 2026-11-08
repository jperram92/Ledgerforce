/**
 * T-0039 — posting-profile matrix resolution and gap check, pure layer (design §4.4, RQ-0097,
 * DL-0260). The matrix is an in-memory snapshot of a company's profiles and overrides; the
 * database layer (profile-resolution.ts, gap-check.db.test.ts) loads it and calls these functions.
 *
 * SS-UC01-06 (gap flagged, nothing to post), SS-PLAT-104 (resolver), SS-PLAT-105 (gap check).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SLOTS,
  findProfileGaps,
  resolvePostingAccount,
  resolvePostingProfile,
  resolveTaxCode,
  PostingProfileResolutionError,
  type Direction,
  type PostingMatrix,
} from './matrix.ts';
import { POSTING_SLOTS, type PostingSlot } from './posting-slots.ts';
import {
  auServicesSmbProfiles,
  auServicesSmbProfilesV2,
  type PostingProfileTemplate,
} from './profiles.template.ts';

const acct = (code: string) => ({ id: `acct-${code}`, code });

/** Shaped like the AU template (T-0038), but HARDWARE has no revenue slot (a gap), plus two overrides. */
const matrix = (): PostingMatrix => ({
  partyProfiles: [
    {
      id: 'pp-dc',
      code: 'DOMESTIC_CUSTOMER',
      partyKind: 'customer',
      status: 'active',
      defaultTaxCode: 'GST',
    },
    {
      id: 'pp-oc',
      code: 'OVERSEAS_CUSTOMER',
      partyKind: 'customer',
      status: 'active',
      defaultTaxCode: 'FRE',
    },
    {
      id: 'pp-ds',
      code: 'DOMESTIC_SUPPLIER',
      partyKind: 'supplier',
      status: 'active',
      defaultTaxCode: 'GST',
    },
    {
      id: 'pp-rp',
      code: 'RELATED_PARTY',
      partyKind: 'customer',
      status: 'archived',
      defaultTaxCode: null,
    },
  ],
  productProfiles: [
    {
      id: 'pr-sub',
      code: 'SUBSCRIPTION',
      status: 'active',
      slots: { revenue: acct('4120'), expense: acct('6310') },
    },
    {
      id: 'pr-ps',
      code: 'PROFESSIONAL_SERVICES',
      status: 'active',
      slots: { revenue: acct('4110'), expense: acct('5000') },
    },
    { id: 'pr-hw', code: 'HARDWARE', status: 'active', slots: { asset: acct('1500') } },
    { id: 'pr-old', code: 'OLD_LINE', status: 'archived', slots: { revenue: acct('4110') } },
  ],
  overrides: [
    { partyProfileId: 'pp-oc', productProfileId: 'pr-ps', slot: 'revenue', account: acct('4100') },
    { partyProfileId: 'pp-dc', productProfileId: 'pr-hw', slot: 'revenue', account: acct('4190') },
  ],
});

const refusal = (fn: () => unknown): PostingProfileResolutionError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PostingProfileResolutionError) return e;
    throw e;
  }
  throw new Error('expected a PostingProfileResolutionError, nothing was thrown');
};

describe('SS-UC01-06: Posting-profile gap flagged, not posted', () => {
  it('refuses with PROFILE_GAP naming the slot, and the gap check lists the combination', () => {
    const m = matrix();
    const e = refusal(() =>
      resolvePostingAccount(m, {
        direction: 'sale',
        slot: 'revenue',
        partyProfileId: 'pp-oc',
        productProfileId: 'pr-hw',
      }),
    );
    expect(e.code).toBe('PROFILE_GAP');
    expect(e.details).toEqual({
      direction: 'sale',
      partyProfile: 'OVERSEAS_CUSTOMER',
      productProfile: 'HARDWARE',
      slot: 'revenue',
    });
    expect(e.message).toBe(
      'PROFILE_GAP: no revenue account for OVERSEAS_CUSTOMER × HARDWARE (sale): ' +
        'product posting profile HARDWARE has no revenue account and there is no override',
    );
    // No account → no journal line can be built; the same combination is on the gap list.
    const gaps = findProfileGaps(m);
    expect(gaps).toContainEqual(
      expect.objectContaining({
        direction: 'sale',
        partyProfile: { id: 'pp-oc', code: 'OVERSEAS_CUSTOMER' },
        productProfile: { id: 'pr-hw', code: 'HARDWARE' },
        slot: 'revenue',
        message: e.message,
      }),
    );
  });
});

describe('SS-PLAT-104: the resolver returns account and tax code, refusals name what is missing', () => {
  it('uses the product profile slot when there is no override', () => {
    expect(
      resolvePostingAccount(matrix(), {
        direction: 'sale',
        slot: 'revenue',
        partyProfileId: 'pp-dc',
        productProfileId: 'pr-ps',
      }),
    ).toEqual({
      account: acct('4110'),
      source: 'product_profile',
      partyProfile: 'DOMESTIC_CUSTOMER',
      productProfile: 'PROFESSIONAL_SERVICES',
      controlRole: 'AR_CONTROL',
    });
  });

  it('a party × product override wins over the product slot', () => {
    const r = resolvePostingAccount(matrix(), {
      direction: 'sale',
      slot: 'revenue',
      partyProfileId: 'pp-oc',
      productProfileId: 'pr-ps',
    });
    expect(r.account).toEqual(acct('4100'));
    expect(r.source).toBe('override');
  });

  it('an override fills an empty product slot for that party profile only', () => {
    const m = matrix();
    expect(
      resolvePostingAccount(m, {
        direction: 'sale',
        slot: 'revenue',
        partyProfileId: 'pp-dc',
        productProfileId: 'pr-hw',
      }).account,
    ).toEqual(acct('4190'));
    expect(
      refusal(() =>
        resolvePostingAccount(m, {
          direction: 'sale',
          slot: 'revenue',
          partyProfileId: 'pp-oc',
          productProfileId: 'pr-hw',
        }),
      ).code,
    ).toBe('PROFILE_GAP');
  });

  it('purchases resolve through the supplier profile and AP_CONTROL', () => {
    const r = resolvePostingAccount(matrix(), {
      direction: 'purchase',
      slot: 'asset',
      partyProfileId: 'pp-ds',
      productProfileId: 'pr-hw',
    });
    expect(r).toMatchObject({ account: acct('1500'), controlRole: 'AP_CONTROL' });
  });

  it('refuses a party without a profile, a product without a profile, and archived profiles', () => {
    const m = matrix();
    const base = { direction: 'sale' as const, slot: 'revenue' as const };
    const noParty = refusal(() =>
      resolvePostingAccount(m, {
        ...base,
        partyProfileId: null,
        productProfileId: 'pr-ps',
        partyLabel: 'Acme Pty Ltd',
      }),
    );
    expect(noParty.code).toBe('NO_PARTY_PROFILE');
    expect(noParty.message).toBe(
      'NO_PARTY_PROFILE: party Acme Pty Ltd has no customer posting profile (sale)',
    );
    const noProduct = refusal(() =>
      resolvePostingAccount(m, {
        ...base,
        partyProfileId: 'pp-dc',
        productProfileId: null,
        productLabel: 'Widget',
      }),
    );
    expect(noProduct.code).toBe('NO_PRODUCT_PROFILE');
    expect(noProduct.message).toBe(
      'NO_PRODUCT_PROFILE: product Widget has no product posting profile',
    );
    expect(
      refusal(() =>
        resolvePostingAccount(m, { ...base, partyProfileId: 'pp-rp', productProfileId: 'pr-ps' }),
      ).message,
    ).toBe('PROFILE_ARCHIVED: party posting profile RELATED_PARTY is archived');
    expect(
      refusal(() =>
        resolvePostingAccount(m, { ...base, partyProfileId: 'pp-dc', productProfileId: 'pr-old' }),
      ).message,
    ).toBe('PROFILE_ARCHIVED: product posting profile OLD_LINE is archived');
  });

  it('refuses a profile of the wrong kind for the direction and a slot of the other direction', () => {
    const m = matrix();
    expect(
      refusal(() =>
        resolvePostingAccount(m, {
          direction: 'purchase',
          slot: 'expense',
          partyProfileId: 'pp-dc',
          productProfileId: 'pr-ps',
        }),
      ).message,
    ).toBe(
      'NO_PARTY_PROFILE: party posting profile DOMESTIC_CUSTOMER is a customer profile; purchase needs a supplier profile',
    );
    expect(
      refusal(() =>
        resolvePostingAccount(m, {
          direction: 'sale',
          slot: 'expense',
          partyProfileId: 'pp-dc',
          productProfileId: 'pr-ps',
        }),
      ).message,
    ).toBe(
      'SLOT_NOT_FOR_DIRECTION: slot expense is not used on a sale (sale slots: revenue, discount, cogs)',
    );
  });

  it('refuses an unknown profile id (another company or tenant) as missing', () => {
    expect(
      refusal(() =>
        resolvePostingAccount(matrix(), {
          direction: 'sale',
          slot: 'revenue',
          partyProfileId: 'pp-x',
          productProfileId: 'pr-ps',
        }),
      ).code,
    ).toBe('NO_PARTY_PROFILE');
    expect(
      refusal(() =>
        resolvePostingAccount(matrix(), {
          direction: 'sale',
          slot: 'revenue',
          partyProfileId: 'pp-dc',
          productProfileId: 'pr-x',
        }),
      ).code,
    ).toBe('NO_PRODUCT_PROFILE');
  });

  it('tax code: explicit line code, else the one default set or both equal', () => {
    expect(
      resolveTaxCode({ lineTaxCode: 'GST', partyTaxCode: 'FRE', productTaxCode: 'INP' }),
    ).toEqual({
      taxCode: 'GST',
      source: 'line',
    });
    expect(resolveTaxCode({ partyTaxCode: 'FRE', productTaxCode: null })).toEqual({
      taxCode: 'FRE',
      source: 'party_profile',
    });
    expect(resolveTaxCode({ partyTaxCode: null, productTaxCode: 'GST' })).toEqual({
      taxCode: 'GST',
      source: 'product',
    });
    expect(resolveTaxCode({ partyTaxCode: 'GST', productTaxCode: 'GST' })).toEqual({
      taxCode: 'GST',
      source: 'party_profile_and_product',
    });
  });

  it('tax code: differing defaults are refused by name, never ranked (RQ-0097); none is refused', () => {
    const conflict = refusal(() =>
      resolveTaxCode({
        partyTaxCode: 'FRE',
        productTaxCode: 'GST',
        partyProfile: 'OVERSEAS_CUSTOMER',
        product: 'Laptop',
      }),
    );
    expect(conflict.code).toBe('TAX_CODE_CONFLICT');
    expect(conflict.message).toBe(
      'TAX_CODE_CONFLICT: party posting profile OVERSEAS_CUSTOMER defaults to FRE but product Laptop defaults to GST; choose the tax code on the line',
    );
    expect(
      refusal(() => resolveTaxCode({ partyTaxCode: null, productTaxCode: null })).message,
    ).toBe('NO_TAX_CODE: no tax code on the line, the party posting profile or the product');
  });

  it('resolvePostingProfile combines account and tax code', () => {
    expect(
      resolvePostingProfile(matrix(), {
        direction: 'sale',
        slot: 'revenue',
        partyProfileId: 'pp-oc',
        productProfileId: 'pr-sub',
        productTaxCode: null,
      }),
    ).toEqual({
      account: acct('4120'),
      source: 'product_profile',
      partyProfile: 'OVERSEAS_CUSTOMER',
      productProfile: 'SUBSCRIPTION',
      controlRole: 'AR_CONTROL',
      taxCode: 'FRE',
      taxCodeSource: 'party_profile',
    });
  });
});

describe('SS-PLAT-105: the gap check lists every combination that cannot resolve', () => {
  it('lists the AU-template gaps of active profiles only, sorted, per direction', () => {
    const gaps = findProfileGaps(matrix());
    expect(
      gaps.map((g) => `${g.direction} ${g.partyProfile.code} × ${g.productProfile.code}.${g.slot}`),
    ).toEqual([
      'purchase DOMESTIC_SUPPLIER × HARDWARE.expense',
      'purchase DOMESTIC_SUPPLIER × PROFESSIONAL_SERVICES.asset',
      'purchase DOMESTIC_SUPPLIER × SUBSCRIPTION.asset',
      'sale DOMESTIC_CUSTOMER × HARDWARE.cogs',
      'sale DOMESTIC_CUSTOMER × HARDWARE.discount',
      'sale DOMESTIC_CUSTOMER × PROFESSIONAL_SERVICES.cogs',
      'sale DOMESTIC_CUSTOMER × PROFESSIONAL_SERVICES.discount',
      'sale DOMESTIC_CUSTOMER × SUBSCRIPTION.cogs',
      'sale DOMESTIC_CUSTOMER × SUBSCRIPTION.discount',
      'sale OVERSEAS_CUSTOMER × HARDWARE.cogs',
      'sale OVERSEAS_CUSTOMER × HARDWARE.discount',
      'sale OVERSEAS_CUSTOMER × HARDWARE.revenue',
      'sale OVERSEAS_CUSTOMER × PROFESSIONAL_SERVICES.cogs',
      'sale OVERSEAS_CUSTOMER × PROFESSIONAL_SERVICES.discount',
      'sale OVERSEAS_CUSTOMER × SUBSCRIPTION.cogs',
      'sale OVERSEAS_CUSTOMER × SUBSCRIPTION.discount',
    ]);
  });

  it('narrows to the given slots', () => {
    const gaps = findProfileGaps(matrix(), { slots: ['revenue', 'expense'] });
    expect(gaps.map((g) => `${g.partyProfile.code} × ${g.productProfile.code}.${g.slot}`)).toEqual([
      'DOMESTIC_SUPPLIER × HARDWARE.expense',
      'OVERSEAS_CUSTOMER × HARDWARE.revenue',
    ]);
  });

  it('a combination is listed exactly when the resolver refuses it with PROFILE_GAP (property)', () => {
    const slotAccount = fc.option(fc.constantFrom('4110', '4120', '4190', '5000', '1500'), {
      nil: undefined,
    });
    const arbMatrix = fc
      .record({
        parties: fc.array(
          fc.record({ kind: fc.constantFrom('customer', 'supplier'), active: fc.boolean() }),
          { minLength: 1, maxLength: 4 },
        ),
        products: fc.array(
          fc.record({
            active: fc.boolean(),
            revenue: slotAccount,
            discount: slotAccount,
            expense: slotAccount,
            cogs: slotAccount,
            asset: slotAccount,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        overrides: fc.array(
          fc.record({
            party: fc.nat(3),
            product: fc.nat(3),
            slot: fc.constantFrom(...POSTING_SLOTS),
          }),
          { maxLength: 6 },
        ),
      })
      .map(({ parties, products, overrides }): PostingMatrix => {
        const partyProfiles = parties.map((p, i) => ({
          id: `pp-${i}`,
          code: `PARTY_${i}`,
          partyKind: p.kind as 'customer' | 'supplier',
          status: p.active ? ('active' as const) : ('archived' as const),
          defaultTaxCode: null,
        }));
        const productProfiles = products.map((p, i) => {
          const slots: Partial<Record<PostingSlot, { id: string; code: string }>> = {};
          for (const s of POSTING_SLOTS) {
            const code = p[s];
            if (code !== undefined) slots[s] = acct(code);
          }
          return {
            id: `pr-${i}`,
            code: `PRODUCT_${i}`,
            status: p.active ? ('active' as const) : ('archived' as const),
            slots,
          };
        });
        // One override per (party, product, slot), as the database's unique key.
        const seen = new Set<string>();
        const os = overrides
          .filter((o) => o.party < partyProfiles.length && o.product < productProfiles.length)
          .filter((o) => {
            const k = `${o.party}/${o.product}/${o.slot}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((o) => ({
            partyProfileId: `pp-${o.party}`,
            productProfileId: `pr-${o.product}`,
            slot: o.slot,
            account: acct('4100'),
          }));
        return { partyProfiles, productProfiles, overrides: os };
      });

    fc.assert(
      fc.property(arbMatrix, (m) => {
        const listed = new Set(
          findProfileGaps(m).map((g) => `${g.partyProfile.id}|${g.productProfile.id}|${g.slot}`),
        );
        for (const party of m.partyProfiles) {
          if (party.status !== 'active') continue;
          const direction: Direction = party.partyKind === 'customer' ? 'sale' : 'purchase';
          for (const product of m.productProfiles) {
            if (product.status !== 'active') continue;
            for (const slot of DIRECTION_SLOTS[direction]) {
              let gap = false;
              try {
                resolvePostingAccount(m, {
                  direction,
                  slot,
                  partyProfileId: party.id,
                  productProfileId: product.id,
                });
              } catch (e) {
                if (!(e instanceof PostingProfileResolutionError) || e.code !== 'PROFILE_GAP')
                  throw e;
                gap = true;
              }
              expect(listed.has(`${party.id}|${product.id}|${slot}`)).toBe(gap);
              listed.delete(`${party.id}|${product.id}|${slot}`);
            }
          }
        }
        // Nothing listed outside active profiles and direction slots.
        expect([...listed]).toEqual([]);
      }),
    );
  });
});

/**
 * SS-PLAT-130 (AC-5) — with profiles v2 (T-0121), an overseas customer no longer makes a sale
 * silently GST-free: a product without its own tax code is refused with NO_TAX_CODE, so a person
 * codes the line (DL-0280 MAJOR 5; interim until ADR-0044, T-0122/T-0123).
 */
describe('SS-PLAT-130: profiles v2 — overseas customer has no party-only GST-free default', () => {
  /** The template's profiles as a matrix; slot account ids are the chart codes. */
  const fromTemplate = (t: PostingProfileTemplate): PostingMatrix => ({
    partyProfiles: t.partyProfiles.map((p) => ({
      id: `pp-${p.code}`,
      code: p.code,
      partyKind: p.partyKind,
      status: 'active',
      defaultTaxCode: p.defaultTaxCode ?? null,
    })),
    productProfiles: t.productProfiles.map((p) => ({
      id: `pr-${p.code}`,
      code: p.code,
      status: 'active',
      slots: Object.fromEntries(
        Object.entries(p.accounts).map(([slot, code]) => [slot, acct(String(code))]),
      ),
    })),
    overrides: [],
  });
  const sale = (t: PostingProfileTemplate, party: string, productTaxCode: string | null) =>
    resolvePostingProfile(fromTemplate(t), {
      direction: 'sale',
      slot: 'revenue',
      partyProfileId: `pp-${party}`,
      productProfileId: 'pr-PROFESSIONAL_SERVICES',
      productTaxCode,
      productLabel: 'Implementation',
    });

  it('OVERSEAS_CUSTOMER × a product without a tax code → NO_TAX_CODE (v1 gave FRE)', () => {
    expect(sale(auServicesSmbProfiles, 'OVERSEAS_CUSTOMER', null).taxCode).toBe('FRE');
    const r = refusal(() => sale(auServicesSmbProfilesV2, 'OVERSEAS_CUSTOMER', null));
    expect(r.code).toBe('NO_TAX_CODE');
  });

  it('a product with its own code still resolves; a domestic customer still defaults to GST', () => {
    expect(sale(auServicesSmbProfilesV2, 'OVERSEAS_CUSTOMER', 'GST')).toMatchObject({
      taxCode: 'GST',
      taxCodeSource: 'product',
      account: { code: '4110' },
    });
    expect(sale(auServicesSmbProfilesV2, 'DOMESTIC_CUSTOMER', null)).toMatchObject({
      taxCode: 'GST',
      taxCodeSource: 'party_profile',
    });
  });

  it('HARDWARE sales post to 4140; HARDWARE purchases have an asset gap; EQUIPMENT buys onto 1500', () => {
    const m = fromTemplate(auServicesSmbProfilesV2);
    expect(
      resolvePostingAccount(m, {
        direction: 'sale',
        slot: 'revenue',
        partyProfileId: 'pp-DOMESTIC_CUSTOMER',
        productProfileId: 'pr-HARDWARE',
      }).account.code,
    ).toBe('4140');
    const gaps = findProfileGaps(m)
      .filter((g) => g.productProfile.code === 'HARDWARE')
      .map((g) => `${g.direction} ${g.partyProfile.code} ${g.slot}`);
    expect(gaps).toContain('purchase DOMESTIC_SUPPLIER asset');
    expect(gaps).toContain('sale DOMESTIC_CUSTOMER cogs');
    expect(
      resolvePostingAccount(m, {
        direction: 'purchase',
        slot: 'asset',
        partyProfileId: 'pp-DOMESTIC_SUPPLIER',
        productProfileId: 'pr-EQUIPMENT',
      }).account.code,
    ).toBe('1500');
  });
});
