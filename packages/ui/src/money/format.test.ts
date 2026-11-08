import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '@ledgerforce/shared/money';
import { formatMoney, groupThousands, sumAmounts } from './format.ts';

describe('SS-PLAT-29 formatMoney (P3: money is set for reading)', () => {
  it('groups thousands and always shows two decimals for AUD', () => {
    expect(formatMoney('1234567.5').text).toBe('1,234,567.50');
    expect(formatMoney('10087').text).toBe('10,087.00');
    expect(formatMoney('0.4').text).toBe('0.40');
    expect(formatMoney('999.99').text).toBe('999.99');
  });

  it('shows negatives in parentheses and speaks them as "minus" (accountant view)', () => {
    const f = formatMoney('-389');
    expect(f.text).toBe('(389.00)');
    expect(f.spoken).toBe('minus 389.00 dollars');
    expect(f.negative).toBe(true);
    expect(f.amount).toBe('-389.00');
  });

  it('formats zero and negative zero the same way, never as a negative', () => {
    for (const z of ['0', '-0', '-0.00', '0.0000']) {
      const f = formatMoney(z);
      expect(f.text).toBe('0.00');
      expect(f.negative).toBe(false);
      expect(f.zero).toBe(true);
      expect(f.spoken).toBe('0.00 dollars');
    }
  });

  it('uses a leading minus for editable values and direction words for owner sentences', () => {
    expect(formatMoney('-389', { sign: 'minus' }).text).toBe('-389.00');
    expect(formatMoney('-12604.10', { sign: 'words' }).text).toBe('12,604.10 out');
    expect(formatMoney('-12604.10', { sign: 'words' }).spoken).toBe('12,604.10 dollars out');
    expect(formatMoney('10087', { sign: 'words' }).text).toBe('10,087.00 in');
    expect(formatMoney('0', { sign: 'words' }).text).toBe('0.00');
  });

  it('rounds half-up (away from zero) to the currency minor unit, exactly', () => {
    expect(formatMoney('0.005').text).toBe('0.01');
    expect(formatMoney('-1.005').text).toBe('(1.01)');
    expect(formatMoney('2.0049').text).toBe('2.00');
    expect(formatMoney('1234', { currency: 'JPY' }).text).toBe('1,234');
    expect(formatMoney('1.2345', { currency: 'KWD' }).text).toBe('1.235');
  });

  it('accepts a Money instance', () => {
    expect(formatMoney(Money.of('-22415', 'AUD')).text).toBe('(22,415.00)');
  });

  it('refuses floating-point and non-decimal input', () => {
    expect(() => formatMoney(0.1 as unknown as string)).toThrow();
    expect(() => formatMoney('1e3')).toThrow();
    expect(() => formatMoney('12,000.00')).toThrow();
    expect(() => formatMoney('')).toThrow();
  });

  it('property: the text is the exact decimal value, grouped, with sign shown once', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 16n), max: 10n ** 16n }), (cents) => {
        const neg = cents < 0n;
        const abs = neg ? -cents : cents;
        const whole = (abs / 100n).toString();
        const frac = (abs % 100n).toString().padStart(2, '0');
        const value = `${neg ? '-' : ''}${whole}.${frac}`;
        const f = formatMoney(value);
        expect(f.text).toMatch(/^\(?\d{1,3}(,\d{3})*\.\d{2}\)?$/);
        expect(f.text.replace(/[,()]/g, '')).toBe(`${whole}.${frac}`);
        expect(f.text.startsWith('(')).toBe(neg);
        expect(f.spoken.startsWith('minus ')).toBe(neg);
      }),
    );
  });
});

describe('groupThousands', () => {
  it('inserts commas every three digits from the right', () => {
    expect(groupThousands('1')).toBe('1');
    expect(groupThousands('123')).toBe('123');
    expect(groupThousands('1234')).toBe('1,234');
    expect(groupThousands('1234567')).toBe('1,234,567');
  });
});

describe('SS-PLAT-29 sumAmounts (exact decimal totals)', () => {
  it('sums decimal strings exactly (no float drift)', () => {
    expect(sumAmounts(['0.1', '0.2'], 'AUD')).toBe('0.3000');
    expect(sumAmounts(['6840.00', '1450.00', '880.00', '917.00'], 'AUD')).toBe('10087.0000');
    expect(sumAmounts([], 'AUD')).toBe('0.0000');
  });
});
