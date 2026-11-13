import { describe, expect, it } from 'vitest';
import { billName, billStatus, formToBody, nextTurn, type BillForm } from './bill-logic.ts';

const row = {
  bill_no: null,
  status: 'draft' as const,
  awaiting_approval: false,
  supplier_name: 'Paper Supplies',
  supplier_ref: 'INV-7',
};

describe('bill words (P2, P13)', () => {
  it('names the state in words, including the approval queue', () => {
    expect(billStatus(row)).toEqual({ key: 'draft', word: 'Draft' });
    expect(billStatus({ ...row, awaiting_approval: true })).toEqual({
      key: 'awaiting',
      word: 'Waiting for approval',
    });
    expect(billStatus({ ...row, status: 'posted' })).toEqual({ key: 'posted', word: 'Posted' });
    expect(billStatus({ ...row, status: 'void' })).toEqual({ key: 'void', word: 'Void' });
  });
  it('names a bill by its number once posted, by supplier invoice before', () => {
    expect(billName(row)).toBe('Draft bill INV-7 from Paper Supplies');
    expect(billName({ ...row, status: 'posted', bill_no: 'BILL-000045' })).toBe(
      'BILL-000045, Paper Supplies',
    );
  });
  it('says who acts next', () => {
    expect(nextTurn(row)).toBe('AP Clerk: send for approval');
    expect(nextTurn({ ...row, awaiting_approval: true })).toBe('An Approver');
    expect(nextTurn({ ...row, status: 'posted' })).toBe('Nobody: posted');
  });
});

const good: BillForm = {
  partyId: 'p1',
  supplierRef: ' INV-7 ',
  billDate: '2026-11-03',
  dueDate: '',
  lines: [{ description: 'Paper', accountId: 'a1', taxCode: 'GST', amount: '1,250.50' }],
};

describe('formToBody', () => {
  it('builds the PUT body with amounts as decimal strings, no due date when blank', () => {
    expect(formToBody('c1', good)).toEqual({
      ok: true,
      body: {
        company_id: 'c1',
        party_id: 'p1',
        supplier_ref: 'INV-7',
        bill_date: '2026-11-03',
        lines: [{ description: 'Paper', account_id: 'a1', tax_code: 'GST', amount: '1250.50' }],
      },
    });
  });
  it('lists every problem in plain words', () => {
    const r = formToBody('c1', {
      partyId: '',
      supplierRef: '',
      billDate: '',
      dueDate: '2026-13-40',
      lines: [
        { description: '', accountId: '', taxCode: '', amount: '12.345' },
        { description: 'x', accountId: 'a', taxCode: 'GST', amount: '-5' },
        { description: 'x', accountId: 'a', taxCode: 'GST', amount: '' },
      ],
    });
    expect(r).toEqual({
      ok: false,
      problems: [
        'Choose the supplier.',
        "Write the supplier's invoice number.",
        'Give the bill date.',
        'The due date is not a real date.',
        'Line 1: write what it is for.',
        'Line 1: choose an account.',
        'Line 1: choose a tax code.',
        'Line 1: the amount needs at most two decimals.',
        'Line 2: the amount is a number like 1250.00, without a minus sign or $.',
        'Line 3: give the amount before GST.',
      ],
    });
  });
});
