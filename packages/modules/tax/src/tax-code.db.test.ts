/**
 * T-0034 — effective-dated tax codes and the company tax-rounding setting (design §3.4, §3.6,
 * migration 0031). Every check runs as lf_app inside a tenant transaction, as the API would.
 * Cross-tenant isolation of app.tax_code is covered by the generated suite (packages/db
 * rls.db.test.ts), which discovers every tenant_id table.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auTaxCodes,
  findTaxCode,
  getTaxRounding,
  loadTaxCodes,
  TaxCodeNotFoundError,
} from './tax-codes.ts';

const T = '01900000-0000-7000-8000-0000000034aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
let bareCompanyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const accountId = (code: string) =>
  inTenant((trx) =>
    trx
      .selectFrom('app.account')
      .select('id')
      .where('company_id', '=', companyId)
      .where('code', '=', code)
      .executeTakeFirstOrThrow(),
  ).then((r) => r.id);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  [companyId, bareCompanyId] = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const rows = await trx
      .insertInto('app.company')
      .values([
        { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
        { name: 'No Chart Pty Ltd', base_currency: 'AUD' },
      ])
      .returning('id')
      .execute();
    const [a, b] = rows.map((r) => r.id);
    if (!a || !b) throw new Error('companies not created');
    return [a, b];
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
  await inTenant((trx) => loadTaxCodes(trx, companyId, auTaxCodes));
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('company tax_rounding setting (design §3.4)', () => {
  it('defaults to per_line (AU default)', async () => {
    expect(await inTenant((trx) => getTaxRounding(trx, companyId))).toBe('per_line');
  });

  it('accepts per_document and refuses any other value', async () => {
    await inTenant((trx) =>
      trx
        .updateTable('app.company')
        .set({ tax_rounding: 'per_document' })
        .where('id', '=', bareCompanyId)
        .execute(),
    );
    expect(await inTenant((trx) => getTaxRounding(trx, bareCompanyId))).toBe('per_document');
    await expect(
      inTenant((trx) =>
        sql`UPDATE app.company SET tax_rounding = 'nearest' WHERE id = ${companyId}`.execute(trx),
      ),
    ).rejects.toThrow(/company_tax_rounding_check|check constraint/);
  });
});

describe('AU tax codes (design §3.6)', () => {
  it('loads the six AU codes with their kinds, rates and roles', async () => {
    const rows = await inTenant((trx) =>
      trx
        .selectFrom('app.tax_code')
        .select(['code', 'kind', 'rate', 'collected_role', 'paid_role', 'valid_from', 'valid_to'])
        .where('company_id', '=', companyId)
        .orderBy('code')
        .execute(),
    );
    expect(
      rows.map((r) => [r.code, r.kind, r.rate, r.collected_role, r.paid_role, r.valid_to]),
    ).toEqual([
      ['CAP', 'capital', '0.10000000', null, 'GST_PAID', null],
      ['FRE', 'gst_free', '0.00000000', null, null, null],
      ['GST', 'taxable', '0.10000000', 'GST_COLLECTED', 'GST_PAID', null],
      ['IMP', 'imports', '0.10000000', null, 'GST_PAID', null],
      ['INP', 'input_taxed', '0.00000000', null, null, null],
      ['N-T', 'bas_excluded', '0.00000000', null, null, null],
    ]);
  });

  it('resolves GST on a date to its rate and the accounts bound to GST_COLLECTED / GST_PAID', async () => {
    const gst = await inTenant((trx) =>
      findTaxCode(trx, { companyId, code: 'GST', on: '2026-11-05' }),
    );
    expect(gst.rate).toBe('0.10000000');
    expect(gst.kind).toBe('taxable');
    expect(gst.collectedAccountId).toBe(await accountId('2310'));
    expect(gst.paidAccountId).toBe(await accountId('1820'));
  });

  it('a zero-rated code resolves with no tax accounts', async () => {
    const fre = await inTenant((trx) =>
      findTaxCode(trx, { companyId, code: 'FRE', on: '2026-11-05' }),
    );
    expect([fre.rate, fre.collectedAccountId, fre.paidAccountId]).toEqual([
      '0.00000000',
      null,
      null,
    ]);
  });

  it('no code exists before GST started (2000-07-01)', async () => {
    await expect(
      inTenant((trx) => findTaxCode(trx, { companyId, code: 'GST', on: '2000-06-30' })),
    ).rejects.toBeInstanceOf(TaxCodeNotFoundError);
  });
});

describe('effective dating', () => {
  it('a rate change is a new row: closing the old one and adding the next resolves by date', async () => {
    await inTenant(async (trx) => {
      await trx
        .updateTable('app.tax_code')
        .set({ valid_to: '2029-12-31' })
        .where('company_id', '=', companyId)
        .where('code', '=', 'CAP')
        .execute();
      await trx
        .insertInto('app.tax_code')
        .values({
          company_id: companyId,
          code: 'CAP',
          name: 'GST on capital acquisitions',
          kind: 'capital',
          rate: '0.15',
          paid_role: 'GST_PAID',
          valid_from: '2030-01-01',
        })
        .execute();
    });
    const before = await inTenant((trx) =>
      findTaxCode(trx, { companyId, code: 'CAP', on: '2029-12-31' }),
    );
    const after = await inTenant((trx) =>
      findTaxCode(trx, { companyId, code: 'CAP', on: '2030-01-01' }),
    );
    expect([before.rate, after.rate]).toEqual(['0.10000000', '0.15000000']);
    expect(before.id).not.toBe(after.id);
  });

  it('refuses a version that overlaps an existing one for the same code', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.tax_code')
          .values({
            company_id: companyId,
            code: 'GST',
            name: 'GST 12%',
            kind: 'taxable',
            rate: '0.12',
            collected_role: 'GST_COLLECTED',
            paid_role: 'GST_PAID',
            valid_from: '2026-01-01',
          })
          .execute(),
      ),
    ).rejects.toThrow(/tax code GST overlaps/);
  });

  it('refuses valid_to before valid_from', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.tax_code')
          .set({ valid_to: '1999-01-01' })
          .where('company_id', '=', companyId)
          .where('code', '=', 'FRE')
          .execute(),
      ),
    ).rejects.toThrow(/tax_code_valid_range|check constraint/);
  });

  it('only valid_to and name may change: rate, kind, code, roles and valid_from are fixed', async () => {
    for (const set of [
      { rate: '0.11' },
      { kind: 'capital' },
      { code: 'GST2' },
      { valid_from: '2001-01-01' },
      { paid_role: null },
    ] as const) {
      await expect(
        inTenant((trx) =>
          trx
            .updateTable('app.tax_code')
            .set(set)
            .where('company_id', '=', companyId)
            .where('code', '=', 'GST')
            .execute(),
        ),
      ).rejects.toThrow(/tax code GST: only valid_to and name can change/);
    }
  });

  it('lf_app cannot delete a tax code', async () => {
    await expect(
      inTenant((trx) =>
        trx.deleteFrom('app.tax_code').where('company_id', '=', companyId).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('rate, kind and account bindings agree', () => {
  const base = { name: 'x', valid_from: '2026-01-01' } as const;
  const insert = (company: string, v: Record<string, unknown>) =>
    inTenant((trx) =>
      trx
        .insertInto('app.tax_code')
        .values({ company_id: company, ...base, ...v } as never)
        .execute(),
    );

  it('a taxable code needs a positive rate', async () => {
    await expect(
      insert(companyId, {
        code: 'GZ',
        kind: 'taxable',
        rate: '0',
        collected_role: 'GST_COLLECTED',
        paid_role: 'GST_PAID',
      }),
    ).rejects.toThrow(/tax_code_rate_kind|check constraint/);
  });

  it('a zero-rated kind cannot carry a rate or tax accounts', async () => {
    await expect(insert(companyId, { code: 'FZ', kind: 'gst_free', rate: '0.1' })).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      insert(companyId, { code: 'FY', kind: 'gst_free', rate: '0', paid_role: 'GST_PAID' }),
    ).rejects.toThrow(/check constraint/);
  });

  it('a taxed code needs at least one tax account role', async () => {
    await expect(insert(companyId, { code: 'GX', kind: 'taxable', rate: '0.1' })).rejects.toThrow(
      /check constraint/,
    );
  });

  it('imports and capital acquisitions are purchase-only (no collected account)', async () => {
    await expect(
      insert(companyId, {
        code: 'IX',
        kind: 'imports',
        rate: '0.1',
        collected_role: 'GST_COLLECTED',
        paid_role: 'GST_PAID',
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it('roles must be the GST system roles', async () => {
    await expect(
      insert(companyId, { code: 'GW', kind: 'taxable', rate: '0.1', collected_role: 'ROUNDING' }),
    ).rejects.toThrow(/check constraint/);
  });

  it('a role must already be bound to an account of the company', async () => {
    await expect(
      insert(bareCompanyId, {
        code: 'GST',
        kind: 'taxable',
        rate: '0.1',
        collected_role: 'GST_COLLECTED',
        paid_role: 'GST_PAID',
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
