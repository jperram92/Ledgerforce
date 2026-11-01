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

/** Who (design §4.4): decides the control account and the default tax code. */
export interface TemplatePartyProfile {
  code: string;
  name: string;
  kind: 'customer' | 'supplier';
  /** Account code; must be the AR_CONTROL (customer) or AP_CONTROL (supplier) account. */
  controlAccount: string;
  /** Tax-code catalogue code (packages/modules/tax AU_TAX_CODES). */
  defaultTaxCode: string;
}

/** What (design §4.4): decides revenue, expense, COGS and discount accounts. */
export interface TemplateProductProfile {
  code: string;
  name: string;
  revenueAccount: string;
  expenseAccount: string | null;
  cogsAccount: string | null;
  discountAccount: string | null;
  defaultTaxCode: string;
}

export interface ChartTemplate {
  id: string;
  name: string;
  country: string;
  version: number;
  accounts: TemplateAccount[];
  /** Accounts for settings that are not system roles yet (postings.md Q2/Q3, DL-0015). */
  suggestedSettings: Record<string, string>;
  partyProfiles: TemplatePartyProfile[];
  productProfiles: TemplateProductProfile[];
  /** Salesforce Product2.Family → product profile; Account.Type → party profile (design §4.4). */
  profileMappings: { productFamily: Record<string, string>; accountType: Record<string, string> };
}

export const PROFILE_CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

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
  errors.push(...validateProfiles(t));
  return errors;
}

/** Posting-profile rules (design §4.4, SS-PLAT-103); [] means valid. */
export function validateProfiles(t: ChartTemplate): string[] {
  const errors: string[] = [];
  const account = new Map(t.accounts.map((a) => [a.code, a]));
  const party = new Set<string>();
  for (const p of t.partyProfiles) {
    if (!PROFILE_CODE_RE.test(p.code))
      errors.push(`party profile ${p.code}: code must be UPPER_SNAKE`);
    if (party.has(p.code)) errors.push(`duplicate party profile ${p.code}`);
    party.add(p.code);
    const role = p.kind === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL';
    if (account.get(p.controlAccount)?.systemRole !== role) {
      errors.push(
        `party profile ${p.code}: control account ${p.controlAccount} must be the ${role} account`,
      );
    }
  }
  const product = new Set<string>();
  for (const p of t.productProfiles) {
    if (!PROFILE_CODE_RE.test(p.code))
      errors.push(`product profile ${p.code}: code must be UPPER_SNAKE`);
    if (product.has(p.code)) errors.push(`duplicate product profile ${p.code}`);
    product.add(p.code);
    const want: [string, string | null, AccountType[]][] = [
      ['revenue', p.revenueAccount, ['revenue']],
      ['expense', p.expenseAccount, ['expense']],
      ['cogs', p.cogsAccount, ['expense']],
      ['discount', p.discountAccount, ['revenue', 'expense']],
    ];
    for (const [what, code, types] of want) {
      if (code === null) continue;
      const a = account.get(code);
      if (!a || !types.includes(a.type) || !a.postable || a.control) {
        errors.push(
          `product profile ${p.code}: ${what} account ${code} must be a postable ${types.join(' or ')} account`,
        );
      }
    }
  }
  for (const [value, target] of Object.entries(t.profileMappings.productFamily)) {
    if (!product.has(target))
      errors.push(`Product2.Family ${value} maps to unknown profile ${target}`);
  }
  for (const [value, target] of Object.entries(t.profileMappings.accountType)) {
    if (!party.has(target)) errors.push(`Account.Type ${value} maps to unknown profile ${target}`);
  }
  return errors;
}

export const auServicesSmb = auServicesSmbJson as ChartTemplate;
