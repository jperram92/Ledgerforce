/**
 * T-0117 / ADR-0061 — the seven period-end system roles (design §3.2 AASB note, §3.10) are bound
 * in the additive table app.account_system_role_ext (migration 0062) with the same database
 * guards as the core roles, and every reader sees both tables through the security_invoker view
 * app.account_role_binding. Runs as lf_app inside tenant transactions, as the API does.
 * Expected codes and types come from the AU services template and RQ-0143, not from the code.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChartTemplate } from './chart.ts';
import { auServicesSmb } from './templates.ts';

const T = '01900000-0000-7000-8000-000000011701';
const OTHER = '01900000-0000-7000-8000-000000011702';
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

/** Role → template account code and the one account type it allows (RQ-0143). */
const PERIOD_END: Record<string, { code: string; type: (typeof TYPES)[number] }> = {
  AR_ECL_ALLOWANCE: { code: '1220', type: 'asset' },
  PREPAYMENTS: { code: '1300', type: 'asset' },
  ACCUM_DEPRECIATION: { code: '1510', type: 'asset' },
  DEPRECIATION_EXPENSE: { code: '6600', type: 'expense' },
  ACCRUED_EXPENSES: { code: '2360', type: 'liability' },
  SGC_PAYABLE: { code: '2370', type: 'liability' },
  PRIOR_PERIOD_ADJUSTMENTS: { code: '3400', type: 'equity' },
};
const CORE_COUNT = 17;

let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2], tenant = T) =>
  withTenant(db, tenant, fn);
const accountId = (code: string) =>
  inTenant((trx) =>
    trx.selectFrom('app.account').select('id').where('code', '=', code).executeTakeFirstOrThrow(),
  ).then((r) => r.id);
const refused = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Period End Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Period End Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
  await inTenant(
    (trx) => trx.insertInto('app.tenant').values({ id: OTHER, name: 'Other Pty Ltd' }).execute(),
    OTHER,
  );
}, 120_000);

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('ADR-0061: period-end system roles are bound and guarded by the database', () => {
  it('AC-2 loading the template binds the seven period-end roles in the additive table [T-0117]', async () => {
    const r = await inTenant((trx) =>
      sql<{ role: string; code: string }>`
        SELECT b.role, a.code FROM app.account_system_role_ext b
          JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
         WHERE b.company_id = ${companyId} ORDER BY b.role`.execute(trx),
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.role, x.code]))).toEqual(
      Object.fromEntries(Object.entries(PERIOD_END).map(([role, v]) => [role, v.code])),
    );
    const core = await inTenant((trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM app.account_system_role`.execute(trx),
    );
    expect(core.rows[0]?.n).toBe(CORE_COUNT);
  });

  it('AC-2 the account_role_binding view returns every core and period-end binding once [T-0117]', async () => {
    const r = await inTenant((trx) =>
      sql<{ role: string; n: number }>`
        SELECT role, count(*)::int AS n FROM app.account_role_binding
         WHERE company_id = ${companyId} GROUP BY role`.execute(trx),
    );
    expect(r.rows).toHaveLength(CORE_COUNT + Object.keys(PERIOD_END).length);
    expect(r.rows.every((x) => x.n === 1)).toBe(true);
    for (const role of Object.keys(PERIOD_END)) {
      expect(
        r.rows.map((x) => x.role),
        role,
      ).toContain(role);
    }
  });

  it('AC-2 app.system_role_allows gives each period-end role exactly its researched type [T-0117]', async () => {
    for (const [role, { type: want }] of Object.entries(PERIOD_END)) {
      for (const type of TYPES) {
        const r = await sql<{
          ok: boolean;
        }>`SELECT app.system_role_allows(${role}, ${type}) AS ok`.execute(db);
        expect(r.rows[0]?.ok, `${role}/${type}`).toBe(type === want);
      }
    }
  });

  it('AC-2 a period-end bound account cannot be archived, made non-postable, made control or re-typed [T-0117]', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['1510', 'ACCUM_DEPRECIATION', { status: 'archived' }],
      ['3400', 'PRIOR_PERIOD_ADJUSTMENTS', { postable: false }],
      ['2360', 'ACCRUED_EXPENSES', { is_control: true }],
      ['6600', 'DEPRECIATION_EXPENSE', { type: 'revenue' }],
      ['1220', 'AR_ECL_ALLOWANCE', { type: 'liability' }],
    ];
    for (const [code, role, change] of cases) {
      const id = await accountId(code);
      const e = await refused(
        inTenant((trx) =>
          trx.updateTable('app.account').set(change).where('id', '=', id).execute(),
        ),
      );
      expect(e?.message ?? 'accepted (no error)', `${code} ${JSON.stringify(change)}`).toMatch(
        new RegExp(`bound to system role ${role}`),
      );
    }
  });

  it('AC-2 a period-end role re-binds only to an account of its type [T-0117]', async () => {
    const liability = await accountId('2500');
    const wrong = await refused(
      inTenant((trx) =>
        sql`UPDATE app.account_system_role_ext SET account_id = ${liability}::uuid
             WHERE role = 'PREPAYMENTS'`.execute(trx),
      ),
    );
    expect(wrong?.message).toMatch(/system role PREPAYMENTS: type liability is not allowed/);

    // Positive control: a second asset account takes the binding, then the original again.
    const original = await accountId('1300');
    const other = await inTenant((trx) =>
      trx
        .insertInto('app.account')
        .values({
          company_id: companyId,
          code: '1310',
          name: 'Prepaid insurance',
          type: 'asset',
          subtype: 'current_asset',
          normal_balance: 'debit',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const bound = async () =>
      (
        await inTenant((trx) =>
          sql<{ account_id: string }>`SELECT account_id::text FROM app.account_role_binding
                                       WHERE role = 'PREPAYMENTS'`.execute(trx),
        )
      ).rows.map((x) => x.account_id);
    await inTenant((trx) =>
      sql`UPDATE app.account_system_role_ext SET account_id = ${other.id}::uuid
           WHERE role = 'PREPAYMENTS'`.execute(trx),
    );
    expect(await bound()).toEqual([other.id]);
    await inTenant((trx) =>
      sql`UPDATE app.account_system_role_ext SET account_id = ${original}::uuid
           WHERE role = 'PREPAYMENTS'`.execute(trx),
    );
    expect(await bound()).toEqual([original]);
  });

  it('AC-2 the additive table refuses core roles, unknown roles and a second binding [T-0117]', async () => {
    const acct = await accountId('1020');
    const insert = (role: string) =>
      refused(
        inTenant((trx) =>
          sql`INSERT INTO app.account_system_role_ext (company_id, role, account_id)
              VALUES (${companyId}::uuid, ${role}, ${acct}::uuid)`.execute(trx),
        ),
      );
    expect((await insert('UNDEPOSITED_FUNDS'))?.code).toBe('23514');
    expect((await insert('NOT_A_ROLE'))?.code).toBe('23514');
    expect((await insert('PREPAYMENTS'))?.code).toBe('23505');
    for (const role of Object.keys(PERIOD_END)) {
      const r = await sql<{
        ext: boolean;
      }>`SELECT app.system_role_is_extended(${role}) AS ext`.execute(db);
      expect(r.rows[0]?.ext, role).toBe(true);
    }
    // No role lives in both tables: every core role bound by the template is not extended.
    const core = await tdb.admin.query<{ role: string; ext: boolean }>(
      `SELECT role, app.system_role_is_extended(role) AS ext FROM app.account_system_role
        WHERE tenant_id = $1 AND company_id = $2`,
      [T, companyId],
    );
    expect(core.rows).toHaveLength(CORE_COUNT);
    expect(core.rows.filter((x) => x.ext)).toEqual([]);
  });

  it('AC-2 lf_app cannot delete period-end bindings (nothing is deleted) [T-0117]', async () => {
    const e = await refused(
      inTenant((trx) =>
        sql`DELETE FROM app.account_system_role_ext WHERE role = 'SGC_PAYABLE'`.execute(trx),
      ),
    );
    expect(e?.code).toBe('42501');
  });

  it('AC-2 the additive table forces RLS and the view is security_invoker, so another tenant sees nothing [T-0117]', async () => {
    const meta = await tdb.admin.query<{ rls: boolean; force: boolean; invoker: boolean }>(
      `SELECT t.relrowsecurity AS rls, t.relforcerowsecurity AS force,
              coalesce('security_invoker=true' = ANY(v.reloptions), false) AS invoker
         FROM pg_class t, pg_class v
        WHERE t.oid = 'app.account_system_role_ext'::regclass
          AND v.oid = 'app.account_role_binding'::regclass`,
    );
    expect(meta.rows[0]).toEqual({ rls: true, force: true, invoker: true });
    const seen = await inTenant(
      (trx) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM app.account_role_binding`.execute(trx),
      OTHER,
    );
    expect(seen.rows[0]?.n).toBe(0);
    const own = await inTenant((trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM app.account_role_binding`.execute(trx),
    );
    expect(own.rows[0]?.n).toBe(CORE_COUNT + Object.keys(PERIOD_END).length);
  });
});
