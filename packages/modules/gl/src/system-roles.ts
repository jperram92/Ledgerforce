/**
 * System roles (design §3.2): the posting engine finds accounts by role, never by code.
 * ROLE_ACCOUNT_TYPES mirrors app.system_role_allows() in migration 0005; chart.db.test.ts
 * proves the two agree for every role × type.
 */
import type { AccountType } from '@ledgerforce/db';

export const SYSTEM_ROLES = [
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
export type SystemRole = (typeof SYSTEM_ROLES)[number];

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
