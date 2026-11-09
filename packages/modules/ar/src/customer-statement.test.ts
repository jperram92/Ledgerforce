/**
 * Customer statement shaping (T-0049, RQ-0122 finding 5, DL-0362): opening balance, one line per
 * document in the range with a running balance, allocations for information, closing balance
 * equal to the party's subledger (Σ open amounts as at the end date), one section per currency.
 */
import { describe, expect, it } from 'vitest';
import { shapeStatement, type StatementItem } from './customer-statement.ts';

let n = 0;
const it_ = (
  o: Partial<StatementItem> & {
    documentDate: string;
    originalAmount: string;
    openAmountAsOf: string;
  },
): StatementItem => ({
  itemId: `s-${String(++n)}`,
  entryId: `e-${String(n)}`,
  sourceType: 'ar_invoice',
  documentId: null,
  reference: `INV-${String(n)}`,
  dueDate: o.documentDate,
  currency: 'AUD',
  ...o,
});

describe('shapeStatement', () => {
  const old = it_({
    documentDate: '2026-08-01',
    originalAmount: '500.0000',
    openAmountAsOf: '0.0000',
  });
  const oldReceipt = it_({
    documentDate: '2026-08-20',
    sourceType: 'ar_receipt',
    reference: 'EFT 1',
    originalAmount: '-300.0000',
    openAmountAsOf: '0.0000',
  });
  const inv = it_({
    documentDate: '2026-11-05',
    dueDate: '2026-11-19',
    originalAmount: '1375.0000',
    openAmountAsOf: '875.0000',
  });
  const cn = it_({
    documentDate: '2026-11-10',
    sourceType: 'ar_credit_note',
    reference: 'CN-1',
    originalAmount: '-220.0000',
    openAmountAsOf: '-20.0000',
  });
  const rc = it_({
    documentDate: '2026-11-12',
    sourceType: 'ar_receipt',
    reference: 'EFT 2',
    originalAmount: '-500.0000',
    openAmountAsOf: '0.0000',
  });
  const usd = it_({
    documentDate: '2026-11-06',
    currency: 'USD',
    originalAmount: '100.0000',
    openAmountAsOf: '100.0000',
    dueDate: '2026-11-06',
  });

  const body = shapeStatement(
    [rc, inv, old, cn, oldReceipt, usd],
    [
      {
        allocationId: 'a1',
        allocationDate: '2026-11-12',
        amount: '500.0000',
        currency: 'AUD',
        fromItemId: rc.itemId,
        toItemId: inv.itemId,
        reversalOfId: null,
      },
      {
        allocationId: 'a0',
        allocationDate: '2026-08-20',
        amount: '300.0000',
        currency: 'AUD',
        fromItemId: oldReceipt.itemId,
        toItemId: old.itemId,
        reversalOfId: null,
      },
    ],
    { from: '2026-11-01', to: '2026-11-30' },
  );

  it('has one section per currency, in currency-code order', () => {
    expect(body.from).toBe('2026-11-01');
    expect(body.to).toBe('2026-11-30');
    expect(body.sections.map((s) => s.currency)).toEqual(['AUD', 'USD']);
  });

  it('opens with the balance before the range and runs a balance through the range', () => {
    const aud = body.sections[0];
    expect(aud?.openingBalance).toBe('200.0000');
    expect(
      aud?.lines.map((l) => [l.date, l.kind, l.reference, l.debit, l.credit, l.balance]),
    ).toEqual([
      ['2026-11-05', 'invoice', inv.reference, '1375.0000', '0.0000', '1575.0000'],
      ['2026-11-10', 'credit_note', 'CN-1', '0.0000', '220.0000', '1355.0000'],
      ['2026-11-12', 'receipt', 'EFT 2', '0.0000', '500.0000', '855.0000'],
    ]);
    expect(aud?.closingBalance).toBe('855.0000');
  });

  it('closes on the subledger: Σ open amounts as at the end date', () => {
    const aud = body.sections[0];
    expect(aud?.subledgerBalance).toBe('855.0000');
    expect(aud?.reconciled).toBe(true);
  });

  it('lists allocations dated in the range with the references of both sides', () => {
    const aud = body.sections[0];
    expect(aud?.allocations).toEqual([
      {
        allocationId: 'a1',
        date: '2026-11-12',
        amount: '500.0000',
        fromReference: 'EFT 2',
        toReference: inv.reference,
        reversal: false,
      },
    ]);
  });

  it('carries the ageing as at the end date and the unallocated credits', () => {
    const aud = body.sections[0];
    expect(aud?.ageing).toMatchObject({
      days1to30: '875.0000',
      unallocatedCredits: '-20.0000',
      total: '855.0000',
    });
    expect(aud?.openItems.map((i) => i.reference)).toEqual([inv.reference]);
    expect(aud?.unallocatedCredits.map((c) => c.reference)).toEqual(['CN-1']);
    const u = body.sections[1];
    expect(u?.openingBalance).toBe('0.0000');
    expect(u?.closingBalance).toBe('100.0000');
    expect(u?.ageing.days1to30).toBe('100.0000');
  });

  it('refuses an item dated after the end date and an inverted range', () => {
    expect(() =>
      shapeStatement(
        [it_({ documentDate: '2026-12-01', originalAmount: '1', openAmountAsOf: '1' })],
        [],
        { from: '2026-11-01', to: '2026-11-30' },
      ),
    ).toThrow(RangeError);
    expect(() => shapeStatement([], [], { from: '2026-12-01', to: '2026-11-30' })).toThrow(
      RangeError,
    );
  });
});
