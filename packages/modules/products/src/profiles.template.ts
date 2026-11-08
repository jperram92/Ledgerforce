/**
 * Posting-profile templates (design §4.4, §4.1 step 7): a country template ships party and
 * product posting profiles pre-mapped onto its chart and tax codes, plus the default Salesforce
 * picklist mappings (Account.Type → party profile, Product2.Family → product profile).
 * validateProfileTemplate() is the gate every template passes before it is loaded (SS-PLAT-100);
 * migration 0032 repeats the account and tax-code rules, so a bad template fails twice.
 */
import type { ChartTemplate } from '@ledgerforce/gl';
import type { TaxCodeTemplate } from '@ledgerforce/tax';
import auServicesSmbProfilesJson from '../templates/au-services-smb-profiles.json' with { type: 'json' };
import {
  CONTROL_ROLE_FOR_KIND,
  isPostingSlot,
  PARTY_KINDS,
  SLOT_ACCOUNT_TYPES,
  type PartyControlRole,
  type PartyKind,
  type PostingSlot,
} from './posting-slots.ts';

export interface TemplatePartyProfile {
  code: string;
  name: string;
  partyKind: PartyKind;
  controlRole: PartyControlRole;
  defaultTaxCode?: string | undefined;
}

export interface TemplateProductProfile {
  code: string;
  name: string;
  /** slot → chart account code; a missing slot is a gap for the wizard (T-0039). */
  accounts: Partial<Record<PostingSlot, string>>;
}

export interface TemplateSalesforceMapping {
  /** Salesforce field API name: Type / Family or a custom field such as LF_Profile__c. */
  field: string;
  /** Picklist API value, matched exactly. */
  value: string;
  /** Profile code. */
  profile: string;
}

export interface PostingProfileTemplate {
  id: string;
  chartTemplate: string;
  taxTemplate: string;
  version: number;
  partyProfiles: TemplatePartyProfile[];
  productProfiles: TemplateProductProfile[];
  salesforce: { account: TemplateSalesforceMapping[]; product: TemplateSalesforceMapping[] };
}

export const PROFILE_CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
export const SF_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** Every problem with a template against its chart and tax codes, as lines; [] means valid. */
export function validateProfileTemplate(
  t: PostingProfileTemplate,
  chart: ChartTemplate,
  taxCodes: TaxCodeTemplate,
): string[] {
  const errors: string[] = [];
  const accounts = new Map(chart.accounts.map((a) => [a.code, a]));
  const taxes = new Set(taxCodes.codes.map((c) => c.code));

  const codes = (kind: string, list: { code: string }[]) => {
    const seen = new Set<string>();
    for (const p of list) {
      if (!PROFILE_CODE_RE.test(p.code)) errors.push(`profile code ${p.code} must be UPPER_SNAKE`);
      if (seen.has(p.code)) errors.push(`duplicate ${kind} profile ${p.code}`);
      seen.add(p.code);
    }
    return seen;
  };
  const partyCodes = codes('party', t.partyProfiles);
  const productCodes = codes('product', t.productProfiles);

  for (const p of t.partyProfiles) {
    if (!p.name.trim()) errors.push(`${p.code}: name is empty`);
    if (!PARTY_KINDS.includes(p.partyKind)) {
      errors.push(`${p.code}: unknown party kind ${String(p.partyKind)}`);
    } else if (p.controlRole !== CONTROL_ROLE_FOR_KIND[p.partyKind]) {
      errors.push(
        `${p.code}: a ${p.partyKind} profile needs ${CONTROL_ROLE_FOR_KIND[p.partyKind]}`,
      );
    }
    if (p.defaultTaxCode !== undefined && !taxes.has(p.defaultTaxCode)) {
      errors.push(`${p.code}: unknown tax code ${p.defaultTaxCode}`);
    }
  }

  for (const p of t.productProfiles) {
    if (!p.name.trim()) errors.push(`${p.code}: name is empty`);
    for (const [slot, code] of Object.entries(p.accounts)) {
      if (!isPostingSlot(slot)) {
        errors.push(`${p.code}: unknown slot ${slot}`);
        continue;
      }
      const a = code === undefined ? undefined : accounts.get(code);
      if (!a) {
        errors.push(`${p.code}.${slot} names unknown account ${String(code)}`);
        continue;
      }
      const allowed = SLOT_ACCOUNT_TYPES[slot];
      if (!allowed.includes(a.type)) {
        errors.push(
          `${p.code}.${slot} on ${a.code}: type ${a.type} is not one of ${allowed.join(', ')}`,
        );
      }
      if (a.control) errors.push(`${p.code}.${slot} on ${a.code}: control account`);
      if (!a.postable) errors.push(`${p.code}.${slot} on ${a.code}: not postable`);
    }
  }

  const mappings = (
    object: string,
    list: TemplateSalesforceMapping[],
    known: Set<string>,
    kind: string,
  ) => {
    const seen = new Set<string>();
    for (const m of list) {
      const key = `${object}.${m.field} = ${m.value}`;
      if (!SF_FIELD_RE.test(m.field)) errors.push(`${key}: field must be a Salesforce API name`);
      if (!m.value.trim()) errors.push(`${key}: value is empty`);
      if (seen.has(`${m.field}\u0000${m.value}`)) errors.push(`${key} is mapped twice`);
      seen.add(`${m.field}\u0000${m.value}`);
      if (!known.has(m.profile)) errors.push(`${key} names unknown ${kind} profile ${m.profile}`);
    }
  };
  mappings('Account', t.salesforce.account, partyCodes, 'party');
  mappings('Product2', t.salesforce.product, productCodes, 'product');
  return errors;
}

export const auServicesSmbProfiles = auServicesSmbProfilesJson as PostingProfileTemplate;
