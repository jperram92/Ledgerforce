/**
 * GST engine unit tests (T-0034, design §3.4, RQ-0094). Expected values are worked by hand from
 * the rules in RQ-0094 (half-up to cents; per_line rounds each line, per_document rounds once
 * per tax code) and, where they coincide, from Draft GP-001 / GP-018 in postings.md.
 * The 10% rate is the GST Act s 9-70 rate (RQ-0094 S3), passed in as data.
 */
import { describe, expect, it } from 'vitest';
import { calculateTax, TaxCalculationError, type TaxCalculationInput } from './gst.engine.ts';

const GST = { taxCode: 'GST', rate: '0.10' } as const;
const FRE = { taxCode: 'FRE', rate: '0' } as const;

const calc = (i: Omit<TaxCalculationInput, 'currency'>) => {
  const r = calculateTax({ currency: 'AUD', ...i });
  return {
    lines: r.lines.map((l) => ({
      net: l.net.toNumericString(),
      tax: l.tax?.toNumericString() ?? null,
      gross: l.gross?.toNumericString() ?? null,
    })),
    byCode: r.byCode.map((c) => [c.taxCode, c.net.toNumericString(), c.tax.toNumericString()]),
    net: r.netTotal.toNumericString(),
    tax: r.taxTotal.toNumericString(),
    total: r.total.toNumericString(),
    residue: r.residue.toNumericString(),
  };
};

describe('per_line (AU default)', () => {
  it('tax-exclusive: GST per line, total = net + GST (GP-001 amounts)', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [
        { amount: '1000.00', ...GST },
        { amount: '250.00', ...GST },
      ],
    });
    expect(r.lines).toEqual([
      { net: '1000.0000', tax: '100.0000', gross: '1100.0000' },
      { net: '250.0000', tax: '25.0000', gross: '275.0000' },
    ]);
    expect([r.net, r.tax, r.total, r.residue]).toEqual([
      '1250.0000',
      '125.0000',
      '1375.0000',
      '0.0000',
    ]);
  });

  it('tax-inclusive: GST = gross/11 rounded, net = gross − GST, no residue (GP-018a)', () => {
    const r = calc({
      amountsAre: 'inclusive',
      rounding: 'per_line',
      lines: [
        { amount: '3.35', ...GST },
        { amount: '3.35', ...GST },
        { amount: '3.35', ...GST },
      ],
    });
    expect(r.lines).toEqual(
      Array.from({ length: 3 }, () => ({ net: '3.0500', tax: '0.3000', gross: '3.3500' })),
    );
    expect(r.byCode).toEqual([['GST', '9.1500', '0.9000']]);
    expect([r.net, r.tax, r.total, r.residue]).toEqual(['9.1500', '0.9000', '10.0500', '0.0000']);
  });

  it('half a cent rounds up: 0.05 ex GST → 0.01 per line', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [
        { amount: '0.05', ...GST },
        { amount: '0.05', ...GST },
        { amount: '0.05', ...GST },
      ],
    });
    expect([r.tax, r.total]).toEqual(['0.0300', '0.1800']);
  });

  it('a negative (credit) line rounds half away from zero', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [{ amount: '-0.05', ...GST }],
    });
    expect(r.lines).toEqual([{ net: '-0.0500', tax: '-0.0100', gross: '-0.0600' }]);
  });

  it('GST-free lines carry zero tax and are totalled per code', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [
        { amount: '100.00', ...GST },
        { amount: '50.00', ...FRE },
      ],
    });
    expect(r.byCode).toEqual([
      ['GST', '100.0000', '10.0000'],
      ['FRE', '50.0000', '0.0000'],
    ]);
    expect(r.total).toBe('160.0000');
  });
});

describe('per_document', () => {
  it('tax-inclusive: GST once on the document, nets per line, residue to ROUNDING (GP-018b)', () => {
    const r = calc({
      amountsAre: 'inclusive',
      rounding: 'per_document',
      lines: [
        { amount: '3.35', ...GST },
        { amount: '3.35', ...GST },
        { amount: '3.35', ...GST },
      ],
    });
    // doc GST 10.05/11 = 0.9136… → 0.91, allocated largest-remainder (ties to the first line)
    expect(r.lines).toEqual([
      { net: '3.0500', tax: '0.3100', gross: '3.3500' },
      { net: '3.0500', tax: '0.3000', gross: '3.3500' },
      { net: '3.0500', tax: '0.3000', gross: '3.3500' },
    ]);
    expect(r.byCode).toEqual([['GST', '9.1500', '0.9100']]);
    expect([r.net, r.tax, r.total, r.residue]).toEqual(['9.1500', '0.9100', '10.0500', '0.0100']);
  });

  it('tax-exclusive: GST once on Σnet, total = net + GST, no residue', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_document',
      lines: [
        { amount: '0.05', ...GST },
        { amount: '0.05', ...GST },
        { amount: '0.05', ...GST },
      ],
    });
    // 0.15 × 10% = 0.015 → 0.02 (per_line would give 0.03)
    expect([r.net, r.tax, r.total, r.residue]).toEqual(['0.1500', '0.0200', '0.1700', '0.0000']);
    expect(r.lines.map((l) => l.gross)).toEqual([null, null, null]);
  });

  it('lines of mixed sign within a code get no line-level tax (document tax only)', () => {
    const r = calc({
      amountsAre: 'exclusive',
      rounding: 'per_document',
      lines: [
        { amount: '100.00', ...GST },
        { amount: '-50.00', ...GST },
      ],
    });
    expect(r.lines.map((l) => l.tax)).toEqual([null, null]);
    expect(r.byCode).toEqual([['GST', '50.0000', '5.0000']]);
  });
});

describe('input validation', () => {
  const one = (line: { amount: string; taxCode: string; rate: string }) => () =>
    calculateTax({
      currency: 'AUD',
      amountsAre: 'exclusive',
      rounding: 'per_line',
      lines: [line],
    });

  it('refuses amounts finer than the currency minor unit', () => {
    expect(one({ amount: '1.005', ...GST })).toThrow(TaxCalculationError);
  });

  it('refuses rates outside 0 ≤ rate < 1 or with more than 8 decimals', () => {
    expect(one({ amount: '1.00', taxCode: 'X', rate: '1' })).toThrow(TaxCalculationError);
    expect(one({ amount: '1.00', taxCode: 'X', rate: '-0.1' })).toThrow(TaxCalculationError);
    expect(one({ amount: '1.00', taxCode: 'X', rate: '0.123456789' })).toThrow(TaxCalculationError);
    expect(one({ amount: '1.00', taxCode: 'X', rate: '0.1e1' })).toThrow(TaxCalculationError);
  });

  it('refuses one tax code with two rates in a document', () => {
    expect(() =>
      calculateTax({
        currency: 'AUD',
        amountsAre: 'exclusive',
        rounding: 'per_line',
        lines: [
          { amount: '1.00', taxCode: 'GST', rate: '0.10' },
          { amount: '1.00', taxCode: 'GST', rate: '0.15' },
        ],
      }),
    ).toThrow(/GST has two rates/);
  });

  it('an empty document totals zero', () => {
    const r = calc({ amountsAre: 'inclusive', rounding: 'per_document', lines: [] });
    expect([r.total, r.residue]).toEqual(['0.0000', '0.0000']);
  });
});
