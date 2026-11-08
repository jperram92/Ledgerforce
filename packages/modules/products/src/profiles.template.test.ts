/**
 * SS-PLAT-100 — the AU services SMB posting-profile template pre-maps 3 party profiles and 5
 * product profiles onto the AU chart (T-0018) and AU tax codes (T-0034) (T-0038, design §4.4,
 * RQ-0095, DL-0247). Templates are data (design principle 3); the validator keeps them honest.
 */
import { auServicesSmb } from '@ledgerforce/gl';
import { auTaxCodes } from '@ledgerforce/tax';
import { describe, expect, it } from 'vitest';
import { POSTING_SLOTS, SLOT_ACCOUNT_TYPES, slotAllows } from './posting-slots.ts';
import {
  auServicesSmbProfiles,
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
