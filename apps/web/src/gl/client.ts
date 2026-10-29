/**
 * Client for the GL routes the screens use (T-0082, ADR-0042): the chart of accounts, manual
 * journals (T-0029) and the posting engine's preview of a stored journal. Same origin, session
 * cookie (RQ-0025). Refusals keep the API's body (`code`, `line` for posting_refused) so the
 * screen can say which line and why (P6). Money stays decimal strings end to end.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';
import type { JournalBody, StoredLine } from './gl-logic.ts';

export interface ChartCompany {
  id: string;
  name: string;
  base_currency: string;
}

export interface ChartAccount {
  id: string;
  company_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  currency: string | null;
  postable: boolean;
  is_control: boolean;
  status: string;
  system_roles: string[];
}

export interface Chart {
  companies: ChartCompany[];
  accounts: ChartAccount[];
}

export type JournalStatus = 'draft' | 'submitted' | 'approved' | 'posted';

export interface JournalRow {
  id: string;
  company_id: string;
  status: JournalStatus;
  entry_date: string;
  memo: string | null;
  line_count: number;
  amount: string;
  total: string | null;
  approval_required: boolean | null;
  created_by: string;
  created_by_name: string;
  submitted_by_name: string | null;
  approved_by_name: string | null;
  posted_by_name: string | null;
  entry_no: string | null;
}

export interface Journal {
  id: string;
  company_id: string;
  status: JournalStatus;
  entry_date: string;
  memo: string | null;
  lines: StoredLine[];
  created_by: string;
  submitted_by: string | null;
  total: string | null;
  approval_required: boolean | null;
  sensitive_accounts: boolean | null;
  approved_by: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  posted_by: string | null;
  journal_entry_id: string | null;
  entry_no: string | null;
  people: Record<string, string>;
}

export interface PreviewLine {
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit: string;
  credit: string;
  memo: string | null;
}

export interface Preview {
  entry_date: string;
  requested_date: string;
  redirected: boolean;
  needs_override: boolean;
  base_currency: string;
  total: string;
  lines: PreviewLine[];
}

export interface SubmitResult {
  id: string;
  status: 'submitted';
  total: string;
  approval_required: boolean;
  sensitive_accounts: boolean;
}

export interface PostResult {
  id: string;
  status: 'posted';
  entry_id: string;
  entry_no: string;
  entry_date: string;
  replayed: boolean;
}

export interface GlClient {
  chart(): Promise<Chart>;
  journals(status?: JournalStatus): Promise<{ journals: JournalRow[] }>;
  journal(id: string): Promise<Journal>;
  preview(id: string): Promise<Preview>;
  create(body: JournalBody, idempotencyKey: string): Promise<Journal & { replayed: boolean }>;
  update(id: string, body: JournalBody): Promise<Journal>;
  submit(id: string): Promise<SubmitResult>;
  approve(id: string): Promise<{ id: string; status: 'approved' }>;
  reject(id: string, reason: string): Promise<{ id: string; status: 'draft' }>;
  post(id: string): Promise<PostResult>;
}

export function createGlClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): GlClient {
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
  const seg = encodeURIComponent;
  return {
    chart: () => send('GET', '/accounts'),
    journals: (status) =>
      send('GET', status ? `/manual-journals?status=${seg(status)}` : '/manual-journals'),
    journal: (id) => send('GET', `/manual-journals/${seg(id)}`),
    preview: (id) => send('GET', `/manual-journals/${seg(id)}/preview`),
    create: (body, key) => send('POST', '/manual-journals', body, { 'idempotency-key': key }),
    update: (id, body) => send('PUT', `/manual-journals/${seg(id)}`, body),
    submit: (id) => send('POST', `/manual-journals/${seg(id)}/submit`, {}),
    approve: (id) => send('POST', `/manual-journals/${seg(id)}/approve`, {}),
    reject: (id, reason) => send('POST', `/manual-journals/${seg(id)}/reject`, { reason }),
    post: (id) => send('POST', `/manual-journals/${seg(id)}/post`, {}),
  };
}
