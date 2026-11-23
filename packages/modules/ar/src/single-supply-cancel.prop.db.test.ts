/**
 * SS-PLAT-182 / T-0217 — single-supply invariants over cancellation and refund (ADR-0089 R11,
 * GP-044a–d), against a real PostgreSQL as lf_app. Default numRuns (100), never lowered. Amounts
 * are integer cents handled as Decimal; nothing uses floating point. The expected figures are
 * derived here independently from the receipts recorded on the contract.
 */
import { randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import { setTaxSettings } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveCustomerRefund, createCustomerRefund, payCustomerRefund } from './refunds.ts';
import { createSingleSupplyContract, recordSingleSupplyReceipt } from './single-supply.ts';
import { cancelSingleSupply, refundCancelledSingleSupply } from './single-supply-cancel.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let party = '';
let owner = '';
let approver = '';
let bank = '';
let run = 0;

const num = (c: Decimal) => Money.of(c.div(100), 'XXX').toNumericString();
const dec = (c: Decimal) => c.div(100).toString();
const toCents = (s: string | undefined) => new Decimal(s ?? '0').times(100);
/** 10 % of a cents amount, half-up. */
const gstOf = (c: Decimal) => c.plus(5).divToInt(10);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000021702');
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'PropCancel',
    billDate: '2026-11-01',
  });
  owner = await f.addUser('owner');
  approver = await f.addUser('owner');
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

describe('SS-PLAT-182: single-supply invariants over cancellation and refund (ADR-0089 R11)', () => {
  it('SS-PLAT-182 AC-2 every entry balances; after cancellation the unbilled GST is zero and the GST left on the contract is the GST on the money still held (agreed: 0 with an AR credit = cash received; undecided: the GST of the receipts); after the refund every contract balance, the GST and the AR open items are zero [T-0217]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 2n, max: 10n ** 9n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 0, maxLength: 4 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.boolean(),
        async (netGen, weights, paidPermille, agreedGen) => {
          let agreed = agreedGen;
          run += 1;
          const net = new Decimal(netGen.toString());
          const total = net.plus(gstOf(net));
          // Receive a share of the total (none when there are no weights), split into receipts.
          const paid =
            weights.length === 0
              ? new Decimal(0)
              : Decimal.max(1, total.times(paidPermille).divToInt(1000));
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
          const k = await f.inTenant((trx) =>
            createSingleSupplyContract(trx, {
              companyId: f.companyId,
              partyId: party,
              reference: `PC-${String(run)}`,
              contractDate: '2026-11-01',
              knownNet: dec(net),
              confirmedBy: owner,
              idempotencyKey: `pc-contract-${String(run)}`,
            }),
          );
          const entries: string[] = [];
          let receivedTax = new Decimal(0);
          let receivedNet = new Decimal(0);
          for (const [i, r] of receipts.entries()) {
            const v = await f.inTenant((trx) =>
              recordSingleSupplyReceipt(trx, {
                companyId: f.companyId,
                contractId: k.contractId,
                receiptDate: '2026-11-15',
                gross: dec(r),
                depositTo: { accountId: bank },
                idempotencyKey: `pc-${String(run)}-${String(i)}`,
              }),
            );
            entries.push(v.entryId);
            receivedTax = receivedTax.plus(toCents(v.tax));
            receivedNet = receivedNet.plus(toCents(v.net));
          }
          // A rounding-only residue (nothing unbilled by net but GST left, or GST below zero) has
          // no GP-044c line: refused by name with nothing written, then cancelled as agreed.
          const unbilledNet = net.minus(receivedNet);
          const unbilledTax = paid.isZero() ? new Decimal(0) : gstOf(net).minus(receivedTax);
          const residue =
            !paid.isZero() &&
            !(unbilledNet.isZero() && unbilledTax.isZero()) &&
            (!unbilledNet.gt(0) || unbilledTax.isNegative());
          if (!agreed && residue) {
            await expect(
              f.inTenant((trx) =>
                cancelSingleSupply(trx, {
                  companyId: f.companyId,
                  contractId: k.contractId,
                  cancelDate: '2026-12-05',
                  refund: 'undecided',
                  reason: 'Cancelled by the customer',
                  idempotencyKey: `pc-cancel-residue-${String(run)}`,
                  createdBy: owner,
                }),
              ),
            ).rejects.toMatchObject({ code: 'ROUNDING_RESIDUE_NOT_COVERED' });
            agreed = true;
          }
          const cancelled = await f.inTenant((trx) =>
            cancelSingleSupply(trx, {
              companyId: f.companyId,
              contractId: k.contractId,
              cancelDate: '2026-12-05',
              refund: agreed ? 'agreed' : 'undecided',
              reason: 'Cancelled by the customer',
              idempotencyKey: `pc-cancel-${String(run)}`,
              createdBy: owner,
            }),
          );
          if (cancelled.entryId) entries.push(cancelled.entryId);

          const state = async () =>
            (await f.inTenant(
              async (trx) =>
                (
                  await sql<{
                    unbalanced: number;
                    gst: string;
                    unbilled: string;
                    liability: string;
                    ar: string;
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
                        (SELECT coalesce(sum(open_amount), 0) FROM app.subledger_entry
                          WHERE entry_id = ANY(${sql.val(entries)}::uuid[]))::text AS ar,
                        (SELECT coalesce(sum(debit - credit), 0) FROM l
                          WHERE account_id = ${bank}::uuid)::text AS bank`.execute(trx)
                ).rows[0],
            )) ?? { unbalanced: -1, gst: '', unbilled: '', liability: '', ar: '', bank: '' };
          const n4 = (s: string) => num(toCents(s));
          const s1 = await state();
          expect(s1.unbalanced).toBe(0);
          expect(n4(s1.unbilled)).toBe('0.0000');
          expect(n4(s1.bank)).toBe(num(paid));
          if (agreed) {
            expect(n4(s1.gst)).toBe('0.0000');
            expect(n4(s1.liability)).toBe('0.0000');
            expect(n4(s1.ar)).toBe(num(paid.neg()));
            expect(cancelled.customerCredit).toBe(num(paid));
          } else {
            expect(n4(s1.gst)).toBe(num(receivedTax));
            expect(n4(s1.liability)).toBe(num(paid.minus(receivedTax)));
            expect(n4(s1.ar)).toBe('0.0000');
          }
          if (cancelled.adjustmentNote) {
            expect(new Decimal(cancelled.adjustmentNote.decreaseGross)).toEqual(
              new Decimal(cancelled.adjustmentNote.decreaseNet).plus(
                cancelled.adjustmentNote.decreaseTax,
              ),
            );
          }
          if (paid.isZero()) {
            expect(cancelled.entryId).toBeNull();
            return;
          }

          if (agreed) {
            const refundId = randomUUID();
            await f.inTenant((trx) =>
              createCustomerRefund(trx, {
                companyId: f.companyId,
                id: refundId,
                partyId: party,
                refundDate: '2026-12-12',
                amount: dec(paid),
                method: 'bank_batch',
                createdBy: owner,
              }),
            );
            await f.inTenant((trx) =>
              approveCustomerRefund(trx, {
                companyId: f.companyId,
                refundId,
                approvedBy: approver,
              }),
            );
            const r = await f.inTenant((trx) =>
              payCustomerRefund(trx, {
                companyId: f.companyId,
                refundId,
                paidOn: '2026-12-12',
                bankAccountId: bank,
              }),
            );
            entries.push(r.entryId ?? '');
          } else {
            const r = await f.inTenant((trx) =>
              refundCancelledSingleSupply(trx, {
                companyId: f.companyId,
                contractId: k.contractId,
                refundDate: '2027-01-20',
                payFrom: { accountId: bank },
                reason: 'Refund agreed',
                createdBy: owner,
                approvedBy: approver,
                idempotencyKey: `pc-refund-${String(run)}`,
              }),
            );
            expect(r.gross).toBe(num(paid));
            expect(r.tax).toBe(num(receivedTax));
            entries.push(r.entryId);
          }
          const s2 = await state();
          expect(s2.unbalanced).toBe(0);
          expect(n4(s2.gst)).toBe('0.0000');
          expect(n4(s2.unbilled)).toBe('0.0000');
          expect(n4(s2.liability)).toBe('0.0000');
          expect(n4(s2.ar)).toBe('0.0000');
          expect(n4(s2.bank)).toBe('0.0000');
        },
      ),
    );
  }, 900_000);
});
