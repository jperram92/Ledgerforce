/**
 * Setup settings API client (T-0176): the ADR-0081 routes under /setup/company and /setup/tax.
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
}

export function createSettingsClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SettingsClient {
  async function send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> {
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
    return data as T;
  }
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
  };
}
