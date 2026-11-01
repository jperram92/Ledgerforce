/**
 * SS-UC11-07 — a credit note cannot exceed what is still creditable on its invoice (T-0045,
 * UC-11): the invoice's gross less the gross of credit notes already posted against it.
 */
import { describe, expect, it } from 'vitest';
import { creditableAmount, CreditNoteError } from './credit-notes.ts';

describe('SS-UC11-07: Credit cannot exceed the creditable amount', () => {
  it('SS-UC11-07 a 1,500.00 credit on a 1,375.00 invoice fails with CREDIT_EXCEEDS_INVOICE', () => {
    expect(() =>
      creditableAmount({
        invoiceGross: '1375.0000',
        creditedGross: '0',
        requestedGross: '1500.0000',
      }),
    ).toThrow(CreditNoteError);
    try {
      creditableAmount({
        invoiceGross: '1375.0000',
        creditedGross: '0',
        requestedGross: '1500.0000',
      });
    } catch (e) {
      expect((e as CreditNoteError).code).toBe('CREDIT_EXCEEDS_INVOICE');
    }
  });

  it('SS-UC11-07 earlier credits reduce what remains; the exact remainder is allowed', () => {
    expect(
      creditableAmount({
        invoiceGross: '1375.0000',
        creditedGross: '220.0000',
        requestedGross: '1155.0000',
      }),
    ).toBe('0.0000');
    expect(() =>
      creditableAmount({
        invoiceGross: '1375.0000',
        creditedGross: '220.0000',
        requestedGross: '1155.0100',
      }),
    ).toThrow(/CREDIT_EXCEEDS_INVOICE|exceeds/);
  });

  it('refuses a zero or negative credit', () => {
    expect(() =>
      creditableAmount({ invoiceGross: '1375.0000', creditedGross: '0', requestedGross: '0' }),
    ).toThrow(CreditNoteError);
  });
});
