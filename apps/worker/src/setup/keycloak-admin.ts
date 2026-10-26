/**
 * Keycloak admin REST calls that create the first Owner of a self-hosted install (T-0094,
 * RQ-0041 S10, ADR-0037). Authenticates with the *temporary* bootstrap admin service account of
 * the master realm (client_credentials; Keycloak creates it only on its first start). Errors name
 * the call and the HTTP status, never a secret or a password.
 */
import type { IdentityAdmin } from './setup.ts';

/** Keycloak runs these on the first sign-in: MFA enrolment, then the person's own password. */
export const FIRST_LOGIN_ACTIONS = Object.freeze(['CONFIGURE_TOTP', 'UPDATE_PASSWORD'] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KeycloakAdminOptions {
  /** Internal base URL of Keycloak, e.g. http://keycloak:8080 (not the public URL). */
  baseUrl: string;
  /** The tenant realm, e.g. `ledgerforce`. */
  realm: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export class KeycloakAdminError extends Error {
  readonly call: string;
  readonly status: number;
  constructor(call: string, status: number) {
    super(`Keycloak admin call ${call} failed with HTTP ${String(status)}`);
    this.name = 'KeycloakAdminError';
    this.call = call;
    this.status = status;
  }
}

export class KeycloakAdmin implements IdentityAdmin {
  readonly #opts: KeycloakAdminOptions;
  readonly #fetch: typeof fetch;
  #token: { value: string; until: number } | undefined;

  constructor(opts: KeycloakAdminOptions) {
    this.#opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
    this.#fetch = opts.fetch ?? fetch;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.until > Date.now()) return this.#token.value;
    const res = await this.#fetch(
      `${this.#opts.baseUrl}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.#opts.clientId,
          client_secret: this.#opts.clientSecret,
        }),
      },
    );
    if (!res.ok) throw new KeycloakAdminError('token', res.status);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new KeycloakAdminError('token', res.status);
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 30;
    this.#token = { value: body.access_token, until: Date.now() + Math.max(ttl - 10, 1) * 1000 };
    return body.access_token;
  }

  async #call(call: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#accessToken();
    const res = await this.#fetch(
      `${this.#opts.baseUrl}/admin/realms/${encodeURIComponent(this.#opts.realm)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!res.ok) throw new KeycloakAdminError(call, res.status);
    return res;
  }

  async ensureUser(u: {
    email: string;
    displayName: string;
  }): Promise<{ subject: string; created: boolean }> {
    const username = u.email.toLowerCase();
    const q = new URLSearchParams({ username, exact: 'true' });
    const found = (await (
      await this.#call('find user', 'GET', `/users?${q.toString()}`)
    ).json()) as { id?: unknown; username?: unknown }[];
    const hit = found.find((x) => x.username === username);
    if (hit && typeof hit.id === 'string') return { subject: hit.id, created: false };

    const res = await this.#call('create user', 'POST', '/users', {
      username,
      email: username,
      firstName: u.displayName,
      enabled: true,
      emailVerified: true,
      requiredActions: [...FIRST_LOGIN_ACTIONS],
    });
    const id = (res.headers.get('location') ?? '').split('/').pop() ?? '';
    if (!UUID.test(id)) throw new KeycloakAdminError('create user (no id)', res.status);
    return { subject: id, created: true };
  }

  async setOneTimePassword(subject: string, password: string): Promise<void> {
    if (!UUID.test(subject)) throw new TypeError('Keycloak subject must be a UUID');
    const path = `/users/${subject}`;
    await this.#call('set one-time password', 'PUT', `${path}/reset-password`, {
      type: 'password',
      value: password,
      temporary: true,
    });
    await this.#call('set first-login actions', 'PUT', path, {
      requiredActions: [...FIRST_LOGIN_ACTIONS],
    });
  }
}
