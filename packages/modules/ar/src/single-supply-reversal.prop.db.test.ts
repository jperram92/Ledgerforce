/**
 * SS-PLAT-205 / T-0231 — single-supply invariants over receipts and their reversals (ADR-0089
 * R11, INV-reversal, GP-019, GP-040a/b), against a real PostgreSQL as lf_app. Default numRuns
 * (100), never lowered. Amounts are integer cents handled as Decimal; nothing uses floating point.
 *
 * Each run records receipts, reverses the latest ones (last in, first out), records more receipts
 * (the first one after every receipt was reversed attributes the whole GST again), checks the
 * contract against the receipts left standing, then reverses everything and checks that every
 * figure of the contract returns to zero. The expected figures are derived here from the receipts
 * the module recorded, independently of the contract view.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import { setTaxSettings } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSingleSupplyContract,
  recordSingleSupplyReceipt,
  singleSupplyContract,
  type SingleSupplyReceiptView,
} from './single-supply.ts';
import { reverseSingleSupplyReceipt } from './single-supply-reversal.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let party = '';
let owner = '';
let bank = '';
let run = 0;

const num = (c: Decimal) => Money.of(c.div(100), 'XXX').toNumericString();
const dec = (c: Decimal) => c.div(100).toString();
const toCents = (s: string | undefined) => new Decimal(s ?? '0').times(100);
/** 10 % of a cents amount, half-up. */
const gstOf = (c: Decimal) => c.plus(5).divToInt(10);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000023102');
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'PropReverse',
    billDate: '2026-11-01',
  });
  owner = await f.addUser('owner');
  bank = f.acct['1010'] ?? '';
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

describe('SS-PLAT-205: single-supply invariants over receipts and reversals (ADR-0089 R11, INV-reversal)', () => {
  it('SS-PLAT-205 AC-3 every entry balances; after last-in-first-out reversals the contract liability, unbilled GST and GST collected equal those of the receipts left standing (whole GST attributed while any stands); reversing every receipt returns every figure of the contract to zero [T-0231]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 2n, max: 10n ** 9n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 4 }),
        fc.nat({ max: 4 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 0, maxLength: 3 }),
        async (netGen, first, reverseCount, second) => {
          run += 1;
          const net = new Decimal(netGen.toString());
          const whole = gstOf(net);
          const total = net.plus(whole);
          const k = await f.inTenant((trx) =>
            createSingleSupplyContract(trx, {
              companyId: f.companyId,
              partyId: party,
              reference: `PR-${String(run)}`,
              contractDate: '2026-11-01',
              knownNet: dec(net),
              confirmedBy: owner,
              idempotencyKey: `pr-contract-${String(run)}`,
            }),
          );
          const entries: string[] = [];
          const standing: SingleSupplyReceiptView[] = [];
          let n = 0;
          let reversals = 0;
          const receiveShares = async (weights: readonly number[], date: string) => {
            for (const w of weights) {
              const received = standing.reduce((s, r) => s.plus(toCents(r.gross)), new Decimal(0));
              const left = total.minus(received);
              if (left.lte(0)) return;
              const gross = Decimal.min(left, Decimal.max(1, left.times(w).divToInt(1000)));
              const v = await f.inTenant((trx) =>
                recordSingleSupplyReceipt(trx, {
                  companyId: f.companyId,
                  contractId: k.contractId,
                  receiptDate: date,
                  gross: dec(gross),
                  depositTo: { accountId: bank },
                  idempotencyKey: `pr-${String(run)}-${String(++n)}`,
                }),
              );
              // The first receipt standing attributes the whole GST; later ones never do.
              expect(v.attributes).toBe(standing.length === 0);
              entries.push(v.entryId);
              standing.push(v);
            }
          };
          const reverseLatest = async (count: number, date: string) => {
            for (let i = 0; i < count && standing.length > 0; i += 1) {
              const last = standing[standing.length - 1];
              if (!last) return;
              if (standing.length > 1) {
                // Last in, first out: an earlier receipt is refused while a later one stands.
                await expect(
                  f.inTenant((trx) =>
                    reverseSingleSupplyReceipt(trx, {
                      companyId: f.companyId,
                      receiptId: standing[0]?.receiptId ?? '',
                      reversalDate: date,
                      reason: 'Out of order',
                      idempotencyKey: `pr-${String(run)}-early-${String(++reversals)}`,
                    }),
                  ),
                ).rejects.toMatchObject({ code: 'NOT_LATEST_RECEIPT' });
              }
              const v = await f.inTenant((trx) =>
                reverseSingleSupplyReceipt(trx, {
                  companyId: f.companyId,
                  receiptId: last.receiptId,
                  reversalDate: date,
                  reason: 'Payment dishonoured',
                  idempotencyKey: `pr-${String(run)}-v${String(++reversals)}`,
                }),
              );
              expect(v.unattributes).toBe(last.attributes);
              entries.push(v.entryId);
              standing.pop();
            }
          };

          const state = async () =>
            (await f.inTenant(
              async (trx) =>
                (
                  await sql<{
                    unbalanced: number;
                    gst: string;
                    unbilled: string;
                    liability: string;
                    bank: string;
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
                      (SELECT coalesce(sum(debit - credit), 0) FROM l
                        WHERE account_id = ${bank}::uuid)::text AS bank`.execute(trx)
                ).rows[0],
            )) ?? { unbalanced: -1, gst: '', unbilled: '', liability: '', bank: '' };
          const n4 = (s: string) => num(toCents(s));
          const expectStanding = async () => {
            const gross = standing.reduce((s, r) => s.plus(toCents(r.gross)), new Decimal(0));
            const tax = standing.reduce((s, r) => s.plus(toCents(r.tax)), new Decimal(0));
            const attributed = standing.length === 0 ? new Decimal(0) : whole;
            const s = await state();
            expect(s.unbalanced).toBe(0);
            expect(n4(s.bank)).toBe(num(gross));
            expect(n4(s.gst)).toBe(num(attributed));
            expect(n4(s.liability)).toBe(num(gross.minus(tax)));
            expect(n4(s.unbilled)).toBe(num(attributed.minus(tax)));
            const view = await f.inTenant((trx) =>
              singleSupplyContract(trx, f.companyId, k.contractId),
            );
            expect(view.receivedGross).toBe(num(gross));
            expect(view.receivedTax).toBe(num(tax));
            expect(view.attributedTax).toBe(standing.length === 0 ? null : num(whole));
            expect(view.unbilledTax).toBe(num(attributed.minus(tax)));
          };

          await receiveShares(first, '2026-11-10');
          await reverseLatest(reverseCount, '2026-11-20');
          await receiveShares(second, '2026-11-25');
          await expectStanding();
          await reverseLatest(standing.length, '2026-12-02');
          await expectStanding();
        },
      ),
    );
  }, 900_000);
});
