/**
 * SS-PLAT-35 — party identifier rules (T-0036, RQ-0017): ABN mod-89 checksum (ABR), Peppol
 * participant ID 0151:<ABN> (ATO), Salesforce 15 → 18-character case-safe Ids.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { abnIsValid, normaliseAbn, peppolParticipantId, toSalesforceId18 } from './identifiers.ts';

describe('SS-PLAT-35: Party identifiers are validated and normalised', () => {
  it('accepts the ATO example ABN and rejects a one-digit change (RQ-0017 S1)', () => {
    expect(abnIsValid('51824753556')).toBe(true);
    expect(abnIsValid('51824753557')).toBe(false);
    expect(abnIsValid('74625118903')).toBe(false);
    expect(abnIsValid('5182475355')).toBe(false);
    expect(abnIsValid('5182475355a')).toBe(false);
  });

  it('normalises spaces in an ABN, and refuses anything that is not a valid ABN', () => {
    expect(normaliseAbn(' 51 824 753 556 ')).toBe('51824753556');
    expect(() => normaliseAbn('51 824 753 557')).toThrow(/not a valid ABN/);
  });

  it('property: changing any single digit of a valid ABN makes it invalid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), fc.integer({ min: 1, max: 9 }), (pos, delta) => {
        const digits = '51824753556'.split('');
        const d = Number.parseInt(digits[pos] ?? '0', 10);
        digits[pos] = String((d + delta) % 10);
        expect(abnIsValid(digits.join(''))).toBe(false);
      }),
    );
  });

  it('derives the Peppol participant ID from the ABN (scheme 0151)', () => {
    expect(peppolParticipantId('51824753556')).toBe('0151:51824753556');
    expect(() => peppolParticipantId('51824753557')).toThrow(/valid ABN/);
  });

  it('converts a 15-character Salesforce Id to its 18-character form (RQ-0017 S5 vector)', () => {
    expect(toSalesforceId18('003G000001SUbc4')).toBe('003G000001SUbc4IAD');
    expect(toSalesforceId18('003G000001SUbc4IAD')).toBe('003G000001SUbc4IAD');
  });

  it('refuses an 18-character Id whose suffix does not match, and malformed Ids', () => {
    expect(() => toSalesforceId18('003G000001SUbc4AAA')).toThrow(/checksum/);
    expect(() => toSalesforceId18('003G000001SUbc')).toThrow(/15 or 18/);
    expect(() => toSalesforceId18('003G000001SUbc4-')).toThrow(/15 or 18/);
  });

  it('property: 15-character Ids differing only in case get different 18-character forms', () => {
    const id15 = fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      minLength: 15,
      maxLength: 15,
    });
    fc.assert(
      fc.property(id15, fc.integer({ min: 0, max: 14 }), (base, pos) => {
        const ch = base[pos] ?? '0';
        fc.pre(ch >= 'a' && ch <= 'z');
        const upper = base.slice(0, pos) + ch.toUpperCase() + base.slice(pos + 1);
        expect(toSalesforceId18(base).toLowerCase()).not.toBe(
          toSalesforceId18(upper).toLowerCase(),
        );
      }),
    );
  });
});
