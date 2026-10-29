import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from './index.ts';

/**
 * Property-based tests. The reference model is exact integer arithmetic on BigInt "ten-thousandths"
 * (the NUMERIC(19,4) unit). If any floating point leaked into Money, these would diverge for
 * values beyond 2^53 or with fractional parts like 0.1.
 */
const MAX_UNITS = 10n ** 19n - 1n; // NUMERIC(19,4) bound in 1/10000 units
const units = fc.bigInt({ min: -(10n ** 17n), max: 10n ** 17n }); // headroom so sums stay in range
const cents = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

function fmt4(u: bigint): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const int = abs / 10000n;
  const frac = (abs % 10000n).toString().padStart(4, '0');
  return `${neg && abs !== 0n ? '-' : ''}${int.toString()}.${frac}`;
}
const m4 = (u: bigint) => Money.fromNumeric(fmt4(u), 'AUD');
const toUnits = (m: Money): bigint => BigInt(m.toNumericString().replace('.', ''));

describe('Money properties', () => {
  it('formats exactly like the BigInt reference (no float leakage)', () => {
    fc.assert(fc.property(units, (u) => m4(u).toNumericString() === fmt4(u)));
  });

  it('add/sub agree with BigInt arithmetic', () => {
    fc.assert(
      fc.property(units, units, (a, b) => {
        expect(m4(a).add(m4(b)).toNumericString()).toBe(fmt4(a + b));
        expect(m4(a).sub(m4(b)).toNumericString()).toBe(fmt4(a - b));
      }),
    );
  });

  it('add is associative and commutative', () => {
    fc.assert(
      fc.property(units, units, units, (a, b, c) => {
        expect(
          m4(a)
            .add(m4(b))
            .add(m4(c))
            .equals(m4(a).add(m4(b).add(m4(c)))),
        ).toBe(true);
        expect(
          m4(a)
            .add(m4(b))
            .equals(m4(b).add(m4(a))),
        ).toBe(true);
      }),
    );
  });

  it('sub is the inverse of add', () => {
    fc.assert(fc.property(units, units, (a, b) => m4(a).add(m4(b)).sub(m4(b)).equals(m4(a))));
  });

  it('NUMERIC string round-trip is lossless', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -MAX_UNITS, max: MAX_UNITS }), (u) => {
        const s = fmt4(u);
        expect(Money.fromNumeric(s, 'AUD').toNumericString()).toBe(s);
      }),
    );
  });

  it('half-up rounding to cents matches the integer reference', () => {
    fc.assert(
      fc.property(units, (u) => {
        const abs = u < 0n ? -u : u;
        const q = abs / 100n;
        const r = abs % 100n;
        const roundedAbs = (r >= 50n ? q + 1n : q) * 100n;
        const expected = u < 0n ? -roundedAbs : roundedAbs;
        expect(toUnits(m4(u).roundToCents())).toBe(expected);
      }),
    );
  });

  it('allocate always sums back to the total, never loses or invents a cent', () => {
    fc.assert(
      fc.property(
        cents,
        fc
          .array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 20 })
          .filter((r) => r.some((x) => x > 0)),
        (c, ratios) => {
          const total = m4(c * 100n);
          const parts = total.allocate(ratios.map(String));
          expect(parts).toHaveLength(ratios.length);
          const sum = parts.reduce((acc, p) => acc.add(p), Money.zero('AUD'));
          expect(sum.equals(total)).toBe(true);
          // every part is a whole number of cents
          for (const p of parts) expect(toUnits(p) % 100n).toBe(0n);
          // each part is within one cent of its exact proportional share
          const ratioSum = ratios.reduce((a, b) => a + BigInt(b), 0n);
          parts.forEach((p, i) => {
            const exactTimesSum = c * BigInt(ratios[i] ?? 0); // in cents * ratioSum
            const partCentsTimesSum = (toUnits(p) / 100n) * ratioSum;
            const diff = partCentsTimesSum - exactTimesSum;
            expect(diff < 0n ? -diff : diff).toBeLessThan(ratioSum);
          });
        },
      ),
    );
  });

  it('split(n) parts differ from each other by at most one cent', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 1, max: 50 }), (c, n) => {
        const parts = m4(c * 100n)
          .split(n)
          .map(toUnits);
        const max = parts.reduce((a, b) => (b > a ? b : a));
        const min = parts.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 100n).toBe(true);
      }),
    );
  });
});
