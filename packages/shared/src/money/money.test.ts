import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { Money, currency, minorUnits } from './index.ts';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../errors.ts';

const aud = (v: string) => Money.of(v, 'AUD');

describe('currency()', () => {
  it('accepts ISO-4217 style upper-case three-letter codes', () => {
    expect(currency('AUD')).toBe('AUD');
  });
  it.each(['aud', 'AU', 'AUDD', '', '12A', 'A D'])('rejects %j', (code) => {
    expect(() => currency(code)).toThrow(InvalidMoneyError);
  });
  it('knows minor units (AUD 2, JPY 0, KWD 3)', () => {
    expect(minorUnits(currency('AUD'))).toBe(2);
    expect(minorUnits(currency('JPY'))).toBe(0);
    expect(minorUnits(currency('KWD'))).toBe(3);
  });
});

describe('Money construction', () => {
  it('builds from decimal strings, bigint, Decimal and safe integers', () => {
    expect(aud('12.34').toNumericString()).toBe('12.3400');
    expect(Money.of(5n, 'AUD').toNumericString()).toBe('5.0000');
    expect(Money.of(new Decimal('0.1'), 'AUD').toNumericString()).toBe('0.1000');
    expect(Money.of(7, 'AUD').toNumericString()).toBe('7.0000');
  });

  it('refuses non-integer JS numbers (no float can enter)', () => {
    expect(() => Money.of(0.1, 'AUD')).toThrow(InvalidMoneyError);
    expect(() => Money.of(Number.NaN, 'AUD')).toThrow(InvalidMoneyError);
    expect(() => Money.of(2 ** 60, 'AUD')).toThrow(InvalidMoneyError);
  });

  it('refuses more than 4 decimal places (NUMERIC(19,4)) instead of silently rounding', () => {
    expect(() => aud('1.00001')).toThrow(InvalidMoneyError);
  });

  it('refuses values outside NUMERIC(19,4)', () => {
    expect(() => aud('1000000000000000')).toThrow(MoneyOverflowError);
    expect(aud('999999999999999.9999').toNumericString()).toBe('999999999999999.9999');
    expect(() => aud('999999999999999.9999').add(aud('0.0001'))).toThrow(MoneyOverflowError);
  });

  it('refuses garbage strings', () => {
    for (const bad of ['', 'abc', '1e5', '1,000.00', ' 1', 'Infinity', '0x10']) {
      expect(() => aud(bad), bad).toThrow(InvalidMoneyError);
    }
  });

  it('builds from minor units', () => {
    expect(Money.fromMinorUnits(12345n, 'AUD').toNumericString()).toBe('123.4500');
    expect(Money.fromMinorUnits(500, 'JPY').toNumericString()).toBe('500.0000');
  });

  it('cannot be coerced to a JS number', () => {
    const m = aud('1.00');
    expect(() => +(m as unknown as number)).toThrow(TypeError);
    expect(() => (m as unknown as number) * 2).toThrow(TypeError);
  });
});

describe('NUMERIC(19,4) string round-trip', () => {
  it('parses canonical database strings', () => {
    const m = Money.fromNumeric('-1234.5600', 'AUD');
    expect(m.toNumericString()).toBe('-1234.5600');
  });
  it('accepts NUMERIC output with fewer decimals', () => {
    expect(Money.fromNumeric('10', 'AUD').toNumericString()).toBe('10.0000');
  });
  it('normalises negative zero', () => {
    expect(Money.fromNumeric('-0.0000', 'AUD').toNumericString()).toBe('0.0000');
  });
  it('serialises to JSON as a string amount, never a number', () => {
    expect(JSON.parse(JSON.stringify(aud('1.5')))).toEqual({ amount: '1.5000', currency: 'AUD' });
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly (0.1 + 0.2 = 0.3)', () => {
    expect(aud('0.1').add(aud('0.2')).equals(aud('0.3'))).toBe(true);
    expect(aud('0.3').sub(aud('0.1')).toNumericString()).toBe('0.2000');
  });

  it('guards currency on add/sub/compare', () => {
    expect(() => aud('1').add(Money.of('1', 'NZD'))).toThrow(CurrencyMismatchError);
    expect(() => aud('1').sub(Money.of('1', 'NZD'))).toThrow(CurrencyMismatchError);
    expect(() => aud('1').compare(Money.of('1', 'NZD'))).toThrow(CurrencyMismatchError);
    expect(aud('1').equals(Money.of('1', 'NZD'))).toBe(false);
  });

  it('multiplies only with an explicit rounding mode', () => {
    // 10% GST on 10.05 = 1.005 -> half-up to cents = 1.01; half-even = 1.00
    expect(aud('10.05').mul('0.1', { scale: 2, rounding: 'half-up' }).toNumericString()).toBe(
      '1.0100',
    );
    expect(aud('10.05').mul('0.1', { scale: 2, rounding: 'half-even' }).toNumericString()).toBe(
      '1.0000',
    );
    expect(aud('10.05').mul('0.1', { scale: 4, rounding: 'half-up' }).toNumericString()).toBe(
      '1.0050',
    );
  });

  it('rounds half-up away from zero for negatives (accounting convention)', () => {
    expect(aud('-1.005').roundToCents().toNumericString()).toBe('-1.0100');
    expect(aud('1.005').roundToCents().toNumericString()).toBe('1.0100');
    expect(aud('1.0049').roundToCents().toNumericString()).toBe('1.0000');
  });

  it('rounds to the currency minor unit', () => {
    expect(Money.of('100.5', 'JPY').roundToMinorUnit().toNumericString()).toBe('101.0000');
  });

  it('negate / abs / sign predicates', () => {
    expect(aud('2.5').negate().toNumericString()).toBe('-2.5000');
    expect(aud('-2.5').abs().toNumericString()).toBe('2.5000');
    expect(aud('0').isZero()).toBe(true);
    expect(aud('-0.0001').isNegative()).toBe(true);
    expect(aud('0.0001').isPositive()).toBe(true);
  });

  it('compares', () => {
    expect(aud('1').compare(aud('2'))).toBe(-1);
    expect(aud('2').compare(aud('2.0000'))).toBe(0);
    expect(aud('3').compare(aud('2'))).toBe(1);
  });

  it('is immutable', () => {
    const a = aud('1');
    a.add(aud('1'));
    expect(a.toNumericString()).toBe('1.0000');
  });
});

describe('allocate / split', () => {
  it('splits 100.00 three ways without losing a cent (largest remainder, earlier wins ties)', () => {
    expect(
      aud('100')
        .split(3)
        .map((m) => m.toNumericString()),
    ).toEqual(['33.3400', '33.3300', '33.3300']);
  });

  it('allocates by ratio', () => {
    expect(
      aud('10.00')
        .allocate(['1', '2', '7'])
        .map((m) => m.toNumericString()),
    ).toEqual(['1.0000', '2.0000', '7.0000']);
    expect(
      aud('0.05')
        .allocate(['3', '7'])
        .map((m) => m.toNumericString()),
    ).toEqual(['0.0200', '0.0300']);
  });

  it('allocates negative amounts symmetrically', () => {
    expect(
      aud('-100')
        .split(3)
        .map((m) => m.toNumericString()),
    ).toEqual(['-33.3400', '-33.3300', '-33.3300']);
  });

  it('supports zero ratios and 4-dp scale', () => {
    expect(
      aud('1')
        .allocate(['0', '1', '1'], { scale: 4 })
        .map((m) => m.toNumericString()),
    ).toEqual(['0.0000', '0.5000', '0.5000']);
  });

  it('refuses to allocate an amount finer than the target scale', () => {
    expect(() => aud('1.005').split(2)).toThrow(InvalidMoneyError);
  });

  it('refuses bad ratios', () => {
    expect(() => aud('1').allocate([])).toThrow(InvalidMoneyError);
    expect(() => aud('1').allocate(['0', '0'])).toThrow(InvalidMoneyError);
    expect(() => aud('1').allocate(['-1', '2'])).toThrow(InvalidMoneyError);
    expect(() => aud('1').split(0)).toThrow(InvalidMoneyError);
  });
});
