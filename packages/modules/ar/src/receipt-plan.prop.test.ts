/**
 * Properties of the receipt allocation plan (T-0046, RQ-0112), default fast-check run count.
 *
 * - Conservation: Σ allocated + unallocated = amount received, exactly (decimal.js, no floats).
 * - Each invoice's open amount after = before − allocated ≥ 0, and its status is the one derived
 *   from the open amount (paid at 0, unpaid when untouched, part paid in between).
 * - Any request above an invoice's open amount, or a total above the receipt, is refused.
 */
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ReceiptError, paymentStatusOf, planReceiptAllocations } from './receipt-plan.ts';

/** Integer cents → plain decimal text (bigint arithmetic only, never floats). */
const text = (cents: number | bigint): string => {
  const b = BigInt(cents);
  return `${(b / 100n).toString()}.${(b % 100n).toString().padStart(2, '0')}`;
};
/** ⌊total × share / 100⌋ cents, at least one cent. */
const shareOf = (total: number, share: number): bigint => {
  const c = (BigInt(total) * BigInt(share)) / 100n;
  return c < 1n ? 1n : c;
};

const scenario = fc
  .array(
    fc.record({
      total: fc.integer({ min: 1, max: 5_000_000 }),
      share: fc.integer({ min: 0, max: 100 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .chain((invs) =>
    fc.record({
      invoices: fc.constant(
        invs.map((x, i) => ({ invoiceId: `i${String(i)}`, total: x.total, share: x.share })),
      ),
      extra: fc.integer({ min: 0, max: 1_000_000 }),
    }),
  );

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReceiptError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('receipt plan properties', () => {
  it('conserves the amount received and derives each status from the open amount', () => {
    fc.assert(
      fc.property(scenario, ({ invoices, extra }) => {
        const requests = invoices
          .map((x) => ({ invoiceId: x.invoiceId, cents: shareOf(x.total, x.share) }))
          .map((r) => ({ invoiceId: r.invoiceId, amount: text(r.cents), cents: r.cents }));
        const sum = requests.reduce((s, r) => s + r.cents, 0n);
        const available = text(sum + BigInt(extra));
        const plan = planReceiptAllocations({
          available,
          invoices: invoices.map((x) => ({
            invoiceId: x.invoiceId,
            total: text(x.total),
            openAmount: text(x.total),
          })),
          requests: requests.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
        });
        const allocated = Money.of(plan.allocated, 'XXX');
        expect(allocated.add(Money.of(plan.unallocated, 'XXX')).toNumericString()).toBe(
          Money.of(available, 'XXX').toNumericString(),
        );
        expect(Money.of(plan.unallocated, 'XXX').isNegative()).toBe(false);
        for (const [i, row] of plan.rows.entries()) {
          const x = invoices[i];
          if (!x) throw new Error('row without invoice');
          const after = Money.of(row.openBefore, 'XXX').sub(Money.of(row.amount, 'XXX'));
          expect(row.openAfter).toBe(after.toNumericString());
          expect(after.isNegative()).toBe(false);
          expect(row.statusAfter).toBe(paymentStatusOf(text(x.total), row.openAfter));
          expect(row.statusAfter === 'paid').toBe(after.isZero());
        }
      }),
    );
  });

  it('refuses any request above the open amount or above the amount received', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (open, over) => {
          const invoices = [{ invoiceId: 'i', total: text(open), openAmount: text(open) }];
          const tooMuch = () =>
            planReceiptAllocations({
              available: text(BigInt(open) + BigInt(over)),
              invoices,
              requests: [{ invoiceId: 'i', amount: text(BigInt(open) + BigInt(over)) }],
            });
          expect(tooMuch).toThrow(ReceiptError);
          expect(codeOf(tooMuch)).toBe('OVER_ALLOCATION');
          expect(
            codeOf(() =>
              planReceiptAllocations({
                available: text(open),
                invoices: [
                  {
                    invoiceId: 'i',
                    total: text(BigInt(open) + BigInt(over)),
                    openAmount: text(BigInt(open) + BigInt(over)),
                  },
                ],
                requests: [{ invoiceId: 'i', amount: text(BigInt(open) + BigInt(over)) }],
              }),
            ),
          ).toBe('EXCEEDS_RECEIPT');
        },
      ),
    );
  });
});
