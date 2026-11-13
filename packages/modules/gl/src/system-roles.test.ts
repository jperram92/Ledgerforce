/**
 * T-0117 / ADR-0061 — the period-end system roles and where their bindings live. Expected types
 * come from RQ-0143 (design §3.2 AASB note, §3.10), not from the code under test.
 */
import { describe, expect, it } from 'vitest';
import * as roles from './system-roles.ts';

const PERIOD_END: Record<string, string[]> = {
  AR_ECL_ALLOWANCE: ['asset'],
  PREPAYMENTS: ['asset'],
  ACCUM_DEPRECIATION: ['asset'],
  DEPRECIATION_EXPENSE: ['expense'],
  ACCRUED_EXPENSES: ['liability'],
  SGC_PAYABLE: ['liability'],
  PRIOR_PERIOD_ADJUSTMENTS: ['equity'],
};

describe('ADR-0061: period-end system roles', () => {
  it('AC-2 the seven period-end roles are the extended roles [T-0117]', () => {
    expect([...roles.EXTENDED_SYSTEM_ROLES].sort()).toEqual(Object.keys(PERIOD_END).sort());
  });

  it('AC-2 each period-end role allows exactly the researched account type [T-0117]', () => {
    const types = roles.ROLE_ACCOUNT_TYPES as Record<string, readonly string[] | undefined>;
    for (const [role, want] of Object.entries(PERIOD_END)) {
      expect(types[role], role).toEqual(want);
    }
  });

  it('AC-2 none is a control role and all are postable [T-0117]', () => {
    for (const role of Object.keys(PERIOD_END)) {
      expect(roles.CONTROL_ROLES as readonly string[], role).not.toContain(role);
      expect(roles.NON_POSTABLE_ROLES as readonly string[], role).not.toContain(role);
    }
  });

  it('AC-2 writes go to the additive table for period-end roles and the core table otherwise [T-0117]', () => {
    for (const role of roles.SYSTEM_ROLES) {
      expect(roles.bindingTableFor(role), role).toBe(
        role in PERIOD_END ? 'app.account_system_role_ext' : 'app.account_system_role',
      );
    }
  });
});
