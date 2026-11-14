/**
 * Sales API client (T-0083): companies and the AR invoice read routes (T-0131); batch billing
 * preview, read and approve (T-0043/T-0044, T-0084). Same origin, session cookie; failures are
 * AdminApiError (status + error code). Money stays a decimal string.
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

export type BatchStatus = 'preview' | 'approved' | 'posted' | 'cancelled';

export interface BatchWarning {
  code: 'PROFILE_GAP' | 'NO_BILLING_TO' | 'CREDIT_HOLD';
  /** Billing-line position (1-based) for line warnings; 0 for the whole invoice. */
  line: number;
  message: string;
}

export interface BatchItem {
  item_no: number;
  party_id: string;
  party_name: string;
  line_count: number;
  net: string | null;
  tax: string | null;
  gross: string | null;
  warnings: BatchWarning[];
  /** The item's result once the job has run. */
  status: 'preview' | 'posted' | 'failed';
  invoice_no: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface Batch {
  id: string;
  replayed: boolean;
  status: BatchStatus;
  period_from: string;
  period_to: string;
  issue_date: string;
  items: BatchItem[];
  totals: { invoices: number; ready: number; net: string; tax: string; gross: string };
  outcome: { posted: number; failed: number; posted_gross: string };
}

export interface BatchRequest {
  company_id: string;
  period_from: string;
  period_to: string;
  issue_date?: string;
}

/** GET /ar/receipts (T-0151). */
export interface ReceiptRow {
  id: string;
  receipt_no: string;
  party_id: string;
  party_name: string;
  receipt_date: string;
  method: 'eft' | 'cheque' | 'cash' | 'card';
  reference: string | null;
  amount: string;
  unallocated: string;
}

/** POST /ar/receipts/:id/allocations (T-0046, keyed since T-0151). */
export interface ReceiptResult {
  id: string;
  receipt_no: string;
  entry_id: string;
  replayed: boolean;
  amount: string;
  unallocated: string;
}

export interface AllocationRequest {
  company_id: string;
  invoice_id: string;
  amount: string;
  allocation_date: string;
}

/** PUT /ar/credit-notes/:id, GET /ar/credit-notes/:id, POST …/approve (T-0045). */
export interface CreditNote {
  id: string;
  replayed: boolean;
  status: 'draft' | 'posted' | 'void';
  credit_note_no: string | null;
  invoice_id: string;
  entry_id: string | null;
  net: string;
  tax: string;
  gross: string;
}

export interface CreditNoteRequest {
  company_id: string;
  invoice_id: string;
  issue_date: string;
  reason_code: string;
  lines: { invoice_line_no: number; amount: string }[];
}

/** Customer refunds (T-0152, ADR-0074): PUT /ar/refunds/:id, GET …, POST …/approve. */
export interface CustomerRefund {
  id: string;
  replayed: boolean;
  refund_no: string;
  party_id: string;
  refund_date: string;
  amount: string;
  method: 'bank_batch' | 'stripe';
  status: 'requested' | 'paid' | 'cancelled';
  approval: 'pending' | 'approved';
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  entry_id: string | null;
  paid_on: string | null;
}

export interface RefundRequest {
  company_id: string;
  party_id: string;
  refund_date: string;
  amount: string;
  method: 'bank_batch';
  reason?: string;
}

/** GET /ar/parties/:id/credit: the customer's AR balance, refunds requested, what is refundable. */
export interface PartyCredit {
  party_id: string;
  balance: string;
  requested: string;
  available: string;
}

export interface RefundJournal extends InvoiceJournal {
  bank_account_source: 'chosen' | 'batch' | 'only_bank_account';
}

export interface SalesClient {
  receipts(companyId: string): Promise<{ receipts: ReceiptRow[] }>;
  allocate(
    receiptId: string,
    body: AllocationRequest,
    idempotencyKey: string,
  ): Promise<ReceiptResult>;
  paymentStatus(
    companyId: string,
    invoiceId: string,
  ): Promise<{ status: 'unpaid' | 'partially_paid' | 'paid'; open: string }>;
  createCreditNote(id: string, body: CreditNoteRequest): Promise<CreditNote>;
  creditNote(companyId: string, id: string): Promise<CreditNote>;
  creditNoteJournal(companyId: string, id: string): Promise<InvoiceJournal>;
  approveCreditNote(companyId: string, id: string): Promise<CreditNote>;
  partyCredit(companyId: string, partyId: string): Promise<PartyCredit>;
  createRefund(id: string, body: RefundRequest): Promise<CustomerRefund>;
  refund(companyId: string, id: string): Promise<CustomerRefund>;
  refundJournal(companyId: string, id: string): Promise<RefundJournal>;
  approveRefund(companyId: string, id: string): Promise<CustomerRefund>;
  companies(): Promise<Company[]>;
  invoices(companyId: string, status?: InvoiceStatus): Promise<{ invoices: InvoiceRow[] }>;
  invoice(companyId: string, id: string): Promise<Invoice>;
  journal(companyId: string, id: string): Promise<InvoiceJournal>;
  previewBatch(body: BatchRequest, idempotencyKey: string): Promise<Batch>;
  batch(companyId: string, id: string): Promise<Batch>;
  approveBatch(companyId: string, id: string): Promise<Batch>;
}

export function createSalesClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SalesClient {
  async function send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { accept: 'application/json', ...extra }
          : { accept: 'application/json', 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const get = <T>(path: string) => send<T>('GET', path);
  const seg = encodeURIComponent;
  const co = (companyId: string) => `company_id=${seg(companyId)}`;
  return {
    receipts: (companyId) => get(`/ar/receipts?${co(companyId)}&unallocated=true`),
    allocate: (receiptId, body, key) =>
      send('POST', `/ar/receipts/${seg(receiptId)}/allocations`, body, { 'idempotency-key': key }),
    paymentStatus: (companyId, invoiceId) =>
      get(`/ar/invoices/${seg(invoiceId)}/payment-status?${co(companyId)}`),
    createCreditNote: (id, body) => send('PUT', `/ar/credit-notes/${seg(id)}`, body),
    creditNote: (companyId, id) => get(`/ar/credit-notes/${seg(id)}?${co(companyId)}`),
    creditNoteJournal: (companyId, id) =>
      get(`/ar/credit-notes/${seg(id)}/journal?${co(companyId)}`),
    approveCreditNote: (companyId, id) =>
      send('POST', `/ar/credit-notes/${seg(id)}/approve?${co(companyId)}`, {}),
    partyCredit: (companyId, partyId) => get(`/ar/parties/${seg(partyId)}/credit?${co(companyId)}`),
    createRefund: (id, body) => send('PUT', `/ar/refunds/${seg(id)}`, body),
    refund: (companyId, id) => get(`/ar/refunds/${seg(id)}?${co(companyId)}`),
    refundJournal: (companyId, id) => get(`/ar/refunds/${seg(id)}/journal?${co(companyId)}`),
    approveRefund: (companyId, id) =>
      send('POST', `/ar/refunds/${seg(id)}/approve?${co(companyId)}`, {}),
    companies: () => get('/companies'),
    invoices: (companyId, status) =>
      get(`/ar/invoices?company_id=${seg(companyId)}${status ? `&status=${seg(status)}` : ''}`),
    invoice: (companyId, id) => get(`/ar/invoices/${seg(id)}?company_id=${seg(companyId)}`),
    journal: (companyId, id) => get(`/ar/invoices/${seg(id)}/journal?company_id=${seg(companyId)}`),
    previewBatch: (body, key) =>
      send('POST', '/ar/batches/preview', body, { 'idempotency-key': key }),
    batch: (companyId, id) => get(`/ar/batches/${seg(id)}?company_id=${seg(companyId)}`),
    approveBatch: (companyId, id) =>
      send('POST', `/ar/batches/${seg(id)}/approve?company_id=${seg(companyId)}`, {}),
  };
}
