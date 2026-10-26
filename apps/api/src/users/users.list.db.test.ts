/**
 * SS-PLAT-78 (API part) — the admin screens' read routes (T-0093, ADR-0034, RQ-0038):
 *  - GET /users (users.read): every user of the caller's tenant with status and active roles;
 *  - GET /auth/me/access (any member): the caller's active roles and effective permissions
 *    (role permissions ∩ token scopes), so the browser can hide or disable what it may not do.
 * Real sessions, real database, lf_app only.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-000000093a0a';
const B = '01900000-0000-7000-8000-000000093b0b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = id(0x93a1);
const FA = id(0x93a2);
const AUDITOR = id(0x93a3);
const CLERK = id(0x93a4);
const INVITED = id(0x93a5);
const GONE = id(0x93a6);
const NOROLE = id(0x93a7);
const OWNER_B = id(0x93b1);

const PEOPLE: [string, string, string, string[], 'active' | 'invited' | 'disabled'][] = [
  [A, OWNER, 'Sam Nguyen', ['owner'], 'active'],
  [A, FA, 'Mei Tan', ['finance_admin', 'approver'], 'active'],
  [A, AUDITOR, 'Ada Auditor', ['auditor'], 'active'],
  [A, CLERK, 'Lena Ortiz', ['ar_clerk'], 'active'],
  [A, INVITED, 'Ivy Invited', ['ap_clerk'], 'invited'],
  [A, GONE, 'Gus Gone', [], 'disabled'],
  [A, NOROLE, 'Nora None', [], 'active'],
  [B, OWNER_B, 'Bea Other', ['owner'], 'active'],
];

let tdb: TestDatabase;
let api: Api;
const cookies = new Map<string, string>();

function call(path: string, cookie?: string): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    headers: cookie === undefined ? {} : { cookie: `lf_session=${cookie}` },
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, name, roles, status] of PEOPLE) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({
            id: u,
            email: `${name.split(' ')[0]?.toLowerCase() ?? 'x'}@admin.test`,
            display_name: name,
            status,
          })
          .execute();
        for (const role of roles) {
          await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
        }
      }
    });
  }
  // A revoked grant is history, not a role: Lena held Accountant once (mover, ADR-0023).
  await withTenant(seed, A, async (trx) => {
    await trx.insertInto('app.user_role').values({ user_id: CLERK, role: 'accountant' }).execute();
    await trx
      .updateTable('app.user_role')
      .set({ revoked_at: new Date(), revoke_reason: 'moved to sales' })
      .where('user_id', '=', CLERK)
      .where('role', '=', 'accountant')
      .execute();
  });
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [t, u, , , status] of PEOPLE) {
    if (status !== 'active') continue;
    cookies.set(
      u,
      await api.sessions.create(t, {
        userId: u,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-PLAT-78: GET /users lists the tenant users with status and active roles', () => {
  it("an Owner sees every user of their own tenant, by name, with active roles; nothing of another tenant's", async () => {
    const res = await call('/users', cookies.get(OWNER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.map((u) => [u['display_name'], u['status'], u['roles']])).toEqual([
      ['Ada Auditor', 'active', ['auditor']],
      ['Gus Gone', 'disabled', []],
      ['Ivy Invited', 'invited', ['ap_clerk']],
      ['Lena Ortiz', 'active', ['ar_clerk']],
      ['Mei Tan', 'active', ['approver', 'finance_admin']],
      ['Nora None', 'active', []],
      ['Sam Nguyen', 'active', ['owner']],
    ]);
    expect(body.find((u) => u['id'] === OWNER)).toEqual({
      id: OWNER,
      email: 'sam@admin.test',
      display_name: 'Sam Nguyen',
      status: 'active',
      created_at: expect.any(String),
      disabled_at: null,
      successor_user_id: null,
      roles: ['owner'],
    });
    expect(body.some((u) => u['id'] === OWNER_B)).toBe(false);
    const other = (await (await call('/users', cookies.get(OWNER_B))).json()) as { id: string }[];
    expect(other.map((u) => u.id)).toEqual([OWNER_B]);
  });

  it('the Finance Admin and the Auditor may list (users.read); a clerk gets 403; no session gets 401', async () => {
    expect((await call('/users', cookies.get(FA))).status).toBe(200);
    expect((await call('/users', cookies.get(AUDITOR))).status).toBe(200);
    const denied = await call('/users', cookies.get(CLERK));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', permission: 'users.read' });
    expect((await call('/users')).status).toBe(401);
  });
});

describe('SS-PLAT-78: GET /auth/me/access tells the browser what the caller may do', () => {
  const sorted = (xs: readonly string[]) => [...xs].sort();

  it('returns the active roles and the effective permissions, sorted', async () => {
    const owner = await call('/auth/me/access', cookies.get(OWNER));
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ roles: ['owner'], permissions: sorted(ALL_PERMISSIONS) });
    const fa = (await (await call('/auth/me/access', cookies.get(FA))).json()) as {
      roles: string[];
      permissions: string[];
    };
    expect(fa.roles).toEqual(['approver', 'finance_admin']);
    expect(fa.permissions).toEqual(
      sorted([
        ...new Set([
          ...ROLE_TEMPLATES.finance_admin.permissions,
          ...ROLE_TEMPLATES.approver.permissions,
        ]),
      ]),
    );
    expect(fa.permissions).not.toContain('users.manage');
    expect(await (await call('/auth/me/access', cookies.get(NOROLE))).json()).toEqual({
      roles: [],
      permissions: [],
    });
  });

  it('is a member route: no session gets 401', async () => {
    expect((await call('/auth/me/access')).status).toBe(401);
  });

  it('for an API token the permissions are its scopes ∩ the role permissions', async () => {
    const issued = await fetch(`${api.url}/api-tokens`, {
      method: 'POST',
      headers: {
        cookie: `lf_session=${cookies.get(AUDITOR) ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'read audit', scopes: ['audit_log.read', 'users.read'] }),
    });
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    const res = await fetch(`${api.url}/auth/me/access`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roles: ['auditor'],
      permissions: ['audit_log.read', 'users.read'],
    });
  });
});
