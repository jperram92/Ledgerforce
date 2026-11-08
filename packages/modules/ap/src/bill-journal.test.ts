/**
 * Journal lines for a supplier bill, in memory (T-0050, GP-008, RQ-0106 F3). Pure.
 */
import { describe, expect, it } from 'vitest';
import { buildBillLines, type BillTaxCode } from './bill-journal.ts';

const OFFICE = '01900000-0000-7000-8000-00000000a001';
const COMPUTERS = '01900000-0000-7000-8000-00000000a002';
const GST_PAID = '01900000-0000-7000-8000-00000000a003';
const SUPPLIER = '01900000-0000-7000-8000-00000000a004';
const taxCodes = new Map<string, BillTaxCode>([
  [
    'GST',
    { id: '01900000-0000-7000-8000-00000000b001', rate: '0.10000000', paidAccountId: GST_PAID },
  ],
  [
    'CAP',
    { id: '01900000-0000-7000-8000-00000000b002', rate: '0.10000000', paidAccountId: GST_PAID },
  ],
  ['FRE', { id: '01900000-0000-7000-8000-00000000b003', rate: '0', paidAccountId: null }],
]);

describe('buildBillLines', () => {
  it('GP-008: document lines, one GST_PAID line per tax code, then AP control (gross) with supplier and due date', () => {
    expect(
      buildBillLines({
        currency: 'AUD',
        amountsAre: 'exclusive',
        rounding: 'per_line',
        supplierId: SUPPLIER,
        dueDate: '2026-11-30',
        taxCodes,
        lines: [
          { accountId: OFFICE, taxCode: 'GST', amount: '500.0000' },
          { accountId: COMPUTERS, taxCode: 'CAP', amount: '2000.0000' },
        ],
      }),
    ).toEqual([
      {
        account: { id: OFFICE },
        debit: '500.0000',
        taxCodeId: taxCodes.get('GST')?.id,
        taxAmount: '50.0000',
        partyId: SUPPLIER,
      },
      {
        account: { id: COMPUTERS },
        debit: '2000.0000',
        taxCodeId: taxCodes.get('CAP')?.id,
        taxAmount: '200.0000',
        partyId: SUPPLIER,
      },
      { account: { id: GST_PAID }, debit: '50.0000', taxCodeId: taxCodes.get('GST')?.id },
      { account: { id: GST_PAID }, debit: '200.0000', taxCodeId: taxCodes.get('CAP')?.id },
      {
        account: { role: 'AP_CONTROL' },
        credit: '2750.0000',
        partyId: SUPPLIER,
        dueDate: '2026-11-30',
      },
    ]);
  });

  it('groups lines with the same account and tax code; a GST-free line has no tax line', () => {
    const lines = buildBillLines({
      currency: 'AUD',
      amountsAre: 'exclusive',
      rounding: 'per_line',
      supplierId: SUPPLIER,
      dueDate: '2026-11-30',
      taxCodes,
      lines: [
        { accountId: OFFICE, taxCode: 'GST', amount: '10.0000' },
        { accountId: OFFICE, taxCode: 'GST', amount: '5.0000' },
        { accountId: OFFICE, taxCode: 'FRE', amount: '7.0000' },
      ],
    });
    expect(lines.map((l) => [l.debit ?? `Cr ${l.credit ?? ''}`, l.taxAmount])).toEqual([
      ['15.0000', '1.5000'],
      ['7.0000', '0.0000'],
      ['1.5000', undefined],
      ['Cr 23.5000', undefined],
    ]);
  });

  it('per-document inclusive residue goes to ROUNDING just before AP control (credit on a purchase)', () => {
    const lines = buildBillLines({
      currency: 'AUD',
      amountsAre: 'inclusive',
      rounding: 'per_document',
      supplierId: SUPPLIER,
      dueDate: '2026-11-30',
      taxCodes,
      lines: Array.from({ length: 3 }, () => ({
        accountId: OFFICE,
        taxCode: 'GST',
        amount: '3.3500',
      })),
    });
    expect(lines.slice(-2)).toEqual([
      { account: { role: 'ROUNDING' }, credit: '0.0100' },
      {
        account: { role: 'AP_CONTROL' },
        credit: '10.0500',
        partyId: SUPPLIER,
        dueDate: '2026-11-30',
      },
    ]);
    expect(lines[0]).toMatchObject({ debit: '9.1500', taxAmount: '0.9100' });
  });

  it('refuses a taxed code without a GST paid account', () => {
    expect(() =>
      buildBillLines({
        currency: 'AUD',
        amountsAre: 'exclusive',
        rounding: 'per_line',
        supplierId: SUPPLIER,
        dueDate: '2026-11-30',
        taxCodes: new Map([['XYZ', { id: OFFICE, rate: '0.10', paidAccountId: null }]]),
        lines: [{ accountId: OFFICE, taxCode: 'XYZ', amount: '10.0000' }],
      }),
    ).toThrow(/TAX_ACCOUNT_MISSING|no GST paid account/);
  });
});
