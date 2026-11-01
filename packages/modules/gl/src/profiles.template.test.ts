/**
 * SS-PLAT-103 — posting profiles in the AU services SMB template (T-0038, design §4.4): three
 * party profiles and five product profiles pre-mapped onto the template's own accounts, plus the
 * Salesforce Product2.Family / Account.Type mapping hooks. validateTemplate() refuses a profile
 * that points at the wrong kind of account.
 */
import { describe, expect, it } from 'vitest';
import { auServicesSmb, validateTemplate, type ChartTemplate } from './templates.ts';

const clone = (t: ChartTemplate): ChartTemplate => structuredClone(t);
const codeOfRole = (role: string) =>
  auServicesSmb.accounts.find((a) => a.systemRole === role)?.code ?? '?';

describe('SS-PLAT-103: Template posting profiles', () => {
  it('SS-PLAT-103 has 3 party and 5 product profiles, all valid', () => {
    expect(validateTemplate(auServicesSmb)).toEqual([]);
    expect(auServicesSmb.partyProfiles.map((p) => p.code)).toEqual([
      'DOMESTIC_CUSTOMER',
      'OVERSEAS_CUSTOMER',
      'DOMESTIC_SUPPLIER',
    ]);
    expect(auServicesSmb.productProfiles.map((p) => p.code)).toEqual([
      'PROFESSIONAL_SERVICES',
      'SUBSCRIPTION',
      'TRAINING',
      'REIMBURSABLE_EXPENSE',
      'HARDWARE',
    ]);
  });

  it('SS-PLAT-103 customer profiles use AR control, supplier profiles AP control', () => {
    for (const p of auServicesSmb.partyProfiles) {
      expect(p.controlAccount, p.code).toBe(
        codeOfRole(p.kind === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL'),
      );
    }
  });

  it('SS-PLAT-103 overseas customers default to GST-free export; domestic parties to GST', () => {
    const tax = Object.fromEntries(
      auServicesSmb.partyProfiles.map((p) => [p.code, p.defaultTaxCode]),
    );
    expect(tax).toEqual({
      DOMESTIC_CUSTOMER: 'GST',
      OVERSEAS_CUSTOMER: 'GST-FREE-EXPORT',
      DOMESTIC_SUPPLIER: 'GST',
    });
  });

  it('SS-PLAT-103 every product profile names a revenue account; hardware has a COGS account', () => {
    const type = (code: string | null | undefined) =>
      auServicesSmb.accounts.find((a) => a.code === code)?.type;
    for (const p of auServicesSmb.productProfiles) {
      expect(type(p.revenueAccount), p.code).toBe('revenue');
      if (p.expenseAccount) expect(type(p.expenseAccount), p.code).toBe('expense');
      if (p.cogsAccount) expect(type(p.cogsAccount), p.code).toBe('expense');
    }
    const hw = auServicesSmb.productProfiles.find((p) => p.code === 'HARDWARE');
    expect(hw?.cogsAccount).toBeTruthy();
  });

  it('SS-PLAT-103 Salesforce mapping hooks name existing profiles', () => {
    const party = new Set(auServicesSmb.partyProfiles.map((p) => p.code));
    const product = new Set(auServicesSmb.productProfiles.map((p) => p.code));
    for (const target of Object.values(auServicesSmb.profileMappings.productFamily)) {
      expect(product.has(target), target).toBe(true);
    }
    for (const target of Object.values(auServicesSmb.profileMappings.accountType)) {
      expect(party.has(target), target).toBe(true);
    }
    expect(Object.keys(auServicesSmb.profileMappings.productFamily).length).toBeGreaterThan(0);
    expect(Object.keys(auServicesSmb.profileMappings.accountType).length).toBeGreaterThan(0);
  });

  it('SS-PLAT-103 validateTemplate refuses misdirected profiles and dangling mappings', () => {
    const t = clone(auServicesSmb);
    const customer = t.partyProfiles[0];
    const services = t.productProfiles[0];
    if (!customer || !services) throw new Error('fixture');
    customer.controlAccount = codeOfRole('AP_CONTROL');
    services.revenueAccount = '6200'; // an expense account
    services.cogsAccount = '4110'; // a revenue account
    t.partyProfiles.push({ ...customer, code: 'DOMESTIC_CUSTOMER' }); // duplicate code
    t.profileMappings.productFamily['Gadgets'] = 'NO_SUCH_PROFILE';
    t.profileMappings.accountType['Partner'] = 'NO_SUCH_PARTY_PROFILE';
    const problems = validateTemplate(t).join('\n');
    expect(problems).toMatch(/DOMESTIC_CUSTOMER.*AR_CONTROL/);
    expect(problems).toMatch(/PROFESSIONAL_SERVICES.*revenue account 6200/);
    expect(problems).toMatch(/PROFESSIONAL_SERVICES.*cogs account 4110/);
    expect(problems).toMatch(/duplicate party profile DOMESTIC_CUSTOMER/);
    expect(problems).toMatch(/Gadgets.*NO_SUCH_PROFILE/);
    expect(problems).toMatch(/Partner.*NO_SUCH_PARTY_PROFILE/);
  });
});
