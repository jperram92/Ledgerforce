/**
 * SS-PLAT-32 — the AU services SMB chart template is internally valid (T-0018, design §3.2).
 * Templates are data (design principle 3), so the validator is what keeps them honest.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, ROLE_ACCOUNT_TYPES, CONTROL_ROLES } from './system-roles.ts';
import {
  auServicesSmb,
  auServicesSmbV2,
  validateTemplate,
  type ChartTemplate,
  type TemplateAccount,
} from './templates.ts';

const clone = (t: ChartTemplate): ChartTemplate => structuredClone(t);

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`test fixture: ${what} not found in the template`);
  return v;
}
const find = (t: ChartTemplate, pred: (a: TemplateAccount) => boolean, what: string) =>
  must(t.accounts.find(pred), what);

describe('SS-PLAT-32: AU services SMB chart template is valid', () => {
  it('knows exactly the 17 system roles listed in design §3.2', () => {
    expect([...SYSTEM_ROLES].sort()).toEqual(
      [
        'AR_CONTROL',
        'AP_CONTROL',
        'GST_COLLECTED',
        'GST_PAID',
        'RETAINED_EARNINGS',
        'CURRENT_YEAR_EARNINGS',
        'ROUNDING',
        'FX_REALISED',
        'FX_UNREALISED',
        'SUSPENSE',
        'UNDEPOSITED_FUNDS',
        'PAYROLL_CLEARING',
        'WAGES_PAYABLE',
        'PAYG_WITHHOLDING',
        'SUPER_PAYABLE',
        'DEFERRED_REVENUE',
        'CUSTOMER_PREPAYMENTS',
      ].sort(),
    );
    expect([...CONTROL_ROLES].sort()).toEqual(['AP_CONTROL', 'AR_CONTROL', 'PAYROLL_CLEARING']);
  });

  it('the shipped template has no errors', () => {
    expect(validateTemplate(auServicesSmb)).toEqual([]);
  });

  it('binds every system role exactly once, to an account of an allowed type', () => {
    const byCode = new Map(auServicesSmb.accounts.map((a) => [a.code, a]));
    for (const role of SYSTEM_ROLES) {
      const bound = auServicesSmb.accounts.filter((a) => a.systemRole === role);
      expect(bound, role).toHaveLength(1);
      const acct = must(byCode.get(must(bound[0], role).code), role);
      expect(ROLE_ACCOUNT_TYPES[role], role).toContain(acct.type);
    }
  });

  it('flags a duplicated role, a missing role and a role on the wrong account type', () => {
    const dup = clone(auServicesSmb);
    const extra = find(dup, (a) => a.code === '1020', '1020');
    extra.systemRole = 'AR_CONTROL';
    expect(validateTemplate(dup).join('\n')).toMatch(/AR_CONTROL bound 2 times/);

    const missing = clone(auServicesSmb);
    find(missing, (a) => a.systemRole === 'SUSPENSE', 'SUSPENSE').systemRole = undefined;
    expect(validateTemplate(missing).join('\n')).toMatch(/SUSPENSE is not bound/);

    const wrong = clone(auServicesSmb);
    find(wrong, (a) => a.systemRole === 'GST_PAID', 'GST_PAID').type = 'liability';
    expect(validateTemplate(wrong).join('\n')).toMatch(/GST_PAID .* type liability/);
  });

  it('flags duplicate codes, bad codes, control flags off the control roles and a postable CURRENT_YEAR_EARNINGS', () => {
    const t = clone(auServicesSmb);
    t.accounts.push({ ...must(t.accounts[0], 'first account'), systemRole: undefined });
    t.accounts.push({
      code: '12A',
      name: 'Bad',
      type: 'asset',
      subtype: 'current_asset',
      normalBalance: 'debit',
      postable: true,
      control: false,
    });
    find(t, (a) => a.code === '1300', '1300').control = true;
    find(t, (a) => a.systemRole === 'CURRENT_YEAR_EARNINGS', 'CYE').postable = true;
    const errors = validateTemplate(t).join('\n');
    expect(errors).toMatch(/duplicate code/);
    expect(errors).toMatch(/code 12A/);
    expect(errors).toMatch(/1300 .*control/);
    expect(errors).toMatch(/CURRENT_YEAR_EARNINGS .*postable/);
  });
});

/**
 * SS-PLAT-130 (AC-1) — chart v2 (T-0121, DL-0280 MAJORs 2–4, DL-0283): fixed assets default to
 * CAP (BAS G10, not G11), an ECL allowance account 1290 for the AASB 9 write-off path, and a
 * hardware sales account 4140. v1 is kept unchanged and marked superseded (ADR-0014).
 */
describe('SS-PLAT-130: AU services SMB chart template v2', () => {
  const byCode = (t: ChartTemplate) => new Map(t.accounts.map((a) => [a.code, a]));

  it('is version 2 of the same template and has no errors', () => {
    expect([auServicesSmbV2.id, auServicesSmbV2.version]).toEqual(['au-services-smb', 2]);
    expect(validateTemplate(auServicesSmbV2)).toEqual([]);
  });

  it('every debit-normal fixed asset defaults to CAP; credit-normal accumulated depreciation has no code', () => {
    const fixed = auServicesSmbV2.accounts.filter((a) => a.subtype === 'fixed_asset');
    expect(fixed.length).toBeGreaterThan(0);
    for (const a of fixed) {
      if (a.normalBalance === 'debit') expect(a.defaultTaxCode, a.code).toBe('CAP');
      else expect(a.defaultTaxCode, a.code).toBeUndefined();
    }
    expect(must(byCode(auServicesSmbV2).get('1500'), '1500').defaultTaxCode).toBe('CAP');
    expect(must(byCode(auServicesSmbV2).get('1510'), '1510').defaultTaxCode).toBeUndefined();
  });

  it('has 1290 Allowance for expected credit losses: contra receivable, credit normal, postable, not control', () => {
    expect(must(byCode(auServicesSmbV2).get('1290'), '1290')).toEqual({
      code: '1290',
      name: 'Allowance for expected credit losses',
      type: 'asset',
      subtype: 'receivable',
      normalBalance: 'credit',
      postable: true,
      control: false,
    });
    expect(auServicesSmbV2.suggestedSettings.ecl_allowance_account).toBe('1290');
    // The bad-debt (impairment expense) setting is unchanged.
    expect(auServicesSmbV2.suggestedSettings.bad_debts_account).toBe('6500');
  });

  it('has 4140 Hardware sales (GST); 4190 stays Recoverable costs income', () => {
    const accounts = byCode(auServicesSmbV2);
    expect(must(accounts.get('4140'), '4140')).toEqual({
      code: '4140',
      name: 'Hardware sales',
      type: 'revenue',
      subtype: 'operating_revenue',
      normalBalance: 'credit',
      postable: true,
      control: false,
      defaultTaxCode: 'GST',
    });
    expect(must(accounts.get('4190'), '4190').name).toBe('Recoverable costs income');
  });

  it('changes nothing else: v2 = v1 + 1290 + 4140, with fixed-asset tax codes CAP', () => {
    const v1 = byCode(auServicesSmb);
    const v2 = byCode(auServicesSmbV2);
    expect([...v2.keys()].filter((c) => !v1.has(c)).sort()).toEqual(['1290', '4140']);
    for (const [code, a] of v1) {
      const b = must(v2.get(code), code);
      const expected =
        a.subtype === 'fixed_asset' && a.normalBalance === 'debit'
          ? { ...a, defaultTaxCode: 'CAP' }
          : a;
      expect(b, code).toEqual(expected);
    }
  });

  it('v1 still loads unchanged: version 1, 1500 defaults to GST, no 1290 or 4140', () => {
    expect(auServicesSmb.version).toBe(1);
    expect(validateTemplate(auServicesSmb)).toEqual([]);
    const v1 = byCode(auServicesSmb);
    expect(must(v1.get('1500'), '1500').defaultTaxCode).toBe('GST');
    expect(v1.has('1290')).toBe(false);
    expect(v1.has('4140')).toBe(false);
    expect(auServicesSmb.suggestedSettings).toEqual({
      stripe_clearing_account: '1210',
      merchant_fees_account: '6120',
      bad_debts_account: '6500',
    });
  });
});
