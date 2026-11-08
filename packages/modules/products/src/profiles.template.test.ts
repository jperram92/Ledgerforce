/**
 * SS-PLAT-100 — the AU services SMB posting-profile template pre-maps 3 party profiles and 5
 * product profiles onto the AU chart (T-0018) and AU tax codes (T-0034) (T-0038, design §4.4,
 * RQ-0096, DL-0250). Templates are data (design principle 3); the validator keeps them honest.
 */
import { auServicesSmb, auServicesSmbV2 } from '@ledgerforce/gl';
import { auTaxCodes, auTaxCodesV1 } from '@ledgerforce/tax';
import { describe, expect, it } from 'vitest';
import { POSTING_SLOTS, SLOT_ACCOUNT_TYPES, slotAllows } from './posting-slots.ts';
import {
  auServicesSmbProfiles,
  auServicesSmbProfilesV2,
  validateProfileTemplate,
  type PostingProfileTemplate,
} from './profiles.template.ts';

const clone = (t: PostingProfileTemplate): PostingProfileTemplate => structuredClone(t);
const check = (t: PostingProfileTemplate) => validateProfileTemplate(t, auServicesSmb, auTaxCodes);

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`test fixture: ${what} not found in the template`);
  return v;
}

describe('posting slots (mirrors app.posting_slot_allows, migration 0032)', () => {
  it('has exactly the five product-profile slots of design §4.4', () => {
    expect([...POSTING_SLOTS]).toEqual(['revenue', 'discount', 'expense', 'cogs', 'asset']);
  });

  it('allows revenue→revenue, discount→revenue|expense, expense→expense, cogs→expense, asset→asset', () => {
    expect(SLOT_ACCOUNT_TYPES).toEqual({
      revenue: ['revenue'],
      discount: ['revenue', 'expense'],
      expense: ['expense'],
      cogs: ['expense'],
      asset: ['asset'],
    });
    expect(slotAllows('revenue', 'revenue')).toBe(true);
    expect(slotAllows('revenue', 'expense')).toBe(false);
    expect(slotAllows('asset', 'liability')).toBe(false);
  });
});

describe('SS-PLAT-100: AU services SMB posting-profile template', () => {
  it('the shipped template has no errors against the AU chart and tax codes', () => {
    expect(check(auServicesSmbProfiles)).toEqual([]);
  });

  it('pre-maps 3 party profiles: domestic and overseas customers, domestic suppliers', () => {
    expect(
      auServicesSmbProfiles.partyProfiles.map((p) => [
        p.code,
        p.partyKind,
        p.controlRole,
        p.defaultTaxCode,
      ]),
    ).toEqual([
      ['DOMESTIC_CUSTOMER', 'customer', 'AR_CONTROL', 'GST'],
      ['OVERSEAS_CUSTOMER', 'customer', 'AR_CONTROL', 'FRE'],
      ['DOMESTIC_SUPPLIER', 'supplier', 'AP_CONTROL', 'GST'],
    ]);
  });

  it('pre-maps 5 product profiles with the golden-file keys and the AU chart accounts', () => {
    const byCode = new Map(auServicesSmbProfiles.productProfiles.map((p) => [p.code, p.accounts]));
    expect([...byCode.keys()]).toEqual([
      'SUBSCRIPTION',
      'PROFESSIONAL_SERVICES',
      'HARDWARE',
      'REIMBURSABLE_EXPENSE',
      'FREIGHT',
    ]);
    // Keys used by Docs/accounting/postings.md (Draft): product:<PROFILE>.<slot>.
    expect(must(byCode.get('PROFESSIONAL_SERVICES'), 'PS').revenue).toBe('4110');
    expect(must(byCode.get('SUBSCRIPTION'), 'SUB').revenue).toBe('4120');
    expect(must(byCode.get('HARDWARE'), 'HW').asset).toBe('1500');
    // Every product profile can be invoiced: each has a revenue account.
    for (const [code, accounts] of byCode) expect(accounts.revenue, code).toMatch(/^4\d{3}$/);
  });

  it('maps Salesforce Account.Type customer values and Product2.Family values to profiles', () => {
    expect(auServicesSmbProfiles.salesforce.account).toEqual([
      { field: 'Type', value: 'Customer - Direct', profile: 'DOMESTIC_CUSTOMER' },
      { field: 'Type', value: 'Customer - Channel', profile: 'DOMESTIC_CUSTOMER' },
    ]);
    expect(
      auServicesSmbProfiles.salesforce.product.map((m) => [m.field, m.value, m.profile]),
    ).toEqual([
      ['Family', 'Subscription', 'SUBSCRIPTION'],
      ['Family', 'Professional Services', 'PROFESSIONAL_SERVICES'],
      ['Family', 'Hardware', 'HARDWARE'],
      ['Family', 'Reimbursable Expense', 'REIMBURSABLE_EXPENSE'],
      ['Family', 'Freight', 'FREIGHT'],
    ]);
  });

  it('flags an unknown account, a wrong slot type and a control account', () => {
    const t = clone(auServicesSmbProfiles);
    const [sub, ps, hw] = t.productProfiles;
    must(sub, 'SUBSCRIPTION').accounts.revenue = '4999';
    must(ps, 'PROFESSIONAL_SERVICES').accounts.revenue = '6200';
    must(hw, 'HARDWARE').accounts.asset = '1200';
    const errors = check(t).join('\n');
    expect(errors).toMatch(/SUBSCRIPTION\.revenue names unknown account 4999/);
    expect(errors).toMatch(
      /PROFESSIONAL_SERVICES\.revenue on 6200: type expense is not one of revenue/,
    );
    expect(errors).toMatch(/HARDWARE\.asset on 1200: control account/);
  });

  it('flags an unknown tax code, a kind/role mismatch, duplicates and dangling Salesforce mappings', () => {
    const t = clone(auServicesSmbProfiles);
    const [dom, , sup] = t.partyProfiles;
    must(dom, 'DOMESTIC_CUSTOMER').defaultTaxCode = 'VAT';
    must(sup, 'DOMESTIC_SUPPLIER').controlRole = 'AR_CONTROL';
    t.productProfiles.push(structuredClone(must(t.productProfiles[0], 'first product profile')));
    t.salesforce.product.push({ field: 'Family', value: 'Hardware', profile: 'HARDWARE' });
    t.salesforce.account.push({ field: 'Type', value: 'Other', profile: 'RELATED_PARTY' });
    t.productProfiles[1] = { ...must(t.productProfiles[1], 'PS'), code: 'bad code' };
    const errors = check(t).join('\n');
    expect(errors).toMatch(/DOMESTIC_CUSTOMER: unknown tax code VAT/);
    expect(errors).toMatch(/DOMESTIC_SUPPLIER: a supplier profile needs AP_CONTROL/);
    expect(errors).toMatch(/duplicate product profile SUBSCRIPTION/);
    expect(errors).toMatch(/Product2\.Family = Hardware is mapped twice/);
    expect(errors).toMatch(/Account\.Type = Other names unknown party profile RELATED_PARTY/);
    expect(errors).toMatch(/profile code bad code must be UPPER_SNAKE/);
  });
});

/**
 * SS-PLAT-130 (AC-2) — profiles v2 (T-0121, DL-0280 MAJORs 4–5, DL-0283): resale hardware is not
 * capitalised into PP&E and earns hardware sales; own-use equipment is its own profile on 1500
 * with CAP; an overseas customer has no party-only GST-free default (interim until ADR-0044).
 */
describe('SS-PLAT-130: AU services SMB posting-profile template v2', () => {
  const v2 = auServicesSmbProfilesV2;
  const product = (code: string) =>
    must(
      v2.productProfiles.find((p) => p.code === code),
      code,
    );
  const party = (code: string) =>
    must(
      v2.partyProfiles.find((p) => p.code === code),
      code,
    );

  it('is version 2, built on chart v2 and au-gst v2, and has no errors against them', () => {
    expect([v2.id, v2.version, v2.chartTemplateVersion, v2.taxTemplateVersion]).toEqual([
      'au-services-smb-profiles',
      2,
      2,
      2,
    ]);
    expect(validateProfileTemplate(v2, auServicesSmbV2, auTaxCodes)).toEqual([]);
  });

  it('is refused against the wrong chart or tax-code version', () => {
    expect(validateProfileTemplate(v2, auServicesSmb, auTaxCodes).join('\n')).toMatch(
      /built on chart au-services-smb version 2, not version 1/,
    );
    expect(validateProfileTemplate(v2, auServicesSmbV2, auTaxCodesV1).join('\n')).toMatch(
      /built on tax codes au-gst version 2, not version 1/,
    );
  });

  it('HARDWARE: asset slot empty (inventory or expensed is a wizard question), revenue 4140, cogs a gap', () => {
    expect(product('HARDWARE').accounts).toEqual({ revenue: '4140' });
  });

  it('EQUIPMENT (own-use): asset 1500, purchase tax CAP', () => {
    expect(product('EQUIPMENT')).toEqual({
      code: 'EQUIPMENT',
      name: 'Equipment (own use)',
      accounts: { asset: '1500' },
      purchaseTaxCode: 'CAP',
    });
  });

  it('OVERSEAS_CUSTOMER has no default tax code; the other party profiles keep GST', () => {
    expect(party('OVERSEAS_CUSTOMER').defaultTaxCode).toBeUndefined();
    expect('defaultTaxCode' in party('OVERSEAS_CUSTOMER')).toBe(false);
    expect(party('DOMESTIC_CUSTOMER').defaultTaxCode).toBe('GST');
    expect(party('DOMESTIC_SUPPLIER').defaultTaxCode).toBe('GST');
  });

  it('every account code is in chart v2 and every tax code in au-gst v2', () => {
    const accounts = new Set(auServicesSmbV2.accounts.map((a) => a.code));
    const taxes = new Set(auTaxCodes.codes.map((c) => c.code));
    for (const p of v2.productProfiles) {
      for (const code of Object.values(p.accounts)) expect(accounts.has(code), p.code).toBe(true);
      if (p.purchaseTaxCode !== undefined) expect(taxes.has(p.purchaseTaxCode), p.code).toBe(true);
    }
    for (const p of v2.partyProfiles) {
      if (p.defaultTaxCode !== undefined) expect(taxes.has(p.defaultTaxCode), p.code).toBe(true);
    }
  });

  it('keeps the other profiles and the Salesforce mappings of v1', () => {
    expect(v2.productProfiles.map((p) => p.code)).toEqual([
      'SUBSCRIPTION',
      'PROFESSIONAL_SERVICES',
      'HARDWARE',
      'REIMBURSABLE_EXPENSE',
      'FREIGHT',
      'EQUIPMENT',
    ]);
    for (const code of [
      'SUBSCRIPTION',
      'PROFESSIONAL_SERVICES',
      'REIMBURSABLE_EXPENSE',
      'FREIGHT',
    ]) {
      expect(product(code), code).toEqual(
        auServicesSmbProfiles.productProfiles.find((p) => p.code === code),
      );
    }
    expect(v2.salesforce).toEqual(auServicesSmbProfiles.salesforce);
  });

  it('flags a purchase tax code that au-gst does not have', () => {
    const t = clone(v2);
    must(
      t.productProfiles.find((p) => p.code === 'EQUIPMENT'),
      'EQUIPMENT',
    ).purchaseTaxCode = 'VAT';
    expect(validateProfileTemplate(t, auServicesSmbV2, auTaxCodes).join('\n')).toMatch(
      /EQUIPMENT: unknown purchase tax code VAT/,
    );
  });

  it('v1 is unchanged: HARDWARE on 1500 and 4190, OVERSEAS_CUSTOMER defaults to FRE', () => {
    expect(auServicesSmbProfiles.version).toBe(1);
    const hw = auServicesSmbProfiles.productProfiles.find((p) => p.code === 'HARDWARE');
    expect(hw?.accounts).toEqual({ revenue: '4190', asset: '1500' });
    expect(
      auServicesSmbProfiles.partyProfiles.find((p) => p.code === 'OVERSEAS_CUSTOMER')
        ?.defaultTaxCode,
    ).toBe('FRE');
  });
});
