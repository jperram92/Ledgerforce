/**
 * T-0159 (ADR-0068): app.ar_settings.ecl_allowance_account_id is deprecated. The column stays
 * (migrations are additive), and migration 0066 records the deprecation in its comment so anyone
 * reading the schema learns that the AR_ECL_ALLOWANCE role is the source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/test-db.ts';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

describe('T-0159: deprecated ECL allowance setting', () => {
  it('the column is kept and its comment names the role and ADR-0068', async () => {
    const { rows } = await tdb.admin.query<{ comment: string | null }>(
      `SELECT col_description('app.ar_settings'::regclass, a.attnum) AS comment
         FROM pg_attribute a
        WHERE a.attrelid = 'app.ar_settings'::regclass AND a.attname = 'ecl_allowance_account_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment ?? '').toMatch(/deprecated/i);
    expect(rows[0]?.comment ?? '').toMatch(/AR_ECL_ALLOWANCE/);
    expect(rows[0]?.comment ?? '').toMatch(/ADR-0068/);
  });
});
