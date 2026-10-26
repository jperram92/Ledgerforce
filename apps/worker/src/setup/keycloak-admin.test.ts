/**
 * SS-PLAT-85 — the Keycloak admin calls that create the first Owner (T-0094, RQ-0041 S10, ADR-0037).
 * Contract checked against a local HTTP stand-in; the real Keycloak runs in SS-PLAT-23.
 *  - token: client_credentials with the temporary bootstrap admin client of the master realm;
 *  - ensureUser: find by exact username, else create with the first-login actions; id from Location;
 *  - setOneTimePassword: a *temporary* password and the actions CONFIGURE_TOTP + UPDATE_PASSWORD.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_LOGIN_ACTIONS, KeycloakAdmin, KeycloakAdminError } from './keycloak-admin.ts';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let server: Server;
let base = '';
let seen: Seen[] = [];
let users: { id: string; username: string }[] = [];
let failNext: Reply | null = null;

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += String(chunk);
  return s;
}

function route(s: Seen): Reply {
  if (failNext) {
    const r = failNext;
    failNext = null;
    return r;
  }
  if (s.method === 'POST' && s.url === '/realms/master/protocol/openid-connect/token') {
    return { status: 200, body: { access_token: 'tok-1', expires_in: 60, token_type: 'Bearer' } };
  }
  if (s.method === 'GET' && s.url.startsWith('/admin/realms/ledgerforce/users?')) {
    const q = new URL(s.url, 'http://x').searchParams;
    return { status: 200, body: users.filter((u) => u.username === q.get('username')) };
  }
  if (s.method === 'POST' && s.url === '/admin/realms/ledgerforce/users') {
    const b = JSON.parse(s.body) as { username: string };
    const id = `0000000${String(users.length + 1)}-aaaa-4bbb-8ccc-dddddddddddd`;
    users.push({ id, username: b.username });
    return { status: 201, headers: { location: `${base}/admin/realms/ledgerforce/users/${id}` } };
  }
  if (
    s.method === 'PUT' &&
    /^\/admin\/realms\/ledgerforce\/users\/[^/]+(\/reset-password)?$/.test(s.url)
  ) {
    return { status: 204 };
  }
  return { status: 404, body: { error: 'not stubbed' } };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const s: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        body,
      };
      seen.push(s);
      const r = route(s);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});
beforeEach(() => {
  seen = [];
  users = [];
  failNext = null;
});

const admin = () =>
  new KeycloakAdmin({
    baseUrl: base,
    realm: 'ledgerforce',
    clientId: 'lf-bootstrap',
    clientSecret: 'bootstrap-secret-value',
  });

describe('SS-PLAT-85 Keycloak admin client for the first Owner', () => {
  it('SS-PLAT-85 gets a token with the bootstrap admin client (client_credentials, master realm)', async () => {
    await admin().ensureUser({ email: 'owner@example.test', displayName: 'Olivia Owner' });
    const tok = seen[0];
    expect(tok?.method).toBe('POST');
    expect(tok?.url).toBe('/realms/master/protocol/openid-connect/token');
    expect(tok?.type).toMatch(/application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(tok?.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'lf-bootstrap',
      client_secret: 'bootstrap-secret-value',
    });
    for (const s of seen.slice(1)) expect(s.auth).toBe('Bearer tok-1');
  });

  it('SS-PLAT-85 creates the user once, with the first-login actions, and returns the subject', async () => {
    const a = admin();
    const first = await a.ensureUser({ email: 'Owner@Example.test', displayName: 'Olivia Owner' });
    expect(first).toEqual({ subject: '00000001-aaaa-4bbb-8ccc-dddddddddddd', created: true });
    const create = seen.find((s) => s.method === 'POST' && s.url.endsWith('/users'));
    expect(JSON.parse(create?.body ?? '{}')).toEqual({
      username: 'owner@example.test',
      email: 'owner@example.test',
      // Keycloak 26's user profile requires both names (else VERIFY_PROFILE at first login).
      firstName: 'Olivia',
      lastName: 'Owner',
      enabled: true,
      emailVerified: true,
      requiredActions: [...FIRST_LOGIN_ACTIONS],
    });
    const lookup = seen.find((s) => s.method === 'GET');
    expect(lookup?.url).toBe(
      '/admin/realms/ledgerforce/users?username=owner%40example.test&exact=true',
    );

    seen = [];
    const again = await a.ensureUser({ email: 'owner@example.test', displayName: 'Olivia Owner' });
    expect(again).toEqual({ subject: '00000001-aaaa-4bbb-8ccc-dddddddddddd', created: false });
    expect(seen.filter((s) => s.method === 'POST' && s.url.endsWith('/users'))).toEqual([]);
  });

  it('SS-PLAT-85 splits the display name at the last space; a single name is the first name only', async () => {
    const a = admin();
    await a.ensureUser({ email: 'a@example.test', displayName: '  Mary Jane van Dyke ' });
    await a.ensureUser({ email: 'b@example.test', displayName: 'Prince' });
    const bodies = seen
      .filter((s) => s.method === 'POST' && s.url.endsWith('/users'))
      .map((s) => JSON.parse(s.body) as { firstName?: string; lastName?: string });
    expect(bodies.map((b) => [b.firstName, b.lastName])).toEqual([
      ['Mary Jane van', 'Dyke'],
      ['Prince', undefined],
    ]);
  });

  it('SS-PLAT-85 sets a temporary password and re-applies MFA enrolment and password change', async () => {
    expect([...FIRST_LOGIN_ACTIONS]).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
    const id = '00000009-aaaa-4bbb-8ccc-dddddddddddd';
    await admin().setOneTimePassword(id, 'one-time-pass-123');
    const reset = seen.find((s) => s.url.endsWith('/reset-password'));
    expect(reset?.method).toBe('PUT');
    expect(reset?.url).toBe(`/admin/realms/ledgerforce/users/${id}/reset-password`);
    expect(JSON.parse(reset?.body ?? '{}')).toEqual({
      type: 'password',
      value: 'one-time-pass-123',
      temporary: true,
    });
    const actions = seen.find((s) => s.method === 'PUT' && s.url.endsWith(id));
    expect(JSON.parse(actions?.body ?? '{}')).toEqual({
      requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'],
    });
  });

  it('SS-PLAT-85 refuses a subject that is not a UUID (no path injection)', async () => {
    await expect(admin().setOneTimePassword('../../x', 'pw-1234567890')).rejects.toThrow(/subject/);
    expect(seen).toEqual([]);
  });

  it('SS-PLAT-85 a failed call throws with status and path, never the secret or the password', async () => {
    failNext = { status: 401, body: { error: 'unauthorized_client' } };
    const err = await admin()
      .ensureUser({ email: 'owner@example.test', displayName: 'O' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeycloakAdminError);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/token/);
    expect((err as Error).message).not.toContain('bootstrap-secret-value');

    const a = admin();
    await a.ensureUser({ email: 'owner@example.test', displayName: 'O' });
    failNext = { status: 400, body: { error: 'invalidPasswordMinLengthMessage' } };
    const err2 = await a
      .setOneTimePassword('00000001-aaaa-4bbb-8ccc-dddddddddddd', 'secret-pass-zzz')
      .catch((e: unknown) => e);
    expect((err2 as Error).message).toMatch(/400/);
    expect((err2 as Error).message).not.toContain('secret-pass-zzz');
  });
});
