/**
 * SS-PLAT-47 — a company's ABN must pass the ABR checksum (T-0107, RQ-0017), the same rule as a
 * party's (migration 0011). Checked as lf_app inside a tenant transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely, Transaction } from 'kysely';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const T = '01900000-0000-7000-8000-000000000caa';
let tdb: TestDatabase;
let db: Kysely<Database>;
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 1);
  await inTenant((trx) =>
    trx.insertInto('app.tenant').values({ id: T, name: 'ABN Pty Ltd' }).execute(),
  );
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-47: A company ABN must pass the ABR checksum', () => {
  it('accepts a valid ABN and no ABN', async () => {
    await inTenant((trx) =>
      trx
        .insertInto('app.company')
        .values([
          { name: 'Valid ABN Pty Ltd', base_currency: 'AUD', abn: '51824753556' },
          { name: 'No ABN Ltd', base_currency: 'AUD', abn: null },
        ])
        .execute(),
    );
  });

  it('refuses an 11-digit ABN that fails the checksum, on insert and on update', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.company')
          .values({ name: 'Bad ABN Pty Ltd', base_currency: 'AUD', abn: '74625118903' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.company')
          .set({ abn: '51824753557' })
          .where('name', '=', 'Valid ABN Pty Ltd')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
