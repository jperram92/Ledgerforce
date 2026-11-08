/**
 * Invariants of customer receipts through the real code paths (T-0046, RQ-0112), against a real
 * PostgreSQL as lf_app, default fast-check run count. Each run posts an invoice through the
 * sales-invoice code, records a receipt allocated to part, all or none of it — leaving any
 * over-payment unallocated — and optionally unallocates it again (reversal only).
 *
 * INV-ar-control   AR subledger = AR control after every step (subledgerReconciliation, no drift).
 * INV-balance      the receipt entry balances: Σ debit = Σ credit = amount received.
 * INV-status       invoice open = total − live allocations; status paid / part_paid / unpaid
 *                  derived from it; receipt unallocated = amount − live allocations.
 * INV-reversal     unallocating restores the invoice and the receipt credit exactly.
 */
import { subledgerDrift, subledgerReconciliation } from '@ledgerforce/ledger';
import {
  createLedgerFixture,
  storedJournal,
  type LedgerFixture,
} from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReceipt, invoicePaymentStatus, recordReceipt, unallocateReceipt } from './receipts.ts';
import { autoApproveSalesInvoice, createSalesInvoice } from './sales-invoices.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';
import { setupReceipts, type ReceiptWorld } from './testing/receipt-world.ts';

let f: LedgerFixture;
let w: InvoiceWorld;
let rw: ReceiptWorld;
let acme: string;

const X = 'XXX';
const m = (s: string) => Money.of(s, X);
/** Integer cents → plain decimal text (bigint, never floats). */
const text = (cents: bigint): string =>
  `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
const cents = (s: string): bigint => {
  const [i = '0', d = ''] = s.split('.');
  return BigInt(i) * 100n + BigInt(d.padEnd(2, '0').slice(0, 2));
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004603');
  ({ w, rw } = await f.inTenant(async (trx) => ({
    w: await setupInvoicing(trx, f.companyId),
    rw: await setupReceipts(trx, f.companyId),
  })));
  acme = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Acme Pty Ltd' })))
    .partyId;
});

afterAll(async () => {
  await f?.close();
});

const step = fc.record({
  net: fc.integer({ min: 1, max: 1_000_000 }),
  /** Share of the invoice total allocated, in percent (≥ 1 cent). */
  share: fc.integer({ min: 1, max: 100 }),
  overpay: fc.integer({ min: 0, max: 50_000 }),
  undeposited: fc.boolean(),
  unallocate: fc.boolean(),
});

describe('receipt invariants (INV-ar-control, INV-balance, INV-status, INV-reversal)', () => {
  it('hold after every receipt and unallocation', async () => {
    await fc.assert(
      fc.asyncProperty(step, async (s) => {
        await f.inTenant(async (trx) => {
          const { id: invoiceId } = await createSalesInvoice(trx, {
            input: {
              companyId: f.companyId,
              partyId: acme,
              invoiceDate: '2026-11-05',
              dueDate: '2026-11-30',
              lines: [{ productId: w.products.PROFESSIONAL_SERVICES, amount: text(BigInt(s.net)) }],
            },
            createdBy: null,
            idempotencyKey: randomUUID(),
          });
          const posted = await autoApproveSalesInvoice(trx, {
            id: invoiceId,
            settings: { autoApprove: true, threshold: '100000000.0000' },
          });
          if (posted.outcome !== 'posted') throw new Error(`not posted: ${posted.reason}`);
          // share % of the invoice total, rounded down to cents (at least one cent), in integer
          // cent units (bigint) from here on, as in the ledger's subledger property test.
          const totalU = cents((await invoicePaymentStatus(trx, invoiceId)).total);
          const shareU = cents(
            m(text(totalU))
              .mul(`0.${String(s.share).padStart(2, '0')}`, { scale: 2, rounding: 'down' })
              .toNumericString(),
          );
          const allocU = s.share === 100 ? totalU : shareU < 1n ? 1n : shareU;
          const receivedU = allocU + BigInt(s.overpay);

          const r = await recordReceipt(trx, {
            input: {
              companyId: f.companyId,
              partyId: acme,
              receiptDate: '2026-11-15',
              amount: text(receivedU),
              method: s.undeposited ? 'cash' : 'eft',
              depositTo: s.undeposited
                ? { kind: 'undeposited_funds' }
                : { kind: 'bank', bankAccountId: rw.operatingBankAccountId },
              allocations: [{ invoiceId, amount: text(allocU) }],
            },
            idempotencyKey: randomUUID(),
          });

          // INV-balance
          const j = await storedJournal(trx, r.entryId);
          const debit = j.lines.reduce((a, l) => a.add(m(l.debit)), m('0'));
          const credit = j.lines.reduce((a, l) => a.add(m(l.credit)), m('0'));
          expect(debit.toNumericString()).toBe(m(text(receivedU)).toNumericString());
          expect(credit.toNumericString()).toBe(debit.toNumericString());

          // INV-status
          const st = await invoicePaymentStatus(trx, invoiceId);
          expect(st.openAmount).toBe(
            m(st.total)
              .sub(m(text(allocU)))
              .toNumericString(),
          );
          expect(st.status).toBe(allocU === totalU ? 'paid' : 'part_paid');
          expect((await getReceipt(trx, r.receiptId)).unallocated).toBe(
            m(text(receivedU))
              .sub(m(text(allocU)))
              .toNumericString(),
          );

          // INV-ar-control
          const check = async () => {
            const rec = await subledgerReconciliation(trx, { companyId: f.companyId });
            expect(rec.find((x) => x.controlRole === 'AR_CONTROL')?.reconciled).toBe(true);
            expect(await subledgerDrift(trx, f.companyId)).toEqual([]);
          };
          await check();

          if (s.unallocate) {
            // INV-reversal
            await unallocateReceipt(trx, {
              receiptId: r.receiptId,
              allocationId: r.allocations[0]?.allocationId ?? '',
              date: '2026-11-16',
              idempotencyKey: randomUUID(),
            });
            const back = await invoicePaymentStatus(trx, invoiceId);
            expect(back).toMatchObject({ status: 'unpaid', openAmount: st.total });
            expect((await getReceipt(trx, r.receiptId)).unallocated).toBe(
              m(text(receivedU)).toNumericString(),
            );
            await check();
          }
        });
      }),
    );
  }, 300_000);
});
