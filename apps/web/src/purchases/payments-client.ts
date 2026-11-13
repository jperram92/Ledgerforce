/**
 * Supplier payments API client (T-0087): payment batches and their release
 * (apps/api/src/ap/payment-batches.controller.ts, T-0054, T-0153) and bank-detail changes and
 * their verification (apps/api/src/parties/bank-detail-changes.controller.ts, T-0053, T-0153).
 * Same origin, session cookie; failures are AdminApiError, so step-up challenges (401
 * step_up_required) and separation-of-duties refusals (403 sod_violation + rule) keep their code.
 * Money stays a decimal string; account numbers arrive masked (`***` + last 3).
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';
import { abaFileName } from './payments-logic.ts';

export type BatchStatus = 'draft' | 'partially_released' | 'released' | 'cancelled';
export type ExclusionReason = 'BANK_DETAILS_COOLING_OFF' | 'NO_VERIFIED_BANK_DETAILS';

export interface BatchRow {
  id: string;
  batch_no: string;
  status: BatchStatus;
  payment_date: string;
  total: string;
  payment_count: number;
  excluded_count: number;
  releases_required: 1 | 2;
  release_count: number;
  created_by_name: string | null;
  created_at: string;
}

export interface Batch {
  id: string;
  batch_no: string;
  status: BatchStatus;
  payment_date: string;
  total: string;
  payment_count: number;
  releases_required: 1 | 2;
  created_by: string | null;
  created_by_name: string | null;
  releases: { released_by: string | null; released_by_name: string | null; released_at: string }[];
  payments: {
    bill_id: string;
    bill_no: string | null;
    party_id: string;
    party_name: string | null;
    amount: string;
    bank_account: { bsb: string; account_number: string } | null;
  }[];
  excluded: {
    bill_id: string;
    bill_no: string | null;
    party_id: string;
    party_name: string | null;
    amount: string;
    reason: ExclusionReason;
    payable_from: string | null;
  }[];
}

export interface MaskedAccount {
  bsb: string;
  account_name: string;
  account_number: string;
}

export interface BankDetailChange {
  id: string;
  party_id: string;
  party_name: string;
  status: 'requested' | 'verified' | 'rejected';
  bank_account: MaskedAccount;
  previous_bank_account: MaskedAccount | null;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  payable_from: string | null;
}

export interface BankFile {
  fileName: string;
  content: Blob;
}

export interface PaymentsClient {
  batches(companyId: string): Promise<{ batches: BatchRow[] }>;
  batch(companyId: string, batchId: string): Promise<Batch>;
  release(companyId: string, batchId: string): Promise<unknown>;
  /**
   * The batch's ABA (Cemtex) file (POST, audited by the API, T-0056): the exact bytes, never
   * decoded or shown, with the attachment's file name (T-0154).
   */
  abaFile(companyId: string, batchId: string, batchNo: string): Promise<BankFile>;
  changes(companyId: string): Promise<{ changes: BankDetailChange[] }>;
  verify(
    changeId: string,
    note: string,
  ): Promise<{ id: string; status: 'verified'; payable_from: string }>;
  reject(changeId: string, reason: string): Promise<{ id: string; status: 'rejected' }>;
}

export function createPaymentsClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): PaymentsClient {
  async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
  return {
    batches: (companyId) => send('GET', `/ap/payment-batches?company_id=${seg(companyId)}`),
    batch: (companyId, batchId) =>
      send('GET', `/ap/payment-batches/${seg(batchId)}?company_id=${seg(companyId)}`),
    release: (companyId, batchId) =>
      send('POST', `/ap/payment-batches/${seg(batchId)}/release?company_id=${seg(companyId)}`),
    abaFile: async (companyId, batchId, batchNo) => {
      const res = await env.fetch(
        `${env.apiBase}/ap/payment-batches/${seg(batchId)}/aba?company_id=${seg(companyId)}`,
        { method: 'POST', credentials: 'same-origin', headers: { accept: 'text/plain' } },
      );
      if (!res.ok) throw new AdminApiError(res.status, await res.json().catch(() => null));
      return {
        fileName: abaFileName(res.headers.get('content-disposition'), batchNo),
        content: await res.blob(),
      };
    },
    changes: (companyId) =>
      send('GET', `/bank-detail-changes?company_id=${seg(companyId)}&status=requested`),
    verify: (changeId, note) =>
      send('POST', `/bank-detail-changes/${seg(changeId)}/verify`, { confirmation_note: note }),
    reject: (changeId, reason) =>
      send('POST', `/bank-detail-changes/${seg(changeId)}/reject`, { reason }),
  };
}
