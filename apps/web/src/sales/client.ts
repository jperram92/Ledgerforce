/**
 * Sales API client (T-0083): companies and the AR invoice read routes (T-0131). Same origin, session
 * cookie; failures are AdminApiError (status + error code). Money stays a decimal string.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export interface Company {
  id: string;
  name: string;
  base_currency: string;
}

export type InvoiceStatus = 'draft' | 'posted' | 'void';

export interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  status: InvoiceStatus;
  party_id: string;
  party_name: string;
  issue_date: string;
  due_date: string;
  gross_total: string | null;
}

export interface InvoiceLine {
  line_no: number;
  description: string;
  quantity: string;
  unit_price: string;
  tax_code: string | null;
  net: string | null;
  tax: string | null;
  gross: string | null;
}

export interface Invoice extends InvoiceRow {
  kind: 'standard' | 'deposit';
  pricing: 'exclusive' | 'inclusive';
  entry_id: string | null;
  net_total: string | null;
  tax_total: string | null;
  warnings: { line?: number; message?: string }[];
  lines: InvoiceLine[];
}

export interface InvoiceJournal {
  entry_date: string;
  requested_date: string;
  redirected: boolean;
  needs_override: boolean;
  base_currency: string;
  total: string;
  lines: {
    line_no: number;
    account_id: string;
    account_code: string;
    account_name: string;
    account_type: string;
    debit: string;
    credit: string;
    party_id: string | null;
  }[];
}

export interface SalesClient {
  companies(): Promise<Company[]>;
  invoices(companyId: string, status?: InvoiceStatus): Promise<{ invoices: InvoiceRow[] }>;
  invoice(companyId: string, id: string): Promise<Invoice>;
  journal(companyId: string, id: string): Promise<InvoiceJournal>;
}

export function createSalesClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SalesClient {
  async function get<T>(path: string): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  return {
    companies: () => get('/companies'),
    invoices: (companyId, status) =>
      get(`/ar/invoices?company_id=${seg(companyId)}${status ? `&status=${seg(status)}` : ''}`),
    invoice: (companyId, id) => get(`/ar/invoices/${seg(id)}?company_id=${seg(companyId)}`),
    journal: (companyId, id) => get(`/ar/invoices/${seg(id)}/journal?company_id=${seg(companyId)}`),
  };
}
