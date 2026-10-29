/**
 * SS-PLAT-49 (database part) — role assignments (migration 0016, T-0012, ADR-0023): one row per
 * grant, revoked by setting revoked_at (never deleted), at most one active grant per user and
 * role, only known role templates, and every grant or revoke bumps the user's session_epoch in
 * the same transaction (revoke-all, ADR-0016). Run as lf_app inside tenant transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely, type Transaction } from 'kysely';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const T = '01900000-0000-7000-8000-000000000d1a';
const OTHER = '01900000-0000-7000-8000-000000000d1b';
const OWNER = '01900000-0000-7000-8000-00000000d101';
const CLERK = '01900000-0000-7000-8000-00000000d102';
const FOREIGN_USER = '01900000-0000-7000-8000-00000000d1f1';
let tdb: TestDatabase;
let db: Kysely<Database>;
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

const epoch = (user: string) =>
  inTenant(async (trx) => {
    const r = await trx
      .selectFrom('app.app_user')
      .select('session_epoch')
      .where('id', '=', user)
      .executeTakeFirstOrThrow();
    return r.session_epoch;
  });

const grant = (user: string, role: string, by: string | null = OWNER) =>
  inTenant((trx) =>
    trx
      .insertInto('app.user_role')
      .values({ user_id: user, role, granted_by: by })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 1);
  for (const [tenant, users] of [
    [T, [OWNER, CLERK]],
    [OTHER, [FOREIGN_USER]],
  ] as const) {
    await withTenant(db, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `Roles ${tenant}` })
        .execute();
      for (const u of users) {
        await trx
          .insertInto('app.app_user')
          .values({ id: u, email: `${u}@example.test`, display_name: 'U', status: 'active' })
          .execute();
      }
    });
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-49: Role assignments are tenant-scoped, never deleted, and revoke sessions', () => {
  it('a grant bumps the user session_epoch in the same transaction; so does a revoke', async () => {
    const e0 = await epoch(CLERK);
    const { id } = await grant(CLERK, 'ar_clerk');
    expect(await epoch(CLERK)).toBe(e0 + 1);
    await inTenant((trx) =>
      trx
        .updateTable('app.user_role')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: OWNER, revoke_reason: 'mover' })
        .where('id', '=', id)
        .execute(),
    );
    expect(await epoch(CLERK)).toBe(e0 + 2);
    // History is kept: the revoked row is still there.
    const rows = await inTenant((trx) =>
      trx.selectFrom('app.user_role').selectAll().where('id', '=', id).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoke_reason).toBe('mover');
  });

  it('a rolled-back grant leaves the epoch unchanged', async () => {
    const e0 = await epoch(CLERK);
    await expect(
      inTenant(async (trx) => {
        await trx.insertInto('app.user_role').values({ user_id: CLERK, role: 'auditor' }).execute();
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await epoch(CLERK)).toBe(e0);
  });

  it('refuses a revocation before its grant even when both timestamps use the database clock [T-0112]', async () => {
    const { id } = await grant(CLERK, 'ap_clerk');
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.user_role')
          .set({
            revoked_at: sql<Date>`granted_at - interval '1 millisecond'`,
            revoked_by: OWNER,
            revoke_reason: 'invalid chronology',
          })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a role that is not one of the ten templates', async () => {
    await expect(grant(CLERK, 'superuser')).rejects.toMatchObject({ code: '23514' });
    await expect(grant(CLERK, 'OWNER')).rejects.toMatchObject({ code: '23514' });
  });

  it('allows one active grant per user and role; a new grant after a revoke is allowed', async () => {
    await grant(CLERK, 'approver');
    await expect(grant(CLERK, 'approver')).rejects.toMatchObject({ code: '23505' });
    await inTenant((trx) =>
      trx
        .updateTable('app.user_role')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: OWNER, revoke_reason: 'test' })
        .where('user_id', '=', CLERK)
        .where('role', '=', 'approver')
        .where('revoked_at', 'is', null)
        .execute(),
    );
    await grant(CLERK, 'approver');
  });

  it('lf_app cannot delete a grant', async () => {
    const { id } = await grant(CLERK, 'payroll_officer');
    await expect(
      inTenant((trx) => sql`DELETE FROM app.user_role WHERE id = ${id}`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a grant cannot change role, user or grantor; a revoke cannot be undone or rewritten', async () => {
    const { id } = await grant(CLERK, 'accountant');
    for (const set of [sql`role = 'owner'`, sql`user_id = ${OWNER}`, sql`granted_by = ${CLERK}`]) {
      await expect(
        inTenant((trx) => sql`UPDATE app.user_role SET ${set} WHERE id = ${id}`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await inTenant((trx) =>
      trx
        .updateTable('app.user_role')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: OWNER, revoke_reason: 'leaver' })
        .where('id', '=', id)
        .execute(),
    );
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.user_role')
          .set({ revoked_at: null, revoked_by: null, revoke_reason: null })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.user_role')
          .set({ revoke_reason: 'rewritten' })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a grant is inserted active, with a revoke reason only when revoked', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.user_role')
          .values({ user_id: CLERK, role: 'auditor', revoked_at: new Date(), revoke_reason: 'x' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("refuses another tenant's user as grantee or grantor", async () => {
    await expect(grant(FOREIGN_USER, 'auditor')).rejects.toMatchObject({ code: '23503' });
    await expect(grant(CLERK, 'auditor', FOREIGN_USER)).rejects.toMatchObject({ code: '23503' });
  });

  it('role ids are known to the database through app.role_template_exists', async () => {
    const r = await inTenant((trx) =>
      sql<{
        ok: boolean;
        bad: boolean;
      }>`SELECT app.role_template_exists('ar_clerk') AS ok, app.role_template_exists('root') AS bad`.execute(
        trx,
      ),
    );
    expect(r.rows[0]).toEqual({ ok: true, bad: false });
  });
});
