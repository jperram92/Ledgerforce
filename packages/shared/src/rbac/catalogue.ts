/**
 * Role templates and permission catalogue (design §6.4, ADR-0023, T-0012).
 *
 * Single source of truth for "which role may do what". The database knows only the role ids
 * (`app.role_template_exists`, migration 0016) so assignments can be checked; the role → permission
 * mapping lives here, as immutable code, so that it is reviewed and versioned with the code that
 * enforces it. A user's permissions are the union over their active role assignments.
 *
 * What this file does NOT decide (hook points for other tasks):
 *  - segregation of duties, e.g. "Owner cannot release a batch they created" (T-0015);
 *  - MFA and step-up (T-0013) — `mfaRequired` below is data for that task;
 *  - connector scopes of the Integration role and API tokens (§6.2, connector tasks).
 */

/** `read` permissions change nothing; the Auditor holds every one of them (design §6.4). */
export type PermissionKind = 'read' | 'write';

const P = <const T extends Record<string, PermissionKind>>(t: T): T => t;

/** Every permission the product checks. Format: `<area>.<object>.<action>` (or `<area>.<action>`). */
export const PERMISSIONS = P({
  // Platform
  'company.read': 'read',
  'users.read': 'read',
  'users.manage': 'write', // invite, disable (leaver), reassign
  'users.roles.assign': 'write', // grant/revoke any role except Owner (mover, design §6.3)
  'users.roles.assign_owner': 'write', // grant/revoke the Owner role
  'subscription.manage': 'write',
  'audit_log.read': 'read',
  'settings.read': 'read',
  // Configuration (Finance Admin)
  'settings.chart.manage': 'write',
  'settings.tax.manage': 'write',
  'settings.posting_rules.author': 'write',
  'settings.posting_rules.activate': 'write',
  'period.close': 'write',
  'period.lock': 'write',
  'period.lock.override': 'write',
  'period.reopen': 'write',
  // General ledger and reporting
  'gl.account.read': 'read',
  'gl.journal.read': 'read',
  'gl.journal.post': 'write', // manual journals
  'gl.journal.approve': 'write',
  'reports.run': 'read',
  // Parties and their bank details
  'parties.read': 'read',
  'parties.manage': 'write',
  'parties.bank_account.read': 'read', // masked to the last 3 characters (ADR-0018)
  'parties.bank_account.change_request': 'write',
  'parties.bank_account.verify': 'write',
  // Bank
  'bank.read': 'read',
  'bank.statement.import': 'write',
  'bank.reconcile': 'write',
  // Tax
  'tax.read': 'read',
  'tax.bas.prepare': 'write',
  // Accounts receivable
  'ar.read': 'read',
  'ar.invoice.create': 'write',
  'ar.invoice.send': 'write',
  'ar.credit_note.create': 'write',
  'ar.credit_note.approve': 'write',
  'ar.receipt.record': 'write',
  'ar.dunning.run': 'write',
  'ar.batch.run': 'write', // UC-02, SS-UC02-07
  'ar.batch.approve': 'write',
  // Accounts payable
  'ap.read': 'read',
  'ap.bill.enter': 'write',
  'ap.bill.approve': 'write',
  'ap.payment_batch.create': 'write',
  'ap.payment_batch.approve': 'write',
  'ap.payment_batch.release': 'write',
  // Payroll (by integration, ADR-0010)
  'payroll.read': 'read',
  'payroll.employee_bank.read': 'read',
  'payroll.pay_run.import': 'write',
  'payroll.net_pay_batch.create': 'write',
  'payroll.net_pay_batch.release': 'write',
});

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
const READ_PERMISSIONS = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p] === 'read');

export function isPermission(p: string): p is Permission {
  return Object.hasOwn(PERMISSIONS, p);
}

/** The ten role templates of design §6.4. Ids are mirrored by `app.role_template_exists` (0016). */
export const ROLE_IDS = [
  'owner',
  'finance_admin',
  'accountant',
  'ar_clerk',
  'ap_clerk',
  'approver',
  'payroll_officer',
  'auditor',
  'sales_user',
  'integration',
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export function isRoleId(r: string): r is RoleId {
  return (ROLE_IDS as readonly string[]).includes(r);
}

export interface RoleTemplate {
  id: RoleId;
  name: string;
  permissions: readonly Permission[];
  /** Design §6.2: MFA mandatory for this role (enforced by T-0013). */
  mfaRequired: boolean;
  /** Design §6.4: Sales user has no UI access by default; Integration never logs in interactively. */
  interactiveLogin: boolean;
}

const ACCOUNTANT: readonly Permission[] = [
  'company.read',
  'settings.read',
  'gl.account.read',
  'gl.journal.read',
  'gl.journal.post',
  'reports.run',
  'parties.read',
  'parties.manage',
  'parties.bank_account.read',
  'bank.read',
  'bank.statement.import',
  'bank.reconcile',
  'tax.read',
  'tax.bas.prepare',
  'ar.read',
  'ap.read',
  'payroll.read',
];

const define = (t: RoleTemplate): RoleTemplate =>
  Object.freeze({ ...t, permissions: Object.freeze([...new Set(t.permissions)]) });

export const ROLE_TEMPLATES: Readonly<Record<RoleId, RoleTemplate>> = Object.freeze({
  // Everything; SoD (T-0015) still stops releasing a batch they created.
  owner: define({
    id: 'owner',
    name: 'Owner',
    permissions: ALL_PERMISSIONS,
    mfaRequired: true,
    interactiveLogin: true,
  }),
  // Adviser equivalent: the Accountant's work plus configuration, periods and user roles (mover,
  // §6.3). Not the Owner role, users.manage, subscription, approvals or releases.
  finance_admin: define({
    id: 'finance_admin',
    name: 'Finance Admin',
    permissions: [
      ...ACCOUNTANT,
      'users.read',
      'users.roles.assign',
      'audit_log.read',
      'settings.chart.manage',
      'settings.tax.manage',
      'settings.posting_rules.author',
      'settings.posting_rules.activate', // SoD: not one they authored (T-0015)
      'period.close',
      'period.lock',
      'period.lock.override',
      'period.reopen', // SoD: two approvers and a reason (T-0015)
      'ar.batch.approve', // UC-02 actors: Approver/Finance Admin approves
    ],
    mfaRequired: true,
    interactiveLogin: true,
  }),
  accountant: define({
    id: 'accountant',
    name: 'Accountant',
    permissions: ACCOUNTANT,
    mfaRequired: true,
    interactiveLogin: true,
  }),
  ar_clerk: define({
    id: 'ar_clerk',
    name: 'AR Clerk',
    permissions: [
      'company.read',
      'parties.read',
      'parties.manage',
      'ar.read',
      'ar.invoice.create',
      'ar.invoice.send',
      'ar.credit_note.create',
      'ar.receipt.record',
      'ar.dunning.run',
      'ar.batch.run',
    ],
    mfaRequired: false,
    interactiveLogin: true,
  }),
  ap_clerk: define({
    id: 'ap_clerk',
    name: 'AP Clerk',
    permissions: [
      'company.read',
      'parties.read',
      'parties.manage',
      'parties.bank_account.read',
      'parties.bank_account.change_request',
      'ap.read',
      'ap.bill.enter',
      'ap.payment_batch.create',
    ],
    mfaRequired: true,
    interactiveLogin: true,
  }),
  // Approves within limits; SoD (T-0015) stops approving what they created.
  approver: define({
    id: 'approver',
    name: 'Approver',
    permissions: [
      'company.read',
      'parties.read',
      'parties.bank_account.read',
      'gl.account.read',
      'gl.journal.read',
      'gl.journal.approve',
      'ar.read',
      'ar.credit_note.approve',
      'ar.batch.approve',
      'ap.read',
      'ap.bill.approve',
      'ap.payment_batch.approve',
      'ap.payment_batch.release',
    ],
    mfaRequired: false,
    interactiveLogin: true,
  }),
  payroll_officer: define({
    id: 'payroll_officer',
    name: 'Payroll Officer',
    permissions: [
      'company.read',
      'parties.read',
      'payroll.read',
      'payroll.employee_bank.read',
      'payroll.pay_run.import',
      'payroll.net_pay_batch.create',
    ],
    mfaRequired: true,
    interactiveLogin: true,
  }),
  // Read-only everything, including the audit log.
  auditor: define({
    id: 'auditor',
    name: 'Auditor',
    permissions: READ_PERMISSIONS,
    mfaRequired: false,
    interactiveLogin: true,
  }),
  // Sees status on Salesforce records (through the Salesforce package, §5.4), not in LedgerForce.
  sales_user: define({
    id: 'sales_user',
    name: 'Sales user (via Salesforce)',
    permissions: [],
    mfaRequired: false,
    interactiveLogin: false,
  }),
  // Only the scopes of its connector (connector tasks); no product permission, no interactive login.
  integration: define({
    id: 'integration',
    name: 'Integration (service)',
    permissions: [],
    mfaRequired: false,
    interactiveLogin: false,
  }),
});

/** Union of the permissions of the given roles. Unknown role ids grant nothing. */
export function permissionsOf(roles: Iterable<string>): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) {
    if (!isRoleId(r)) continue;
    for (const p of ROLE_TEMPLATES[r].permissions) out.add(p);
  }
  return out;
}

export function rolesAllow(roles: Iterable<string>, permission: Permission): boolean {
  return permissionsOf(roles).has(permission);
}

/** Which permission it takes to grant or revoke `role`. */
export function permissionToAssign(role: RoleId): Permission {
  return role === 'owner' ? 'users.roles.assign_owner' : 'users.roles.assign';
}

/** Design §6.2 / ADR-0025: true when any of the roles has a template with `mfaRequired`. */
export function rolesRequireMfa(roles: Iterable<string>): boolean {
  for (const r of roles) if (isRoleId(r) && ROLE_TEMPLATES[r].mfaRequired) return true;
  return false;
}

/**
 * Design §6.2 / ADR-0025: actions that need a fresh step-up re-authentication — releasing payment
 * batches, changing bank details, reopening a locked period. A route whose permission is listed
 * here needs step-up even if it forgot `@RequireStepUp` (fail closed, T-0013).
 */
export const STEP_UP_PERMISSIONS: readonly Permission[] = Object.freeze([
  'ap.payment_batch.release',
  'payroll.net_pay_batch.release',
  'parties.bank_account.change_request',
  'parties.bank_account.verify',
  'period.reopen',
  'period.lock.override',
]);
