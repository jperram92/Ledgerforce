/**
 * Re-binding a system role (T-0146, design §3.2: roles are re-bound, never unbound; ADR-0061)
 * against a real PostgreSQL as lf_app. A core role (app.account_system_role) and a period-end role
 * (app.account_system_role_ext) each move to another account, and app.account_role_binding shows the
 * new account. A disallowed type, an archived account or a non-postable account is refused with
 * the database's own message, and the binding is unchanged.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChartTemplate } from './chart.ts';
import { rebindSystemRole, RebindError } from './rebind.ts';
import { auServicesSmb } from './templates.ts';

const T = '01900000-0000-7000-8000-000000014601';

let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId = '';
let otherCompanyId = '';
let spareExpense = '';
let archivedExpense = '';
let headerExpense = '';
let assetAccount = '';
let otherCompanyExpense = '';

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const boundTo = (role: string) =>
  inTenant(
    async (trx) =>
      (
        await sql<{ account_id: string }>`
          SELECT account_id::text FROM app.account_role_binding
           WHERE company_id = ${companyId} AND role = ${role}`.execute(trx)
      ).rows[0]?.account_id,
  );
const rebind = (role: string, accountId: string) =>
  inTenant((trx) => rebindSystemRole(trx, { companyId, role, accountId }));

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Rebind Pty Ltd' }).execute();
    for (const name of ['Rebind Pty Ltd', 'Sister Pty Ltd']) {
      const c = await trx
        .insertInto('app.company')
        .values({ name, base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await loadChartTemplate(trx, c.id, auServicesSmb);
      if (!companyId) companyId = c.id;
      else otherCompanyId = c.id;
    }
  });
  const add = async (company: string, code: string, cols: string, vals: string) =>
    (
      await tdb.admin.query<{ id: string }>(
        `INSERT INTO app.account (tenant_id, company_id, code, name, type, subtype, normal_balance${cols})
         VALUES ($1, $2, $3, $4, 'expense', 'operating_expense', 'debit'${vals}) RETURNING id`,
        [T, company, code, `Spare ${code}`],
      )
    ).rows[0]?.id ?? '';
  spareExpense = await add(companyId, '6990', '', '');
  archivedExpense = await add(companyId, '6991', ', status', ", 'archived'");
  headerExpense = await add(companyId, '6992', ', postable', ', false');
  otherCompanyExpense = await add(otherCompanyId, '6990', '', '');
  assetAccount =
    (
      await tdb.admin.query<{ id: string }>(
        `SELECT id FROM app.account WHERE company_id = $1 AND code = '1500'`,
        [companyId],
      )
    ).rows[0]?.id ?? '';
}, 120_000);

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('T-0146: re-bind a system role', () => {
  it('AC-1 a core role (ROUNDING) moves to another account; the view shows it', async () => {
    const before = await boundTo('ROUNDING');
    const r = await rebind('ROUNDING', spareExpense);
    expect(r).toMatchObject({
      role: 'ROUNDING',
      previousAccountId: before,
      accountId: spareExpense,
      changed: true,
    });
    expect(await boundTo('ROUNDING')).toBe(spareExpense);
  });

  it('AC-1 a period-end role (DEPRECIATION_EXPENSE) moves too (extended binding table)', async () => {
    const r = await rebind('DEPRECIATION_EXPENSE', spareExpense);
    expect(r.changed).toBe(true);
    expect(await boundTo('DEPRECIATION_EXPENSE')).toBe(spareExpense);
    const ext = await tdb.admin.query<{ account_id: string }>(
      `SELECT account_id::text FROM app.account_system_role_ext
        WHERE company_id = $1 AND role = 'DEPRECIATION_EXPENSE'`,
      [companyId],
    );
    expect(ext.rows[0]?.account_id).toBe(spareExpense);
  });

  it('re-binding to the account it already has changes nothing and says so', async () => {
    const r = await rebind('ROUNDING', spareExpense);
    expect(r.changed).toBe(false);
  });

  it('AC-2 a disallowed type, an archived or a non-postable account is refused; nothing changes', async () => {
    for (const [account, msg] of [
      [assetAccount, /type asset is not allowed/],
      [archivedExpense, /must stay active/],
      [headerExpense, /must be/],
    ] as const) {
      await expect(rebind('ROUNDING', account)).rejects.toMatchObject({
        code: 'REBIND_REFUSED',
        message: expect.stringMatching(msg),
      });
      expect(await boundTo('ROUNDING')).toBe(spareExpense);
    }
  });

  it('an unknown role, or an account of another company, is refused', async () => {
    await expect(rebind('NOT_A_ROLE', spareExpense)).rejects.toMatchObject({
      code: 'UNKNOWN_ROLE',
    });
    await expect(rebind('ROUNDING', otherCompanyExpense)).rejects.toBeInstanceOf(RebindError);
    await expect(rebind('ROUNDING', otherCompanyExpense)).rejects.toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
    });
  });
});
