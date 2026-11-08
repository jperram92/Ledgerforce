/**
 * SS-UC02-07 and SS-PLAT-49 (API part) — permission checks on every endpoint and role
 * administration (T-0012, ADR-0023). Real sessions, real database, lf_app only.
 *
 * The AR batch-run endpoint belongs to T-0043 and does not exist yet. A test controller stands in
 * for it, declared exactly as T-0043 must declare its route (`@RequirePermission('ar.batch.run')`);
 * the check, the 403 and the audit row are the real ones.
 */
import 'reflect-metadata';
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { ROLE_IDS } from '@ledgerforce/shared/rbac';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { RequirePermission } from './permission.decorator.ts';

const A = '01900000-0000-7000-8000-000000000e1a';
const B = '01900000-0000-7000-8000-000000000e1b';
const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(0xe01);
const FA = id(0xe02);
const AR = id(0xe03);
const AP = id(0xe04);
const ACC = id(0xe05);
const NOROLE = id(0xe06);
const TARGET = id(0xe07);
const AUDITOR = id(0xe08);
const OWNER_B = id(0xe0b);

let batchRuns = 0;

@Controller('ar/batches')
class TestBatchController {
  @Post(':batchId/run')
  @HttpCode(202)
  @RequirePermission('ar.batch.run')
  run(@Param('batchId') batchId: string): { batch_id: string; status: string } {
    batchRuns += 1;
    return { batch_id: batchId, status: 'running' };
  }
}

/** A route that forgot to declare its permission: must be refused (fail closed). */
@Controller('undeclared')
class TestUndeclaredController {
  @Get()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

let tdb: TestDatabase;
let api: Api;
let headerApi: Api;
const cookies = new Map<string, string>();

async function login(user: string, tenant = A): Promise<string> {
  if (!api.sessions) throw new Error('sessions not configured');
  // Signed in with MFA: these tests are about permissions, not MFA (T-0013 enforces it, DL-0123).
  const c = await api.sessions.create(tenant, { userId: user, amr: ['pwd', 'otp'], acr: null });
  cookies.set(user, c);
  return c;
}

function call(method: string, path: string, user?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const c = user ? cookies.get(user) : undefined;
  if (c) headers.cookie = `lf_session=${c}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface AuditRow {
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  tenant_id: string;
}
async function auditRows(): Promise<AuditRow[]> {
  const r = await tdb.admin.query<AuditRow>(
    'SELECT tenant_id, actor_user_id, action, entity_type, entity_id, before, after, request_id FROM audit.audit_log ORDER BY id',
  );
  return r.rows;
}

async function epochOf(user: string): Promise<number> {
  const r = await tdb.admin.query<{ e: number }>(
    'SELECT session_epoch AS e FROM app.app_user WHERE id = $1',
    [user],
  );
  return r.rows[0]?.e ?? -1;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  const users: [string, string, string | null][] = [
    [A, OWNER, 'owner'],
    [A, FA, 'finance_admin'],
    [A, AR, 'ar_clerk'],
    [A, AP, 'ap_clerk'],
    [A, ACC, 'accountant'],
    [A, NOROLE, null],
    [A, TARGET, null],
    [A, AUDITOR, 'auditor'],
    [B, OWNER_B, 'owner'],
  ];
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, role] of users) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({
            id: u,
            email: `${u}@example.test`,
            display_name: u.slice(-3),
            status: 'active',
          })
          .execute();
        if (role) await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
      }
    });
  }
  await seed.destroy();
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    testControllers: [TestBatchController, TestUndeclaredController],
  });
  // A resolver that yields a tenant but no verified user (as SS-PLAT-28 uses): permission routes refuse it.
  headerApi = await createApi({
    databaseUrl: tdb.url('lf_app'),
    tenantResolver: { resolve: () => Promise.resolve(A) },
    testControllers: [TestBatchController],
  });
  for (const [, u] of users) await login(u, u === OWNER_B ? B : A);
});

afterAll(async () => {
  await api.close();
  await headerApi.close();
  await tdb.close();
});

describe('SS-UC02-07: Permission required to run a batch', () => {
  it('a user without ar.batch.run is refused with 403 naming the permission, and the refusal is audited', async () => {
    const runsBefore = batchRuns;
    const auditBefore = (await auditRows()).length;
    const res = await call('POST', '/ar/batches/nov-2026/run', AP);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ar.batch.run' });
    expect(batchRuns).toBe(runsBefore);
    const rows = (await auditRows()).slice(auditBefore);
    expect(rows).toEqual([
      {
        tenant_id: A,
        actor_user_id: AP,
        action: 'permission_denied',
        entity_type: 'permission',
        entity_id: 'ar.batch.run',
        before: null,
        after: { method: 'POST', route: '/ar/batches/:batchId/run', permission: 'ar.batch.run' },
        request_id: res.headers.get('x-request-id'),
      },
    ]);
  });

  it('a user with no role at all is refused too', async () => {
    const res = await call('POST', '/ar/batches/nov-2026/run', NOROLE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ar.batch.run' });
  });

  it('an AR Clerk (holds ar.batch.run) may run the batch', async () => {
    const runsBefore = batchRuns;
    const res = await call('POST', '/ar/batches/nov-2026/run', AR);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ batch_id: 'nov-2026', status: 'running' });
    expect(batchRuns).toBe(runsBefore + 1);
  });

  it('without a session the answer stays 401, not 403', async () => {
    expect((await call('POST', '/ar/batches/nov-2026/run')).status).toBe(401);
  });
});

describe('SS-PLAT-49: Every endpoint checks a permission; role changes are audited and revoke sessions', () => {
  it('a route that declares no permission is refused (fail closed)', async () => {
    const res = await call('GET', '/undeclared', OWNER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: null });
  });

  it('a permission route refuses a tenant claim that has no verified user', async () => {
    const res = await fetch(`${headerApi.url}/ar/batches/x/run`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('bank details need parties.bank_account.read: an AR Clerk is refused, an Accountant is not', async () => {
    const party = '01900000-0000-7000-8000-0000000000ff';
    const denied = await call('GET', `/parties/${party}/bank-accounts`, AR);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'forbidden',
      permission: 'parties.bank_account.read',
    });
    expect((await call('GET', `/parties/${party}/bank-accounts`, ACC)).status).toBe(200);
  });

  it('any member may read /auth/me and /companies, even with no role', async () => {
    expect((await call('GET', '/auth/me', NOROLE)).status).toBe(200);
    expect((await call('GET', '/companies', NOROLE)).status).toBe(200);
  });

  it('the database role ids are exactly the ten templates', async () => {
    const r = await tdb.admin.query<{ id: string; ok: boolean }>(
      'SELECT id, app.role_template_exists(id) AS ok FROM unnest($1::text[]) AS id',
      [[...ROLE_IDS, 'root', 'Owner', '']],
    );
    expect(r.rows.filter((x) => x.ok).map((x) => x.id)).toEqual([...ROLE_IDS]);
  });

  it('the Owner grants a role: 201, audited with before/after, and the grantee is signed out everywhere', async () => {
    const targetCookie = await login(TARGET);
    expect((await call('GET', '/auth/me', TARGET)).status).toBe(200);
    const epoch = await epochOf(TARGET);
    const auditBefore = (await auditRows()).length;
    const res = await call('POST', `/users/${TARGET}/roles`, OWNER, { role: 'ar_clerk' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; user_id: string; role: string };
    expect(body).toMatchObject({ user_id: TARGET, role: 'ar_clerk' });
    expect(await epochOf(TARGET)).toBe(epoch + 1);
    const me = await fetch(`${api.url}/auth/me`, {
      headers: { cookie: `lf_session=${targetCookie}` },
    });
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ error: 'session_expired' });
    const rows = (await auditRows()).slice(auditBefore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: OWNER,
      action: 'POST /users/:userId/roles',
      entity_type: 'user_role',
      entity_id: body.id,
      before: null,
      after: { user_id: TARGET, role: 'ar_clerk' },
    });
    // A new session now carries the new role.
    await login(TARGET);
    expect((await call('POST', '/ar/batches/dec/run', TARGET)).status).toBe(202);
  });

  it('granting a role the user already holds is idempotent: 200, same grant, no session revoke', async () => {
    const epoch = await epochOf(TARGET);
    const res = await call('POST', `/users/${TARGET}/roles`, OWNER, { role: 'ar_clerk' });
    expect(res.status).toBe(200);
    expect(await epochOf(TARGET)).toBe(epoch);
  });

  it('lists a user’s grants, including revoked ones, for holders of users.read', async () => {
    const res = await call('GET', `/users/${TARGET}/roles`, AUDITOR);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { role: string; revoked_at: string | null }[];
    expect(list.map((r) => [r.role, r.revoked_at])).toEqual([['ar_clerk', null]]);
    expect((await call('GET', `/users/${TARGET}/roles`, AR)).status).toBe(403);
  });

  it('revoking a role: 200, audited, signs the user out, keeps the grant as history', async () => {
    const epoch = await epochOf(TARGET);
    const res = await call('POST', `/users/${TARGET}/roles/ar_clerk/revoke`, FA, {
      reason: 'moved to AP',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: TARGET, role: 'ar_clerk', revoked: true });
    expect(await epochOf(TARGET)).toBe(epoch + 1);
    const again = await call('POST', `/users/${TARGET}/roles/ar_clerk/revoke`, FA, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ revoked: false });
    expect(await epochOf(TARGET)).toBe(epoch + 1);
    const list = (await (await call('GET', `/users/${TARGET}/roles`, OWNER)).json()) as {
      role: string;
      revoked_at: string | null;
      revoke_reason: string | null;
      revoked_by: string | null;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      role: 'ar_clerk',
      revoke_reason: 'moved to AP',
      revoked_by: FA,
    });
    expect(list[0]?.revoked_at).not.toBeNull();
  });

  it('a Finance Admin may assign roles but not Owner; an AR Clerk may assign nothing', async () => {
    expect((await call('POST', `/users/${TARGET}/roles`, FA, { role: 'accountant' })).status).toBe(
      201,
    );
    const owner = await call('POST', `/users/${TARGET}/roles`, FA, { role: 'owner' });
    expect(owner.status).toBe(403);
    expect(await owner.json()).toEqual({
      error: 'forbidden',
      permission: 'users.roles.assign_owner',
    });
    const clerk = await call('POST', `/users/${TARGET}/roles`, AR, { role: 'auditor' });
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'users.roles.assign' });
    const denials = (await auditRows()).filter(
      (r) => r.action === 'permission_denied' && r.entity_id === 'users.roles.assign_owner',
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.actor_user_id).toBe(FA);
  });

  it('refuses an unknown role (400), an unknown or other-tenant user (404) and the last Owner (409)', async () => {
    const bad = await call('POST', `/users/${TARGET}/roles`, OWNER, { role: 'superuser' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_role' });
    expect((await call('POST', `/users/${TARGET}/roles`, OWNER, {})).status).toBe(400);
    expect((await call('POST', `/users/${TARGET}/roles/root/revoke`, OWNER, {})).status).toBe(400);
    const foreign = await call('POST', `/users/${OWNER_B}/roles`, OWNER, { role: 'auditor' });
    expect(foreign.status).toBe(404);
    expect((await call('GET', `/users/${OWNER_B}/roles`, OWNER)).status).toBe(404);
    expect((await call('GET', '/users/not-a-uuid/roles', OWNER)).status).toBe(400);
    const last = await call('POST', `/users/${OWNER}/roles/owner/revoke`, OWNER, {});
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: 'last_owner' });
    expect((await call('GET', '/auth/me', OWNER)).status).toBe(200);
  });

  it("another tenant's Owner cannot see or change this tenant's roles", async () => {
    expect((await call('GET', `/users/${TARGET}/roles`, OWNER_B)).status).toBe(404);
    expect((await call('POST', `/users/${TARGET}/roles`, OWNER_B, { role: 'owner' })).status).toBe(
      404,
    );
  });
});
