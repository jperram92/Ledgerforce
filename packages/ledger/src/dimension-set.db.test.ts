/**
 * SS-PLAT-33 — dimension sets are deduplicated by a hash of their sorted pairs (design §3.3).
 * SS-PLAT-34 — required dimensions per account are checked, and dimension identity is stable.
 * T-0019. dimension_set is a ledger table, so its writer and this test live in packages/ledger.
 * Every statement runs as lf_app inside a tenant transaction.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import fc from 'fast-check';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { dimensionSetId, missingRequiredDimensions } from './dimension-set.ts';

const T = '01900000-0000-7000-8000-0000000004aa';
const OTHER = '01900000-0000-7000-8000-0000000004bb';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
/** dimension code → value code → value id */
const values: Record<string, Record<string, string>> = {};
let otherTenantValue: string;

const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);
const v = (dim: string, val: string): string => {
  const id = values[dim]?.[val];
  if (!id) throw new Error(`test fixture: no value ${dim}/${val}`);
  return id;
};

async function seedDimensions(
  trx: Transaction<Database>,
  company: string,
  dims: [code: string, slot: 1 | 2 | null, valueCodes: string[]][],
) {
  const out: Record<string, Record<string, string>> = {};
  for (const [code, slot, codes] of dims) {
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: company, code, name: code, primary_slot: slot })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rows = await trx
      .insertInto('app.dimension_value')
      .values(codes.map((c) => ({ company_id: company, dimension_id: d.id, code: c, name: c })))
      .returning(['id', 'code'])
      .execute();
    out[code] = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  }
  return out;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 4);
  await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    companyId = c.id;
    await loadChartTemplate(trx, companyId, auServicesSmb);
    Object.assign(
      values,
      await seedDimensions(trx, companyId, [
        ['department', 1, ['delivery', 'sales', 'admin']],
        ['location', 2, ['syd', 'mel', 'bne']],
        ['sales_team', null, ['enterprise', 'smb']],
        ['project', null, ['p100', 'p200', 'p300']],
      ]),
    );
  });
  otherTenantValue = await withTenant(db, OTHER, async (trx) => {
    await trx.insertInto('app.tenant').values({ id: OTHER, name: 'Other Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const d = await seedDimensions(trx, c.id, [['department', 1, ['delivery']]]);
    const id = d.department?.delivery;
    if (!id) throw new Error('seed failed');
    return id;
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-33: Dimension sets are deduplicated by a hash of their sorted pairs', () => {
  it('the same pairs in any order give the same set id (property)', async () => {
    const pool = [
      ['department', ['delivery', 'sales', 'admin']],
      ['location', ['syd', 'mel', 'bne']],
      ['sales_team', ['enterprise', 'smb']],
      ['project', ['p100', 'p200', 'p300']],
    ] as const;
    const pick = fc.tuple(
      ...pool.map(([dim, vals]) =>
        fc.option(fc.constantFrom(...vals.map((x) => v(dim, x))), { nil: undefined }),
      ),
    );
    // A combination, plus a genuine permutation of it (fc.shuffledSubarray at full length).
    const combinationAndPermutation = pick.chain((choice) => {
      const ids = choice.filter((x): x is string => x !== undefined);
      return fc.tuple(
        fc.constant(ids),
        fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
      );
    });
    let reordered = 0;
    await fc.assert(
      fc.asyncProperty(combinationAndPermutation, async ([ids, shuffled]) => {
        if (shuffled.join() !== ids.join()) reordered += 1;
        const [a, b] = await inTenant(async (trx) => [
          await dimensionSetId(trx, companyId, ids),
          await dimensionSetId(trx, companyId, shuffled),
        ]);
        expect(b).toBe(a);
      }),
      { numRuns: 40 },
    );
    expect(reordered, 'the property must actually exercise reordering').toBeGreaterThan(5);
  });

  it('different pairs give different sets, and each combination is stored once', async () => {
    const one = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [v('department', 'sales'), v('location', 'syd')]),
    );
    const two = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [v('department', 'sales'), v('location', 'mel')]),
    );
    expect(two).not.toBe(one);
    const again = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [v('location', 'syd'), v('department', 'sales')]),
    );
    expect(again).toBe(one);
    const rows = await inTenant((trx) =>
      trx
        .selectFrom('app.dimension_set')
        .select('hash')
        .where('company_id', '=', companyId)
        .execute(),
    );
    expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
  });

  it('the empty set is a real, single set (no NULL dimension keys)', async () => {
    const [a, b] = await inTenant(async (trx) => [
      await dimensionSetId(trx, companyId, []),
      await dimensionSetId(trx, companyId, []),
    ]);
    expect(a).toBe(b);
  });

  it('the two primary dimensions are copied into indexed columns', async () => {
    const id = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [
        v('project', 'p100'),
        v('location', 'bne'),
        v('department', 'admin'),
      ]),
    );
    const row = await inTenant((trx) =>
      trx
        .selectFrom('app.dimension_set')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.primary1_value_id).toBe(v('department', 'admin'));
    expect(row.primary2_value_id).toBe(v('location', 'bne'));
  });

  it('a set holds at most one value per dimension', async () => {
    await expect(
      inTenant((trx) =>
        dimensionSetId(trx, companyId, [v('department', 'sales'), v('department', 'admin')]),
      ),
    ).rejects.toThrow(/one value per dimension/);
  });

  it('a value from another tenant, an unknown value or a repeated value is refused', async () => {
    await expect(
      inTenant((trx) => dimensionSetId(trx, companyId, [otherTenantValue])),
    ).rejects.toThrow(/unknown dimension value/);
    await expect(
      inTenant((trx) => dimensionSetId(trx, companyId, ['01900000-0000-7000-8000-00000000dead'])),
    ).rejects.toThrow(/unknown dimension value/);
    await expect(
      inTenant((trx) =>
        dimensionSetId(trx, companyId, [v('location', 'syd'), v('location', 'syd')]),
      ),
    ).rejects.toThrow(/one value per dimension/);
  });

  it('a caller cannot store a forged hash or canonical form: the trigger recomputes them', async () => {
    const real = await inTenant((trx) => dimensionSetId(trx, companyId, [v('project', 'p200')]));
    const forged = await inTenant((trx) =>
      trx
        .insertInto('app.dimension_set')
        .values({ company_id: companyId, value_ids: [v('project', 'p200')], hash: 'f'.repeat(64) })
        .onConflict((oc) => oc.columns(['tenant_id', 'company_id', 'hash']).doNothing())
        .returning('id')
        .execute(),
    );
    expect(forged).toEqual([]); // recomputed hash collided with the real set: nothing stored
    const row = await inTenant((trx) =>
      trx
        .selectFrom('app.dimension_set')
        .select('hash')
        .where('id', '=', real)
        .executeTakeFirstOrThrow(),
    );
    expect(row.hash).not.toBe('f'.repeat(64));
  });

  it('sets are immutable and never deleted (lf_app has no UPDATE or DELETE)', async () => {
    const id = await inTenant((trx) => dimensionSetId(trx, companyId, [v('sales_team', 'smb')]));
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.dimension_set')
          .set({ primary1_value_id: null })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant((trx) => trx.deleteFrom('app.dimension_set').where('id', '=', id).execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('an archived value cannot be used in a new set', async () => {
    await inTenant((trx) =>
      trx
        .updateTable('app.dimension_value')
        .set({ status: 'archived' })
        .where('id', '=', v('project', 'p300'))
        .execute(),
    );
    await expect(
      inTenant((trx) => dimensionSetId(trx, companyId, [v('project', 'p300')])),
    ).rejects.toThrow(/archived/);
  });
});

describe('SS-PLAT-34: Required dimensions per account are enforced; dimension identity is stable', () => {
  const accountId = (code: string) =>
    inTenant((trx) =>
      trx.selectFrom('app.account').select('id').where('code', '=', code).executeTakeFirstOrThrow(),
    ).then((r) => r.id);

  it('reports the required dimensions a set is missing, by code', async () => {
    const revenue = await accountId('4110');
    await inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ required_dimensions: ['department', 'project'] })
        .where('id', '=', revenue)
        .execute(),
    );
    const partial = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [v('department', 'delivery')]),
    );
    const full = await inTenant((trx) =>
      dimensionSetId(trx, companyId, [v('project', 'p100'), v('department', 'delivery')]),
    );
    const empty = await inTenant((trx) => dimensionSetId(trx, companyId, []));
    expect(await inTenant((trx) => missingRequiredDimensions(trx, revenue, partial))).toEqual([
      'project',
    ]);
    expect(await inTenant((trx) => missingRequiredDimensions(trx, revenue, full))).toEqual([]);
    expect(await inTenant((trx) => missingRequiredDimensions(trx, revenue, empty))).toEqual([
      'department',
      'project',
    ]);
    const rent = await accountId('6200');
    expect(await inTenant((trx) => missingRequiredDimensions(trx, rent, empty))).toEqual([]);
  });

  it('an account cannot require a dimension the company does not have', async () => {
    const id = await accountId('6200');
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.account')
          .set({ required_dimensions: ['cost_centre'] })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/cost_centre/);
  });

  it('dimension codes and primary slots cannot change once created', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.dimension')
          .set({ code: 'dept' })
          .where('code', '=', 'department')
          .execute(),
      ),
    ).rejects.toThrow(/code/);
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.dimension')
          .set({ primary_slot: 1 })
          .where('code', '=', 'project')
          .execute(),
      ),
    ).rejects.toThrow(/primary_slot/);
  });

  it('a primary slot is taken by at most one dimension, and only slots 1 and 2 exist', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.dimension')
          .values({ company_id: companyId, code: 'region', name: 'Region', primary_slot: 1 })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique (tenant, company, primary_slot)
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.dimension')
          // Deliberately outside the type: proves the CHECK, not the compiler, refuses slot 3.
          .values({
            company_id: companyId,
            code: 'region',
            name: 'Region',
            primary_slot: sql<1>`3`,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('a dimension required by an active account cannot be archived', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.dimension')
          .set({ status: 'archived' })
          .where('code', '=', 'project')
          .execute(),
      ),
    ).rejects.toThrow(/4110/);
  });
});
