/**
 * Batch billing run — selection and preview (T-0043, UC-02, design §4.3, DL-0271), against a real
 * PostgreSQL as lf_app. Billable lines for the period are grouped one invoice per account (BATCH
 * format), priced exactly as approval will price them, with warnings; nothing reaches the ledger.
 */
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles, type SeededProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBillingLine, previewBatch, type BatchError } from './batch.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
const customers: string[] = [];
let decemberOnly = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004301');
  profiles = await f.inTenant(async (trx) => {
    await seedTaxCodes(trx, f.companyId);
    return seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
  });
  const services = profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
  const subscription = profiles.productProfiles.get('SUBSCRIPTION') ?? '';
  await f.inTenant(async (trx) => {
    for (let i = 1; i <= 41; i++) {
      const p = await trx
        .insertInto('app.party')
        .values({
          company_id: f.companyId,
          legal_name: `Customer ${String(i).padStart(2, '0')} Pty Ltd`,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: f.companyId, party_id: p.id, role: 'customer' })
        .execute();
      // Customer 07 has no posting profile (PROFILE_GAP); everyone else is domestic.
      if (i !== 7) {
        await setPartyProfiles(trx, f.companyId, p.id, {
          customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
        });
      }
      // Customer 13 has no Billing To contact (NO_BILLING_TO).
      if (i !== 13) {
        const c = await trx
          .insertInto('app.party_contact')
          .values({
            company_id: f.companyId,
            party_id: p.id,
            name: 'Accounts',
            email: `ap${String(i)}@example.test`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('app.party_contact_role')
          .values({ company_id: f.companyId, party_id: p.id, contact_id: c.id, role: 'billing_to' })
          .execute();
      }
      if (i <= 40) {
        customers.push(p.id);
        await addBillingLine(trx, f.companyId, {
          partyId: p.id,
          productProfileId: subscription,
          description: 'Subscription November 2026',
          quantity: '1',
          unitPrice: '250.00',
          billDate: '2026-11-01',
        });
        if (i % 2 === 0) {
          await addBillingLine(trx, f.companyId, {
            partyId: p.id,
            productProfileId: services,
            description: 'Support hours',
            quantity: '2',
            unitPrice: '150.00',
            billDate: '2026-11-20',
          });
        }
      } else {
        // Customer 41 has only a December line: not billable in November.
        decemberOnly = p.id;
        await addBillingLine(trx, f.companyId, {
          partyId: p.id,
          productProfileId: subscription,
          description: 'Subscription December 2026',
          quantity: '1',
          unitPrice: '250.00',
          billDate: '2026-12-01',
        });
      }
    }
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const november = (key: string) =>
  f.inTenant((trx) =>
    previewBatch(trx, {
      companyId: f.companyId,
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
      idempotencyKey: key,
    }),
  );

describe('SS-UC02-01: Preview lists all invoices, posts nothing', () => {
  it('SS-UC02-01 a November preview of 40 billable accounts returns 40 rows with totals and warnings and writes no journal', async () => {
    const entriesBefore = await f.countEntries();
    const p = await november('batch-nov-2026');
    expect(p.replayed).toBe(false);
    expect(p.items).toHaveLength(40);
    expect(p.items.map((i) => i.partyId).sort()).toEqual([...customers].sort());
    expect(p.items.some((i) => i.partyId === decemberOnly)).toBe(false);
    // Odd customers: 250 + GST 25 = 275.00; even: + 300 + 30 = 605.00.
    const c2 = p.items.find((i) => i.partyId === customers[1]);
    expect(c2).toMatchObject({
      lineCount: 2,
      net: '550.0000',
      tax: '55.0000',
      gross: '605.0000',
      warnings: [],
    });
    const c7 = p.items.find((i) => i.partyId === customers[6]);
    expect(c7?.gross).toBeNull();
    expect(c7?.warnings).toEqual([expect.objectContaining({ code: 'PROFILE_GAP' })]);
    const c13 = p.items.find((i) => i.partyId === customers[12]);
    expect(c13?.warnings).toEqual([expect.objectContaining({ code: 'NO_BILLING_TO' })]);
    expect(p.items.filter((i) => i.warnings.length > 0)).toHaveLength(2);
    // 20 × 275 + 20 × 605 = 17,600 gross, less customer 07's 275 that cannot be priced.
    expect(p.totals).toEqual({
      invoices: 40,
      ready: 38,
      net: '15750.0000',
      tax: '1575.0000',
      gross: '17325.0000',
    });
    expect(await f.countEntries()).toBe(entriesBefore);
    const invoices = await f.inTenant((trx) =>
      trx.selectFrom('app.sales_invoice').select('id').execute(),
    );
    expect(invoices).toHaveLength(0);
  });

  it('SS-UC02-01 the same request again returns the same preview (idempotent); lines stay pending', async () => {
    const first = await november('batch-nov-2026');
    expect(first.replayed).toBe(true);
    expect(first.items).toHaveLength(40);
    const pending = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_line')
        .select('status')
        .where('status', '<>', 'pending')
        .execute(),
    );
    expect(pending).toHaveLength(0);
  });

  it('refuses an inverted period and a period with nothing to bill', async () => {
    const inverted = await f
      .inTenant((trx) =>
        previewBatch(trx, {
          companyId: f.companyId,
          periodFrom: '2026-11-30',
          periodTo: '2026-11-01',
          idempotencyKey: 'x1',
        }),
      )
      .catch((e: unknown) => e);
    expect((inverted as BatchError).code).toBe('INVALID_BATCH');
    const empty = await f
      .inTenant((trx) =>
        previewBatch(trx, {
          companyId: f.companyId,
          periodFrom: '2027-03-01',
          periodTo: '2027-03-31',
          idempotencyKey: 'x2',
        }),
      )
      .catch((e: unknown) => e);
    expect((empty as BatchError).code).toBe('NOTHING_TO_BILL');
  });
});
