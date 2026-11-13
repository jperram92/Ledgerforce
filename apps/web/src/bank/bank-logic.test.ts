/** Bank reconciliation screen logic (T-0088): masking, amounts as text, file encoding. */
import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  bytesToBase64,
  closingBalanceText,
  counterAmount,
  last3,
  lineIsMoneyIn,
  transactionInput,
} from './bank-logic.ts';

describe('T-0150 transaction request (one body for the journal preview and the post)', () => {
  const line = {
    amount: '-10.0000',
    suggestions: [
      { id: 'sug-1', kind: 'rule' as const, account_id: 'acct-fees' },
      { id: 'sug-2', kind: 'candidate' as const, account_id: null },
    ],
  };

  it('keeps the rule suggestion only while its account is chosen; the amount defaults to the line', () => {
    expect(transactionInput(line, 'acct-fees', null, '')).toEqual({
      lines: [{ account_id: 'acct-fees', amount: '10.0000' }],
      from_suggestion_id: 'sug-1',
    });
    expect(transactionInput(line, 'acct-interest', ' 10.00 ', ' Fee ')).toEqual({
      lines: [{ account_id: 'acct-interest', amount: '10.00' }],
      memo: 'Fee',
    });
  });

  it('asks nothing of the API until an account is chosen and the amount is a decimal string', () => {
    expect(transactionInput(line, '', null, '')).toBeNull();
    expect(transactionInput(line, 'acct-fees', '10.12345', '')).toBeNull();
    expect(transactionInput(line, 'acct-fees', '1e3', '')).toBeNull();
    expect(transactionInput(line, 'acct-fees', '-10', '')).toBeNull();
  });
});

describe('T-0088 bank logic', () => {
  it('shows only the last 3 characters of an account number, even if more arrive', () => {
    expect(last3('***678')).toBe('678');
    expect(last3('12345678')).toBe('678');
    expect(last3('7')).toBe('7');
    expect(accountLabel({ name: 'Operating', bsb: '062-000', account_number: '12345678' })).toBe(
      'Operating, account ending 678, BSB 062-000',
    );
  });

  it('the counter line amount is the line amount without its sign (text only, no arithmetic)', () => {
    expect(counterAmount('-10.0000')).toBe('10.0000');
    expect(counterAmount('1375.0000')).toBe('1375.0000');
    expect(lineIsMoneyIn('-10.0000')).toBe(false);
    expect(lineIsMoneyIn('550.5500')).toBe(true);
  });

  it('a closing balance is accepted as a decimal string with optional grouping commas', () => {
    expect(closingBalanceText('13,394.43')).toBe('13394.43');
    expect(closingBalanceText(' -12.5 ')).toBe('-12.5');
    expect(closingBalanceText('12.34567')).toBeNull();
    expect(closingBalanceText('1e5')).toBeNull();
    expect(closingBalanceText('')).toBeNull();
  });

  it('encodes file bytes as base64 for the import route', () => {
    expect(bytesToBase64(new TextEncoder().encode('Date,Amount\n'))).toBe('RGF0ZSxBbW91bnQK');
    expect(bytesToBase64(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe('77u/');
  });
});
