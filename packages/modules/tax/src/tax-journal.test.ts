/**
 * In-memory journal lines for a taxed document (T-0034). Purchase side and mixed codes; the sale
 * side of GP-018 is covered by golden/gp-018.golden.test.ts (Draft). Purchase expectations mirror
 * the sale rules (design §3.8: bills debit expense and GST_PAID, credit AP_CONTROL); no purchase
 * golden exists yet, so these assert structure and balance, not an approved journal.
 */
import { Money } from '@ledgerforce/shared';
import { describe, expect, it } from 'vitest';
import { calculateTax } from './gst.engine.ts';
import { draftTaxedDocumentLines } from './tax-journal.ts';

const n = (s: string) => Money.of(s, 'AUD').toNumericString();

describe('draftTaxedDocumentLines', () => {
  it('purchase per_document inclusive: Cr AP total, Dr expense nets and GST paid, residue credited to ROUNDING', () => {
    const calc = calculateTax({
      currency: 'AUD',
      amountsAre: 'inclusive',
      rounding: 'per_document',
      lines: Array.from({ length: 3 }, () => ({ amount: '3.35', taxCode: 'GST', rate: '0.10' })),
    });
    expect(
      draftTaxedDocumentLines(calc, {
        side: 'purchase',
        lineAccounts: ['expense:6100', 'expense:6100', 'expense:6100'],
      }),
    ).toEqual([
      {
        account: 'system:AP_CONTROL',
        debit: n('0'),
        credit: n('10.05'),
        taxCode: null,
        taxAmount: null,
      },
      {
        account: 'system:ROUNDING',
        debit: n('0'),
        credit: n('0.01'),
        taxCode: null,
        taxAmount: null,
      },
      {
        account: 'expense:6100',
        debit: n('9.15'),
        credit: n('0'),
        taxCode: 'GST',
        taxAmount: n('0.91'),
      },
      {
        account: 'tax:GST.paid',
        debit: n('0.91'),
        credit: n('0'),
        taxCode: 'GST',
        taxAmount: null,
      },
    ]);
  });

  it('sale with GST and GST-free lines: revenue grouped by account and code, no tax line for a zero tax', () => {
    const calc = calculateTax({
      currency: 'AUD',
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [
        { amount: '1000.00', taxCode: 'GST', rate: '0.10' },
        { amount: '250.00', taxCode: 'GST', rate: '0.10' },
        { amount: '40.00', taxCode: 'FRE', rate: '0' },
      ],
    });
    expect(
      draftTaxedDocumentLines(calc, {
        side: 'sale',
        lineAccounts: ['rev:4000', 'rev:4100', 'rev:4000'],
      }),
    ).toEqual([
      {
        account: 'system:AR_CONTROL',
        debit: n('1415.00'),
        credit: n('0'),
        taxCode: null,
        taxAmount: null,
      },
      {
        account: 'rev:4000',
        debit: n('0'),
        credit: n('1000.00'),
        taxCode: 'GST',
        taxAmount: n('100.00'),
      },
      {
        account: 'rev:4100',
        debit: n('0'),
        credit: n('250.00'),
        taxCode: 'GST',
        taxAmount: n('25.00'),
      },
      { account: 'rev:4000', debit: n('0'), credit: n('40.00'), taxCode: 'FRE', taxAmount: n('0') },
      {
        account: 'tax:GST.collected',
        debit: n('0'),
        credit: n('125.00'),
        taxCode: 'GST',
        taxAmount: null,
      },
    ]);
  });

  it('a credit (negative) line flips to the other side', () => {
    const calc = calculateTax({
      currency: 'AUD',
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [
        { amount: '100.00', taxCode: 'GST', rate: '0.10' },
        { amount: '-20.00', taxCode: 'GST', rate: '0.10' },
      ],
    });
    const lines = draftTaxedDocumentLines(calc, {
      side: 'sale',
      lineAccounts: ['rev:4000', 'rev:4900'],
    });
    expect(lines.find((l) => l.account === 'rev:4900')).toEqual({
      account: 'rev:4900',
      debit: n('20.00'),
      credit: n('0'),
      taxCode: 'GST',
      taxAmount: n('-2.00'),
    });
  });

  it('refuses a line-account list that does not match the lines', () => {
    const calc = calculateTax({
      currency: 'AUD',
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [{ amount: '1.00', taxCode: 'GST', rate: '0.10' }],
    });
    expect(() => draftTaxedDocumentLines(calc, { side: 'sale', lineAccounts: [] })).toThrow(
      /1 line/,
    );
  });
});
