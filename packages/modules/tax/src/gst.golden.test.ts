/**
 * SS-UC01-11 — Tax-inclusive rounding follows the company setting (T-0034, GP-023, which
 * supersedes GP-018; postings.md Q8). The calculator's result for three $3.35 GST-inclusive
 * subscription lines is turned into the invoice journal (AR gross, revenue Σ net, GST Σ tax)
 * and compared with the Approved golden tables 23a (total_invoice, AU default) and 23b
 * (per_line_2dp, opt-in), line for line.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { Money } from '@ledgerforce/shared/money';
import { describe, expect, it } from 'vitest';
import { computeTax, type TaxRounding } from './gst.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp023 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).filter(
  (t) => t.entryId === 'GP-023',
);

/** Invoice journal in the golden's line order: AR, revenue, GST. */
function journal(rounding: TaxRounding) {
  const r = computeTax({
    pricing: 'inclusive',
    rounding,
    lines: Array.from({ length: 3 }, () => ({ amount: '3.35', rate: '0.10' })),
  });
  return [
    { binding: 'system:AR_CONTROL', debit: r.gross, credit: '0' },
    { binding: 'product:SUBSCRIPTION.revenue', debit: '0', credit: r.net },
    { binding: 'tax:GST.collected', debit: '0', credit: r.tax },
  ];
}

const same = (a: string, b: string) => Money.of(a, 'AUD').equals(Money.of(b, 'AUD'));

describe('SS-UC01-11: Tax-inclusive rounding follows company setting', () => {
  it('GP-023 has exactly the two Approved variants a (total_invoice) and b (per_line_2dp)', () => {
    expect(gp023.map((t) => t.label)).toEqual(['a', 'b']);
  });

  for (const [label, rounding] of [
    ['a', 'total_invoice'],
    ['b', 'per_line_2dp'],
  ] as const) {
    it(`SS-UC01-11 ${rounding} produces GP-023${label} line for line`, () => {
      const golden = gp023.find((t) => t.label === label);
      expect(golden, `GP-023${label}`).toBeDefined();
      const got = journal(rounding);
      expect(got.map((l) => l.binding)).toEqual(golden?.lines.map((l) => l.binding));
      got.forEach((l, i) => {
        const g = golden?.lines[i];
        const at = `GP-023${label} line ${String(i + 1)}`;
        expect(
          same(l.debit, g?.debit ?? 'NaN'),
          `${at} debit ${l.debit} vs ${String(g?.debit)}`,
        ).toBe(true);
        expect(
          same(l.credit, g?.credit ?? 'NaN'),
          `${at} credit ${l.credit} vs ${String(g?.credit)}`,
        ).toBe(true);
      });
    });
  }
});
