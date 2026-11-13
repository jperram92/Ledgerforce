/**
 * Purchases API client (T-0086): supplier bills — the coding choices, the bills list, one bill,
 * its journal, and entering, sending for approval and approving (apps/api/src/ap/bills.controller.ts).
 * Same origin, session cookie; failures are AdminApiError (status + error code). Money stays a
 * decimal string.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export type BillStatus = 'draft' | 'posted' | 'void';

export interface BillRow {
  id: string;
  bill_no: string | null;
  status: BillStatus;
  awaiting_approval: boolean;
  party_id: string;
  supplier_name: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  gross: string;
}

export interface BillStep {
  by: string;
  you: boolean;
  at: string;
}

export interface Bill extends BillRow {
  currency: string;
  net: string;
  tax: string;
  entry_id: string | null;
  lines: {
    line_no: number;
    description: string;
    account_id: string;
    account_code: string;
    account_name: string;
    tax_code: string;
    amount: string;
  }[];
  entered: BillStep | null;
  submitted: BillStep | null;
  approved: BillStep | null;
  approval: {
    allowed: boolean;
    rule: string | null;
    small_team_exception_required: boolean;
    self_approval_threshold: string | null;
  };
}

export interface BillJournal {
  posted: boolean;
  entry_no: string | null;
  entry_date: string;
  requested_date: string;
  redirected: boolean;
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

export interface BillCoding {
  suppliers: { id: string; name: string }[];
  accounts: { id: string; code: string; name: string; type: string }[];
  tax_codes: { code: string; name: string; rate: string }[];
}

export interface BillBody {
  company_id: string;
  party_id: string;
  supplier_ref: string;
  bill_date: string;
  due_date?: string;
  lines: { description: string; account_id: string; tax_code: string; amount: string }[];
}

export interface PurchasesClient {
  companies(): Promise<{ id: string; name: string; base_currency: string }[]>;
  coding(companyId: string): Promise<BillCoding>;
  bills(companyId: string): Promise<{ bills: BillRow[] }>;
  bill(companyId: string, id: string): Promise<Bill>;
  journal(companyId: string, id: string): Promise<BillJournal>;
  /** Enter a draft under a client-chosen id (a repeat returns the same bill). */
  enter(id: string, body: BillBody): Promise<{ id: string; status: BillStatus }>;
  submit(companyId: string, id: string): Promise<unknown>;
  approve(companyId: string, id: string): Promise<unknown>;
}

export function createPurchasesClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): PurchasesClient {
  async function send<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  const co = (companyId: string) => `company_id=${seg(companyId)}`;
  return {
    companies: () => send('GET', '/companies'),
    coding: (companyId) => send('GET', `/ap/bill-coding?${co(companyId)}`),
    bills: (companyId) => send('GET', `/ap/bills?${co(companyId)}`),
    bill: (companyId, id) => send('GET', `/ap/bills/${seg(id)}?${co(companyId)}`),
    journal: (companyId, id) => send('GET', `/ap/bills/${seg(id)}/journal?${co(companyId)}`),
    enter: (id, body) => send('PUT', `/ap/bills/${seg(id)}`, body),
    submit: (companyId, id) => send('POST', `/ap/bills/${seg(id)}/submit?${co(companyId)}`, {}),
    approve: (companyId, id) => send('POST', `/ap/bills/${seg(id)}/approve?${co(companyId)}`, {}),
  };
}
