/**
 * SS-PLAT-21 (API part) and SS-PLAT-71 — user lifecycle (T-0016, design §6.3, ADR-0027).
 * Real sessions, real database, lf_app only.
 *
 * Joiner: POST /users invites (users.manage + the right to assign each role).
 * Mover: role changes (ADR-0023 routes) refuse self-grants and grants to disabled users.
 * Leaver: POST /users/:id/offboard disables the user (never deletes), revokes sessions, tokens
 * and role grants, records the successor who inherits pending approvals, and reports the
 * leaver's pending items. The revocations happen in the database (migration 0022).
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import {
  createTestDatabase,
  DEFAULT_ROW_OVERRIDES,
  seedRow,
  type TestDatabase,
} from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-000000021a0a';
const B = '01900000-0000-7000-8000-000000021b0b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = id(0x2101);
const FA = id(0x2102);
const LEAVER = id(0x2103);
const SUCC = id(0x2104);
const CLERK = id(0x2105);
const GONE = id(0x2106); // disabled before the tests
const OWNER_B = id(0x21b1);

let tdb: TestDatabase;
let api: Api;

async function session(user: string): Promise<string> {
  if (!api.sessions) throw new Error('sessions not configured');
  return api.sessions.create(user === OWNER_B ? B : A, {
    userId: user,
    amr: ['pwd', 'otp'],
    acr: null,
    authTime: new Date(),
  });
}

function call(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie: `lf_session=${cookie}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function bearer(path: string, token: string): Promise<Response> {
  return fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  const users: [string, string, string[], 'active' | 'disabled'][] = [
    [A, OWNER, ['owner'], 'active'],
    [A, FA, ['finance_admin'], 'active'],
    [A, LEAVER, ['accountant', 'approver'], 'active'],
    [A, SUCC, ['approver'], 'active'],
    [A, CLERK, ['ar_clerk'], 'active'],
    [A, GONE, [], 'disabled'],
    [B, OWNER_B, ['owner'], 'active'],
  ];
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, roles, status] of users) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({ id: u, email: `${u}@life.test`, display_name: 'U', status })
          .execute();
        for (const role of roles) {
          await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
        }
      }
    });
  }
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-PLAT-21: Leaver is disabled, never deleted', () => {
  it('offboarding disables the user, revokes sessions, tokens and roles, keeps history and reassigns pending approvals', async () => {
    const s1 = await session(LEAVER);
    const s2 = await session(LEAVER);
    const issued = await call('POST', '/api-tokens', s1, {
      name: 'bi',
      scopes: ['gl.account.read'],
    });
    expect(issued.status).toBe(201);
    const { token, id: tokenId } = (await issued.json()) as { token: string; id: string };
    expect((await bearer('/auth/me', s1)).status).toBe(401); // sanity: a cookie is not a bearer
    expect((await call('GET', '/auth/me', s2)).status).toBe(200);
    // A pending period-reopen request raised by the leaver (an item awaiting another approver).
    const reopen = await seedRow(
      tdb.admin,
      { schema: 'app', table: 'period_reopen_request', qualified: 'app.period_reopen_request' },
      A,
      DEFAULT_ROW_OVERRIDES,
      0,
      new Map([['requested_by', LEAVER]]),
    );

    const res = await call('POST', `/users/${LEAVER}/offboard`, await session(OWNER), {
      reason: 'Resigned 2026-10-24',
      successor_user_id: SUCC,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: LEAVER,
      status: 'disabled',
      changed: true,
      sessions_revoked: 2,
      tokens_revoked: 1,
      roles_revoked: 2,
      successor_user_id: SUCC,
      approvals_assignee: SUCC,
      pending: { period_reopen_requests: [reopen.id] },
    });

    // Every credential is dead.
    expect((await call('GET', '/auth/me', s1)).status).toBe(401);
    expect((await call('GET', '/auth/me', s2)).status).toBe(401);
    expect((await bearer('/companies', token)).status).toBe(401);
    // History retained: the user, sessions, token and grants are still there, revoked.
    const kept = await tdb.admin.query(
      `SELECT (SELECT status FROM app.app_user WHERE id = $1) AS status,
              (SELECT count(*)::int FROM app.session WHERE user_id = $1 AND revoked_at IS NOT NULL) AS sessions,
              (SELECT revoke_reason FROM app.api_token WHERE id = $2) AS token,
              (SELECT count(*)::int FROM app.user_role WHERE user_id = $1 AND revoke_reason = 'leaver') AS roles`,
      [LEAVER, tokenId],
    );
    expect(kept.rows).toEqual([
      { status: 'disabled', sessions: 2, token: 'user_disabled', roles: 2 },
    ]);
    const view = await call('GET', `/users/${LEAVER}`, await session(FA));
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      id: LEAVER,
      status: 'disabled',
      disabled_by: OWNER,
      disable_reason: 'Resigned 2026-10-24',
      successor_user_id: SUCC,
      roles: [],
    });
    const audit = await tdb.admin.query(
      `SELECT actor_user_id, action, entity_type, entity_id FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_id = $2 AND action IN ('user.disabled', 'POST /users/:userId/offboard')
        ORDER BY id`,
      [A, LEAVER],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: OWNER, action: 'user.disabled', entity_type: 'app_user', entity_id: LEAVER },
      {
        actor_user_id: OWNER,
        action: 'POST /users/:userId/offboard',
        entity_type: 'app_user',
        entity_id: LEAVER,
      },
    ]);

    // Idempotent: a second offboard changes nothing.
    const again = await call('POST', `/users/${LEAVER}/offboard`, await session(OWNER), {
      reason: 'again',
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      user_id: LEAVER,
      status: 'disabled',
      changed: false,
    });
  });

  it('needs users.manage and a reason; refuses oneself, bad successors, unknown and foreign users', async () => {
    const owner = await session(OWNER);
    const fa = await call('POST', `/users/${CLERK}/offboard`, await session(FA), { reason: 'x' });
    expect(fa.status).toBe(403);
    expect(await fa.json()).toEqual({ error: 'forbidden', permission: 'users.manage' });
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }]) {
      const r = await call('POST', `/users/${CLERK}/offboard`, owner, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_reason' });
    }
    const self = await call('POST', `/users/${OWNER}/offboard`, owner, { reason: 'bye' });
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: 'cannot_offboard_self' });
    for (const successor of [CLERK, GONE, OWNER_B, 'not-a-uuid']) {
      const r = await call('POST', `/users/${CLERK}/offboard`, owner, {
        reason: 'x',
        successor_user_id: successor,
      });
      expect([successor, r.status]).toEqual([successor, 400]);
      expect(await r.json()).toEqual({ error: 'invalid_successor' });
    }
    expect(
      (await call('POST', `/users/${id(0x2199)}/offboard`, owner, { reason: 'x' })).status,
    ).toBe(404);
    expect((await call('POST', `/users/${OWNER_B}/offboard`, owner, { reason: 'x' })).status).toBe(
      404,
    );
    // The refused attempts changed nothing.
    const clerk = await tdb.admin.query('SELECT status FROM app.app_user WHERE id = $1', [CLERK]);
    expect(clerk.rows).toEqual([{ status: 'active' }]);
  });
});

describe('SS-PLAT-71: Joiner is invited with roles; mover cannot grant themselves roles', () => {
  it('invite creates an invited user with role grants, audited; needs users.manage', async () => {
    const owner = await session(OWNER);
    const res = await call('POST', '/users', owner, {
      email: 'Nina@Harbour.test',
      display_name: 'Nina New',
      idp_issuer: 'https://idp.example.test',
      idp_subject: 'sub-nina',
      roles: ['ar_clerk', 'approver'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      email: 'Nina@Harbour.test',
      display_name: 'Nina New',
      status: 'invited',
      roles: ['approver', 'ar_clerk'],
    });
    const row = await tdb.admin.query(
      `SELECT u.status, u.invited_by, u.idp_issuer, u.idp_subject,
              array(SELECT r.role || ':' || r.granted_by FROM app.user_role r
                     WHERE r.user_id = u.id ORDER BY r.role) AS grants
         FROM app.app_user u WHERE u.id = $1`,
      [body.id],
    );
    expect(row.rows).toEqual([
      {
        status: 'invited',
        invited_by: OWNER,
        idp_issuer: 'https://idp.example.test',
        idp_subject: 'sub-nina',
        grants: [`approver:${OWNER}`, `ar_clerk:${OWNER}`],
      },
    ]);
    const audit = await tdb.admin.query(
      `SELECT actor_user_id, entity_type FROM audit.audit_log WHERE action = 'POST /users' AND entity_id = $1`,
      [body.id],
    );
    expect(audit.rows).toEqual([{ actor_user_id: OWNER, entity_type: 'app_user' }]);

    // Same e-mail (case-insensitive) or same IdP subject: conflict.
    for (const dup of [
      { email: 'nina@harbour.test', idp_subject: 'sub-other' },
      { email: 'other@harbour.test', idp_subject: 'sub-nina' },
    ]) {
      const r = await call('POST', '/users', owner, {
        display_name: 'Dup',
        idp_issuer: 'https://idp.example.test',
        roles: [],
        ...dup,
      });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'user_exists' });
    }
    for (const bad of [
      { email: 'no-at-sign', display_name: 'X', idp_issuer: 'https://i', idp_subject: 's' },
      { email: 'a@b.test', display_name: '', idp_issuer: 'https://i', idp_subject: 's' },
      { email: 'a@b.test', display_name: 'X', idp_subject: 's' },
      {
        email: 'a@b.test',
        display_name: 'X',
        idp_issuer: 'https://i',
        idp_subject: 's',
        roles: ['root'],
      },
      {
        email: 'a@b.test',
        display_name: 'X',
        idp_issuer: 'https://i',
        idp_subject: 's',
        roles: 'owner',
      },
    ]) {
      const r = await call('POST', '/users', owner, bad);
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    const fa = await call('POST', '/users', await session(FA), {
      email: 'z@harbour.test',
      display_name: 'Z',
      idp_issuer: 'https://i',
      idp_subject: 'sub-z',
    });
    expect(fa.status).toBe(403);
    expect(await fa.json()).toEqual({ error: 'forbidden', permission: 'users.manage' });
  });

  it('nobody grants a role to themselves; nobody grants a role to a disabled user', async () => {
    const self = await call('POST', `/users/${FA}/roles`, await session(FA), { role: 'approver' });
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({ error: 'self_grant' });
    const audit = await tdb.admin.query(
      `SELECT actor_user_id, entity_id FROM audit.audit_log WHERE action = 'self_grant_refused'`,
    );
    expect(audit.rows).toEqual([{ actor_user_id: FA, entity_id: FA }]);
    const roles = await tdb.admin.query(
      `SELECT role FROM app.user_role WHERE user_id = $1 AND revoked_at IS NULL`,
      [FA],
    );
    expect(roles.rows).toEqual([{ role: 'finance_admin' }]);
    const disabled = await call('POST', `/users/${GONE}/roles`, await session(OWNER), {
      role: 'auditor',
    });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: 'user_disabled' });
    // Granting someone else is unchanged (positive control).
    const ok = await call('POST', `/users/${CLERK}/roles`, await session(FA), { role: 'auditor' });
    expect(ok.status).toBe(201);
  });
});
