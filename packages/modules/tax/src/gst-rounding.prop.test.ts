/**
 * Property-based invariants of the GST engine (T-0034, Docs/process/tdd.md §4 INV-rounding,
 * RQ-0094). Money is generated as integer cents and turned into decimal strings with
 * Money.fromMinorUnits — never fc.float/fc.double. Default fast-check run count (100).
 */
import { Money } from '@ledgerforce/shared';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateTax, type TaxCalculation, type TaxLineInput } from './gst.engine.ts';
import { draftTaxedDocumentLines } from './tax-journal.ts';

const cents = (n: number) => Money.fromMinorUnits(n, 'AUD').toNumericString();
const HALF_CENT = new Decimal('0.005');

/** 10% GST, zero-rated codes, and arbitrary rates in basis points (0.0001 … 0.9999). */
const rateArb = fc.oneof(
  fc.constant({ taxCode: 'GST', rate: '0.10' }),
  fc.constant({ taxCode: 'FRE', rate: '0' }),
  fc
    .integer({ min: 1, max: 9999 })
    .map((bp) => ({ taxCode: `R${String(bp)}`, rate: new Decimal(bp).div(10_000).toString() })),
);
const lineArb = (sign: 'any' | 'positive') =>
  fc
    .record({
      c:
        sign === 'positive'
          ? fc.integer({ min: 0, max: 10_000_000 })
          : fc.integer({ min: -10_000_000, max: 10_000_000 }),
      r: rateArb,
    })
    .map(({ c, r }): TaxLineInput => ({ amount: cents(c), ...r }));
const docArb = (sign: 'any' | 'positive' = 'any') =>
  fc.record({
    lines: fc.array(lineArb(sign), { minLength: 1, maxLength: 25 }),
    amountsAre: fc.constantFrom('exclusive' as const, 'inclusive' as const),
    rounding: fc.constantFrom('per_line' as const, 'per_document' as const),
  });

/**
 * `rounded` is `exact` rounded half-up (ties away from zero) to cents: the error is at most half
 * a cent, and exactly half a cent only towards zero-away (a tie never rounds towards zero).
 */
const isHalfUpCents = (rounded: Decimal, exact: Decimal): boolean => {
  const err = rounded.minus(exact); // away from zero on a tie: err = +0.005 if exact > 0
  return (
    rounded.decimalPlaces() <= 2 &&
    err.abs().lte(HALF_CENT) &&
    !(err.abs().eq(HALF_CENT) && (exact.isPositive() ? err.isNegative() : err.isPositive()))
  );
};

const dec = (m: Money) => new Decimal(m.toNumericString());
const sumOf = (ms: readonly Money[]) => ms.reduce((s, m) => s.plus(dec(m)), new Decimal(0));
const run = (d: {
  lines: TaxLineInput[];
  amountsAre: 'exclusive' | 'inclusive';
  rounding: 'per_line' | 'per_document';
}): TaxCalculation => calculateTax({ currency: 'AUD', ...d });

describe('GST engine invariants', () => {
  it('totals reconcile: total = Σnet + Σtax − residue; Σline net = net total; Σcode tax = tax total', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run(d);
        expect(dec(r.total).eq(dec(r.netTotal).plus(dec(r.taxTotal)).minus(dec(r.residue)))).toBe(
          true,
        );
        expect(sumOf(r.lines.map((l) => l.net)).eq(dec(r.netTotal))).toBe(true);
        expect(sumOf(r.byCode.map((c) => c.tax)).eq(dec(r.taxTotal))).toBe(true);
        // inclusive: the document total is exactly what the customer was charged
        if (d.amountsAre === 'inclusive') {
          expect(dec(r.total).eq(d.lines.reduce((s, l) => s.plus(l.amount), new Decimal(0)))).toBe(
            true,
          );
        }
      }),
    );
  });

  it('every amount is at whole cents (half-up to the minor unit)', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run(d);
        const all = [
          r.total,
          r.netTotal,
          r.taxTotal,
          r.residue,
          ...r.lines.flatMap((l) => [l.net, l.tax, l.gross]).filter((m): m is Money => m !== null),
        ];
        for (const m of all) expect(dec(m).decimalPlaces()).toBeLessThanOrEqual(2);
      }),
    );
  });

  it('per_line: net + tax = gross on every line, tax is the half-up rounding of the exact tax, no residue', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run({ ...d, rounding: 'per_line' });
        expect(r.residue.isZero()).toBe(true);
        r.lines.forEach((l, i) => {
          const input = d.lines[i] as TaxLineInput;
          const a = new Decimal(input.amount);
          const rate = new Decimal(input.rate);
          const exact =
            d.amountsAre === 'inclusive' ? a.times(rate).div(rate.plus(1)) : a.times(rate);
          const tax = l.tax as Money;
          expect(
            dec(l.net)
              .plus(dec(tax))
              .eq(dec(l.gross as Money)),
          ).toBe(true);
          expect(isHalfUpCents(dec(tax), exact)).toBe(true);
        });
      }),
    );
  });

  it('per_document: code tax is the half-up rounding of the exact tax on the code total; exclusive has no residue; line taxes (when given) sum to the code tax', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run({ ...d, rounding: 'per_document' });
        if (d.amountsAre === 'exclusive') expect(r.residue.isZero()).toBe(true);
        for (const c of r.byCode) {
          const base = d.lines
            .filter((l) => l.taxCode === c.taxCode)
            .reduce((s, l) => s.plus(l.amount), new Decimal(0));
          const rate = new Decimal(c.rate);
          const exact =
            d.amountsAre === 'inclusive' ? base.times(rate).div(rate.plus(1)) : base.times(rate);
          expect(isHalfUpCents(dec(c.tax), exact)).toBe(true);
          const taxes = r.lines.filter((l) => l.taxCode === c.taxCode).map((l) => l.tax);
          if (taxes.every((t): t is Money => t !== null)) {
            expect(sumOf(taxes).eq(dec(c.tax))).toBe(true);
          }
        }
      }),
    );
  });

  it('INV-rounding: |residue| ≤ (lines + tax codes) × 0.005, in whole cents', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run(d);
        const bound = HALF_CENT.times(d.lines.length + r.byCode.length);
        expect(dec(r.residue).abs().lte(bound)).toBe(true);
        expect(dec(r.residue).times(100).isInteger()).toBe(true);
      }),
    );
  });

  it('INV-rounding at 10% GST: |residue| ≤ lines × 0.005', () => {
    const gstDoc = fc.record({
      lines: fc.array(
        fc
          .integer({ min: 0, max: 10_000_000 })
          .map((c): TaxLineInput => ({ amount: cents(c), taxCode: 'GST', rate: '0.10' })),
        { minLength: 1, maxLength: 25 },
      ),
      amountsAre: fc.constantFrom('exclusive' as const, 'inclusive' as const),
      rounding: fc.constantFrom('per_line' as const, 'per_document' as const),
    });
    fc.assert(
      fc.property(gstDoc, (d) => {
        const r = run(d);
        expect(dec(r.residue).abs().lte(HALF_CENT.times(d.lines.length))).toBe(true);
      }),
    );
  });

  it('sign symmetry: negating every line negates every result (half-up is away from zero)', () => {
    fc.assert(
      fc.property(docArb(), (d) => {
        const r = run(d);
        const n = run({
          ...d,
          lines: d.lines.map((l) => ({
            ...l,
            amount: Money.of(l.amount, 'AUD').negate().toNumericString(),
          })),
        });
        expect(n.total.equals(r.total.negate())).toBe(true);
        expect(n.taxTotal.equals(r.taxTotal.negate())).toBe(true);
        expect(n.residue.equals(r.residue.negate())).toBe(true);
      }),
    );
  });

  it('INV-balance: the drafted journal balances and every line has exactly one positive side', () => {
    fc.assert(
      fc.property(docArb(), fc.constantFrom('sale' as const, 'purchase' as const), (d, side) => {
        const r = run(d);
        const lines = draftTaxedDocumentLines(r, {
          side,
          lineAccounts: d.lines.map((_, i) => `acct:${String(i % 3)}`),
        });
        const dr = lines.reduce((s, l) => s.plus(l.debit), new Decimal(0));
        const cr = lines.reduce((s, l) => s.plus(l.credit), new Decimal(0));
        expect(dr.eq(cr)).toBe(true);
        for (const l of lines) {
          expect(new Decimal(l.debit).gt(0) !== new Decimal(l.credit).gt(0)).toBe(true);
        }
      }),
    );
  });
});
