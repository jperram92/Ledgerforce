/**
 * T-0080 SS-PLAT-116 (unit): the opening-balance CSV files — trial balance and open AR/AP items —
 * are read strictly; every refusal names the CSV line (header = line 1). Amounts stay decimal
 * strings (no floating point on money).
 */
import { describe, expect, it } from 'vitest';
import { OpeningBalanceError } from './errors.ts';
import { parseOpenItemsCsv, parseTrialBalanceCsv } from './opening-csv.ts';

const refusal = (fn: () => unknown): OpeningBalanceError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpeningBalanceError) return e;
    throw e;
  }
  throw new Error('expected an OpeningBalanceError');
};

describe('SS-PLAT-116: opening-balance CSV files', () => {
  it('reads a trial balance by account code, any column order, extra columns ignored, zero rows dropped', () => {
    const rows = parseTrialBalanceCsv(
      'Account_Name,account_code,Debit,Credit\r\n' +
        'Operating account,1010,12400.00,\n' +
        '"Trade creditors, AU",2000,,660\n' +
        'Business saver,1020,0,0\n' +
        'Owner drawings,3100,,\n',
    );
    expect(rows).toEqual([
      { row: 2, accountCode: '1010', debit: '12400.00', credit: '0' },
      { row: 3, accountCode: '2000', debit: '0', credit: '660' },
    ]);
  });

  it('refuses a trial-balance row with both sides, a negative or malformed amount, or a missing column', () => {
    expect(
      refusal(() => parseTrialBalanceCsv('account_code,debit,credit\n1010,1.00,2.00\n')),
    ).toMatchObject({
      code: 'INVALID_CSV',
      row: 2,
    });
    expect(refusal(() => parseTrialBalanceCsv('account_code,debit,credit\n1010,-5,\n')).row).toBe(
      2,
    );
    expect(
      refusal(() => parseTrialBalanceCsv('account_code,debit,credit\n1010,1.00,\n1020,1e3,\n')).row,
    ).toBe(3);
    expect(
      refusal(() => parseTrialBalanceCsv('account_code,debit,credit\n1010,1.00001,\n')).message,
    ).toMatch(/4 decimals/);
    expect(refusal(() => parseTrialBalanceCsv('code,debit,credit\n1010,1,\n'))).toMatchObject({
      code: 'INVALID_CSV',
      row: 1,
    });
    expect(refusal(() => parseTrialBalanceCsv('account_code,debit,credit\n')).message).toMatch(
      /no rows/,
    );
  });

  it('reads open items with signed amounts and optional GST; quoted party names keep their commas', () => {
    const items = parseOpenItemsCsv(
      'party,document_no,document_date,due_date,amount,gst_amount\n' +
        '"Acme Pty Ltd",INV-0991,2026-09-15,2026-10-15,1375.00,125.00\n' +
        '"Smith, Jones & Co",CN-0042,2026-10-01,2026-10-01,-110.00,-10.00\n' +
        'Acme Pty Ltd,INV-1004,2026-10-15,2026-11-14,550.00,\n',
      'ar',
    );
    expect(items).toEqual([
      {
        row: 2,
        kind: 'ar',
        party: 'Acme Pty Ltd',
        documentNo: 'INV-0991',
        documentDate: '2026-09-15',
        dueDate: '2026-10-15',
        amount: '1375.00',
        gstAmount: '125.00',
      },
      {
        row: 3,
        kind: 'ar',
        party: 'Smith, Jones & Co',
        documentNo: 'CN-0042',
        documentDate: '2026-10-01',
        dueDate: '2026-10-01',
        amount: '-110.00',
        gstAmount: '-10.00',
      },
      {
        row: 4,
        kind: 'ar',
        party: 'Acme Pty Ltd',
        documentNo: 'INV-1004',
        documentDate: '2026-10-15',
        dueDate: '2026-11-14',
        amount: '550.00',
        gstAmount: '0',
      },
    ]);
  });

  it('refuses a zero amount, GST larger than or opposite to the amount, bad dates, due before issue, duplicates', () => {
    const head = 'party,document_no,document_date,due_date,amount,gst_amount\n';
    const row = (r: string) => refusal(() => parseOpenItemsCsv(head + r, 'ap'));
    expect(row('S,B-1,2026-10-08,2026-11-07,0,\n')).toMatchObject({ code: 'INVALID_CSV', row: 2 });
    expect(row('S,B-1,2026-10-08,2026-11-07,660.00,700.00\n').message).toMatch(/GST/);
    expect(row('S,B-1,2026-10-08,2026-11-07,660.00,-60.00\n').message).toMatch(/GST/);
    expect(row('S,B-1,2026-02-30,2026-11-07,660.00,\n').message).toMatch(/document_date/);
    expect(row('S,B-1,2026-10-08,2026-10-07,660.00,\n').message).toMatch(/before/);
    expect(row('S,,2026-10-08,2026-11-07,660.00,\n').message).toMatch(/document_no/);
    expect(
      row('S,B-1,2026-10-08,2026-11-07,660.00,\nS,B-1,2026-10-09,2026-11-08,10.00,\n'),
    ).toMatchObject({ row: 3 });
  });
});
