/**
 * T-0038 — products, party posting profiles and product posting profiles (design §4.4,
 * migration 0032, RQ-0096, DL-0250). Every check runs as lf_app inside a tenant transaction, as
 * the API would. Cross-tenant isolation of the new tables is covered by the generated suite
 * (packages/db rls.db.test.ts), which discovers every tenant_id table.
 *
 * SS-PLAT-100 (template loads), SS-PLAT-101 (database rules), SS-PLAT-102 (product tax code
 * through app.tax_code), SS-PLAT-103 (Salesforce mapping hooks).
 */
import { ACCOUNT_TYPES, auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auTaxCodes, loadTaxCodes } from '@ledgerforce/tax';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTING_SLOTS, slotAllows } from './posting-slots.ts';
import {
  createProduct,
  findPartyProfileForSalesforce,
  findProductProfileForSalesforce,
  findProductTaxCode,
  loadPostingProfileTemplate,
} from './posting-profiles.ts';
import { auServicesSmbProfiles } from './profiles.template.ts';

const T = '01900000-0000-7000-8000-0000000038aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
let otherCompanyId: string;

const inTenant = <R>(fn: Parameters<typeof withTenant<Database, R>>[2]) => withTenant(db, T, fn);
const one = async <R>(q: ReturnType<typeof sql<R>>): Promise<R> => {
  const r = await inTenant((trx) => q.execute(trx));
  const row = r.rows[0];
  if (row === undefined) throw new Error('no row');
  return row;
};
const accountId = (code: string, company = companyId) =>
  one(
    sql<{
      id: string;
    }>`SELECT id FROM app.account WHERE company_id = ${company} AND code = ${code}`,
  ).then((r) => r.id);
const productProfileId = (code: string) =>
  one(
    sql<{
      id: string;
    }>`SELECT id FROM app.product_posting_profile WHERE company_id = ${companyId} AND code = ${code}`,
  ).then((r) => r.id);
const partyProfileId = (code: string) =>
  one(
    sql<{
      id: string;
    }>`SELECT id FROM app.party_posting_profile WHERE company_id = ${companyId} AND code = ${code}`,
  ).then((r) => r.id);
const run = <R = unknown>(q: ReturnType<typeof sql<R>>) => inTenant((trx) => q.execute(trx));

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
  for (const c of [companyId, otherCompanyId]) {
    await inTenant((trx) => loadChartTemplate(trx, c, auServicesSmb));
    await inTenant((trx) => loadTaxCodes(trx, c, auTaxCodes));
  }
  await inTenant((trx) => loadPostingProfileTemplate(trx, companyId, auServicesSmbProfiles));
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-100: the AU services posting-profile template loads into a company', () => {
  it('writes 3 party profiles with their control role and default tax code', async () => {
    const r = await run(sql`SELECT code, party_kind, control_role, default_tax_code, status
                              FROM app.party_posting_profile WHERE company_id = ${companyId} ORDER BY code`);
    expect(r.rows).toEqual([
      {
        code: 'DOMESTIC_CUSTOMER',
        party_kind: 'customer',
        control_role: 'AR_CONTROL',
        default_tax_code: 'GST',
        status: 'active',
      },
      {
        code: 'DOMESTIC_SUPPLIER',
        party_kind: 'supplier',
        control_role: 'AP_CONTROL',
        default_tax_code: 'GST',
        status: 'active',
      },
      {
        code: 'OVERSEAS_CUSTOMER',
        party_kind: 'customer',
        control_role: 'AR_CONTROL',
        default_tax_code: 'FRE',
        status: 'active',
      },
    ]);
  });

  it('writes 5 product profiles whose slots name the template accounts', async () => {
    const r = await run(sql<{ code: string; slot: string; account: string }>`
      SELECT p.code, s.slot, a.code AS account
        FROM app.product_posting_profile p
        CROSS JOIN LATERAL (VALUES ('revenue', p.revenue_account_id), ('discount', p.discount_account_id),
                                   ('expense', p.expense_account_id), ('cogs', p.cogs_account_id),
                                   ('asset', p.asset_account_id)) AS s(slot, account_id)
        JOIN app.account a ON a.id = s.account_id
       WHERE p.company_id = ${companyId}
       ORDER BY p.code, s.slot`);
    const expected = auServicesSmbProfiles.productProfiles
      .flatMap((p) =>
        Object.entries(p.accounts).map(([slot, account]) => ({ code: p.code, slot, account })),
      )
      .sort((x, y) => (x.code + x.slot < y.code + y.slot ? -1 : 1));
    expect(r.rows).toEqual(expected);
    expect(new Set(r.rows.map((x) => x.code)).size).toBe(5);
    // Golden keys (Draft postings.md) resolve: product:PROFESSIONAL_SERVICES.revenue, product:HARDWARE.asset.
    expect(r.rows).toContainEqual({
      code: 'PROFESSIONAL_SERVICES',
      slot: 'revenue',
      account: '4110',
    });
    expect(r.rows).toContainEqual({ code: 'HARDWARE', slot: 'asset', account: '1500' });
  });

  it('refuses to load an invalid template before writing anything', async () => {
    const bad = structuredClone(auServicesSmbProfiles);
    const first = bad.productProfiles[0];
    if (!first) throw new Error('fixture');
    first.accounts.revenue = '6200';
    await expect(
      inTenant((trx) => loadPostingProfileTemplate(trx, otherCompanyId, bad)),
    ).rejects.toThrow(/SUBSCRIPTION\.revenue on 6200/);
    const r = await one(
      sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM app.product_posting_profile WHERE company_id = ${otherCompanyId}`,
    );
    expect(r.n).toBe(0);
  });
});

describe('SS-PLAT-101: the database holds the posting-profile rules', () => {
  it('app.posting_slot_allows agrees with the TypeScript mirror for every slot × type', async () => {
    for (const slot of POSTING_SLOTS) {
      for (const type of ACCOUNT_TYPES) {
        const r = await one(
          sql<{ ok: boolean }>`SELECT app.posting_slot_allows(${slot}, ${type}) AS ok`,
        );
        expect(r.ok, `${slot} × ${type}`).toBe(slotAllows(slot, type));
      }
    }
  });

  const insertProfile = async (code: string, slot: string, accountCode: string) =>
    run(sql`INSERT INTO app.product_posting_profile (company_id, code, name, ${sql.ref(`${slot}_account_id`)})
            VALUES (${companyId}, ${code}, ${code}, ${await accountId(accountCode)})`);

  it('refuses a slot account of the wrong type, a control account and an archived or non-postable one', async () => {
    await expect(insertProfile('BAD_TYPE', 'revenue', '6200')).rejects.toThrow(
      /slot revenue: account 6200 has type expense/,
    );
    await expect(insertProfile('BAD_CONTROL', 'asset', '1200')).rejects.toThrow(
      /slot asset: account 1200 is a control account/,
    );
    await run(sql`INSERT INTO app.account (company_id, code, name, type, subtype, normal_balance, status)
                  VALUES (${companyId}, '4980', 'Old revenue', 'revenue', 'operating_revenue', 'credit', 'archived')`);
    await expect(insertProfile('BAD_ARCHIVED', 'revenue', '4980')).rejects.toThrow(
      /slot revenue: account 4980 is not active/,
    );
    await expect(insertProfile('BAD_HEADER', 'revenue', '3300')).rejects.toThrow(
      /slot revenue: account 3300/,
    );
    await insertProfile('GOOD_DISCOUNT', 'discount', '6900');
  });

  it('refuses archiving or retyping an account a profile slot or an override uses', async () => {
    await expect(
      run(
        sql`UPDATE app.account SET status = 'archived' WHERE company_id = ${companyId} AND code = '4110'`,
      ),
    ).rejects.toThrow(
      /account 4110 is used by product posting profile PROFESSIONAL_SERVICES \(revenue\)/,
    );
    await expect(
      run(
        sql`UPDATE app.account SET type = 'expense' WHERE company_id = ${companyId} AND code = '4120'`,
      ),
    ).rejects.toThrow(/account 4120 is used by product posting profile SUBSCRIPTION \(revenue\)/);
    // A rename is fine.
    await run(
      sql`UPDATE app.account SET name = 'Consulting revenue' WHERE company_id = ${companyId} AND code = '4110'`,
    );

    await run(sql`INSERT INTO app.account (company_id, code, name, type, subtype, normal_balance)
                  VALUES (${companyId}, '4115', 'Overseas services revenue', 'revenue', 'operating_revenue', 'credit')`);
    await run(sql`INSERT INTO app.posting_profile_override
                    (company_id, party_posting_profile_id, product_posting_profile_id, slot, account_id)
                  VALUES (${companyId}, ${await partyProfileId('OVERSEAS_CUSTOMER')},
                          ${await productProfileId('PROFESSIONAL_SERVICES')}, 'revenue', ${await accountId('4115')})`);
    await expect(
      run(
        sql`UPDATE app.account SET postable = false WHERE company_id = ${companyId} AND code = '4115'`,
      ),
    ).rejects.toThrow(
      /account 4115 is used by posting-profile override OVERSEAS_CUSTOMER × PROFESSIONAL_SERVICES \(revenue\)/,
    );
  });

  it('refuses an override for an unknown slot, on a wrong type, and a second override for the same cell', async () => {
    const party = await partyProfileId('DOMESTIC_CUSTOMER');
    const product = await productProfileId('HARDWARE');
    const override = async (slot: string, code: string) =>
      run(sql`INSERT INTO app.posting_profile_override
                (company_id, party_posting_profile_id, product_posting_profile_id, slot, account_id)
              VALUES (${companyId}, ${party}, ${product}, ${slot}, ${await accountId(code)})`);
    await expect(override('tax', '4190')).rejects.toThrow(/check constraint/);
    await expect(override('revenue', '1500')).rejects.toThrow(
      /slot revenue: account 1500 has type asset/,
    );
    await override('revenue', '4110');
    await expect(override('revenue', '4120')).rejects.toThrow(/duplicate key/);
  });

  it('a party profile kind decides its control role and its tax code must exist', async () => {
    const insert = (code: string, kind: string, role: string, tax: string | null) =>
      run(sql`INSERT INTO app.party_posting_profile (company_id, code, name, party_kind, control_role, default_tax_code)
              VALUES (${companyId}, ${code}, ${code}, ${kind}, ${role}, ${tax})`);
    await expect(insert('MIXED', 'customer', 'AP_CONTROL', null)).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert('NO_TAX', 'supplier', 'AP_CONTROL', 'VAT')).rejects.toThrow(
      /tax code VAT does not exist in this company/,
    );
    await insert('RELATED_PARTY', 'customer', 'AR_CONTROL', 'GST');
    // Kind and code are history the parties point at; the name may change.
    await expect(
      run(sql`UPDATE app.party_posting_profile SET party_kind = 'supplier', control_role = 'AP_CONTROL'
               WHERE company_id = ${companyId} AND code = 'RELATED_PARTY'`),
    ).rejects.toThrow(
      /party posting profile RELATED_PARTY: only name, default_tax_code and status can change/,
    );
    await run(sql`UPDATE app.party_posting_profile SET name = 'Related party (customer)'
                   WHERE company_id = ${companyId} AND code = 'RELATED_PARTY'`);
  });

  it('a party links its customer and supplier profiles only to profiles of that kind', async () => {
    const party = await one(sql<{ id: string }>`
      INSERT INTO app.party (company_id, legal_name) VALUES (${companyId}, 'Acme Pty Ltd') RETURNING id`);
    const customer = await partyProfileId('DOMESTIC_CUSTOMER');
    const supplier = await partyProfileId('DOMESTIC_SUPPLIER');
    await run(sql`UPDATE app.party SET customer_posting_profile_id = ${customer},
                                       supplier_posting_profile_id = ${supplier} WHERE id = ${party.id}`);
    await expect(
      run(
        sql`UPDATE app.party SET customer_posting_profile_id = ${supplier} WHERE id = ${party.id}`,
      ),
    ).rejects.toThrow(/customer_posting_profile_id must name a customer profile/);
    await expect(
      run(
        sql`UPDATE app.party SET supplier_posting_profile_id = ${customer} WHERE id = ${party.id}`,
      ),
    ).rejects.toThrow(/supplier_posting_profile_id must name a supplier profile/);
  });

  it('lf_app cannot delete profiles, products, overrides or mappings', async () => {
    for (const t of [
      'app.party_posting_profile',
      'app.product_posting_profile',
      'app.posting_profile_override',
      'app.product',
      'app.party_profile_mapping',
      'app.product_profile_mapping',
    ]) {
      await expect(run(sql`DELETE FROM ${sql.table(t)}`), t).rejects.toThrow(/permission denied/);
    }
  });
});

describe('SS-PLAT-102: a product default tax code resolves through app.tax_code', () => {
  it('returns the version valid on the date, and null for a product without a tax code', async () => {
    const product = await inTenant((trx) =>
      createProduct(trx, {
        companyId,
        name: 'Advisory day',
        code: 'ADV-DAY',
        productPostingProfileCode: 'PROFESSIONAL_SERVICES',
        defaultTaxCode: 'GST',
        salesforceProductId: '01t5g00000AbCdEAAZ',
        salesforceFamily: 'Professional Services',
      }),
    );
    // A later GST rate: close the open version, add a new one (T-0034 effective dating).
    await run(sql`UPDATE app.tax_code SET valid_to = '2030-06-30'
                   WHERE company_id = ${companyId} AND code = 'GST' AND valid_to IS NULL`);
    await run(sql`INSERT INTO app.tax_code (company_id, code, name, kind, rate, collected_role, paid_role, valid_from)
                  VALUES (${companyId}, 'GST', 'GST 12%', 'taxable', '0.12', 'GST_COLLECTED', 'GST_PAID', '2030-07-01')`);

    const now = await inTenant((trx) =>
      findProductTaxCode(trx, { companyId, productId: product.id, on: '2026-11-08' }),
    );
    expect(now).toMatchObject({ code: 'GST', rate: '0.10000000', validTo: '2030-06-30' });
    expect(now?.collectedAccountId).toBe(await accountId('2310'));
    expect(now?.paidAccountId).toBe(await accountId('1820'));
    const later = await inTenant((trx) =>
      findProductTaxCode(trx, { companyId, productId: product.id, on: '2031-01-01' }),
    );
    expect(later).toMatchObject({ code: 'GST', rate: '0.12000000', validFrom: '2030-07-01' });

    const untaxed = await inTenant((trx) => createProduct(trx, { companyId, name: 'Gift card' }));
    expect(
      await inTenant((trx) =>
        findProductTaxCode(trx, { companyId, productId: untaxed.id, on: '2026-11-08' }),
      ),
    ).toBeNull();
  });

  it('refuses a product naming a tax code with no version in its company, and a duplicate Salesforce Id', async () => {
    await expect(
      inTenant((trx) => createProduct(trx, { companyId, name: 'Widget', defaultTaxCode: 'VAT' })),
    ).rejects.toThrow(/tax code VAT does not exist in this company/);
    await expect(
      inTenant((trx) =>
        createProduct(trx, {
          companyId,
          name: 'Same Product2',
          salesforceProductId: '01t5g00000AbCdEAAZ',
        }),
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      inTenant((trx) =>
        createProduct(trx, { companyId, name: 'Short Id', salesforceProductId: '01t5g00000AbCdE' }),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('SS-PLAT-103: Salesforce picklist values map to posting profiles', () => {
  it('finds the template mappings for Account.Type and Product2.Family', async () => {
    const p = await inTenant((trx) =>
      findPartyProfileForSalesforce(trx, { companyId, field: 'Type', value: 'Customer - Direct' }),
    );
    expect(p?.code).toBe('DOMESTIC_CUSTOMER');
    const q = await inTenant((trx) =>
      findProductProfileForSalesforce(trx, { companyId, field: 'Family', value: 'Hardware' }),
    );
    expect(q?.code).toBe('HARDWARE');
    expect(
      await inTenant((trx) =>
        findProductProfileForSalesforce(trx, { companyId, field: 'Family', value: 'Catering' }),
      ),
    ).toBeNull();
    // Exact match on the picklist API value.
    expect(
      await inTenant((trx) =>
        findPartyProfileForSalesforce(trx, {
          companyId,
          field: 'Type',
          value: 'customer - direct',
        }),
      ),
    ).toBeNull();
  });

  it('accepts a custom field, refuses a value mapped twice and a bad field name', async () => {
    const overseas = await partyProfileId('OVERSEAS_CUSTOMER');
    await run(sql`INSERT INTO app.party_profile_mapping (company_id, sf_field, sf_value, party_posting_profile_id)
                  VALUES (${companyId}, 'LF_Party_Profile__c', 'Overseas', ${overseas})`);
    expect(
      (
        await inTenant((trx) =>
          findPartyProfileForSalesforce(trx, {
            companyId,
            field: 'LF_Party_Profile__c',
            value: 'Overseas',
          }),
        )
      )?.code,
    ).toBe('OVERSEAS_CUSTOMER');
    await expect(
      run(sql`INSERT INTO app.party_profile_mapping (company_id, sf_field, sf_value, party_posting_profile_id)
              VALUES (${companyId}, 'Type', 'Customer - Direct', ${overseas})`),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      run(sql`INSERT INTO app.product_profile_mapping (company_id, sf_field, sf_value, product_posting_profile_id)
              VALUES (${companyId}, 'Family; DROP', 'X', ${await productProfileId('FREIGHT')})`),
    ).rejects.toThrow(/check constraint/);
    // Re-mapping a value is an UPDATE.
    await run(sql`UPDATE app.product_profile_mapping SET product_posting_profile_id = ${await productProfileId('REIMBURSABLE_EXPENSE')}
                   WHERE company_id = ${companyId} AND sf_field = 'Family' AND sf_value = 'Freight'`);
    expect(
      (
        await inTenant((trx) =>
          findProductProfileForSalesforce(trx, { companyId, field: 'Family', value: 'Freight' }),
        )
      )?.code,
    ).toBe('REIMBURSABLE_EXPENSE');
  });
});
