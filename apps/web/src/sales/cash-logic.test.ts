import { describe, expect, it } from 'vitest';
import { amountInput, CREDIT_REASONS, invoicesFor, PAYMENT_WORD } from './cash-logic.ts';
import type { InvoiceRow } from './client.ts';

const row = (over: Partial<InvoiceRow>): InvoiceRow => ({
  id: 'i1',
  invoice_no: 'INV-000001',
  status: 'posted',
  party_id: 'p1',
  party_name: 'Acme Pty Ltd',
  issue_date: '2026-11-01',
  due_date: '2026-11-15',
  gross_total: '110.0000',
  ...over,
});

describe('cash-logic [T-0085]', () => {
  it('amountInput turns NUMERIC text into a form amount without arithmetic', () => {
    expect(amountInput('1375.0000')).toBe('1375.00');
    expect(amountInput('12.3400')).toBe('12.34');
    expect(amountInput('0.0500')).toBe('0.05');
    expect(amountInput('7')).toBe('7.00');
    // More than cents is kept as it is; the API refuses it rather than the browser rounding.
    expect(amountInput('12.3456')).toBe('12.3456');
  });

  it('invoicesFor offers only the customer’s posted, numbered invoices', () => {
    const list = [
      row({ id: 'a' }),
      row({ id: 'b', party_id: 'p2' }),
      row({ id: 'c', status: 'draft', invoice_no: null }),
      row({ id: 'd', status: 'void' }),
    ];
    expect(invoicesFor(list, 'p1').map((i) => i.id)).toEqual(['a']);
  });

  it('payment words and credit reasons are plain words for every API code', () => {
    expect(PAYMENT_WORD).toEqual({
      unpaid: 'Unpaid',
      partially_paid: 'Partly paid',
      paid: 'Paid',
    });
    expect(CREDIT_REASONS.map((r) => r.code)).toEqual([
      'price_concession',
      'return',
      'scope_reduction',
      'billing_error',
      'goodwill',
    ]);
    expect(CREDIT_REASONS.every((r) => r.label.length > 0)).toBe(true);
  });
});
