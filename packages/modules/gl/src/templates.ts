/**
 * Chart templates (design §3.2): country starter charts kept as data (design principle 3).
 * validateTemplate() is the gate every template passes before it can be loaded (SS-PLAT-32);
 * the database repeats the role rules (migration 0005), so a bad template fails twice.
 */
import type { AccountType } from '@ledgerforce/db';
import auServicesSmbJson from '../templates/au-services-smb.json' with { type: 'json' };
import {
  ACCOUNT_TYPES,
  CONTROL_ROLES,
  isSystemRole,
  NON_POSTABLE_ROLES,
  ROLE_ACCOUNT_TYPES,
  SYSTEM_ROLES,
  type SystemRole,
} from './system-roles.ts';

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  normalBalance: 'debit' | 'credit';
  postable: boolean;
  control: boolean;
  systemRole?: SystemRole | undefined;
  defaultTaxCode?: string | undefined;
}

export interface ChartTemplate {
  id: string;
  name: string;
  country: string;
  version: number;
  accounts: TemplateAccount[];
  /** Accounts for settings that are not system roles yet (postings.md Q2/Q3, DL-0015). */
  suggestedSettings: Record<string, string>;
}

export const CODE_RE = /^[0-9]{3,10}$/;
const SUBTYPE_RE = /^[a-z][a-z0-9_]*$/;

/** Every problem with a template, as human-readable lines; [] means valid. */
export function validateTemplate(t: ChartTemplate): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const a of t.accounts) {
    if (!CODE_RE.test(a.code)) errors.push(`code ${a.code} must be 3–10 digits`);
    if (seen.has(a.code)) errors.push(`duplicate code ${a.code}`);
    seen.add(a.code);
    if (!a.name.trim()) errors.push(`${a.code}: name is empty`);
    if (!ACCOUNT_TYPES.includes(a.type)) errors.push(`${a.code}: unknown type ${String(a.type)}`);
    if (!SUBTYPE_RE.test(a.subtype))
      errors.push(`${a.code}: subtype ${a.subtype} must be snake_case`);
    if (a.normalBalance !== 'debit' && a.normalBalance !== 'credit') {
      errors.push(`${a.code}: normal balance must be debit or credit`);
    }
    const role = a.systemRole;
    if (role !== undefined && !isSystemRole(role))
      errors.push(`${a.code}: unknown system role ${String(role)}`);
    const isControlRole = role !== undefined && CONTROL_ROLES.includes(role);
    if (a.control !== isControlRole) {
      errors.push(
        `${a.code} control flag must be ${String(isControlRole)} (only ${CONTROL_ROLES.join(', ')} are control accounts)`,
      );
    }
    if (role !== undefined && isSystemRole(role)) {
      if (!ROLE_ACCOUNT_TYPES[role].includes(a.type)) {
        errors.push(
          `${role} on ${a.code}: type ${a.type} is not one of ${ROLE_ACCOUNT_TYPES[role].join(', ')}`,
        );
      }
      const mustPost = !NON_POSTABLE_ROLES.includes(role);
      if (a.postable !== mustPost) {
        errors.push(`${role} on ${a.code}: must be ${mustPost ? 'postable' : 'non-postable'}`);
      }
    }
  }
  for (const role of SYSTEM_ROLES) {
    const n = t.accounts.filter((a) => a.systemRole === role).length;
    if (n === 0) errors.push(`${role} is not bound`);
    if (n > 1) errors.push(`${role} bound ${String(n)} times`);
  }
  for (const [key, code] of Object.entries(t.suggestedSettings)) {
    if (!seen.has(code)) errors.push(`setting ${key} names unknown account ${code}`);
  }
  return errors;
}

export const auServicesSmb = auServicesSmbJson as ChartTemplate;
