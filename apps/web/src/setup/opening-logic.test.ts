/**
 * Opening balances screen wording (T-0177, SS-PLAT-132): which side of a preview line has the
 * amount (decided on the decimal string, never a number), dates in words, refusals in plain words.
 */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { balanceDay, kindWord, obRefusal, sideOf } from './opening-logic.ts';

describe('opening balances wording [T-0177]', () => {
  it('a preview line shows the side whose decimal string is not zero', () => {
    expect(sideOf({ debit: '1375.0000', credit: '0.0000' })).toEqual({ debit: '1375.0000' });
    expect(sideOf({ debit: '0.0000', credit: '660.0000' })).toEqual({ credit: '660.0000' });
    expect(sideOf({ debit: '0', credit: '0.0001' })).toEqual({ credit: '0.0001' });
  });

  it('a date is said in words without moving across time zones', () => {
    expect(balanceDay('2026-10-31')).toBe('31 Oct 2026');
    expect(balanceDay('2026-01-01')).toBe('1 Jan 2026');
  });

  it('open item kinds in plain words', () => {
    expect(kindWord('ar')).toBe('Customer owes');
    expect(kindWord('ap')).toBe('You owe');
  });

  it('a CSV refusal names the line; an engine refusal names the journal line', () => {
    expect(
      obRefusal(new AdminApiError(422, { error: 'INVALID_CSV', message: 'bad amount', row: 2 })),
    ).toBe('LedgerForce did not accept the files: bad amount (line 2 of the file).');
    expect(
      obRefusal(new AdminApiError(422, { error: 'UNKNOWN_ACCOUNT', message: 'no 9999', line: 3 })),
    ).toBe('LedgerForce did not accept the files: no 9999 (journal line 3).');
    expect(
      obRefusal(new AdminApiError(422, { error: 'OPENING_EXISTS', message: 'already there' })),
    ).toBe('LedgerForce did not accept the files: already there.');
    expect(obRefusal(new AdminApiError(400, { error: 'invalid_opening_balance' }))).toBeNull();
    expect(obRefusal(new Error('offline'))).toBeNull();
  });
});
