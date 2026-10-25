/**
 * SS-PLAT-80 (database part) — the audit log read path (migration 0029, T-0093, ADR-0034,
 * RQ-0038). lf_app keeps INSERT only on audit.audit_log; the only read is audit.read_log(), a
 * SECURITY DEFINER function owned by lf_migrator that needs a tenant context, re-checks that the
 * acting user holds an audit-reading role, returns only that tenant's rows, newest first, at most
 * 100 per call, with keyset pages. Run as lf_app inside tenant transactions.
 */
import { ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const A = '01900000-0000-7000-8000-0000000093aa';
const B = '01900000-0000-7000-8000-0000000093bb';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = uid(0x9301);
const AUDITOR = uid(0x9302);
const FIN_ADMIN = uid(0x9303);
const CLERK = uid(0x9304);
const GONE = uid(0x9305); // disabled auditor
const NOROLE = uid(0x9306);
const B_OWNER = uid(0x9311);

interface Row {
  id: string;
  occurred_at: Date;
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

interface Filter {
  actor?: string | null;
  action?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  from?: string | null;
  to?: string | null;
  before?: string | null;
  limit?: number;
}

let tdb: TestDatabase;
let db: Kysely<Database>;

const readLog = (trx: Transaction<Database>, actor: string | null, f: Filter = {}) =>
  sql<Row>`
    SELECT * FROM audit.read_log(${actor}::uuid, ${f.actor ?? null}::uuid, ${f.action ?? null}::text,
      ${f.entityType ?? null}::text, ${f.entityId ?? null}::text, ${f.from ?? null}::timestamptz,
      ${f.to ?? null}::timestamptz, ${f.before ?? null}::bigint, ${f.limit ?? 50}::integer)`
    .execute(trx)
    .then((r) => r.rows);

const asA = (actor: string | null, f?: Filter) =>
  withTenant(db, A, (trx) => readLog(trx, actor, f));

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  const people: [string, string, string, string[], string][] = [
    [A, OWNER, 'Owen Owner', ['owner'], 'active'],
    [A, AUDITOR, 'Ada Auditor', ['auditor'], 'active'],
    [A, FIN_ADMIN, 'Fin Admin', ['finance_admin'], 'active'],
    [A, CLERK, 'Cleo Clerk', ['ar_clerk', 'approver'], 'active'],
    [A, GONE, 'Gone Auditor', ['auditor'], 'active'],
    [A, NOROLE, 'Nora None', [], 'active'],
    [B, B_OWNER, 'Bea Owner', ['owner'], 'active'],
  ];
  for (const [t, name] of [
    [A, 'Audit Read A'],
    [B, 'Audit Read B'],
  ] as const) {
    await tdb.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [t, name]);
  }
  for (const [t, id, name, roles, status] of people) {
    await tdb.admin.query(
      'INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
      [id, t, `${id}@audit.test`, name, status],
    );
    for (const r of roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [t, id, r],
      );
    }
  }
  // GONE leaves: the offboarding trigger revokes the auditor grant (migration 0022).
  await tdb.admin.query(`UPDATE app.app_user SET status = 'disabled' WHERE id = $1`, [GONE]);
  // ... and, as test data only (a superuser may), an active auditor grant on the disabled user, so
  // that the reader's own "active user" check is what refuses them.
  await tdb.admin.query(
    `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'auditor')`,
    [A, GONE],
  );
  // Seven seeded rows in A on four days (plus the trigger's user.disabled row), three rows in B. Inserted oldest first, so id order = time order.
  const rows: [string, string, string | null, string, string, string | null, string][] = [
    [A, '2026-10-20T01:00:00Z', OWNER, 'POST /users', 'app_user', CLERK, '{"status":"invited"}'],
    [A, '2026-10-20T02:00:00Z', OWNER, 'POST /users/:userId/roles', 'user_role', 'r-1', '{}'],
    [A, '2026-10-21T03:00:00Z', CLERK, 'user.joined', 'app_user', CLERK, '{}'],
    [A, '2026-10-22T04:00:00Z', OWNER, 'POST /sod/settings', 'sod_settings', 's-1', '{}'],
    [A, '2026-10-22T05:00:00Z', null, 'period.status_changed', 'fiscal_period', 'p-1', '{}'],
    [
      A,
      '2026-10-23T06:00:00Z',
      FIN_ADMIN,
      'POST /users/:userId/roles/:role/revoke',
      'user_role',
      'r-1',
      '{}',
    ],
    [A, '2026-10-23T07:00:00Z', OWNER, 'POST /users/:userId/offboard', 'app_user', GONE, '{}'],
    [B, '2026-10-21T01:00:00Z', B_OWNER, 'POST /users', 'app_user', B_OWNER, '{}'],
    [B, '2026-10-22T01:00:00Z', B_OWNER, 'POST /users/:userId/roles', 'user_role', 'rb-1', '{}'],
    [B, '2026-10-23T01:00:00Z', B_OWNER, 'user.joined', 'app_user', B_OWNER, '{}'],
  ];
  for (const [t, at, actor, action, et, eid, after] of rows) {
    await tdb.admin.query(
      `INSERT INTO audit.audit_log (tenant_id, occurred_at, actor_type, actor_user_id, action,
                                    entity_type, entity_id, after, ip, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '203.0.113.9', 'test-agent', 'req-1')`,
      [t, at, actor === null ? 'system' : 'user', actor, action, et, eid, after],
    );
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-80: the audit log is read only through audit.read_log', () => {
  it('lf_app still cannot SELECT the table directly (42501)', async () => {
    const code = await sqlstate(
      withTenant(db, A, (trx) => sql`SELECT count(*) FROM audit.audit_log`.execute(trx)),
    );
    expect(code).toBe('42501');
  });

  it('the reader is SECURITY DEFINER, owned by lf_migrator, pinned search_path, EXECUTE for lf_app only', async () => {
    const { rows } = await tdb.admin.query<{
      definer: boolean;
      owner: string;
      config: string[] | null;
      volatile: string;
      app: boolean;
      pub: boolean;
    }>(`SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
               p.provolatile AS volatile,
               has_function_privilege('lf_app', p.oid, 'EXECUTE') AS app,
               coalesce(bool_or(a.grantee = 0 AND a.privilege_type = 'EXECUTE'), false) AS pub
          FROM pg_proc p
          LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
         WHERE p.oid = 'audit.read_log(uuid,uuid,text,text,text,timestamptz,timestamptz,bigint,integer)'::regprocedure
         GROUP BY p.prosecdef, p.proowner, p.proconfig, p.provolatile, p.oid`);
    expect(rows).toEqual([
      {
        definer: true,
        owner: 'lf_migrator',
        config: ['search_path=pg_catalog, pg_temp'],
        volatile: 's',
        app: true,
        pub: false,
      },
    ]);
  });

  it("an Owner reads only the tenant's rows, newest first, with every column", async () => {
    const rows = await asA(OWNER);
    expect(rows.map((r) => r.action)).toEqual([
      'POST /users/:userId/offboard',
      'POST /users/:userId/roles/:role/revoke',
      'period.status_changed',
      'POST /sod/settings',
      'user.joined',
      'POST /users/:userId/roles',
      'POST /users',
      'user.disabled', // written by the offboarding trigger during this file's setup (oldest id)
    ]);
    const ids = rows.map((r) => BigInt(r.id));
    expect([...ids].sort((x, y) => (x > y ? -1 : 1))).toEqual(ids);
    expect(rows[0]).toMatchObject({
      actor_type: 'user',
      actor_user_id: OWNER,
      entity_type: 'app_user',
      entity_id: GONE,
      after: {},
      before: null,
      ip: '203.0.113.9',
      user_agent: 'test-agent',
      request_id: 'req-1',
      api_token_id: null,
    });
    expect(rows[2]).toMatchObject({ actor_type: 'system', actor_user_id: null });
    const b = await withTenant(db, B, (trx) => readLog(trx, B_OWNER));
    expect(b.map((r) => r.action)).toEqual([
      'user.joined',
      'POST /users/:userId/roles',
      'POST /users',
    ]);
  });

  it('the Auditor and the Finance Admin may read; other roles, disabled and foreign users may not (42501)', async () => {
    expect(await asA(AUDITOR)).toHaveLength(8);
    expect(await asA(FIN_ADMIN)).toHaveLength(8);
    for (const who of [CLERK, NOROLE, GONE, B_OWNER, null]) {
      expect(await sqlstate(asA(who)), String(who)).toBe('42501');
    }
  });

  it('refuses without a tenant context (42501)', async () => {
    const code = await sqlstate(db.transaction().execute((trx) => readLog(trx, OWNER)));
    expect(code).toBe('42501');
  });

  it('page size must be 1..100 (22023); 1 and 100 are accepted', async () => {
    expect(await sqlstate(asA(OWNER, { limit: 0 }))).toBe('22023');
    expect(await sqlstate(asA(OWNER, { limit: 101 }))).toBe('22023');
    expect(await asA(OWNER, { limit: 1 })).toHaveLength(1);
    expect(await asA(OWNER, { limit: 100 })).toHaveLength(8);
  });

  it('keyset pages: before=<id> continues strictly after the last row seen', async () => {
    const all = await asA(OWNER);
    const p1 = await asA(OWNER, { limit: 3 });
    expect(p1.map((r) => r.id)).toEqual(all.slice(0, 3).map((r) => r.id));
    const p2 = await asA(OWNER, { limit: 3, before: p1[2]?.id ?? null });
    expect(p2.map((r) => r.id)).toEqual(all.slice(3, 6).map((r) => r.id));
    const p3 = await asA(OWNER, { limit: 3, before: p2[2]?.id ?? null });
    expect(p3.map((r) => r.id)).toEqual(all.slice(6).map((r) => r.id));
  });

  it('filters: actor, action (case-insensitive substring), entity type and id, from inclusive, to exclusive', async () => {
    const actions = async (f: Filter) => (await asA(OWNER, f)).map((r) => r.action);
    expect(await actions({ actor: FIN_ADMIN })).toEqual(['POST /users/:userId/roles/:role/revoke']);
    expect(await actions({ action: 'USERS/:USERID/ROLES' })).toEqual([
      'POST /users/:userId/roles/:role/revoke',
      'POST /users/:userId/roles',
    ]);
    // A LIKE wildcard is matched literally, not as a pattern.
    expect(await actions({ action: '%' })).toEqual([]);
    expect(await actions({ entityType: 'user_role' })).toHaveLength(2);
    expect(await actions({ entityType: 'user' })).toEqual([]);
    expect(await actions({ entityType: 'app_user', entityId: CLERK })).toEqual([
      'user.joined',
      'POST /users',
    ]);
    expect(await actions({ from: '2026-10-22T04:00:00Z', to: '2026-10-23T06:00:00Z' })).toEqual([
      'period.status_changed',
      'POST /sod/settings',
    ]);
    expect(await actions({ actor: OWNER, from: '2026-10-21T00:00:00Z' })).toEqual([
      'POST /users/:userId/offboard',
      'POST /sod/settings',
    ]);
  });

  it('app.role_allows_audit_read mirrors the role templates holding audit_log.read', async () => {
    const got = await withTenant(db, A, async (trx) => {
      const out: Record<string, boolean> = {};
      for (const r of [...ROLE_IDS, 'nobody']) {
        const res = await sql<{
          ok: boolean;
        }>`SELECT app.role_allows_audit_read(${r}) AS ok`.execute(trx);
        out[r] = res.rows[0]?.ok ?? false;
      }
      return out;
    });
    const want: Record<string, boolean> = { nobody: false };
    for (const r of ROLE_IDS) want[r] = ROLE_TEMPLATES[r].permissions.includes('audit_log.read');
    expect(got).toEqual(want);
  });
});
