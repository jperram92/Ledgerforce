/**
 * GST calculator (T-0034, design §3.4/§3.6, ATO tax-invoice rounding rules, RQ-0096 Q8, DL-0260).
 *
 * total_invoice (AU default): GST is the document's unrounded GST rounded once, half-up to
 *   cents; line nets are rounded half-up and any cent residual goes to the largest line.
 * per_line_2dp (opt-in, taxable supply rule at 2 dp): each line's GST is rounded on its own.
 * Invariants for any document: Σnet + Σtax = Σgross exactly; every amount has ≤ 2 decimals.
 */
import fc from 'fast-check';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeTax, type TaxDocumentInput } from './gst.ts';

/** "9.14" → "9.1400": the calculator returns the ledger's NUMERIC(19,4) text. */
const m = (v: string) => Money.of(v, 'AUD').toNumericString();
const ms = (vs: string[]) => vs.map(m);
const nets = (r: ReturnType<typeof computeTax>) => r.lines.map((l) => l.net);
const taxes = (r: ReturnType<typeof computeTax>) => r.lines.map((l) => l.tax);

describe('GST calculator — worked examples', () => {
  it('GP-001: exclusive lines 1,000.00 and 250.00 at 10% → GST 100.00 and 25.00 under either rule', () => {
    for (const rounding of ['total_invoice', 'per_line_2dp'] as const) {
      const r = computeTax({
        pricing: 'exclusive',
        rounding,
        lines: [
          { amount: '1000.00', rate: '0.10' },
          { amount: '250.00', rate: '0.10' },
        ],
      });
      expect(nets(r)).toEqual(ms(['1000.00', '250.00']));
      expect(taxes(r)).toEqual(ms(['100.00', '25.00']));
      expect([r.net, r.tax, r.gross]).toEqual(ms(['1250.00', '125.00', '1375.00']));
    }
  });

  it('GP-023a: three 3.35 inclusive lines, total invoice rule → GST 0.91, nets 3.05/3.05/3.04', () => {
    const r = computeTax({
      pricing: 'inclusive',
      rounding: 'total_invoice',
      lines: [
        { amount: '3.35', rate: '0.10' },
        { amount: '3.35', rate: '0.10' },
        { amount: '3.35', rate: '0.10' },
      ],
    });
    expect(nets(r)).toEqual(ms(['3.05', '3.05', '3.04']));
    expect([r.net, r.tax, r.gross]).toEqual(ms(['9.14', '0.91', '10.05']));
  });

  it('GP-023b: the same lines per line at 2 dp → GST 0.30 each, 0.90 in total', () => {
    const r = computeTax({
      pricing: 'inclusive',
      rounding: 'per_line_2dp',
      lines: Array.from({ length: 3 }, () => ({ amount: '3.35', rate: '0.10' })),
    });
    expect(nets(r)).toEqual(ms(['3.05', '3.05', '3.05']));
    expect(taxes(r)).toEqual(ms(['0.30', '0.30', '0.30']));
    expect([r.net, r.tax, r.gross]).toEqual(ms(['9.15', '0.90', '10.05']));
  });

  it('exclusive cents: three 0.33 lines → total invoice GST 0.10 (residual on the last), per line 0.09', () => {
    const lines = Array.from({ length: 3 }, () => ({ amount: '0.33', rate: '0.10' }));
    const t = computeTax({ pricing: 'exclusive', rounding: 'total_invoice', lines });
    expect(taxes(t)).toEqual(ms(['0.03', '0.03', '0.04']));
    expect(t.tax).toBe(m('0.10'));
    const p = computeTax({ pricing: 'exclusive', rounding: 'per_line_2dp', lines });
    expect(p.tax).toBe(m('0.09'));
  });

  it('GST-free lines (rate 0) carry no GST and never take a residual', () => {
    const r = computeTax({
      pricing: 'inclusive',
      rounding: 'total_invoice',
      lines: [
        { amount: '100.00', rate: '0' },
        { amount: '3.35', rate: '0.10' },
        { amount: '3.35', rate: '0.10' },
      ],
    });
    expect(r.lines[0]).toEqual({ net: m('100'), tax: m('0'), gross: m('100') });
    expect(r.tax).toBe(m('0.61')); // 6.70 / 11 = 0.6090… → 0.61
  });

  it('rejects amounts with more than 2 decimals, negative amounts and unknown rates', () => {
    const bad: TaxDocumentInput[] = [
      {
        pricing: 'exclusive',
        rounding: 'total_invoice',
        lines: [{ amount: '1.005', rate: '0.10' }],
      },
      {
        pricing: 'exclusive',
        rounding: 'total_invoice',
        lines: [{ amount: '-1.00', rate: '0.10' }],
      },
      { pricing: 'exclusive', rounding: 'total_invoice', lines: [{ amount: '1.00', rate: 'x' }] },
    ];
    for (const d of bad) expect(() => computeTax(d)).toThrow();
  });
});

const cents = fc
  .integer({ min: 0, max: 100_000_000 })
  .map((n) => Money.fromMinorUnits(n, 'AUD').toNumericString().replace(/00$/, ''));
const docArb = fc.record({
  pricing: fc.constantFrom('inclusive' as const, 'exclusive' as const),
  rounding: fc.constantFrom('total_invoice' as const, 'per_line_2dp' as const),
  lines: fc.array(fc.record({ amount: cents, rate: fc.constantFrom('0.10', '0') }), {
    minLength: 1,
    maxLength: 12,
  }),
});
/** Cent precision in the ledger's 4-decimal text. */
const cent = /^\d+\.\d{2}00$/;

describe('GST calculator — invariants (fast-check)', () => {
  it('INV-gst-sum: Σnet + Σtax = Σgross exactly, and each line net + tax = its gross', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const r = computeTax(doc);
        let n = new Decimal(0);
        let t = new Decimal(0);
        let g = new Decimal(0);
        for (const l of r.lines) {
          expect(new Decimal(l.net).plus(l.tax).equals(l.gross)).toBe(true);
          n = n.plus(l.net);
          t = t.plus(l.tax);
          g = g.plus(l.gross);
        }
        expect([n, t, g].map((d) => Money.of(d, 'AUD').toNumericString())).toEqual([
          r.net,
          r.tax,
          r.gross,
        ]);
        expect(n.plus(t).equals(g)).toBe(true);
      }),
    );
  });

  it('INV-gst-scale: every amount is a non-negative cent amount; the input side is kept', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const r = computeTax(doc);
        r.lines.forEach((l, i) => {
          for (const v of [l.net, l.tax, l.gross]) expect(v).toMatch(cent);
          const given = doc.lines[i]?.amount ?? '';
          expect(doc.pricing === 'inclusive' ? l.gross : l.net).toBe(m(given));
        });
      }),
    );
  });

  it('INV-gst-total-invoice: document GST = Σ unrounded line GST rounded once half-up', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const r = computeTax({ ...doc, rounding: 'total_invoice' });
        const exact = doc.lines.reduce((s, l) => {
          const rate = new Decimal(l.rate);
          const a = new Decimal(l.amount);
          return s.plus(
            doc.pricing === 'inclusive' ? a.times(rate).div(rate.plus(1)) : a.times(rate),
          );
        }, new Decimal(0));
        expect(r.tax).toBe(m(exact.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()));
      }),
    );
  });
});
