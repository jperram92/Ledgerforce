/**
 * Aged-AR invariants through the real AR code paths (T-0049, RQ-0122), against a real
 * PostgreSQL as lf_app, default fast-check run count. Each run adds a customer with 1–3 posted
 * invoices (random dates and terms), an optional receipt allocated in part or in full with an
 * optional over-payment, an optional credit note, an optional unallocation — then picks a random
 * as-at date. State accumulates across runs, so later runs check ever larger ledgers.
 *
 * INV-aged-ar-control  Σ ageing buckets + unallocated credits = AR control balance as at the date
 *                      (base currency; single currency, so no unposted FX), for the whole company.
 * INV-aged-ar-party    each party's statement from the fiscal-year start to the date closes on its
 *                      aged total, and its balance due / overdue equal its aged totals.
 */
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGEING_BUCKETS } from './ageing.ts';
import {
  agedReceivables,
  customerReceivableTotals,
  customerStatement,
} from './aged-receivables.ts';
import { approveCreditNote, createCreditNote, postCreditNote } from './credit-notes.ts';
import { recordReceipt, unallocateReceipt } from './receipts.ts';
import { autoApproveSalesInvoice, createSalesInvoice } from './sales-invoices.ts';
import { setupCreditNotes } from './testing/credit-note-world.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';
import { setupReceipts, type ReceiptWorld } from './testing/receipt-world.ts';
import { sql } from 'kysely';

let f: LedgerFixture;
let w: InvoiceWorld;
let rw: ReceiptWorld;
let approver: string;

const X = 'XXX';
const m = (s: string) => Money.of(s, X);
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 6, 1); // FY2027 starts 2026-07-01
const iso = (offset: number) => new Date(BASE + offset * DAY).toISOString().slice(0, 10);
/** Integer cents → plain decimal text (bigint, never floats). */
const text = (cents: bigint): string =>
  `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004903');
  approver = await f.addUser('approver');
  ({ w, rw } = await f.inTenant(async (trx) => {
    const world = await setupInvoicing(trx, f.companyId);
    await setupCreditNotes(trx, f.companyId);
    return { w: world, rw: await setupReceipts(trx, f.companyId) };
  }));
}, 120_000);

afterAll(async () => {
  await f?.close();
});

const run = fc.record({
  invoices: fc.array(
    fc.record({
      net: fc.integer({ min: 1, max: 500_000 }),
      day: fc.integer({ min: 0, max: 200 }),
      terms: fc.integer({ min: 0, max: 120 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  receipt: fc.option(
    fc.record({
      after: fc.integer({ min: 0, max: 60 }),
      /** Percent of the first invoice allocated (1–100). */
      share: fc.integer({ min: 1, max: 100 }),
      overpay: fc.integer({ min: 0, max: 50_000 }),
      unallocate: fc.boolean(),
    }),
  ),
  creditNote: fc.option(
    fc.record({ after: fc.integer({ min: 0, max: 60 }), net: fc.integer({ min: 1, max: 100 }) }),
  ),
  asOf: fc.integer({ min: 0, max: 364 }),
});

describe('SS-PLAT-190: aged-AR invariants (INV-aged-ar-control, INV-aged-ar-party)', () => {
  it('SS-PLAT-190 hold for every as-at date after every run', async () => {
    await fc.assert(
      fc.asyncProperty(run, async (r) => {
        await f.inTenant(async (trx) => {
          const party = (
            await newCustomer(trx, f.companyId, { name: `Cust ${randomUUID().slice(0, 8)}` })
          ).partyId;
          const posted: { id: string; day: number; firstLineId: string }[] = [];
          for (const i of r.invoices) {
            const { id } = await createSalesInvoice(trx, {
              input: {
                companyId: f.companyId,
                partyId: party,
                invoiceDate: iso(i.day),
                dueDate: iso(i.day + i.terms),
                amountsAre: 'exclusive',
                lines: [
                  { productId: w.products.PROFESSIONAL_SERVICES, amount: text(BigInt(i.net)) },
                ],
              },
              createdBy: null,
              idempotencyKey: randomUUID(),
            });
            const p = await autoApproveSalesInvoice(trx, {
              id,
              settings: { autoApprove: true, threshold: '100000000.0000' },
            });
            if (p.outcome !== 'posted') throw new Error(`not posted: ${p.reason}`);
            const line = await sql<{ id: string }>`
              SELECT id::text FROM app.sales_invoice_line WHERE invoice_id = ${id} ORDER BY line_no LIMIT 1`.execute(
              trx,
            );
            posted.push({ id, day: i.day, firstLineId: line.rows[0]?.id ?? '' });
          }
          const first = posted[0];
          const firstNet = BigInt(r.invoices[0]?.net ?? 0);
          if (!first) throw new Error('no invoice');
          const lastDay = Math.max(...posted.map((p) => p.day));

          if (r.receipt) {
            // Allocate share% of the first invoice's gross (net × 1.1, in cents), ≥ 1 cent.
            const gross = (firstNet * 11n) / 10n;
            const alloc =
              r.receipt.share === 100 ? gross : (gross * BigInt(r.receipt.share)) / 100n || 1n;
            const day = lastDay + r.receipt.after;
            const rec = await recordReceipt(trx, {
              input: {
                companyId: f.companyId,
                partyId: party,
                receiptDate: iso(day),
                amount: text(alloc + BigInt(r.receipt.overpay)),
                method: 'eft',
                depositTo: { kind: 'bank', bankAccountId: rw.operatingBankAccountId },
                allocations: [{ invoiceId: first.id, amount: text(alloc) }],
              },
              idempotencyKey: randomUUID(),
            });
            if (r.receipt.unallocate) {
              await unallocateReceipt(trx, {
                receiptId: rec.receiptId,
                allocationId: rec.allocations[0]?.allocationId ?? '',
                date: iso(day + 1),
                idempotencyKey: randomUUID(),
              });
            }
          }
          if (r.creditNote) {
            const net = BigInt(r.creditNote.net) > firstNet ? firstNet : BigInt(r.creditNote.net);
            const { id } = await createCreditNote(trx, {
              input: {
                companyId: f.companyId,
                invoiceId: first.id,
                creditNoteDate: iso(first.day + r.creditNote.after),
                reason: 'Property run',
                lines: [{ invoiceLineId: first.firstLineId, amount: text(net) }],
              },
              createdBy: null,
              idempotencyKey: randomUUID(),
            });
            await approveCreditNote(trx, { id, approvedBy: approver });
            await postCreditNote(trx, { id });
          }

          const asOf = iso(r.asOf);
          const aged = await agedReceivables(trx, { companyId: f.companyId, asOf });
          const control = (
            await subledgerReconciliation(trx, { companyId: f.companyId, asOf })
          ).find((x) => x.controlRole === 'AR_CONTROL');
          // INV-aged-ar-control
          const buckets = AGEING_BUCKETS.reduce((s, b) => s.add(m(aged.totals[b])), m('0'));
          expect(buckets.add(m(aged.totals.unallocatedCredits)).toNumericString()).toBe(
            m(control?.controlBalance ?? 'x').toNumericString(),
          );
          expect(aged.totals.total).toBe(m(control?.controlBalance ?? 'x').toNumericString());
          expect(aged.reconciliation.reconciled).toBe(true);

          // INV-aged-ar-party (this run's customer; earlier customers were checked in their run)
          const mine = aged.parties.find((p) => p.partyId === party);
          const expected = mine?.totals.total ?? '0.0000';
          const s = await customerStatement(trx, {
            companyId: f.companyId,
            partyId: party,
            from: iso(0),
            to: asOf,
          });
          const closing = s.sections.reduce((acc, x) => acc.add(m(x.closingBalance)), m('0'));
          expect(closing.toNumericString()).toBe(expected);
          for (const x of s.sections) expect(x.reconciled).toBe(true);
          const t = await customerReceivableTotals(trx, {
            companyId: f.companyId,
            partyId: party,
            asOf,
          });
          expect(t.balanceDue).toBe(expected);
          expect(t.overdueAmount).toBe(mine?.totals.overdue ?? '0.0000');
        });
      }),
    );
  }, 600_000);
});
