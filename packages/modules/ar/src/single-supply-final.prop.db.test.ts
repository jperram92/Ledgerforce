/**
 * SS-PLAT-159 / T-0204 AC-5 (slice 1: receipts and the final invoice; cancellation and refund
 * lifecycles are T-0218) — single-supply invariants after the final tax invoice (ADR-0089 R11,
 * GP-045), against a real PostgreSQL as lf_app. Default numRuns (100), never lowered. Amounts are
 * integer cents handled as Decimal; nothing uses floating point. Expected GST is derived here
 * independently: 10 % half-up of the known total plus 10 % half-up of the price change.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import { setTaxSettings } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSingleSupplyContract, recordSingleSupplyReceipt } from './single-supply.ts';
import { finaliseSingleSupply } from './single-supply-final.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let party = '';
let owner = '';
let profile = '';
let run = 0;

const num = (c: Decimal) => Money.of(c.div(100), 'XXX').toNumericString();
const dec = (c: Decimal) => c.div(100).toString();
const toCents = (s: string | undefined) => new Decimal(s ?? '0').times(100);
/** 10 % of a cents amount, half-up, keeping the sign. */
const gstOf = (c: Decimal) => {
  const t = c.abs().plus(5).divToInt(10);
  return c.isNegative() ? t.neg() : t;
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020402');
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'PropFinal',
    billDate: '2026-11-01',
  });
  profile = profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
  owner = await f.addUser('owner');
  await f.inTenant((trx) =>
    setTaxSettings(trx, {
      companyId: f.companyId,
      effectiveFrom: '2026-07-01',
      gstBasis: 'accrual',
      basFrequency: 'monthly',
    }),
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-159: single-supply invariants after the final tax invoice (ADR-0089 R11)', () => {
  it('SS-PLAT-159 AC-5 every entry balances; GST reported on the contract = GST on the final consideration (fixed GST + GST on the change); unbilled and prepayments end at zero; AR open = invoice − received; a final invoice below the cash received is refused [T-0204]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 2n, max: 10n ** 9n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: -999, max: 1000 }),
        async (netGen, weights, paidPermille, changePermille) => {
          run += 1;
          const net = new Decimal(netGen.toString());
          const whole = gstOf(net);
          const total = net.plus(whole);
          // Receive a share of the total (at least one cent), split into receipts.
          const paid = Decimal.max(1, total.times(paidPermille).divToInt(1000));
          const receipts: Decimal[] = [];
          let left = paid;
          for (const [i, w] of weights.entries()) {
            if (left.lte(0)) break;
            const part =
              i === weights.length - 1 ? left : Decimal.max(1, left.times(w).divToInt(1000));
            const r = Decimal.min(part, left);
            receipts.push(r);
            left = left.minus(r);
          }
          if (left.gt(0)) receipts.push(left);
          // A price change of −99.9 % … +100 % of the known net, final net ≥ 1 cent.
          const change = net.times(changePermille).divToInt(1000);
          const finalNet = Decimal.max(1, net.plus(change));
          const delta = finalNet.minus(net);

          const k = await f.inTenant((trx) =>
            createSingleSupplyContract(trx, {
              companyId: f.companyId,
              partyId: party,
              reference: `PF-${String(run)}`,
              contractDate: '2026-11-01',
              knownNet: dec(net),
              confirmedBy: owner,
              idempotencyKey: `pf-contract-${String(run)}`,
            }),
          );
          const entries: string[] = [];
          for (const [i, r] of receipts.entries()) {
            const v = await f.inTenant((trx) =>
              recordSingleSupplyReceipt(trx, {
                companyId: f.companyId,
                contractId: k.contractId,
                receiptDate: '2026-11-15',
                gross: dec(r),
                depositTo: { accountId: f.acct['1010'] ?? '' },
                idempotencyKey: `pf-${String(run)}-${String(i)}`,
              }),
            );
            entries.push(v.entryId);
          }
          const expectedTax = whole.plus(gstOf(delta));
          const gross = finalNet.plus(expectedTax);
          const attempt = f.inTenant((trx) =>
            finaliseSingleSupply(trx, {
              companyId: f.companyId,
              contractId: k.contractId,
              invoiceDate: '2026-12-15',
              lines: [
                { description: 'Completed', productProfileId: profile, amount: dec(finalNet) },
              ],
              ...(delta.isZero()
                ? {}
                : { priceChange: { variationDate: '2026-12-15', reason: 'Agreed at completion' } }),
              idempotencyKey: `pf-final-${String(run)}`,
              createdBy: owner,
            }),
          );
          if (gross.lt(paid)) {
            await expect(attempt).rejects.toMatchObject({ code: 'BELOW_CASH_RECEIVED' });
            return;
          }
          const inv = await attempt;
          expect(inv.taxTotal).toBe(num(expectedTax));
          expect(inv.grossTotal).toBe(num(gross));
          expect(inv.amountDue).toBe(num(gross.minus(paid)));
          // One rounding each for the fixed GST and the change: within a cent of 10 % of the final net.
          expect(expectedTax.minus(finalNet.times('0.1')).abs().lte(1)).toBe(true);
          entries.push(inv.entryId);

          const r = await f.inTenant(
            async (trx) =>
              (
                await sql<{
                  unbalanced: number;
                  gst: string;
                  unbilled: string;
                  liability: string;
                  ar_open: string;
                  line_tax: string;
                }>`
                  WITH l AS (
                    SELECT l.*, rb.role,
                           (${k.dimensionValueId}::uuid = ANY(s.value_ids)) AS on_contract
                      FROM app.journal_line l
                      JOIN app.dimension_set s ON s.id = l.dimension_set_id
                      LEFT JOIN app.account_role_binding rb ON rb.account_id = l.account_id
                     WHERE l.entry_id = ANY(${sql.val(entries)}::uuid[]))
                  SELECT
                    (SELECT count(*)::int FROM (SELECT entry_id FROM l GROUP BY entry_id
                       HAVING sum(debit) <> sum(credit)) u) AS unbalanced,
                    (SELECT coalesce(sum(credit - debit), 0) FROM l WHERE role = 'GST_COLLECTED')::text AS gst,
                    (SELECT coalesce(sum(debit - credit), 0) FROM l
                      WHERE role = 'GST_ATTRIBUTED_UNBILLED' AND on_contract)::text AS unbilled,
                    (SELECT coalesce(sum(credit - debit), 0) FROM l
                      WHERE role = 'CUSTOMER_PREPAYMENTS' AND on_contract)::text AS liability,
                    (SELECT coalesce(sum(open_amount), 0) FROM app.subledger_entry
                      WHERE entry_id = ${inv.entryId}::uuid)::text AS ar_open,
                    (SELECT coalesce(sum(tax), 0) FROM app.sales_invoice_line
                      WHERE invoice_id = ${inv.invoiceId}::uuid)::text AS line_tax`.execute(trx)
              ).rows[0],
          );
          const n4 = (s: string | undefined) => num(toCents(s));
          expect(r?.unbalanced).toBe(0);
          expect(n4(r?.gst)).toBe(num(expectedTax));
          expect(n4(r?.unbilled)).toBe('0.0000');
          expect(n4(r?.liability)).toBe('0.0000');
          expect(n4(r?.ar_open)).toBe(num(gross.minus(paid)));
          expect(n4(r?.line_tax)).toBe(num(expectedTax));
        },
      ),
    );
  }, 900_000);
});
