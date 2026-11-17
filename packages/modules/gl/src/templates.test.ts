/**
 * SS-PLAT-32 — the AU services SMB chart template is internally valid (T-0018, design §3.2).
 * Templates are data (design principle 3), so the validator is what keeps them honest.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, ROLE_ACCOUNT_TYPES, CONTROL_ROLES } from './system-roles.ts';
import {
  auServicesSmb,
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
  it('knows exactly the 17 core roles of design §3.2, the 7 period-end roles of §3.2/§3.10 and the ADR-0089 role [T-0117][T-0203]', () => {
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
        // Period-end roles (design §3.2 AASB note, §3.10; ADR-0061, T-0117).
        'AR_ECL_ALLOWANCE',
        'PREPAYMENTS',
        'ACCUM_DEPRECIATION',
        'DEPRECIATION_EXPENSE',
        'ACCRUED_EXPENSES',
        'SGC_PAYABLE',
        'PRIOR_PERIOD_ADJUSTMENTS',
        // Single-supply GST attribution (ADR-0089 R3, T-0203).
        'GST_ATTRIBUTED_UNBILLED',
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

describe('T-0159: the ECL allowance comes from its system role, not a suggested setting (ADR-0068)', () => {
  it('suggests no ECL allowance setting; AR_ECL_ALLOWANCE stays bound to 1220', () => {
    expect(Object.keys(auServicesSmb.suggestedSettings)).not.toContain('ecl_allowance_account');
    expect(
      auServicesSmb.accounts.filter((a) => a.systemRole === 'AR_ECL_ALLOWANCE').map((a) => a.code),
    ).toEqual(['1220']);
  });
});

describe('SS-PLAT-142: account 1230 GST attributed on unbilled supplies (ADR-0089 R3, review finding 4)', () => {
  const a = () => find(auServicesSmb, (x) => x.code === '1230', '1230');

  it('SS-PLAT-142 AC-2 binds GST_ATTRIBUTED_UNBILLED to 1230, an other current asset with a debit balance, not control [T-0203]', () => {
    expect(
      auServicesSmb.accounts
        .filter((x) => x.systemRole === 'GST_ATTRIBUTED_UNBILLED')
        .map((x) => x.code),
    ).toEqual(['1230']);
    expect(a()).toMatchObject({
      name: 'GST attributed on unbilled supplies',
      type: 'asset',
      subtype: 'current_asset',
      normalBalance: 'debit',
      postable: true,
      control: false,
    });
    expect(auServicesSmb.version).toBe(2);
  });

  it('SS-PLAT-142 AC-11 its description is the disclosure policy: other current asset, recoverability like a prepayment, outside trade receivables and the ECL base [T-0203]', () => {
    const d = a().description ?? '';
    expect(d).toMatch(/other current asset/i);
    expect(d).toMatch(/recoverability .*like a prepayment/i);
    expect(d).toMatch(/not a trade receivable/i);
    expect(d).toMatch(/outside the expected credit loss \(ECL\) base/i);
    expect(d).toMatch(/ADR-0089/);
  });

  it('SS-PLAT-142 AC-11 a description must not be blank when given [T-0203]', () => {
    const t = clone(auServicesSmb);
    find(t, (x) => x.code === '1230', '1230').description = '  ';
    expect(validateTemplate(t).join('\n')).toMatch(/1230: description is empty/);
  });
});
