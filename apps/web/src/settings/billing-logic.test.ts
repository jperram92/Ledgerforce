/** Wording and form helpers of the Numbering and billing and Approval amounts screens (T-0186). */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import {
  amountEdit,
  amountInput,
  amountText,
  approvalRefusal,
  billingRefusal,
  digitsInput,
  firstNumber,
  termsInput,
} from './billing-logic.ts';

describe('SS-PLAT-131 T-0186 billing and approval logic', () => {
  it('shows the first number a new series will issue, padded like the database does', () => {
    expect(firstNumber('INV-', 6)).toBe('INV-000001');
    expect(firstNumber('', 1)).toBe('1');
    expect(firstNumber('TI/', 3)).toBe('TI/001');
  });

  it('reads the number of digits and the payment terms as whole numbers in range, else null', () => {
    expect(digitsInput('6')).toBe(6);
    expect(digitsInput(' 18 ')).toBe(18);
    for (const bad of ['', '0', '19', '2.5', 'six', '-1']) expect(digitsInput(bad)).toBeNull();
    expect(termsInput('0')).toBe(0);
    expect(termsInput('30')).toBe(30);
    for (const bad of ['', '366', '1.5', 'x', '-3']) expect(termsInput(bad)).toBeNull();
  });

  it('reads an amount as a decimal string without turning it into a number', () => {
    expect(amountInput('1,000')).toBe('1000');
    expect(amountInput(' $7,500.50 ')).toBe('7500.50');
    expect(amountInput('0.0001')).toBe('0.0001');
    expect(amountInput('12345678901234567890')).toBeNull();
    for (const bad of ['', '1e3', '-1', '1.23456', 'ten', '1,0,0.5.5']) {
      expect(amountInput(bad), bad).toBeNull();
    }
  });

  it('puts a stored threshold in the input without losing any of its four decimals', () => {
    expect(amountEdit('5000.0000')).toBe('5,000.00');
    expect(amountEdit('1000.1234')).toBe('1,000.1234');
    expect(amountEdit('0.5000')).toBe('0.50');
    expect(amountInput(amountEdit('1234567.0100'))).toBe('1234567.01');
  });

  it('shows a threshold as dollars and cents', () => {
    expect(amountText('10000.0000')).toBe('10,000.00');
    expect(amountText('1000.5000')).toBe('1,000.50');
  });

  it('says the numbering and billing refusals in plain words', () => {
    expect(
      billingRefusal(new AdminApiError(409, { error: 'NUMBER_SERIES_IN_USE', message: 'm' })),
    ).toMatch(/already been given a number/);
    expect(
      billingRefusal(
        new AdminApiError(400, {
          error: 'INVALID_NUMBER_SERIES',
          message:
            'the prefix must be up to 20 letters, digits or the characters - / _ . (no spaces)',
        }),
      ),
    ).toBe('The prefix must be up to 20 letters, digits or the characters - / _ . (no spaces).');
    expect(
      billingRefusal(new AdminApiError(422, { error: 'INVALID_CLEARING_ACCOUNT', message: 'm' })),
    ).toMatch(/Choose an asset account/);
    expect(
      billingRefusal(
        new AdminApiError(400, {
          error: 'INVALID_INVOICE_SETTINGS',
          message: 'the brand colour must be #RRGGBB',
        }),
      ),
    ).toBe('The brand colour must be #RRGGBB.');
    expect(billingRefusal(new Error('boom'))).toBeNull();
  });

  it('says the approval-amount refusals in plain words', () => {
    expect(approvalRefusal(new AdminApiError(400, { error: 'invalid_sod_settings' }))).toMatch(
      /could not be saved/,
    );
    expect(
      approvalRefusal(new AdminApiError(403, { error: 'forbidden', permission: 'x' })),
    ).toMatch(/Only the Owner/);
    expect(approvalRefusal(new Error('boom'))).toBeNull();
  });
});
