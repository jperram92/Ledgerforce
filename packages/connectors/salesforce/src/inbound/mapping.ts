/**
 * Pure mapping of a record's full Salesforce state onto the LedgerForce values Salesforce owns
 * (design §4.2, §5.5, ADR-0006; RQ-0098). Everything else on a party, contact or product is
 * LedgerForce-owned and never produced here (credit limit, terms, delivery preference, tax status,
 * bank details, …).
 *
 * Problems are never dropped (design §5.6 rule 2): a `blocking` problem means the record is not
 * applied; a non-blocking one (unmapped picklist value, unusable address) means the record is
 * applied without that value. Both become inbound sync issues.
 */
import type { ContactRole } from '@ledgerforce/db';
import { normaliseAbn } from '@ledgerforce/parties';
import type { SfState } from './changes.ts';

export type IssueCode =
  'unmapped_value' | 'invalid_value' | 'missing_parent' | 'moved_record' | 'apply_failed';

export interface Problem {
  code: IssueCode;
  /** Salesforce field API name ('Type', 'BillingAddress'), or null for the whole record. */
  field: string | null;
  value: string | null;
  message: string;
  blocking: boolean;
}

export interface AddressValues {
  kind: 'billing' | 'shipping';
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string;
}

export interface AccountValues {
  legalName: string;
  currency: string | null;
  abn: string | null;
  /** Raw value of the profile field (Account.Type or the configured custom field). */
  profileValue: string | null;
  addresses: AddressValues[];
  problems: Problem[];
}

export interface ContactValues {
  accountId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  /** Active billing roles; every other role is deactivated. */
  roles: ContactRole[];
  problems: Problem[];
}

export interface ProductValues {
  name: string;
  code: string | null;
  description: string | null;
  /** Raw Product2.Family (kept on the product for the mapping, DL-0250). */
  family: string | null;
  profileValue: string | null;
  active: boolean;
  taxCode: string | null;
  problems: Problem[];
}

const str = (s: SfState, k: string): string | null => {
  const v = s[k];
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

const short = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v).slice(0, 255);

const block = (code: IssueCode, field: string, value: unknown, message: string): Problem => ({
  code,
  field,
  value: short(value),
  message,
  blocking: true,
});

/** Billing role multi-select values (`;`-separated API values, RQ-0098 F5) → contact roles. */
export const BILLING_ROLE_VALUES: Readonly<Record<string, ContactRole>> = {
  'Billing To': 'billing_to',
  'Billing CC': 'billing_cc',
  Statements: 'statements',
  Remittance: 'remittance',
  'AP Contact': 'ap_contact',
};

const EMAIL = /^[^@\s]+@[^@\s]+$/;

function mapAddress(
  s: SfState,
  prefix: 'BillingAddress' | 'ShippingAddress',
): {
  address: AddressValues | null;
  problem: Problem | null;
} {
  const part = (c: string) => str(s, `${prefix}.${c}`);
  const parts = ['Street', 'City', 'State', 'PostalCode', 'Country', 'CountryCode'].map(part);
  if (parts.every((p) => p === null)) return { address: null, problem: null };
  const kind = prefix === 'BillingAddress' ? 'billing' : 'shipping';
  const soft = (message: string, value: unknown): { address: null; problem: Problem } => ({
    address: null,
    problem: {
      code: 'invalid_value',
      field: prefix,
      value: short(value),
      message,
      blocking: false,
    },
  });
  const code = part('CountryCode') ?? part('Country');
  let country = 'AU'; // the party_address default when Salesforce has no country (DL-0266)
  if (code !== null) {
    if (!/^[A-Za-z]{2}$/.test(code)) {
      return soft(
        `${prefix} country "${code}" is not an ISO 3166 two-letter code (enable State and Country picklists or use the code); the ${kind} address was not imported`,
        code,
      );
    }
    country = code.toUpperCase();
  }
  const street = part('Street');
  if (street === null) {
    return soft(`${prefix} has no street; the ${kind} address was not imported`, null);
  }
  const [line1, ...rest] = street
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return {
    address: {
      kind,
      line1: line1 ?? street,
      line2: rest.length > 0 ? rest.join(', ') : null,
      city: part('City'),
      state: part('State'),
      postcode: part('PostalCode'),
      country,
    },
    problem: null,
  };
}

export function mapAccount(s: SfState, profileField: string): AccountValues {
  const problems: Problem[] = [];
  const legalName = str(s, 'Name');
  if (legalName === null)
    problems.push(block('invalid_value', 'Name', s.Name, 'Account Name is empty'));
  let abn: string | null = null;
  const rawAbn = str(s, 'LF_ABN__c');
  if (rawAbn !== null) {
    try {
      abn = normaliseAbn(rawAbn);
    } catch (e) {
      problems.push(block('invalid_value', 'LF_ABN__c', rawAbn, (e as Error).message));
    }
  }
  const currency = str(s, 'CurrencyIsoCode');
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    problems.push(
      block(
        'invalid_value',
        'CurrencyIsoCode',
        currency,
        `currency "${currency}" is not an ISO 4217 code`,
      ),
    );
  }
  const addresses: AddressValues[] = [];
  for (const prefix of ['BillingAddress', 'ShippingAddress'] as const) {
    const a = mapAddress(s, prefix);
    if (a.address) addresses.push(a.address);
    if (a.problem) problems.push(a.problem);
  }
  return {
    legalName: legalName ?? '',
    currency,
    abn,
    profileValue: str(s, profileField),
    addresses,
    problems,
  };
}

export function mapContact(s: SfState): ContactValues {
  const problems: Problem[] = [];
  const accountId = str(s, 'AccountId');
  if (accountId === null) {
    problems.push(
      block(
        'missing_parent',
        'AccountId',
        null,
        'Contact has no Account; only Account contacts are imported',
      ),
    );
  }
  const name = [str(s, 'Name.FirstName'), str(s, 'Name.LastName')]
    .filter((p): p is string => p !== null)
    .join(' ');
  if (name === '') problems.push(block('invalid_value', 'Name', null, 'Contact name is empty'));
  const email = str(s, 'Email');
  if (email !== null && !EMAIL.test(email)) {
    problems.push(block('invalid_value', 'Email', email, `"${email}" is not an email address`));
  }
  const roles: ContactRole[] = [];
  for (const v of (str(s, 'LF_Billing_Role__c') ?? '').split(';')) {
    const value = v.trim();
    if (value === '') continue;
    const role = BILLING_ROLE_VALUES[value];
    if (role === undefined) {
      problems.push({
        code: 'unmapped_value',
        field: 'LF_Billing_Role__c',
        value: short(value),
        message: `billing role "${value}" has no LedgerForce contact role; it was not imported`,
        blocking: false,
      });
    } else if (!roles.includes(role)) {
      roles.push(role);
    }
  }
  return { accountId, name, email, phone: str(s, 'Phone'), roles, problems };
}

export function mapProduct(s: SfState, profileField: string): ProductValues {
  const problems: Problem[] = [];
  const name = str(s, 'Name');
  if (name === null) problems.push(block('invalid_value', 'Name', s.Name, 'Product name is empty'));
  const code = str(s, 'ProductCode');
  if (code !== null && code.length > 64) {
    problems.push(
      block('invalid_value', 'ProductCode', code, 'ProductCode is longer than 64 characters'),
    );
  }
  return {
    name: name ?? '',
    code,
    description: str(s, 'Description'),
    family: str(s, 'Family'),
    profileValue: str(s, profileField),
    active: s.IsActive !== false,
    taxCode: str(s, 'LF_Tax_Code__c'),
    problems,
  };
}
