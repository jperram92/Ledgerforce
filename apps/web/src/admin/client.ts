/**
 * Client for the administration routes the admin screens use (T-0093, ADR-0034): users and roles
 * (T-0012, T-0016), the weekly SoD exceptions report (T-0015), the audit log and the caller's
 * access. Same origin, session cookie (RQ-0025). Refusals keep the API's error code so the screen
 * can say what happened in plain words (P6) and route step-up challenges (ADR-0025).
 */
import { ApiError } from '../api.ts';
import type { AppEnv } from '../env.tsx';

/** An API refusal with its `{ error }` code and body (e.g. `max_age` for step_up_required). */
export class AdminApiError extends ApiError {
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: unknown) {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof b['error'] === 'string' ? b['error'] : `http_${String(status)}`;
    super(status, `API answered ${String(status)} ${code}`);
    this.name = 'AdminApiError';
    this.code = code;
    this.body = b;
  }
}

export type UserStatus = 'active' | 'invited' | 'disabled';

export interface Access {
  roles: string[];
  permissions: string[];
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: UserStatus;
  created_at: string;
  disabled_at: string | null;
  successor_user_id: string | null;
  roles: string[];
}

export interface UserDetail extends UserRow {
  invited_by: string | null;
  disabled_by: string | null;
  disable_reason: string | null;
}

export interface Invite {
  email: string;
  display_name: string;
  idp_issuer: string;
  idp_subject: string;
  roles: string[];
}

export interface OffboardResult {
  user_id: string;
  status: string;
  changed: boolean;
  sessions_revoked?: number;
  tokens_revoked?: number;
  roles_revoked?: number;
  successor_user_id?: string | null;
  approvals_assignee?: string | null;
}

export interface SodException {
  id: string;
  rule: string;
  subject_type: string;
  subject_id: string;
  step: string;
  actor_user_id: string;
  kind: string;
  reviewer_user_id: string | null;
  reason: string;
  occurred_at: string;
  acknowledged: boolean;
}

export interface SodWeek {
  week_start: string;
  timezone: string;
  acknowledged_at: string | null;
  exceptions: SodException[];
}

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  api_token_id: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  next_before: string | null;
}

export const AUDIT_FILTER_KEYS = [
  'actor',
  'action',
  'entity_type',
  'entity_id',
  'from',
  'to',
  'before',
] as const;
export type AuditQuery = Partial<Record<(typeof AUDIT_FILTER_KEYS)[number], string>>;

/** `?a=1&b=2` from the non-empty values, in AUDIT_FILTER_KEYS order; '' when there are none. */
export function auditQueryString(q: AuditQuery): string {
  const p = new URLSearchParams();
  for (const k of AUDIT_FILTER_KEYS) {
    const v = q[k]?.trim();
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export interface AdminClient {
  access(): Promise<Access>;
  users(): Promise<UserRow[]>;
  user(id: string): Promise<UserDetail>;
  invite(body: Invite): Promise<UserRow>;
  offboard(
    id: string,
    body: { reason: string; successor_user_id?: string },
  ): Promise<OffboardResult>;
  grantRole(id: string, role: string): Promise<unknown>;
  revokeRole(id: string, role: string, reason: string): Promise<unknown>;
  sodWeek(weekStart?: string): Promise<SodWeek>;
  acknowledgeWeek(weekStart: string, note?: string): Promise<unknown>;
  auditLog(q: AuditQuery): Promise<AuditPage>;
}

export function createAdminClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): AdminClient {
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
    access: () => send('GET', '/auth/me/access'),
    users: () => send('GET', '/users'),
    user: (id) => send('GET', `/users/${seg(id)}`),
    invite: (body) => send('POST', '/users', body),
    offboard: (id, body) => send('POST', `/users/${seg(id)}/offboard`, body),
    grantRole: (id, role) => send('POST', `/users/${seg(id)}/roles`, { role }),
    revokeRole: (id, role, reason) =>
      send('POST', `/users/${seg(id)}/roles/${seg(role)}/revoke`, { reason }),
    sodWeek: (weekStart) =>
      send(
        'GET',
        weekStart
          ? `/sod/exceptions/weekly?week_start=${seg(weekStart)}`
          : '/sod/exceptions/weekly',
      ),
    acknowledgeWeek: (weekStart, note) =>
      send('POST', '/sod/exceptions/weekly/acknowledge', {
        week_start: weekStart,
        ...(note ? { note } : {}),
      }),
    auditLog: (q) => send('GET', `/audit-log${auditQueryString(q)}`),
  };
}
