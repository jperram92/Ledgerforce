/**
 * T-0126 SS-PLAT-136 (property, fast-check default runs): the FX rule of a foreign opening item
 * (GP-040, DL-0741). For any transaction amount and rate, the base amount half-up to cents is
 * accepted with that rate, any other base amount is refused (FX_MISMATCH), the implied rate is
 * base ÷ amount half-up to 8 decimals, and the line always carries the absolute amount.
 */
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OpeningBalanceError } from './errors.ts';
import type { OpeningItemInput } from './opening-csv.ts';
import { checkItemFxShape, itemFx } from './opening-fx.ts';

/** Signed transaction amount with 4 decimals, never zero. */
const txnArb = fc
  .tuple(fc.bigInt({ min: 1n, max: 10_000_000_000n }), fc.boolean())
  .map(([u, neg]) => new Decimal(u.toString()).div(10_000).times(neg ? -1 : 1));
/** Positive rate with 8 decimals, 0.0001 … 1000. */
const rateArb = fc
  .bigInt({ min: 10_000n, max: 100_000_000_000n })
  .map((u) => new Decimal(u.toString()).div(100_000_000));

const item = (txn: Decimal, base: Decimal, fxRate?: Decimal): OpeningItemInput => ({
  kind: txn.isNegative() ? 'ap' : 'ar',
  party: 'P',
  documentNo: 'D-1',
  documentDate: '2026-10-01',
  dueDate: '2026-10-31',
  amount: base.toString(),
  gstAmount: '0',
  currency: 'USD',
  currencyAmount: txn.toString(),
  ...(fxRate ? { fxRate: fxRate.toString() } : {}),
});
const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

describe('SS-PLAT-136: foreign opening-item rate rule (property)', () => {
  it('SS-PLAT-136 a rate is accepted exactly when it reproduces the base amount half-up to cents', () => {
    fc.assert(
      fc.property(txnArb, rateArb, fc.integer({ min: -3, max: 3 }), (txn, rate, cent) => {
        const base = cents(txn.times(rate)).plus(new Decimal(cent).div(100));
        fc.pre(!base.isZero() && base.isNegative() === txn.isNegative());
        const it = item(txn, base, rate);
        checkItemFxShape(it);
        if (cent === 0) {
          const fx = itemFx(it, 'AUD');
          expect(fx?.currency).toBe('USD');
          expect(new Decimal(fx?.fxRate ?? '0').equals(rate)).toBe(true);
          expect(new Decimal(fx?.txnAmount ?? '0').equals(txn.abs())).toBe(true);
        } else {
          expect(() => itemFx(it, 'AUD')).toThrow(
            expect.objectContaining({ code: 'FX_MISMATCH' }) as unknown as OpeningBalanceError,
          );
        }
      }),
    );
  });

  it('SS-PLAT-136 without a rate the rate is base ÷ amount half-up to 8 decimals, printed with 8 decimals', () => {
    fc.assert(
      fc.property(txnArb, rateArb, (txn, rate) => {
        const base = cents(txn.times(rate));
        fc.pre(!base.isZero());
        const fx = itemFx(item(txn, base), 'AUD');
        expect(fx?.fxRate).toMatch(/^\d+\.\d{8}$/);
        const implied = new Decimal(fx?.fxRate ?? '0');
        expect(implied.equals(base.div(txn).toDecimalPlaces(8, Decimal.ROUND_HALF_UP))).toBe(true);
        expect(implied.isPositive()).toBe(true);
        expect(fx?.txnAmount.startsWith('-')).toBe(false);
      }),
    );
  });

  it('SS-PLAT-136 an item in the base currency is a base item: no FX fields, rate 1 only', () => {
    fc.assert(
      fc.property(txnArb, (amount) => {
        const it = { ...item(amount, amount), currency: 'AUD' };
        expect(itemFx(it, 'AUD')).toBeNull();
        expect(() => itemFx({ ...it, fxRate: '1.5' }, 'AUD')).toThrow(OpeningBalanceError);
      }),
    );
  });
});
