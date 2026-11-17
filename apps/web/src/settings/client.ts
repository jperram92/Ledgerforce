/**
 * Setup settings API client (T-0176): the ADR-0081 routes under /setup/company and /setup/tax,
 * (T-0185) the ADR-0084 routes under /setup/bank-accounts, and (T-0186) the ADR-0085 routes
 * under /setup/billing and the approval amounts (/sod/settings).
 * Same origin, session cookie; failures are AdminApiError (status + error code + body). Every
 * write carries the Idempotency-Key the screen passes.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export interface FiscalYear {
  label: string;
  start_date: string;
  end_date: string;
}

export interface CompanySettings {
  company_id: string;
  name: string;
  legal_name: string | null;
  abn: string | null;
  base_currency: string;
  /** True once the company has a journal entry (DL-0641). */
  base_currency_locked: boolean;
  fiscal_years: FiscalYear[];
}

export interface CompanyInput {
  legal_name: string;
  abn: string;
  base_currency: string;
}

export type GstBasis = 'accrual' | 'cash';
export type BasFrequency = 'monthly' | 'quarterly' | 'annual';

export interface TaxSettingsValue {
  effective_from: string;
  gst_basis: GstBasis;
  bas_frequency: BasFrequency;
}

export interface TaxCode {
  code: string;
  name: string;
  kind: string;
  /** Decimal string, e.g. "0.10000000". */
  rate: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
}

export interface TaxSettingsView {
  company_id: string;
  as_of: string;
  settings: TaxSettingsValue | null;
  codes: TaxCode[];
}

/** A company bank account as the API lists it: the number is `***` + the last 3 characters. */
export interface BankAccount {
  id: string;
  name: string;
  gl_account_id: string;
  gl_account_code: string | null;
  gl_account_name: string | null;
  currency: string;
  bsb: string;
  account_name: string;
  account_number: string;
  apca_user_id: string | null;
  aba_user_name: string | null;
  aba_fi_mnemonic: string | null;
  status: string;
}

export interface BankGlAccount {
  id: string;
  code: string;
  name: string;
  currency: string | null;
  /** Already has an active bank account (one per GL account). */
  in_use: boolean;
}

export interface BankAccountsView {
  company_id: string;
  base_currency: string;
  /** False when the server has no key service to seal account numbers (ADR-0030). */
  kms_configured: boolean;
  accounts: BankAccount[];
  gl_accounts: BankGlAccount[];
}

export interface BankAccountInput {
  gl_account_id: string;
  name: string;
  bsb: string;
  account_number: string;
  account_name: string;
  currency: string;
  apca_user_id?: string;
  aba_user_name?: string;
  aba_fi_mnemonic?: string;
}

/** The ABA header of a bank account (ADR-0094): all three are set together. */
export interface BankAccountAba {
  apca_user_id: string;
  aba_user_name: string;
  aba_fi_mnemonic: string;
}

export type PaymentMethod = 'bank_transfer' | 'stripe';
export const INVOICE_SERIES = 'ar_invoice_document';
export const CREDIT_NOTE_SERIES = 'ar_credit_note_document';

export interface NumberSeries {
  code: string;
  prefix: string;
  pad_width: number;
  /** The number the next document gets, e.g. "INV-000001". */
  next_number: string;
  /** Prefix and digits are fixed once true. */
  issued: boolean;
  status: string;
}

export interface InvoiceSettingsValue {
  brand_colour: string | null;
  brand_accent_colour: string | null;
  default_payment_terms_days: number | null;
  accepted_payment_methods: PaymentMethod[] | null;
  has_logo: boolean;
}

export interface BillingSettings {
  company_id: string;
  series: NumberSeries[];
  formats: { code: string; name: string; posted: boolean; status: string }[];
  invoice: InvoiceSettingsValue;
  stripe: { clearing_account_id: string } | null;
  clearing_accounts: { id: string; code: string; name: string }[];
}

export interface InvoiceInput {
  brand_colour: string;
  default_payment_terms_days: number;
  accepted_payment_methods: PaymentMethod[];
}

export type ThresholdName =
  'bill_self_approval' | 'credit_note_self_approval' | 'journal_approval' | 'batch_two_releasers';

export interface ApprovalSettings {
  small_team_mode: boolean;
  /** Decimal strings with 4 places, e.g. "1000.0000". */
  thresholds: Record<ThresholdName, string>;
  report_timezone: string;
  set_at: string | null;
  /** True until the Owner saves them: the values are the design's placeholders. */
  placeholder_defaults: boolean;
}

export interface ApprovalInput {
  small_team_mode: boolean;
  thresholds: Record<ThresholdName, string>;
  report_timezone: string;
  reason: string;
}

export interface SettingsClient {
  company(companyId: string): Promise<CompanySettings>;
  saveCompany(
    companyId: string,
    input: CompanyInput,
    key: string,
  ): Promise<CompanySettings & { changed: boolean }>;
  addFiscalYear(
    companyId: string,
    start: string,
    key: string,
  ): Promise<FiscalYear & { periods: number; replayed: boolean }>;
  tax(companyId: string): Promise<TaxSettingsView>;
  saveTax(
    companyId: string,
    value: TaxSettingsValue,
    key: string,
  ): Promise<{ settings: TaxSettingsValue; changed: boolean }>;
  addStandardTaxCodes(companyId: string, key: string): Promise<{ inserted: number }>;
  bankAccounts(companyId: string): Promise<BankAccountsView>;
  addBankAccount(
    companyId: string,
    input: BankAccountInput,
    key: string,
  ): Promise<{ account: BankAccount; replayed: boolean }>;
  setBankAccountAba(
    companyId: string,
    bankAccountId: string,
    input: BankAccountAba,
    key: string,
  ): Promise<{ account: BankAccount; changed: boolean }>;
  archiveBankAccount(
    companyId: string,
    bankAccountId: string,
    key: string,
  ): Promise<{ account: BankAccount; changed: boolean; remittance_released: boolean }>;
  billing(companyId: string): Promise<BillingSettings>;
  saveSeries(
    companyId: string,
    input: { code: string; prefix: string; pad_width: number },
    key: string,
  ): Promise<{ series: NumberSeries; changed: boolean }>;
  addStandardFormats(companyId: string, key: string): Promise<{ inserted: number }>;
  saveInvoice(
    companyId: string,
    input: InvoiceInput,
    key: string,
  ): Promise<{ invoice: InvoiceSettingsValue; changed: boolean }>;
  saveStripe(
    companyId: string,
    clearingAccountId: string,
    key: string,
  ): Promise<{ stripe: { clearing_account_id: string }; changed: boolean }>;
  approvals(): Promise<ApprovalSettings>;
  /** 201 when a new settings row was saved, 200 when the values were already in force. */
  saveApprovals(
    input: ApprovalInput,
    key: string,
  ): Promise<{ settings: ApprovalSettings; changed: boolean }>;
}

export function createSettingsClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SettingsClient {
  async function sendWithStatus<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined) headers['idempotency-key'] = key;
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return { status: res.status, data: data as T };
  }
  const send = async <T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> => (await sendWithStatus<T>(method, path, body, key)).data;
  const q = (companyId: string) => `?company_id=${encodeURIComponent(companyId)}`;
  return {
    company: (c) => send('GET', `/setup/company${q(c)}`),
    saveCompany: (c, input, key) => send('PUT', '/setup/company', { company_id: c, ...input }, key),
    addFiscalYear: (c, start, key) =>
      send('POST', '/setup/company/fiscal-years', { company_id: c, start }, key),
    tax: (c) => send('GET', `/setup/tax${q(c)}`),
    saveTax: (c, value, key) => send('PUT', '/setup/tax', { company_id: c, ...value }, key),
    addStandardTaxCodes: (c, key) =>
      send('POST', '/setup/tax/codes/standard', { company_id: c }, key),
    bankAccounts: (c) => send('GET', `/setup/bank-accounts${q(c)}`),
    addBankAccount: (c, input, key) =>
      send('POST', '/setup/bank-accounts', { company_id: c, ...input }, key),
    setBankAccountAba: (c, id, input, key) =>
      send(
        'PUT',
        `/setup/bank-accounts/${encodeURIComponent(id)}/aba`,
        { company_id: c, ...input },
        key,
      ),
    archiveBankAccount: (c, id, key) =>
      send(
        'POST',
        `/setup/bank-accounts/${encodeURIComponent(id)}/archive`,
        { company_id: c },
        key,
      ),
    billing: (c) => send('GET', `/setup/billing${q(c)}`),
    saveSeries: (c, input, key) =>
      send('PUT', '/setup/billing/series', { company_id: c, ...input }, key),
    addStandardFormats: (c, key) =>
      send('POST', '/setup/billing/formats/standard', { company_id: c }, key),
    saveInvoice: (c, input, key) =>
      send('PUT', '/setup/billing/invoice', { company_id: c, ...input }, key),
    saveStripe: (c, id, key) =>
      send('PUT', '/setup/billing/stripe', { company_id: c, clearing_account_id: id }, key),
    approvals: () => send('GET', '/sod/settings'),
    saveApprovals: async (input, key) => {
      const r = await sendWithStatus<ApprovalSettings>('POST', '/sod/settings', input, key);
      return { settings: r.data, changed: r.status === 201 };
    },
  };
}
