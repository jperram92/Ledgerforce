/**
 * Test data for accounts payable (T-0054): a company ready to bill and pay, suppliers whose bank
 * details were verified a chosen number of hours ago, and posted bills. Bank details are added
 * through @ledgerforce/parties (sealed account numbers); the verification is then written as test
 * data dated in the past — the verification workflow itself is proven in parties'
 * bank-change.workflow.db.test.ts (T-0053).
 */
import { randomBytes } from 'node:crypto';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import type { LedgerFixture } from '@ledgerforce/ledger/testing';
import { setPartyProfiles, type SeededProfiles } from '@ledgerforce/products';
import { addBankAccount } from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { approveBill, createBill, submitBill } from '../bills.ts';

export const PAYMENT_BATCH_SERIES_PREFIX = 'PB-';

/** The test key service that sealed the fixture's bank details (ABA export unseals with it). */
export const payablesKms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

export interface PayablesFixture {
  /** The posting profiles the company was seeded with (to raise customer invoices). */
  readonly profiles: SeededProfiles;
  /**
   * A party with bank details verified `verifiedHoursAgo` hours ago (null = no bank details).
   * `customer`: a customer that is also a supplier (payee) — only suppliers and employees hold
   * bank details (migration 0012, design §4.2), and customer refunds use the same verification
   * and cooling-off (postings Q9, DL-0305; customer-only holders are ADR-0050, Proposed).
   * `customer-only`: a customer without the payee role, so it cannot hold bank details.
   */
  addSupplier(
    name: string,
    verifiedHoursAgo: number | null,
    role?: 'supplier' | 'customer' | 'customer-only',
  ): Promise<string>;
  /** A posted GST-free bill of `amount` (decimal string) to office expenses. */
  postBill(supplier: string, ref: string, amount: string, dueDate: string): Promise<string>;
}

export async function seedPayablesCompany(f: LedgerFixture): Promise<PayablesFixture> {
  const profiles = await seedBillingCompany(f);
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of [
      ['ap_bill_document', 'BILL-'],
      ['ap_payment_batch_document', PAYMENT_BATCH_SERIES_PREFIX],
    ] as const) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix })
        .execute();
    }
  });
  const verifier = await f.addUser('owner');
  let n = 0;
  return {
    profiles,
    async addSupplier(name, verifiedHoursAgo, role = 'supplier') {
      n += 1;
      const party = await f.inTenant(async (trx) => {
        const p = await trx
          .insertInto('app.party')
          .values({ company_id: f.companyId, legal_name: name, status: 'active' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const roles =
          role === 'supplier'
            ? (['supplier'] as const)
            : role === 'customer'
              ? (['customer', 'supplier'] as const)
              : (['customer'] as const);
        for (const r of roles) {
          await trx
            .insertInto('app.party_role')
            .values({ company_id: f.companyId, party_id: p.id, role: r })
            .execute();
        }
        if (role !== 'supplier') {
          // A customer to invoice: its posting profile and a Billing To contact (as AR's fixture).
          await setPartyProfiles(trx, f.companyId, p.id, {
            customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
          });
          const c = await trx
            .insertInto('app.party_contact')
            .values({
              company_id: f.companyId,
              party_id: p.id,
              name: `Accounts ${String(n)}`,
              email: `accounts${String(n)}@customer.example`,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('app.party_contact_role')
            .values({
              company_id: f.companyId,
              party_id: p.id,
              contact_id: c.id,
              role: 'billing_to',
            })
            .execute();
        }
        return p.id;
      });
      if (verifiedHoursAgo === null) return party;
      const account = await f.inTenant((trx) =>
        addBankAccount(trx, payablesKms, f.companyId, party, {
          bsb: '062-000',
          accountNumber: String(100000 + n),
          accountName: name.slice(0, 32),
          source: 'ui',
        }),
      );
      const client = await f.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query(`UPDATE app.party_bank_account SET status = 'active' WHERE id = $1`, [
          account,
        ]);
        await client.query(
          `INSERT INTO app.bank_detail_change
             (tenant_id, company_id, party_id, bank_account_id, status, requested_by, requested_at,
              decided_by, decided_at, decision_note, cooling_off_hours, payable_from)
           SELECT $1, $2, $3, $4, 'verified', $5, d, $5, d, 'Phoned the supplier on the number on file.',
                  24, d + interval '24 hours'
             FROM (SELECT clock_timestamp() - make_interval(hours => $6) AS d) t`,
          [f.tenantId, f.companyId, party, account, verifier, verifiedHoursAgo],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return party;
    },
    async postBill(supplier, ref, amount, dueDate) {
      return f.inTenant(async (trx) => {
        const b = await createBill(trx, {
          companyId: f.companyId,
          partyId: supplier,
          supplierRef: ref,
          billDate: '2026-11-02',
          dueDate,
          lines: [
            {
              accountId: f.acct['6230'] ?? '',
              description: 'Supplies',
              amount,
              taxCode: 'GST-FREE',
            },
          ],
        });
        await submitBill(trx, { companyId: f.companyId, billId: b.billId });
        return (await approveBill(trx, { companyId: f.companyId, billId: b.billId })).billId;
      });
    },
  };
}
