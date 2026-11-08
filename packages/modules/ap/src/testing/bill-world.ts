/**
 * Test world for supplier bills (T-0050). Test-only.
 *
 * Builds on the golden world (T-0031: AU chart, the GP-008 accounts "Office expenses" 6150 and
 * "Computer equipment" 1520, the golden parties, one journal series per source type, FY2027 and
 * FY2028) and adds what a bill needs: the AU tax codes (T-0034), the supplier role, the 'bill'
 * series positioned so the first bill is BILL-000045 (GP-008), posting profiles and two products
 * (T-0038), a second supplier, and users.
 */
import type { Database } from '@ledgerforce/db';
import { auTaxCodes, loadTaxCodes } from '@ledgerforce/tax';
import { createGoldenWorld, type GoldenFixture } from '@ledgerforce/ledger/testing/golden-world';
import type { Transaction } from 'kysely';

export interface BillWorld {
  g: GoldenFixture;
  companyId: string;
  inTenant<R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R>;
  /** GP-008's supplier ("Supplier" in postings.md), with a TRADE_SUPPLIER profile (default GST). */
  supplierId: string;
  /** A second supplier without a posting profile and without history. */
  otherSupplierId: string;
  /** A party that is not a supplier. */
  customerId: string;
  acct: { office: string; computers: string; rent: string; apControl: string; gstPaid: string };
  /** Tax code key → id of its (only) version. */
  taxCodeIds: Map<string, string>;
  products: { laptop: string; paper: string };
  users: { apClerk: string; approver: string; financeAdmin: string };
  close(): Promise<void>;
}

export async function createBillWorld(tenantId: string): Promise<BillWorld> {
  const g = await createGoldenWorld(tenantId);
  const f = g.fixture;
  const companyId = g.world.companyId;
  const chosen = (type: string, name: string) =>
    g.world.account({ kind: 'chosen', type, name }).accountId;
  const office = chosen('expense', 'Office expenses');
  const computers = chosen('asset', 'Computer equipment');
  const supplierId = g.world.partyId('Supplier');
  const customerId = g.world.partyId('Acme');
  if (supplierId === undefined || customerId === undefined)
    throw new Error('golden parties missing');

  const seeded = await f.inTenant(async (trx) => {
    await loadTaxCodes(trx, companyId, auTaxCodes);
    const codes = await trx
      .selectFrom('app.tax_code')
      .select(['code', 'id'])
      .where('company_id', '=', companyId)
      .execute();
    await trx
      .insertInto('app.number_series')
      .values({ company_id: companyId, code: 'bill', prefix: 'BILL-', next_value: '45' })
      .execute();
    const other = await trx
      .insertInto('app.party')
      .values({ company_id: companyId, legal_name: 'Harbour Couriers Pty Ltd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values([
        { company_id: companyId, party_id: supplierId, role: 'supplier' },
        { company_id: companyId, party_id: other.id, role: 'supplier' },
        { company_id: companyId, party_id: customerId, role: 'customer' },
      ])
      .execute();
    const partyProfile = await trx
      .insertInto('app.party_posting_profile')
      .values({
        company_id: companyId,
        code: 'TRADE_SUPPLIER',
        name: 'Trade suppliers',
        party_kind: 'supplier',
        control_role: 'AP_CONTROL',
        default_tax_code: 'GST',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('app.party')
      .set({ supplier_posting_profile_id: partyProfile.id })
      .where('id', '=', supplierId)
      .execute();
    const [hardware, stationery] = await trx
      .insertInto('app.product_posting_profile')
      .values([
        {
          company_id: companyId,
          code: 'IT_HARDWARE',
          name: 'IT hardware',
          asset_account_id: computers,
        },
        {
          company_id: companyId,
          code: 'STATIONERY',
          name: 'Stationery',
          expense_account_id: office,
        },
      ])
      .returning('id')
      .execute();
    if (!hardware || !stationery) throw new Error('product profiles not created');
    const [laptop, paper] = await trx
      .insertInto('app.product')
      .values([
        {
          company_id: companyId,
          code: 'LAPTOP',
          name: 'Laptop',
          product_posting_profile_id: hardware.id,
          default_tax_code: 'CAP',
        },
        {
          company_id: companyId,
          code: 'PAPER',
          name: 'Copy paper',
          product_posting_profile_id: stationery.id,
        },
      ])
      .returning('id')
      .execute();
    if (!laptop || !paper) throw new Error('products not created');
    return {
      taxCodeIds: new Map(codes.map((c) => [c.code, c.id])),
      otherSupplierId: other.id,
      products: { laptop: laptop.id, paper: paper.id },
    };
  });

  const users = {
    apClerk: await f.addUser('ap_clerk'),
    approver: await f.addUser('approver'),
    financeAdmin: await f.addUser('finance_admin'),
  };

  return {
    g,
    companyId,
    inTenant: (fn) => f.inTenant(fn),
    supplierId,
    customerId,
    acct: {
      office,
      computers,
      rent: f.acct['6200'] ?? '',
      apControl: f.acct['2000'] ?? '',
      gstPaid: f.acct['1820'] ?? '',
    },
    users,
    close: () => g.close(),
    ...seeded,
  };
}
