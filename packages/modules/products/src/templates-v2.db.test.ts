/**
 * SS-PLAT-130 — AU templates v2 load into a new company and behave as the accountant review asks
 * (T-0121, DL-0280, DL-0283): chart v2 + au-gst v2 + profiles v2, as lf_app inside a tenant
 * transaction. A fixed-asset purchase defaults to CAP (BAS G10); an overseas sale of a product
 * without its own tax code is refused (NO_TAX_CODE), never silently GST-free; hardware is sold
 * on 4140 and is not capitalised by default.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmbV2, loadChartTemplate } from '@ledgerforce/gl';
import { auTaxCodes, basLabelMap, loadTaxCodes } from '@ledgerforce/tax';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostingProfileResolutionError } from './matrix.ts';
import { createProduct, loadPostingProfileTemplate } from './posting-profiles.ts';
import {
  loadPostingMatrix,
  postingProfileGapCheck,
  resolvePartyProductPosting,
} from './profile-resolution.ts';
import { auServicesSmbProfilesV2 } from './profiles.template.ts';

const T = '01900000-0000-7000-8000-0000000121aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
const ids: Record<string, string> = {};
const id = (key: string): string => {
  const v = ids[key];
  if (v === undefined) throw new Error(`fixture ${key} was not created`);
  return v;
};

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);

const party = (name: string, customerProfile: string) =>
  inTenant(async (trx) => {
    const r = await sql<{ id: string }>`
      INSERT INTO app.party (company_id, legal_name, customer_posting_profile_id)
      SELECT ${companyId}, ${name}, pp.id FROM app.party_posting_profile pp
       WHERE pp.company_id = ${companyId} AND pp.code = ${customerProfile}
      RETURNING id`.execute(trx);
    const row = r.rows[0];
    if (!row) throw new Error(`party ${name} not created`);
    return row.id;
  });

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const row = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await loadChartTemplate(trx, row.id, auServicesSmbV2);
    await loadTaxCodes(trx, row.id, auTaxCodes);
    await loadPostingProfileTemplate(trx, row.id, auServicesSmbProfilesV2);
    return row.id;
  });
  ids.domestic = await party('Acme Pty Ltd', 'DOMESTIC_CUSTOMER');
  ids.overseas = await party('Kiwi Ltd', 'OVERSEAS_CUSTOMER');
  for (const [key, name, profile] of [
    ['consulting', 'Consulting', 'PROFESSIONAL_SERVICES'],
    ['laptop', 'Laptop for resale', 'HARDWARE'],
  ] as const) {
    ids[key] = (
      await inTenant((trx) =>
        createProduct(trx, { companyId, name, productPostingProfileCode: profile }),
      )
    ).id;
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-130: AU templates v2 load for a new company', () => {
  it('chart v2: 1500 defaults to CAP, 1290 is a credit-normal allowance, 4140 hardware sales', async () => {
    const rows = await inTenant((trx) =>
      trx
        .selectFrom('app.account')
        .select(['code', 'name', 'type', 'normal_balance', 'is_control', 'default_tax_code'])
        .where('company_id', '=', companyId)
        .where('code', 'in', ['1290', '1500', '1510', '4140'])
        .orderBy('code')
        .execute(),
    );
    expect(
      rows.map((r) => [r.code, r.name, r.type, r.normal_balance, r.is_control, r.default_tax_code]),
    ).toEqual([
      ['1290', 'Allowance for expected credit losses', 'asset', 'credit', false, null],
      ['1500', 'Office equipment', 'asset', 'debit', false, 'CAP'],
      ['1510', 'Accumulated depreciation - office equipment', 'asset', 'credit', false, null],
      ['4140', 'Hardware sales', 'revenue', 'credit', false, 'GST'],
    ]);
  });

  it('a fixed-asset purchase on its default code reports to G10 and 1B, not G11', async () => {
    const map = await inTenant((trx) => basLabelMap(trx, { companyId, on: '2026-11-05' }));
    expect(
      map
        .filter((r) => r.taxCode === 'CAP' && r.flow === 'purchases')
        .map((r) => r.label)
        .sort(),
    ).toEqual(['1B', 'G10']);
  });

  it('profiles v2: OVERSEAS_CUSTOMER stored without a default; EQUIPMENT on 1500; HARDWARE without asset', async () => {
    const m = await inTenant((trx) => loadPostingMatrix(trx, companyId));
    const overseas = m.partyProfiles.find((p) => p.code === 'OVERSEAS_CUSTOMER');
    expect(overseas?.defaultTaxCode).toBeNull();
    const slots = (code: string) =>
      Object.fromEntries(
        Object.entries(m.productProfiles.find((p) => p.code === code)?.slots ?? {}).map(
          ([slot, a]) => [slot, a.code],
        ),
      );
    expect(slots('EQUIPMENT')).toEqual({ asset: '1500' });
    expect(slots('HARDWARE')).toEqual({ revenue: '4140' });
  });

  it('an overseas sale of a product without a tax code is refused NO_TAX_CODE, not FRE', async () => {
    let err: unknown;
    try {
      await inTenant((trx) =>
        resolvePartyProductPosting(trx, {
          companyId,
          partyId: id('overseas'),
          productId: id('consulting'),
          direction: 'sale',
          slot: 'revenue',
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PostingProfileResolutionError);
    expect((err as PostingProfileResolutionError).code).toBe('NO_TAX_CODE');
    // A person codes the line: the line's code always wins.
    const coded = await inTenant((trx) =>
      resolvePartyProductPosting(trx, {
        companyId,
        partyId: id('overseas'),
        productId: id('consulting'),
        direction: 'sale',
        slot: 'revenue',
        lineTaxCode: 'EXS',
      }),
    );
    expect([coded.account.code, coded.taxCode, coded.taxCodeSource]).toEqual([
      '4110',
      'EXS',
      'line',
    ]);
  });

  it('hardware is sold on 4140 with GST; the gap check asks about its asset and cogs slots', async () => {
    const r = await inTenant((trx) =>
      resolvePartyProductPosting(trx, {
        companyId,
        partyId: id('domestic'),
        productId: id('laptop'),
        direction: 'sale',
        slot: 'revenue',
      }),
    );
    expect([r.account.code, r.taxCode]).toEqual(['4140', 'GST']);
    const gaps = await inTenant((trx) => postingProfileGapCheck(trx, { companyId }));
    const hw = gaps
      .filter((g) => g.productProfile.code === 'HARDWARE')
      .map((g) => `${g.direction} ${g.partyProfile.code} ${g.slot}`);
    expect(hw).toContain('purchase DOMESTIC_SUPPLIER asset');
    expect(hw).toContain('sale DOMESTIC_CUSTOMER cogs');
  });
});
