/**
 * Client for the auth endpoints of T-0011 (ADR-0016): `GET /auth/me`, `POST /auth/logout` and the
 * tenant login URL `/t/<slug>/auth/login`. The session is the HttpOnly `lf_session` cookie, sent
 * because the app is served on the API's origin (RQ-0025).
 */
import type { AppEnv } from './env.tsx';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Me {
  tenant_id: string;
  user_id: string;
  display_name: string;
}

export interface ApiClient {
  me(): Promise<Me>;
  /** Ends this session. Resolves when signed out, including when it had already ended (401). */
  logout(): Promise<void>;
  loginUrl(slug: string): string;
}

function isMe(v: unknown): v is Me {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['tenant_id'] === 'string' &&
    typeof o['user_id'] === 'string' &&
    typeof o['display_name'] === 'string'
  );
}

export function createApiClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): ApiClient {
  const call = (method: 'GET' | 'POST', path: string) =>
    env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

  return {
    async me() {
      const res = await call('GET', '/auth/me');
      if (!res.ok) throw new ApiError(res.status, `GET /auth/me answered ${String(res.status)}`);
      const body: unknown = await res.json();
      if (!isMe(body)) throw new ApiError(res.status, 'GET /auth/me answered an unexpected body');
      return body;
    },
    async logout() {
      const res = await call('POST', '/auth/logout');
      if (res.status === 204 || res.status === 401) return;
      throw new ApiError(res.status, `POST /auth/logout answered ${String(res.status)}`);
    },
    loginUrl(slug) {
      return `${env.apiBase}/t/${encodeURIComponent(slug)}/auth/login`;
    },
  };
}
