/**
 * Plain words for the admin screens (P6, P12): every refusal the admin routes can answer, role
 * names from the role templates, and each segregation-of-duties rule as one sentence.
 */
import { isRoleId, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import type { SodRuleId } from '@ledgerforce/shared/sod';
import { AdminApiError } from './client.ts';

const MESSAGES = {
  self_grant:
    "You can't give yourself a role. Another Owner or Finance Admin has to do it, so nobody widens their own access.",
  last_owner:
    'This is the last Owner. Make someone else an Owner first: an organisation always needs one.',
  user_disabled:
    'This person is disabled, so they cannot be given roles. Invite them again if they are coming back.',
  user_exists: 'Someone with this email address or sign-in id is already a user here.',
  invalid_user:
    'Fill in the name, a valid email address, the identity provider and their id there.',
  invalid_role: 'That role does not exist. Choose one from the list.',
  invalid_reason: 'Write a reason of up to 500 characters. It is kept in the audit log.',
  invalid_successor:
    'Choose an active person, other than the one you are disabling, to take over their approvals.',
  cannot_offboard_self: "You can't disable yourself. Ask another Owner to do it.",
  not_found: 'There is nothing here: it does not exist, or it belongs to another organisation.',
  invalid_week_start: 'That week could not be found. Weeks start on a Monday.',
  invalid_note: 'The note is too long. Keep it under 2,000 characters.',
  invalid_filter:
    'Check the filters: dates must be real days with "from" before "to", and the person must be chosen from the list.',
  forbidden: "You don't have permission for this.",
  mfa_required:
    'Your role needs two-step sign-in (MFA). Sign out, then sign in again with your second factor.',
  step_up_required: 'This needs you to confirm your sign-in again before it can go ahead.',
  step_up_mismatch:
    'The sign-in you just confirmed belongs to someone else. Sign in again as yourself.',
  unauthenticated: 'You are signed out. Sign in again to continue.',
  session_expired: 'Your session has ended. Sign in again to continue.',
  sod_violation:
    'A separation-of-duties rule stops one person doing both steps. Someone else has to do this one.',
} as const;

export const API_ERROR_CODES = Object.keys(MESSAGES) as (keyof typeof MESSAGES)[];

const OFFLINE = 'LedgerForce did not answer. Check your connection, then try again.';

export function messageFor(error: unknown): string {
  if (!(error instanceof AdminApiError)) return OFFLINE;
  const known = (MESSAGES as Record<string, string>)[error.code];
  if (error.code === 'forbidden' && typeof error.body['permission'] === 'string') {
    return `${MESSAGES.forbidden} It needs the ${error.body['permission']} permission; ask the Owner.`;
  }
  return known ?? `LedgerForce did not accept this (${error.code}). Try again, or ask the Owner.`;
}

export function roleName(role: string): string {
  return isRoleId(role) ? ROLE_TEMPLATES[role].name : role;
}

const RULES: Record<SodRuleId, string> = {
  SOD_BATCH_SELF_RELEASE: 'Released a payment batch they had created',
  SOD_BATCH_SAME_RELEASER: 'Gave both releases of a large payment batch',
  SOD_BATCH_SELF_APPROVAL: 'Approved a payment batch they had created',
  SOD_NET_PAY_SELF_RELEASE: 'Released a net-pay batch they had created',
  SOD_BANK_DETAIL_SELF_VERIFY: 'Verified bank details they had asked to change',
  SOD_BILL_SELF_APPROVAL: 'Approved a bill they had entered, above the bill limit',
  SOD_JOURNAL_SELF_APPROVAL: 'Approved a manual journal they had posted',
  SOD_RULE_SELF_ACTIVATION: 'Switched on a posting rule they had written',
  SOD_TAX_CODE_SELF_ACTIVATION: 'Switched on a tax code they had written',
  SOD_PERIOD_REOPEN_SELF_APPROVAL: 'Approved reopening a locked period they had asked to reopen',
  SOD_CREDIT_NOTE_SELF_APPROVAL: 'Approved a credit note they had created, above the limit',
};

export function ruleText(rule: string): string {
  return (RULES as Record<string, string>)[rule] ?? rule;
}

export const KIND_TEXT: Record<string, string> = {
  external_reviewer: 'Checked by an outside reviewer',
  recorded_exception: 'Allowed and recorded (small team)',
};

export const STATUS_TEXT: Record<string, string> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};
