/**
 * System roles (design §3.2): the posting engine finds accounts by role, never by code.
 * ROLE_ACCOUNT_TYPES mirrors app.system_role_allows() (migrations 0005 and 0062);
 * chart.db.test.ts proves the two agree for every role × type. EXTENDED_SYSTEM_ROLES mirrors
 * app.system_role_is_extended() (0062, ADR-0061): those roles are bound in
 * app.account_system_role_ext, the others in app.account_system_role; readers use the view
 * app.account_role_binding.
 */
import type { AccountType } from '@ledgerforce/db';

/** The 17 roles of migration 0005 (its CHECK cannot be widened; ADR-0061). */
export const CORE_SYSTEM_ROLES = [
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
] as const;

/** Period-end roles (design §3.2 AASB note, §3.10; migration 0062, ADR-0061, RQ-0143). */
export const EXTENDED_SYSTEM_ROLES = [
  'AR_ECL_ALLOWANCE',
  'PREPAYMENTS',
  'ACCUM_DEPRECIATION',
  'DEPRECIATION_EXPENSE',
  'ACCRUED_EXPENSES',
  'SGC_PAYABLE',
  'PRIOR_PERIOD_ADJUSTMENTS',
] as const;

export const SYSTEM_ROLES = [...CORE_SYSTEM_ROLES, ...EXTENDED_SYSTEM_ROLES] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];
export type ExtendedSystemRole = (typeof EXTENDED_SYSTEM_ROLES)[number];

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

export const ROLE_ACCOUNT_TYPES: Readonly<Record<SystemRole, readonly AccountType[]>> = {
  AR_CONTROL: ['asset'],
  UNDEPOSITED_FUNDS: ['asset'],
  GST_PAID: ['asset'],
  AP_CONTROL: ['liability'],
  GST_COLLECTED: ['liability'],
  PAYROLL_CLEARING: ['liability'],
  WAGES_PAYABLE: ['liability'],
  PAYG_WITHHOLDING: ['liability'],
  SUPER_PAYABLE: ['liability'],
  DEFERRED_REVENUE: ['liability'],
  CUSTOMER_PREPAYMENTS: ['liability'],
  RETAINED_EARNINGS: ['equity'],
  CURRENT_YEAR_EARNINGS: ['equity'],
  ROUNDING: ['expense', 'revenue'],
  FX_REALISED: ['expense', 'revenue'],
  FX_UNREALISED: ['expense', 'revenue'],
  SUSPENSE: ['asset', 'liability'],
  // Period-end roles (0062). The allowances are contra-assets: type asset, credit normal balance.
  AR_ECL_ALLOWANCE: ['asset'],
  PREPAYMENTS: ['asset'],
  ACCUM_DEPRECIATION: ['asset'],
  DEPRECIATION_EXPENSE: ['expense'],
  ACCRUED_EXPENSES: ['liability'],
  SGC_PAYABLE: ['liability'],
  PRIOR_PERIOD_ADJUSTMENTS: ['equity'],
};

/** Control accounts: posted only by their subledger. */
export const CONTROL_ROLES: readonly SystemRole[] = [
  'AR_CONTROL',
  'AP_CONTROL',
  'PAYROLL_CLEARING',
];

/** The one role whose account is never posted to directly (closing computes it). */
export const NON_POSTABLE_ROLES: readonly SystemRole[] = ['CURRENT_YEAR_EARNINGS'];

export const isSystemRole = (s: string): s is SystemRole =>
  (SYSTEM_ROLES as readonly string[]).includes(s);

export const isExtendedSystemRole = (s: string): s is ExtendedSystemRole =>
  (EXTENDED_SYSTEM_ROLES as readonly string[]).includes(s);

/** The table a role's binding is written to (ADR-0061). Read through app.account_role_binding. */
export const bindingTableFor = (
  role: SystemRole,
): 'app.account_system_role' | 'app.account_system_role_ext' =>
  isExtendedSystemRole(role) ? 'app.account_system_role_ext' : 'app.account_system_role';
