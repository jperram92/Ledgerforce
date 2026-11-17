/**
 * SS-PLAT-142 / T-0203 AC-1, AC-2 — the GST_ATTRIBUTED_UNBILLED role (ADR-0089 R3, RQ-0171) is an
 * extended role (migration 0073, ADR-0061 pattern): allowed on an asset account only, bound by the
 * AU services template to 1230 in app.account_system_role_ext, guarded like every bound account.
 * Runs as lf_app inside tenant transactions. Expected values come from ADR-0089, not the code.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChartTemplate } from './chart.ts';
import { auServicesSmb } from './templates.ts';

const T = '01900000-0000-7000-8000-000000020301';
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const ROLE = 'GST_ATTRIBUTED_UNBILLED';

let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const refused = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Unbilled Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Unbilled Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
}, 120_000);

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-142: GST_ATTRIBUTED_UNBILLED is an extended asset role bound to 1230', () => {
  it('SS-PLAT-142 AC-1 app.system_role_allows accepts an asset account only and the role is extended [T-0203]', async () => {
    for (const type of TYPES) {
      const r = await sql<{
        ok: boolean;
      }>`SELECT app.system_role_allows(${ROLE}, ${type}) AS ok`.execute(db);
      expect(r.rows[0]?.ok, type).toBe(type === 'asset');
    }
    const ext = await sql<{
      ext: boolean;
    }>`SELECT app.system_role_is_extended(${ROLE}) AS ext`.execute(db);
    expect(ext.rows[0]?.ext).toBe(true);
  });

  it('SS-PLAT-142 AC-2 loading the template binds the role to 1230 in the additive table [T-0203]', async () => {
    const r = await inTenant((trx) =>
      sql<{ code: string; name: string; is_control: boolean; postable: boolean }>`
        SELECT a.code, a.name, a.is_control, a.postable FROM app.account_system_role_ext b
          JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
         WHERE b.company_id = ${companyId}::uuid AND b.role = ${ROLE}`.execute(trx),
    );
    expect(r.rows).toEqual([
      {
        code: '1230',
        name: 'GST attributed on unbilled supplies',
        is_control: false,
        postable: true,
      },
    ]);
  });

  it('SS-PLAT-142 AC-1 the bound account cannot be re-typed to a liability or archived, and the role cannot go to the core table [T-0203]', async () => {
    const id = (
      await inTenant((trx) =>
        trx
          .selectFrom('app.account')
          .select('id')
          .where('code', '=', '1230')
          .executeTakeFirstOrThrow(),
      )
    ).id;
    for (const change of [{ type: 'liability' as const }, { status: 'archived' as const }]) {
      const e = await refused(
        inTenant((trx) =>
          trx.updateTable('app.account').set(change).where('id', '=', id).execute(),
        ),
      );
      expect(e?.message ?? 'accepted', JSON.stringify(change)).toMatch(
        /bound to system role GST_ATTRIBUTED_UNBILLED/,
      );
    }
    const core = await refused(
      inTenant((trx) =>
        sql`INSERT INTO app.account_system_role (company_id, role, account_id)
            VALUES (${companyId}::uuid, ${ROLE}, ${id}::uuid)`.execute(trx),
      ),
    );
    expect(core?.code).toBe('23514');
  });
});
