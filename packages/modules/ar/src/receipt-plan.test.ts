/**
 * The receipt allocation plan and the invoice payment status (T-0046, RQ-0112 Q2/Q3): pure
 * functions shared by recordReceipt, allocateReceipt and previewReceipt.
 */
import { describe, expect, it } from 'vitest';
import { ReceiptError, paymentStatusOf, planReceiptAllocations } from './receipt-plan.ts';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReceiptError) return e.code;
    throw e;
  }
  return 'accepted';
};

const inv = (invoiceId: string, total: string, openAmount = total) => ({
  invoiceId,
  total,
  openAmount,
});

describe('paymentStatusOf — status derived from the AR open item (RQ-0112 Q2)', () => {
  it('unpaid when open = total, part_paid in between, paid at zero', () => {
    expect(paymentStatusOf('1375.0000', '1375.0000')).toBe('unpaid');
    expect(paymentStatusOf('1375.0000', '1000.0000')).toBe('part_paid');
    expect(paymentStatusOf('1375.0000', '0.0000')).toBe('paid');
    expect(paymentStatusOf('1375', '0')).toBe('paid');
  });
});

describe('planReceiptAllocations', () => {
  it('GP-002: 1,375.00 to INV-000123 pays it in full, nothing unallocated', () => {
    expect(
      planReceiptAllocations({
        available: '1375.00',
        invoices: [inv('i1', '1375.0000')],
        requests: [{ invoiceId: 'i1', amount: '1375.00' }],
      }),
    ).toEqual({
      rows: [
        {
          invoiceId: 'i1',
          amount: '1375.0000',
          openBefore: '1375.0000',
          openAfter: '0.0000',
          statusAfter: 'paid',
        },
      ],
      allocated: '1375.0000',
      unallocated: '0.0000',
    });
  });

  it('SS-UC03-08: 375.00 leaves 1,000.00 open, part paid', () => {
    const p = planReceiptAllocations({
      available: '375.00',
      invoices: [inv('i1', '1375.0000')],
      requests: [{ invoiceId: 'i1', amount: '375.00' }],
    });
    expect(p.rows[0]).toMatchObject({ openAfter: '1000.0000', statusAfter: 'part_paid' });
    expect(p.unallocated).toBe('0.0000');
  });

  it('over-payment: the remainder is unallocated', () => {
    const p = planReceiptAllocations({
      available: '1500.00',
      invoices: [inv('i1', '1375.0000')],
      requests: [{ invoiceId: 'i1', amount: '1375.00' }],
    });
    expect(p).toMatchObject({ allocated: '1375.0000', unallocated: '125.0000' });
  });

  it('refuses with a code', () => {
    const base = { available: '100.00', invoices: [inv('i1', '50.00'), inv('i2', '80.00')] };
    expect(codeOf(() => planReceiptAllocations({ ...base, requests: [] }))).toBe('NO_ALLOCATION');
    expect(
      codeOf(() =>
        planReceiptAllocations({ ...base, requests: [{ invoiceId: 'i1', amount: '50.01' }] }),
      ),
    ).toBe('OVER_ALLOCATION');
    expect(
      codeOf(() =>
        planReceiptAllocations({
          ...base,
          requests: [
            { invoiceId: 'i1', amount: '50.00' },
            { invoiceId: 'i2', amount: '50.01' },
          ],
        }),
      ),
    ).toBe('EXCEEDS_RECEIPT');
    expect(
      codeOf(() =>
        planReceiptAllocations({
          ...base,
          requests: [
            { invoiceId: 'i1', amount: '1.00' },
            { invoiceId: 'i1', amount: '1.00' },
          ],
        }),
      ),
    ).toBe('DUPLICATE_INVOICE');
    for (const amount of ['0', '0.00', '-1.00', '1.001', 'abc', '']) {
      expect(
        codeOf(() => planReceiptAllocations({ ...base, requests: [{ invoiceId: 'i1', amount }] })),
        amount,
      ).toBe('INVALID_AMOUNT');
    }
    expect(
      codeOf(() =>
        planReceiptAllocations({ ...base, requests: [{ invoiceId: 'nope', amount: '1.00' }] }),
      ),
    ).toBe('UNKNOWN_INVOICE');
  });
});
