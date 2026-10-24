/**
 * SS-PLAT-31 — system-role accounts are protected by the database (T-0018, design §3.2).
 * Every check runs as lf_app, inside a tenant transaction, exactly as the API would.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChartTemplate } from './chart.ts';
import { ROLE_ACCOUNT_TYPES, SYSTEM_ROLES } from './system-roles.ts';
import { auServicesSmb } from './templates.ts';

const T = '01900000-0000-7000-8000-0000000003aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const accountId = (code: string) =>
  inTenant((trx) =>
    trx.selectFrom('app.account').select('id').where('code', '=', code).executeTakeFirstOrThrow(),
  ).then((r) => r.id);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD', abn: '74625118903' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-31: System-role accounts are protected by the database', () => {
  it('loading the template creates every account and binds all 17 roles once', async () => {
    const [accounts, roles] = await inTenant((trx) =>
      Promise.all([
        trx
          .selectFrom('app.account')
          .select(sql<number>`count(*)::int`.as('n'))
          .executeTakeFirstOrThrow(),
        trx.selectFrom('app.account_system_role').select(['role']).execute(),
      ]),
    );
    expect(accounts.n).toBe(auServicesSmb.accounts.length);
    expect(roles.map((r) => r.role).sort()).toEqual([...SYSTEM_ROLES].sort());
  });

  it('a bound account cannot be archived', async () => {
    const id = await accountId('1200');
    await expect(
      inTenant((trx) =>
        trx.updateTable('app.account').set({ status: 'archived' }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/system role AR_CONTROL/);
  });

  it('a bound account cannot be made non-postable', async () => {
    const id = await accountId('2310');
    await expect(
      inTenant((trx) =>
        trx.updateTable('app.account').set({ postable: false }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/system role GST_COLLECTED/);
  });

  it('a bound account cannot change to a type its role does not allow', async () => {
    const id = await accountId('1200');
    await expect(
      inTenant((trx) =>
        trx.updateTable('app.account').set({ type: 'liability' }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/AR_CONTROL/);
  });

  it('a role can only be re-bound to an account of an allowed type', async () => {
    const liability = await accountId('2500');
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.account_system_role')
          .set({ account_id: liability })
          .where('role', '=', 'GST_PAID')
          .execute(),
      ),
    ).rejects.toThrow(/GST_PAID/);
  });

  it('a role cannot be bound twice in one company', async () => {
    const other = await accountId('1020');
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.account_system_role')
          .values({ company_id: companyId, role: 'AR_CONTROL', account_id: other })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('control accounts must carry the control flag (and only control roles may bind them)', async () => {
    const ar = await accountId('1200');
    await expect(
      inTenant((trx) =>
        trx.updateTable('app.account').set({ is_control: false }).where('id', '=', ar).execute(),
      ),
    ).rejects.toThrow(/control/);
  });

  it('an unbound account can be archived (positive control)', async () => {
    const id = await accountId('6800');
    await inTenant((trx) =>
      trx.updateTable('app.account').set({ status: 'archived' }).where('id', '=', id).execute(),
    );
    const row = await inTenant((trx) =>
      trx.selectFrom('app.account').select('status').where('id', '=', id).executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('archived');
  });

  it('lf_app cannot delete accounts or role bindings (nothing is deleted)', async () => {
    await expect(
      inTenant((trx) => trx.deleteFrom('app.account').where('code', '=', '6700').execute()),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant((trx) =>
        trx.deleteFrom('app.account_system_role').where('role', '=', 'SUSPENSE').execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the database role/type rule matches the TypeScript ROLE_ACCOUNT_TYPES map', async () => {
    for (const role of SYSTEM_ROLES) {
      for (const type of ['asset', 'liability', 'equity', 'revenue', 'expense'] as const) {
        const r = await sql<{
          ok: boolean;
        }>`SELECT app.system_role_allows(${role}, ${type}) AS ok`.execute(db);
        expect(r.rows[0]?.ok, `${role}/${type}`).toBe(ROLE_ACCOUNT_TYPES[role].includes(type));
      }
    }
  });
});
