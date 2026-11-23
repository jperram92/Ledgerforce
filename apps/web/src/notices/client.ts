/**
 * Client for the failed security notices routes (T-0209, ADR-0097): `GET /security-notices/failed`
 * and `POST /security-notices/:kind/:id/retry` with an Idempotency-Key. Same origin, session cookie
 * (RQ-0025). Refusals are `AdminApiError`s, so the admin screens' routing and messages apply.
 */
import { AdminApiError } from '../admin/client.ts';
import type { AppEnv } from '../env.tsx';

export type NoticeKind = 'remittance_account_changed' | 'bank_details_changed';

export interface FailedNotice {
  kind: NoticeKind;
  id: string;
  /** The company (remittance account) or the supplier (bank details) the notice is about. */
  context: string;
  account_last3: string | null;
  /** Masked by the API: first character and domain. */
  recipient: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string;
  last_smtp_code: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: string;
  retry_requested: boolean;
}

export interface NoticesClient {
  failed(): Promise<{ notices: FailedNotice[] }>;
  retry(kind: NoticeKind, id: string, key: string): Promise<FailedNotice>;
}

export function createNoticesClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): NoticesClient {
  async function send<T>(method: 'GET' | 'POST', path: string, key?: string): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  return {
    failed: () => send('GET', '/security-notices/failed'),
    retry: (kind, id, key) => send('POST', `/security-notices/${seg(kind)}/${seg(id)}/retry`, key),
  };
}
