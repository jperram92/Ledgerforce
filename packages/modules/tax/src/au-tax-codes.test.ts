import { describe, expect, it } from 'vitest';
import { AU_TAX_CODES, taxCodeOn, type TaxCodeDefinition } from './au-tax-codes.ts';

describe('AU tax-code catalogue (T-0034, design §3.6)', () => {
  it('has the design §3.6 codes plus the adjustment code, each once', () => {
    expect(AU_TAX_CODES.map((t) => t.code).sort()).toEqual(
      [
        'BAS-EXCLUDED',
        'GST',
        'GST-ADJ',
        'GST-CAP',
        'GST-FREE',
        'GST-FREE-EXPORT',
        'GST-IMPORT',
        'INPUT-TAXED',
      ].sort(),
    );
  });

  it('rates are 10 % for taxable, capital, import and adjustment codes and 0 otherwise', () => {
    for (const t of AU_TAX_CODES) {
      const ten = ['taxable', 'capital', 'import', 'adjustment'].includes(t.kind);
      expect(t.rate, t.code).toBe(ten ? '0.10' : '0');
    }
  });

  it('confirmed BAS labels: GST sales G1/1A, purchases G11/1B; capital G10/1B; adjustments 1A/1B', () => {
    const by = (c: string) => AU_TAX_CODES.find((t) => t.code === c);
    expect(by('GST')?.sales).toEqual(['G1', '1A']);
    expect(by('GST')?.purchases).toEqual(['G11', '1B']);
    expect(by('GST-CAP')?.purchases).toEqual(['G10', '1B']);
    expect([by('GST-ADJ')?.sales, by('GST-ADJ')?.purchases]).toEqual([['1A'], ['1B']]);
    expect(by('BAS-EXCLUDED')?.sales).toEqual([]);
  });

  it('looks codes up by effective date; a superseded rate stops on its end date', () => {
    expect(taxCodeOn('GST', '2026-11-05')?.rate).toBe('0.10');
    expect(taxCodeOn('GST', '2000-06-30')).toBeUndefined();
    const gst = AU_TAX_CODES.find((t) => t.code === 'GST');
    if (!gst) throw new Error('GST missing');
    const dated: TaxCodeDefinition[] = [
      { ...gst, rate: '0.10', effectiveTo: '2030-06-30' },
      { ...gst, rate: '0.125', effectiveFrom: '2030-07-01' },
    ];
    expect(taxCodeOn('GST', '2030-06-30', dated)?.rate).toBe('0.10');
    expect(taxCodeOn('GST', '2030-07-01', dated)?.rate).toBe('0.125');
    expect(taxCodeOn('NOPE', '2026-11-05')).toBeUndefined();
  });
});
