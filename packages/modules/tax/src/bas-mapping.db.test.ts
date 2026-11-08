/**
 * T-0035 — BAS label mapping as data (design §3.6, migration 0036, RQ-0102, DL-0257).
 *
 * SS-PLAT-110: the AU template's new codes (ADJ-BD bad-debt decreasing adjustment, EXP GST-free
 * exports, BAS-W1/BAS-W2 PAYG labels) and the effective-dated tax-code → BAS label map are held by
 * the database: kinds and labels are constrained, versions never overlap, history is fixed, the
 * company GST basis is a setting, and lf_app can never delete. Every check runs as lf_app inside a
 * tenant transaction. Cross-tenant isolation of app.bas_label_map is covered by the generated
 * suite (packages/db rls.db.test.ts), which discovers every tenant_id table.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basLabelMap, getGstBasis } from './bas-report.ts';
import { auTaxCodes, findTaxCode, loadTaxCodes } from './tax-codes.ts';

const T = '01900000-0000-7000-8000-0000000035aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
let otherCompanyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const roleAccount = (role: string) =>
  inTenant((trx) =>
    trx
      .selectFrom('app.account_system_role')
      .select('account_id')
      .where('company_id', '=', companyId)
      .where('role', '=', role)
      .executeTakeFirstOrThrow(),
  ).then((r) => r.account_id);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  [companyId, otherCompanyId] = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const rows = await trx
      .insertInto('app.company')
      .values([
        { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
        { name: 'Second Co Pty Ltd', base_currency: 'AUD' },
      ])
      .returning('id')
      .execute();
    const [a, b] = rows.map((r) => r.id);
    if (!a || !b) throw new Error('companies not created');
    return [a, b];
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
  await inTenant((trx) => loadTaxCodes(trx, companyId, auTaxCodes));
  await inTenant((trx) => loadChartTemplate(trx, otherCompanyId, auServicesSmb));
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-110 new AU tax codes (RQ-0095 Q3, RQ-0102 finding 6)', () => {
  it('ADJ-BD is a 10 % bad-debt decreasing adjustment posting to GST collected (DL-0257)', async () => {
    const adj = await inTenant((trx) =>
      findTaxCode(trx, { companyId, code: 'ADJ-BD', on: '2027-12-01' }),
    );
    expect([adj.kind, adj.rate, adj.paidAccountId]).toEqual([
      'adjustment_decreasing',
      '0.10000000',
      null,
    ]);
    expect(adj.collectedAccountId).toBe(await roleAccount('GST_COLLECTED'));
  });

  it('EXP is GST-free exports; BAS-W1 / BAS-W2 are PAYG reporting codes without tax', async () => {
    const got = [];
    for (const code of ['EXP', 'BAS-W1', 'BAS-W2']) {
      const c = await inTenant((trx) => findTaxCode(trx, { companyId, code, on: '2027-07-14' }));
      got.push([c.code, c.kind, c.rate, c.collectedAccountId, c.paidAccountId]);
    }
    expect(got).toEqual([
      ['EXP', 'gst_free', '0.00000000', null, null],
      ['BAS-W1', 'payg_withholding', '0.00000000', null, null],
      ['BAS-W2', 'payg_withholding', '0.00000000', null, null],
    ]);
  });

  it('a subkind must agree with the stored kind, rate and roles (refused 23514)', async () => {
    const insert = (v: Record<string, unknown>) =>
      inTenant((trx) =>
        trx
          .insertInto('app.tax_code')
          .values({ company_id: companyId, name: 'x', valid_from: '2026-01-01', ...v } as never)
          .execute(),
      );
    // adjustment_decreasing needs kind taxable, a rate and the collected role only
    await expect(
      insert({ code: 'ADJ-X', kind: 'gst_free', rate: '0', subkind: 'adjustment_decreasing' }),
    ).rejects.toThrow(/tax_code_subkind_kind|check constraint/);
    await expect(
      insert({
        code: 'ADJ-Y',
        kind: 'taxable',
        rate: '0.1',
        paid_role: 'GST_PAID',
        subkind: 'adjustment_decreasing',
      }),
    ).rejects.toThrow(/tax_code_subkind_kind|check constraint/);
    // payg_withholding is stored as bas_excluded (no GST)
    await expect(
      insert({
        code: 'W-X',
        kind: 'taxable',
        rate: '0.1',
        collected_role: 'GST_COLLECTED',
        subkind: 'payg_withholding',
      }),
    ).rejects.toThrow(/tax_code_subkind_kind|check constraint/);
    await expect(
      insert({ code: 'W-Y', kind: 'bas_excluded', rate: '0', subkind: 'reverse_charge' }),
    ).rejects.toThrow(/check constraint/);
  });

  it('the subkind is history: it cannot change after insert', async () => {
    for (const subkind of [null, 'payg_withholding']) {
      await expect(
        inTenant((trx) =>
          trx
            .updateTable('app.tax_code')
            .set({ subkind } as never)
            .where('company_id', '=', companyId)
            .where('code', '=', subkind === null ? 'ADJ-BD' : 'N-T')
            .execute(),
        ),
      ).rejects.toThrow(/only valid_to and name can change/);
    }
  });
});

describe('SS-PLAT-110 company GST basis setting (design §3.6)', () => {
  it('defaults to accruals, accepts cash, refuses anything else', async () => {
    expect(await inTenant((trx) => getGstBasis(trx, companyId))).toBe('accruals');
    await inTenant((trx) =>
      trx
        .updateTable('app.company')
        .set({ gst_basis: 'cash' } as never)
        .where('id', '=', otherCompanyId)
        .execute(),
    );
    expect(await inTenant((trx) => getGstBasis(trx, otherCompanyId))).toBe('cash');
    await expect(
      inTenant((trx) =>
        sql`UPDATE app.company SET gst_basis = 'hybrid' WHERE id = ${companyId}`.execute(trx),
      ),
    ).rejects.toThrow(/company_gst_basis_check|check constraint/);
  });
});

describe('SS-PLAT-110 BAS label map (design §3.6, RQ-0102 finding 1)', () => {
  it('the AU template maps every code to its BAS labels', async () => {
    const rows = await inTenant((trx) => basLabelMap(trx, { companyId, on: '2026-11-05' }));
    const text = rows
      .map((r) => `${r.taxCode} ${r.flow} ${r.label} ${r.amount} ${r.positiveSide} ${r.basis}`)
      .sort();
    expect(text).toEqual(
      [
        'ADJ-BD any 1B tax debit accruals',
        'BAS-W1 any W1 net debit both',
        'BAS-W2 any W2 net credit both',
        'CAP purchases 1B tax debit both',
        'CAP purchases G10 gross debit both',
        'EXP sales G1 gross credit both',
        'EXP sales G2 gross credit both',
        'FRE purchases G11 gross debit both',
        'FRE sales G1 gross credit both',
        'FRE sales G3 gross credit both',
        'GST purchases 1B tax debit both',
        'GST purchases G11 gross debit both',
        'GST sales 1A tax credit both',
        'GST sales G1 gross credit both',
        'IMP purchases 1B tax debit both',
        'IMP purchases G11 gross debit both',
        'INP purchases G11 gross debit both',
        'INP sales G1 gross credit both',
      ].sort(),
    );
    // BAS excluded reports nothing.
    expect(rows.filter((r) => r.taxCode === 'N-T')).toEqual([]);
  });

  const mapRow = (v: Record<string, unknown>) =>
    inTenant((trx) =>
      trx
        .insertInto('app.bas_label_map' as never)
        .values({
          company_id: companyId,
          // N-T has no rows, so only the check under test can refuse (CHECKs run after the guard).
          tax_code: 'N-T',
          flow: 'sales',
          label: 'G1',
          amount: 'gross',
          positive_side: 'credit',
          basis: 'both',
          valid_from: '2030-01-01',
          ...v,
        } as never)
        .execute(),
    );

  it('refuses unknown labels, amounts, flows, bases and a side that contradicts the flow', async () => {
    await expect(mapRow({ label: 'G4' })).rejects.toThrow(/check constraint/);
    await expect(mapRow({ amount: 'half' })).rejects.toThrow(/check constraint/);
    await expect(mapRow({ flow: 'both' })).rejects.toThrow(/check constraint/);
    await expect(mapRow({ basis: 'hybrid' })).rejects.toThrow(/check constraint/);
    await expect(mapRow({ positive_side: 'debit' })).rejects.toThrow(
      /bas_label_map_flow_side|check constraint/,
    );
    await expect(
      mapRow({ flow: 'purchases', label: 'G11', positive_side: 'credit' }),
    ).rejects.toThrow(/bas_label_map_flow_side|check constraint/);
  });

  it('refuses a tax code the company does not have (23503)', async () => {
    await expect(mapRow({ tax_code: 'GST-ADJ' })).rejects.toThrow(
      /tax code GST-ADJ does not exist/,
    );
    await expect(mapRow({ company_id: otherCompanyId })).rejects.toThrow(
      /tax code N-T does not exist/,
    );
  });

  it('refuses a version overlapping the same code, flow and label on an intersecting basis', async () => {
    await expect(mapRow({ tax_code: 'GST', valid_from: '2026-01-01' })).rejects.toThrow(
      /BAS map GST sales G1 overlaps/,
    );
    await expect(
      mapRow({ tax_code: 'GST', basis: 'cash', valid_from: '2030-01-01' }),
    ).rejects.toThrow(/BAS map GST sales G1 overlaps/);
    // A different label of the same code does not overlap.
    await expect(mapRow({ tax_code: 'N-T', label: 'G3' })).resolves.toBeDefined();
  });

  it('a mapping change is a new version: close the old one, add the next, resolve by date', async () => {
    await inTenant(async (trx) => {
      await sql`UPDATE app.bas_label_map SET valid_to = '2029-12-31'
                 WHERE company_id = ${companyId} AND tax_code = 'INP' AND flow = 'sales'`.execute(
        trx,
      );
    });
    await mapRow({ tax_code: 'INP', label: 'G1', valid_from: '2030-01-01' });
    const before = await inTenant((trx) => basLabelMap(trx, { companyId, on: '2029-12-31' }));
    const after = await inTenant((trx) => basLabelMap(trx, { companyId, on: '2030-01-01' }));
    const inp = (rs: typeof before) =>
      rs.filter((r) => r.taxCode === 'INP' && r.flow === 'sales').map((r) => r.validFrom);
    expect(inp(before)).toEqual(['2000-07-01']);
    expect(inp(after)).toEqual(['2030-01-01']);
  });

  it('only valid_to may change; lf_app cannot delete', async () => {
    for (const set of [
      "label = 'G3'",
      "amount = 'net'",
      "valid_from = '2001-01-01'",
      "tax_code = 'FRE'",
    ]) {
      await expect(
        inTenant((trx) =>
          sql`UPDATE app.bas_label_map SET ${sql.raw(set)}
               WHERE company_id = ${companyId} AND tax_code = 'GST' AND label = '1A'`.execute(trx),
        ),
      ).rejects.toThrow(/BAS map row: only valid_to can change/);
    }
    await expect(
      inTenant((trx) =>
        sql`DELETE FROM app.bas_label_map WHERE company_id = ${companyId}`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
