/**
 * Bill posting invariants (T-0050) against a real PostgreSQL as lf_app, default fast-check numRuns.
 *
 * For random bills (1–4 positive lines, accounts, tax codes GST/CAP/FRE, exclusive or inclusive):
 *  INV-balance     the posted entry balances (Σdebit = Σcredit)
 *  INV-ap-control  AP subledger = AP control after every post (subledgerReconciliation)
 *  open item       the bill's AP open item is −(the AP control credit), dated by the bill
 *  preview = post  previewBill's lines equal what postBill stored
 * Amounts are bigint cents formatted as decimal strings (no floating point).
 * T-0052 (DL-0330): each bill is submitted and approved (without posting) before postBill.
 */
import { subledgerEntriesOf, subledgerReconciliation } from '@ledgerforce/ledger';
import { storedJournal } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBill, submitBill } from './bill-approval.ts';
import { createBill, postBill, previewBill } from './bills.ts';
import { createBillWorld, type BillWorld } from './testing/bill-world.ts';

let w: BillWorld;
beforeAll(async () => {
  w = await createBillWorld('01900000-0000-7000-8000-000000005002');
});
afterAll(async () => {
  await w.close();
});

const cents = (c: bigint) => {
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};
const sum = (xs: string[]) => xs.reduce((t, x) => t.add(Money.of(x, 'AUD')), Money.zero('AUD'));

let n = 0;

describe('bill posting invariants', () => {
  it('INV-balance, INV-ap-control, open item and preview = post hold for random bills', async () => {
    const line = fc.record({
      amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
      account: fc.constantFrom('office', 'computers', 'rent') as fc.Arbitrary<
        'office' | 'computers' | 'rent'
      >,
      taxCode: fc.constantFrom('GST', 'CAP', 'FRE'),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(line, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('exclusive', 'inclusive') as fc.Arbitrary<'exclusive' | 'inclusive'>,
        fc.integer({ min: 1, max: 28 }),
        async (lines, amountsAre, day) => {
          n += 1;
          const billDate = `2026-11-${String(day).padStart(2, '0')}`;
          const bill = await w.inTenant((trx) =>
            createBill(trx, {
              companyId: w.companyId,
              supplierId: w.supplierId,
              supplierRef: `PROP-${String(n)}`,
              billDate,
              dueDate: '2026-12-31',
              amountsAre,
              lines: lines.map((l, i) => ({
                description: `line ${String(i + 1)}`,
                amount: cents(l.amount),
                accountId: w.acct[l.account],
                taxCode: l.taxCode,
              })),
            }),
          );
          const p = await w.inTenant((trx) => previewBill(trx, bill.id));
          await w.inTenant(async (trx) => {
            await submitBill(trx, { billId: bill.id, submittedBy: w.users.apClerk });
            const a = await approveBill(trx, {
              billId: bill.id,
              approvedBy: w.users.approver,
              post: false,
            });
            if (a.outcome !== 'approved') throw new Error(`approval denied: ${a.rule}`);
          });
          const r = await w.inTenant((trx) => postBill(trx, bill.id));
          const j = await w.inTenant((trx) => storedJournal(trx, r.entryId));

          expect(sum(j.lines.map((l) => l.debit)).equals(sum(j.lines.map((l) => l.credit)))).toBe(
            true,
          );
          expect(j.lines.map((l) => [l.accountId, l.debit, l.credit, l.taxAmount])).toEqual(
            p.entry.lines.map((l) => [l.accountId, l.debit, l.credit, l.taxAmount]),
          );
          const control = j.lines.filter((l) => l.accountId === w.acct.apControl);
          expect(control).toHaveLength(1);
          const items = await w.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
          expect(items).toHaveLength(1);
          expect(items[0]?.originalAmount).toBe(
            Money.of(control[0]?.credit ?? '0', 'AUD')
              .negate()
              .toNumericString(),
          );
          expect(items[0]?.documentDate).toBe(billDate);
          const rec = await w.inTenant((trx) =>
            subledgerReconciliation(trx, { companyId: w.companyId }),
          );
          for (const x of rec) expect(x.reconciled, `${x.controlRole} ${x.difference}`).toBe(true);
        },
      ),
    );
  });
});
