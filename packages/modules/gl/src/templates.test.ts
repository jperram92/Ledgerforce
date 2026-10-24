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
