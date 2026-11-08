/**
 * Client for the Sync issues inbox routes (T-0071, ADR-0040; RQ-0047): `GET /sync-issues` (status
 * filter, keyset `after`, `limit`), `GET /sync-issues/:id` (with the payload), `POST …/retry` and
 * `POST …/ignore` (optional note). Same origin, session cookie (RQ-0025). Refusals are
 * `AdminApiError`s, so the admin screens' step-up routing and messages apply unchanged.
 */
import { AdminApiError } from '../admin/client.ts';
import type { AppEnv } from '../env.tsx';

export type SyncIssueStatus = 'open' | 'retried' | 'resolved' | 'ignored';
export type StatusFilter = SyncIssueStatus | 'all';

export interface SyncIssueError {
  name: string;
  kind: string | null;
  code: string | null;
  http_status: number | null;
  retryable: boolean;
  message: string;
}

export interface SyncIssue {
  id: string;
  company_id: string | null;
  event_id: string;
  handler: string;
  connector: string;
  status: SyncIssueStatus;
  attempts: number;
  error: SyncIssueError;
  payload_ref: { topic: string; aggregate_type: string; aggregate_id: string };
  retry_job_id: string | null;
  note: string | null;
  status_changed_by: string | null;
  status_changed_at: string;
  first_failed_at: string;
  last_failed_at: string;
}

export interface SyncIssueDetail extends SyncIssue {
  payload: Record<string, unknown>;
}

export interface SyncIssuePage {
  issues: SyncIssue[];
  next_after: string | null;
}

export interface InboxQuery {
  status?: StatusFilter;
  after?: string;
}

/** Issues per page: short enough to read on a phone, well inside the API's 1–200 (RQ-0047 F2). */
export const PAGE_SIZE = 20;

/** `?status=open&limit=20[&after=…]`; the default filter is open, and "all" sends no status. */
export function listQueryString(q: InboxQuery): string {
  const p = new URLSearchParams();
  const status = q.status ?? 'open';
  if (status !== 'all') p.set('status', status);
  p.set('limit', String(PAGE_SIZE));
  if (q.after) p.set('after', q.after);
  return `?${p.toString()}`;
}

export interface SyncClient {
  list(q: InboxQuery): Promise<SyncIssuePage>;
  issue(id: string): Promise<SyncIssueDetail>;
  retry(id: string): Promise<SyncIssue>;
  ignore(id: string, note: string): Promise<SyncIssue>;
}

export function createSyncClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SyncClient {
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
    // A body that is not JSON (e.g. a proxy's error page) is treated as no body.
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  return {
    list: (q) => send('GET', `/sync-issues${listQueryString(q)}`),
    issue: (id) => send('GET', `/sync-issues/${seg(id)}`),
    retry: (id) => send('POST', `/sync-issues/${seg(id)}/retry`),
    ignore: (id, note) => {
      const n = note.trim();
      return send('POST', `/sync-issues/${seg(id)}/ignore`, n ? { note: n } : {});
    },
  };
}
