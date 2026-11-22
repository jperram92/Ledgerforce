/**
 * Opening balances screen wording (T-0177, SS-PLAT-132): which side of a preview line has the
 * amount (decided on the decimal string, never a number), dates in words, refusals in plain words.
 */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import {
  balanceDay,
  fxNote,
  itemColumnsHelp,
  kindWord,
  obRefusal,
  sideOf,
} from './opening-logic.ts';

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

describe('opening balances, foreign-currency items [T-0202]', () => {
  it('SS-PLAT-164 a foreign line names its currency, currency amount and rate; a base line names none', () => {
    const usd = { txn_currency: 'USD', txn_amount: '1000.0000', fx_rate: '1.53846154' };
    expect(fxNote(usd, 'AUD')).toBe('USD 1,000.00 @ 1.53846154');
    // A posted AP item carries a signed currency amount: the note says the size, not the sign.
    expect(
      fxNote({ txn_currency: 'USD', txn_amount: '-400.0000', fx_rate: '1.53846154' }, 'AUD'),
    ).toBe('USD 400.00 @ 1.53846154');
    // The currency's own minor unit (JPY has none).
    expect(
      fxNote({ txn_currency: 'JPY', txn_amount: '150000.0000', fx_rate: '0.01020000' }, 'AUD'),
    ).toBe('JPY 150,000 @ 0.01020000');
    expect(
      fxNote({ txn_currency: 'AUD', txn_amount: '1375.0000', fx_rate: '1' }, 'AUD'),
    ).toBeNull();
    expect(fxNote({ txn_currency: null, txn_amount: null, fx_rate: null }, 'AUD')).toBeNull();
    expect(fxNote({}, 'AUD')).toBeNull();
  });

  it('SS-PLAT-165 an FX_MISMATCH refusal says in plain words that the rate does not give the amount, with its line', () => {
    const text = obRefusal(
      new AdminApiError(422, {
        error: 'FX_MISMATCH',
        message:
          'INV-1004: USD 357.50 × 1.5 = 536.25 (half-up to cents), not the base amount 550.00; correct the rate or leave it empty to imply it',
        row: 3,
      }),
    );
    expect(text).toBe(
      'LedgerForce did not accept the files: on line 3 of the file, the exchange rate times the currency amount does not give the amount. INV-1004: USD 357.50 × 1.5 = 536.25 (half-up to cents), not the base amount 550.00; correct the rate or leave it empty to imply it.',
    );
  });

  it('SS-PLAT-166 the open-items CSV help lists the three optional foreign-currency columns', () => {
    const help = itemColumnsHelp('AUD');
    expect(help).toContain('party, document_no, document_date, due_date, amount and gst_amount');
    for (const col of ['currency', 'currency_amount', 'fx_rate']) expect(help).toContain(col);
    expect(help).toMatch(/optional/);
    expect(help).toMatch(/carrying amount in AUD/);
    expect(help).toMatch(/AUD per one unit/);
  });
});
