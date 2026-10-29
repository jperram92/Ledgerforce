/**
 * SS-PLAT-48 / SS-UC02-07 (unit) — the role templates of design §6.4 as a table-driven matrix
 * (T-0012, ADR-0023). The exact holders of every write permission are listed here, so any change
 * to the catalogue's mapping fails this test until it is reviewed.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_IDS,
  ROLE_TEMPLATES,
  isPermission,
  permissionToAssign,
  permissionsOf,
  rolesAllow,
  type Permission,
  type RoleId,
} from './index.ts';

/** Who holds each write permission (Owner holds all of them; listed for readability). */
const WRITE_HOLDERS: Record<string, readonly RoleId[]> = {
  'users.manage': ['owner'],
  'users.roles.assign': ['owner', 'finance_admin'],
  'users.roles.assign_owner': ['owner'],
  'subscription.manage': ['owner'],
  'settings.sod.manage': ['owner'], // T-0015, ADR-0026
  'settings.chart.manage': ['owner', 'finance_admin'],
  'settings.tax.manage': ['owner', 'finance_admin'],
  'settings.posting_rules.author': ['owner', 'finance_admin'],
  'settings.posting_rules.activate': ['owner', 'finance_admin'],
  'period.close': ['owner', 'finance_admin'],
  'period.lock': ['owner', 'finance_admin'],
  'period.lock.override': ['owner', 'finance_admin'],
  'period.reopen': ['owner', 'finance_admin'],
  'gl.journal.post': ['owner', 'finance_admin', 'accountant'],
  'gl.journal.approve': ['owner', 'approver'],
  'parties.manage': ['owner', 'finance_admin', 'accountant', 'ar_clerk', 'ap_clerk'],
  'parties.bank_account.change_request': ['owner', 'ap_clerk'],
  'parties.bank_account.verify': ['owner'],
  'bank.statement.import': ['owner', 'finance_admin', 'accountant'],
  'bank.reconcile': ['owner', 'finance_admin', 'accountant'],
  'tax.bas.prepare': ['owner', 'finance_admin', 'accountant'],
  'ar.invoice.create': ['owner', 'ar_clerk'],
  'ar.invoice.send': ['owner', 'ar_clerk'],
  'ar.credit_note.create': ['owner', 'ar_clerk'],
  'ar.credit_note.approve': ['owner', 'approver'],
  'ar.receipt.record': ['owner', 'ar_clerk'],
  'ar.dunning.run': ['owner', 'ar_clerk'],
  'ar.batch.run': ['owner', 'ar_clerk'],
  'ar.batch.approve': ['owner', 'finance_admin', 'approver'],
  'ap.bill.enter': ['owner', 'ap_clerk'],
  'ap.bill.approve': ['owner', 'approver'],
  'ap.payment_batch.create': ['owner', 'ap_clerk'],
  'ap.payment_batch.approve': ['owner', 'approver'],
  'ap.payment_batch.release': ['owner', 'approver'],
  'payroll.pay_run.import': ['owner', 'payroll_officer'],
  'payroll.net_pay_batch.create': ['owner', 'payroll_officer'],
  'payroll.net_pay_batch.release': ['owner'],
  'sync.issues.manage': ['owner', 'finance_admin', 'accountant'], // T-0071, DL-0215
};

/** Design §6.4 "Can" and "Cannot (by default)" columns, as permissions. */
const DESIGN: Record<RoleId, { can: Permission[]; cannot: Permission[] }> = {
  owner: { can: ['users.manage', 'subscription.manage', 'ap.payment_batch.release'], cannot: [] },
  finance_admin: {
    can: [
      'settings.chart.manage',
      'settings.tax.manage',
      'settings.posting_rules.author',
      'period.close',
      'period.lock',
      'period.lock.override',
    ],
    cannot: ['users.manage', 'users.roles.assign_owner', 'subscription.manage'],
  },
  accountant: {
    can: ['gl.journal.post', 'bank.reconcile', 'reports.run', 'tax.bas.prepare'],
    cannot: [
      'users.manage',
      'users.roles.assign',
      'ap.payment_batch.release',
      'payroll.net_pay_batch.release',
    ],
  },
  ar_clerk: {
    can: [
      'ar.invoice.create',
      'ar.invoice.send',
      'ar.credit_note.create',
      'ar.receipt.record',
      'ar.dunning.run',
      'ar.batch.run',
    ],
    cannot: ['gl.journal.post', 'ar.credit_note.approve'],
  },
  ap_clerk: {
    can: ['ap.bill.enter', 'ap.payment_batch.create', 'parties.bank_account.change_request'],
    cannot: ['ap.bill.approve', 'ap.payment_batch.release', 'parties.bank_account.verify'],
  },
  approver: {
    can: [
      'ap.bill.approve',
      'ar.credit_note.approve',
      'gl.journal.approve',
      'ap.payment_batch.approve',
    ],
    cannot: [
      'ap.bill.enter',
      'ar.credit_note.create',
      'gl.journal.post',
      'ap.payment_batch.create',
    ],
  },
  payroll_officer: {
    can: ['payroll.pay_run.import', 'payroll.net_pay_batch.create', 'payroll.employee_bank.read'],
    cannot: ['payroll.net_pay_batch.release'],
  },
  auditor: {
    can: ['audit_log.read', 'reports.run', 'gl.journal.read'],
    cannot: ['gl.journal.post'],
  },
  sales_user: { can: [], cannot: ['company.read', 'ar.read'] },
  integration: { can: [], cannot: ['company.read'] },
};

const writes = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p] === 'write');
const reads = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p] === 'read');

describe('SS-PLAT-48: Role templates grant exactly the design §6.4 matrix', () => {
  it('has the ten role templates of §6.4, each with its id', () => {
    expect([...ROLE_IDS].sort()).toEqual(
      [
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
      ].sort(),
    );
    for (const id of ROLE_IDS) expect(ROLE_TEMPLATES[id].id).toBe(id);
  });

  it('lists the holders of every write permission (no write permission is unlisted)', () => {
    expect(Object.keys(WRITE_HOLDERS).sort()).toEqual([...writes].sort());
  });

  it.each(Object.entries(WRITE_HOLDERS))('%s is held by exactly %j', (perm, holders) => {
    const actual = ROLE_IDS.filter((r) =>
      ROLE_TEMPLATES[r].permissions.includes(perm as Permission),
    );
    expect([...actual].sort()).toEqual([...holders].sort());
  });

  it.each(ROLE_IDS)('%s: can and cannot as in §6.4', (role) => {
    const held = permissionsOf([role]);
    for (const p of DESIGN[role].can) expect(held.has(p), `${role} can ${p}`).toBe(true);
    for (const p of DESIGN[role].cannot) expect(held.has(p), `${role} cannot ${p}`).toBe(false);
  });

  it('Owner holds every permission; Auditor holds every read permission and no write', () => {
    expect([...permissionsOf(['owner'])].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect([...permissionsOf(['auditor'])].sort()).toEqual([...reads].sort());
  });

  it('Sales user and Integration hold nothing and never log in interactively', () => {
    for (const r of ['sales_user', 'integration'] as const) {
      expect(ROLE_TEMPLATES[r].permissions).toEqual([]);
      expect(ROLE_TEMPLATES[r].interactiveLogin).toBe(false);
    }
  });

  it('MFA is mandatory exactly for Owner, Finance Admin, Accountant, AP Clerk, Payroll Officer (§6.2)', () => {
    expect(ROLE_IDS.filter((r) => ROLE_TEMPLATES[r].mfaRequired).sort()).toEqual(
      ['owner', 'finance_admin', 'accountant', 'ap_clerk', 'payroll_officer'].sort(),
    );
  });

  it('permissions of several roles are their union; unknown roles grant nothing', () => {
    const both = permissionsOf(['ar_clerk', 'approver']);
    expect(both.has('ar.batch.run')).toBe(true);
    expect(both.has('ap.bill.approve')).toBe(true);
    expect(permissionsOf(['superuser', 'OWNER']).size).toBe(0);
    expect(isPermission('ar.batch.run')).toBe(true);
    expect(isPermission('ar.batch.*')).toBe(false);
  });

  it('granting or revoking Owner needs users.roles.assign_owner; any other role users.roles.assign', () => {
    expect(permissionToAssign('owner')).toBe('users.roles.assign_owner');
    for (const r of ROLE_IDS.filter((x) => x !== 'owner')) {
      expect(permissionToAssign(r)).toBe('users.roles.assign');
    }
  });

  it('templates cannot be changed at runtime', () => {
    expect(Object.isFrozen(ROLE_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(ROLE_TEMPLATES.ar_clerk)).toBe(true);
    expect(Object.isFrozen(ROLE_TEMPLATES.ar_clerk.permissions)).toBe(true);
  });
});

describe('SS-UC02-07: Permission required to run a batch', () => {
  it.each(ROLE_IDS)('%s may run a batch only if the template grants ar.batch.run', (role) => {
    expect(rolesAllow([role], 'ar.batch.run')).toBe(role === 'owner' || role === 'ar_clerk');
  });

  it('a user with no role may not run a batch', () => {
    expect(rolesAllow([], 'ar.batch.run')).toBe(false);
  });
});
