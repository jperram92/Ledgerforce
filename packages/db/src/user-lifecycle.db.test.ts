/**
 * SS-PLAT-21, SS-PLAT-70, SS-PLAT-71 (database part) — user lifecycle and API tokens
 * (migration 0022, T-0016, ADR-0027, RQ-0031).
 *
 *  - Leaver: the status change to `disabled` revokes every open session, every active API token
 *    and every active role grant in the same statement (trigger), bumps session_epoch, records
 *    who and why, audits it, and keeps every row. A disabled user never becomes active again.
 *  - Mover: nobody grants a role to themselves; no role is granted to a disabled user.
 *  - Tokens: only a SHA-256 is stored; scopes are known, token-allowed permissions; expiry is
 *    mandatory and bounded; the only changes are last_used_at and one revoke; tenant-bound (RLS).
 *
 * Run as lf_app inside tenant transactions (withTenant); the superuser only inspects.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ALL_PERMISSIONS, TOKEN_FORBIDDEN_SCOPES } from '@ledgerforce/shared/rbac';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const T = '01900000-0000-7000-8000-000000021a1a';
const OTHER = '01900000-0000-7000-8000-000000021a1b';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = uid(0x2101);
const LEAVER = uid(0x2102);
const SUCC = uid(0x2103);
const CLERK = uid(0x2104);
const INVITED = uid(0x2105);
const GONE = uid(0x2106); // a second leaver, for the successor chain
const LONER = uid(0x2107); // disabled without a successor
const OTHER_USER = uid(0x2108);

let tdb: TestDatabase;
let db: Kysely<Database>;
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>, tenant = T) =>
  withTenant(db, tenant, fn);

const sha = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const DAY = 86_400_000;

async function addSession(user: string, revoked = false): Promise<string> {
  return inTenant(async (trx) => {
    const now = new Date();
    const r = await trx
      .insertInto('app.session')
      .values({
        user_id: user,
        secret_sha256: sha(),
        created_at: now,
        last_seen_at: now,
        absolute_expires_at: new Date(now.getTime() + 12 * 3600_000),
        idle_timeout_seconds: 1800,
        user_session_epoch: 0,
        ...(revoked ? { revoked_at: now, revoke_reason: 'logout' } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  });
}

function token(
  user: string,
  v: { scopes?: string[]; expiresInDays?: number; secret?: string; createdAt?: Date } = {},
) {
  return inTenant(async (trx) => {
    const created = v.createdAt ?? new Date();
    const r = await trx
      .insertInto('app.api_token')
      .values({
        user_id: user,
        name: 'ci export',
        scopes: v.scopes ?? ['ar.read'],
        secret_sha256: v.secret ?? sha(),
        created_at: created,
        expires_at: new Date(created.getTime() + (v.expiresInDays ?? 90) * DAY),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  });
}

const revokeToken = (id: string, by: string | null = OWNER) =>
  inTenant((trx) =>
    trx
      .updateTable('app.api_token')
      .set({ revoked_at: sql<Date>`clock_timestamp()`, revoked_by: by, revoke_reason: 'rotated' })
      .where('id', '=', id)
      .execute(),
  );

const disable = (user: string, by: string | null, successor: string | null = null) =>
  inTenant((trx) =>
    trx
      .updateTable('app.app_user')
      .set({
        status: 'disabled',
        disabled_by: by,
        disable_reason: 'left the company',
        successor_user_id: successor,
      })
      .where('id', '=', user)
      .execute(),
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 1);
  for (const tenant of [T, OTHER]) {
    await tdb.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, $2)`, [tenant, 'Life']);
  }
  const people: [string, string, string[], string][] = [
    [T, OWNER, ['owner'], 'active'],
    [T, LEAVER, ['ap_clerk', 'approver'], 'active'],
    [T, SUCC, ['approver'], 'active'],
    [T, CLERK, ['ar_clerk'], 'active'],
    [T, INVITED, [], 'invited'],
    [T, GONE, ['approver'], 'active'],
    [T, LONER, [], 'active'],
    [OTHER, OTHER_USER, ['owner'], 'active'],
  ];
  for (const [tenant, id, roles, status] of people) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, 'U', $4)`,
      [id, tenant, `${id}@life.test`, status],
    );
    for (const role of roles) {
      await tdb.admin.query(
        `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
        [tenant, id, role],
      );
    }
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-21: Leaver is disabled, never deleted', () => {
  it('disabling revokes every open session, token and role grant in the same statement and keeps every row', async () => {
    const open1 = await addSession(LEAVER);
    const open2 = await addSession(LEAVER);
    const loggedOut = await addSession(LEAVER, true);
    const t1 = await token(LEAVER);
    const t2 = await token(LEAVER, { scopes: ['ap.read', 'ap.bill.enter'] });
    const rotated = await token(LEAVER);
    await revokeToken(rotated, LEAVER);
    const otherSession = await addSession(CLERK);
    const otherToken = await token(CLERK);
    const counts = async () =>
      (
        await tdb.admin.query<{ s: number; t: number; r: number; u: number }>(
          `SELECT (SELECT count(*)::int FROM app.session WHERE user_id = $1) AS s,
                  (SELECT count(*)::int FROM app.api_token WHERE user_id = $1) AS t,
                  (SELECT count(*)::int FROM app.user_role WHERE user_id = $1) AS r,
                  (SELECT count(*)::int FROM app.app_user WHERE id = $1) AS u`,
          [LEAVER],
        )
      ).rows[0];
    const before = await counts();
    const epochBefore = (
      await tdb.admin.query<{ e: number }>(
        'SELECT session_epoch AS e FROM app.app_user WHERE id = $1',
        [LEAVER],
      )
    ).rows[0]?.e;

    await disable(LEAVER, OWNER, SUCC);

    expect(await counts()).toEqual(before); // history retained: nothing deleted
    const user = await tdb.admin.query(
      `SELECT status, disabled_by, disable_reason, successor_user_id,
              disabled_at IS NOT NULL AS stamped, session_epoch > $2 AS epoch_bumped
         FROM app.app_user WHERE id = $1`,
      [LEAVER, epochBefore],
    );
    expect(user.rows).toEqual([
      {
        status: 'disabled',
        disabled_by: OWNER,
        disable_reason: 'left the company',
        successor_user_id: SUCC,
        stamped: true,
        epoch_bumped: true,
      },
    ]);
    const sessions = await tdb.admin.query(
      `SELECT id, revoke_reason FROM app.session WHERE user_id = $1 ORDER BY id`,
      [LEAVER],
    );
    expect(sessions.rows).toEqual(
      expect.arrayContaining([
        { id: open1, revoke_reason: 'user_disabled' },
        { id: open2, revoke_reason: 'user_disabled' },
        { id: loggedOut, revoke_reason: 'logout' },
      ]),
    );
    const tokens = await tdb.admin.query(
      `SELECT id, revoked_by, revoke_reason FROM app.api_token WHERE user_id = $1`,
      [LEAVER],
    );
    expect(tokens.rows).toEqual(
      expect.arrayContaining([
        { id: t1, revoked_by: OWNER, revoke_reason: 'user_disabled' },
        { id: t2, revoked_by: OWNER, revoke_reason: 'user_disabled' },
        { id: rotated, revoked_by: LEAVER, revoke_reason: 'rotated' },
      ]),
    );
    const roles = await tdb.admin.query(
      `SELECT role, revoked_by, revoke_reason FROM app.user_role WHERE user_id = $1 ORDER BY role`,
      [LEAVER],
    );
    expect(roles.rows).toEqual([
      { role: 'ap_clerk', revoked_by: OWNER, revoke_reason: 'leaver' },
      { role: 'approver', revoked_by: OWNER, revoke_reason: 'leaver' },
    ]);
    // Other users are untouched.
    const others = await tdb.admin.query(
      `SELECT (SELECT revoked_at FROM app.session WHERE id = $1) AS s,
              (SELECT revoked_at FROM app.api_token WHERE id = $2) AS t`,
      [otherSession, otherToken],
    );
    expect(others.rows).toEqual([{ s: null, t: null }]);
    const audit = await tdb.admin.query(
      `SELECT actor_type, actor_user_id, action, entity_type, entity_id, after
         FROM audit.audit_log WHERE tenant_id = $1 AND action = 'user.disabled'`,
      [T],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'user',
        actor_user_id: OWNER,
        action: 'user.disabled',
        entity_type: 'app_user',
        entity_id: LEAVER,
        after: {
          reason: 'left the company',
          successor_user_id: SUCC,
          sessions_revoked: 2,
          tokens_revoked: 2,
          roles_revoked: 2,
        },
      },
    ]);
  });

  it('a disabled user never becomes active again; lf_app cannot delete users, sessions or tokens', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.app_user')
          .set({ status: 'active' })
          .where('id', '=', LEAVER)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const [table, col] of [
      ['app.app_user', 'id'],
      ['app.session', 'user_id'],
      ['app.api_token', 'user_id'],
    ] as const) {
      await expect(
        inTenant((trx) =>
          sql`DELETE FROM ${sql.table(table)} WHERE ${sql.ref(col)} = ${LEAVER}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // Not even the table owner deletes a token (append-only history).
    await expect(
      tdb.admin.query('DELETE FROM app.api_token WHERE user_id = $1', [LEAVER]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the disable columns cannot be rewritten later', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.app_user')
          .set({ disable_reason: 'something nicer' })
          .where('id', '=', LEAVER)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the successor must be another active user of the tenant', async () => {
    await expect(disable(LONER, OWNER, LONER)).rejects.toMatchObject({ code: '23514' });
    await expect(disable(LONER, OWNER, LEAVER)).rejects.toMatchObject({ code: '23514' });
    await expect(disable(LONER, OWNER, OTHER_USER)).rejects.toMatchObject({ code: '23503' });
    await expect(disable(LONER, LONER)).rejects.toMatchObject({ code: '23514' }); // not by themself
  });

  it('approval_assignee follows the successor chain to an active user (pending approvals are routed)', async () => {
    const assignee = (u: string) =>
      inTenant(async (trx) => {
        const r = await sql<{
          a: string | null;
        }>`SELECT app.approval_assignee(${u}::uuid) AS a`.execute(trx);
        return r.rows[0]?.a;
      });
    expect(await assignee(OWNER)).toBe(OWNER);
    expect(await assignee(LEAVER)).toBe(SUCC);
    await disable(SUCC, OWNER, GONE);
    expect(await assignee(LEAVER)).toBe(GONE); // two hops
    await disable(LONER, OWNER);
    expect(await assignee(LONER)).toBeNull(); // no successor: nobody, the caller must decide
    expect(await assignee(OTHER_USER)).toBeNull(); // another tenant's user is invisible
  });
});

describe('SS-PLAT-71: Joiner and mover controls (database)', () => {
  it('nobody grants a role to themselves', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.user_role')
          .values({ user_id: CLERK, role: 'approver', granted_by: CLERK })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Granted by someone else it is fine (positive control).
    await inTenant((trx) =>
      trx
        .insertInto('app.user_role')
        .values({ user_id: CLERK, role: 'auditor', granted_by: OWNER })
        .execute(),
    );
  });

  it('no role is granted to a disabled user', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.user_role')
          .values({ user_id: LEAVER, role: 'auditor', granted_by: OWNER })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('SS-PLAT-70: API tokens are hashed, scoped, expiring and tenant-bound (database)', () => {
  it('stores only a SHA-256 of the secret: anything else is refused', async () => {
    const plaintext = `lfpat.${T}.${uid(1)}.${randomBytes(32).toString('base64url')}`;
    await expect(token(CLERK, { secret: plaintext })).rejects.toMatchObject({ code: '23514' });
    await expect(token(CLERK, { secret: 'A'.repeat(64) })).rejects.toMatchObject({
      code: '23514',
    }); // upper-case hex is not our digest format
  });

  it('scopes are known, token-allowed permissions, at least one, no duplicates', async () => {
    await expect(token(CLERK, { scopes: [] })).rejects.toMatchObject({ code: '23514' });
    await expect(token(CLERK, { scopes: ['ar.read', 'invoices:read'] })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(token(CLERK, { scopes: ['ar.read', 'ar.read'] })).rejects.toMatchObject({
      code: '23514',
    });
    for (const forbidden of TOKEN_FORBIDDEN_SCOPES) {
      await expect(token(OWNER, { scopes: ['ar.read', forbidden] })).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect(await token(CLERK, { scopes: ['ar.read', 'ar.invoice.create'] })).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('the database mirrors the permission catalogue and the token deny-list', async () => {
    const r = await tdb.admin.query<{ p: string; known: boolean; allowed: boolean }>(
      `SELECT p, app.permission_known(p) AS known, app.token_scope_allowed(p) AS allowed
         FROM unnest($1::text[]) AS p`,
      [[...ALL_PERMISSIONS, 'nope', 'invoices:read']],
    );
    for (const row of r.rows) {
      const known = (ALL_PERMISSIONS as readonly string[]).includes(row.p);
      expect([row.p, row.known]).toEqual([row.p, known]);
      expect([row.p, row.allowed]).toEqual([
        row.p,
        known && !(TOKEN_FORBIDDEN_SCOPES as readonly string[]).includes(row.p),
      ]);
    }
  });

  it('expiry is mandatory, after creation and at most 366 days; created_at is the database clock', async () => {
    await expect(token(CLERK, { expiresInDays: 367 })).rejects.toMatchObject({ code: '23514' });
    await expect(token(CLERK, { expiresInDays: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant((trx) =>
        sql`INSERT INTO app.api_token (user_id, name, scopes, secret_sha256)
            VALUES (${CLERK}, 'x', '{ar.read}', ${sha()})`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '23502' });
    // A back-dated created_at is replaced by the clock, so a year-old token cannot be minted.
    const backdated = new Date(Date.now() - 400 * DAY);
    await expect(token(CLERK, { createdAt: backdated, expiresInDays: 300 })).rejects.toMatchObject({
      code: '23514',
    });
    const id = await token(CLERK, { expiresInDays: 30 });
    const r = await tdb.admin.query<{ fresh: boolean }>(
      `SELECT created_at > now() - interval '1 minute' AS fresh FROM app.api_token WHERE id = $1`,
      [id],
    );
    expect(r.rows).toEqual([{ fresh: true }]);
  });

  it('only an active user owns a new token, and it is inserted active', async () => {
    await expect(token(INVITED)).rejects.toMatchObject({ code: '23514' });
    await expect(token(LEAVER)).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant((trx) =>
        sql`INSERT INTO app.api_token (user_id, name, scopes, secret_sha256, expires_at, revoked_at, revoke_reason)
            VALUES (${CLERK}, 'x', '{ar.read}', ${sha()}, now() + interval '1 day', now(), 'x')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the only changes are last_used_at (forward) and one revoke', async () => {
    const id = await token(CLERK);
    const set = (s: ReturnType<typeof sql>) =>
      inTenant((trx) => sql`UPDATE app.api_token SET ${s} WHERE id = ${id}`.execute(trx));
    await set(sql`last_used_at = clock_timestamp()`);
    await expect(set(sql`last_used_at = now() - interval '1 day'`)).rejects.toMatchObject({
      code: '23514',
    });
    // lf_app holds UPDATE only on the usage and revoke columns.
    for (const s of [
      sql`scopes = '{ar.read,ar.invoice.create}'`,
      sql`secret_sha256 = ${sha()}`,
      sql`expires_at = expires_at + interval '1 day'`,
      sql`user_id = ${OWNER}`,
    ]) {
      await expect(set(s)).rejects.toMatchObject({ code: '42501' });
    }
    await revokeToken(id, CLERK);
    await expect(
      set(sql`revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL`),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(set(sql`revoke_reason = 'again'`)).rejects.toMatchObject({ code: '23514' });
    await expect(set(sql`last_used_at = clock_timestamp()`)).rejects.toMatchObject({
      code: '23514',
    }); // a revoked token is never used again
    // Even the owner of the table cannot widen scopes (trigger, not only grants).
    await expect(
      tdb.admin.query(
        `UPDATE app.api_token SET scopes = '{ar.read,ar.invoice.send}' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is tenant-bound: another tenant neither sees nor creates rows for this tenant', async () => {
    const id = await token(CLERK);
    const seen = await inTenant(
      (trx) => trx.selectFrom('app.api_token').select('id').where('id', '=', id).execute(),
      OTHER,
    );
    expect(seen).toEqual([]);
    await expect(
      inTenant(
        (trx) =>
          sql`INSERT INTO app.api_token (tenant_id, user_id, name, scopes, secret_sha256, expires_at)
              VALUES (${T}, ${CLERK}, 'x', '{ar.read}', ${sha()}, now() + interval '1 day')`.execute(
            trx,
          ),
        OTHER,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
