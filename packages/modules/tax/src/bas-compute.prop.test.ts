/**
 * SS-PLAT-114 — BAS invariants (T-0035, RQ-0102, DL-0278), fast-check with the default run
 * count. Money is generated as integer cents (Money.fromMinorUnits), never floats.
 *
 *  INV-bas-settled   a document settled in one allocation reports on the cash basis exactly
 *                    what it reports on accruals; settled in k parts (k periods) the cash
 *                    periods sum to the accruals figure within k half-cents per label.
 *  INV-bas-mirror    a document and its mirror (every side swapped — a full credit note or
 *                    supplier credit) net to zero on every label.
 *  INV-bas-simpler   the Simpler BAS equals the full BAS's G1, 1A and 1B.
 */
import type { AccountType } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BAS_LABELS, computeBas, type BasLine } from './bas-compute.ts';
import type { BasLabelMapRow } from './bas-report.ts';
import { auTaxCodes } from './tax-codes.ts';

const MAP: BasLabelMapRow[] = (auTaxCodes.basLabels ?? []).map((l) => ({
  taxCode: l.code,
  flow: l.flow,
  label: l.label,
  amount: l.amount,
  positiveSide: l.positiveSide,
  basis: l.basis,
  validFrom: l.validFrom,
  validTo: null,
}));
const cents = (n: number) => Money.fromMinorUnits(n, 'AUD').toNumericString();

const CODES = ['GST', 'FRE', 'EXP', 'INP', 'N-T', 'IMP', 'CAP', 'BAS-W1', 'BAS-W2'] as const;
const TYPES: AccountType[] = ['revenue', 'liability', 'asset', 'expense', 'equity'];

const lineArb = fc
  .record({
    net: fc.integer({ min: 1, max: 50_000_000 }),
    tax: fc.integer({ min: 0, max: 5_000_000 }),
    debit: fc.boolean(),
    code: fc.constantFrom(...CODES),
    type: fc.constantFrom(...TYPES),
    date: fc.constantFrom('2026-11-05', '2027-03-31', '2027-12-01'),
  })
  .map((r): BasLine => ({
    entryId: 'doc',
    entryDate: r.date,
    accountType: r.type,
    debit: r.debit ? cents(r.net) : '0.0000',
    credit: r.debit ? '0.0000' : cents(r.net),
    taxCode: r.code,
    taxAmount: r.code === 'GST' || r.code === 'CAP' || r.code === 'IMP' ? cents(r.tax) : null,
  }));
const docArb = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 12 }),
  original: fc.integer({ min: 1, max: 100_000_000 }),
  // Settlement split into parts (integer cents summing to `original`).
  cuts: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }),
});

/** The settlement split into parts by Money#allocate (largest remainder, exact cents). */
const parts = (original: number, cuts: number[]): string[] =>
  Money.fromMinorUnits(original, 'AUD')
    .allocate(cuts)
    .filter((p) => !p.isZero())
    .map((p) => p.toNumericString());

describe('SS-PLAT-114 BAS invariants', () => {
  it('INV-bas-settled: settled cash equals accruals (exact in one part, within k half-cents in k)', () => {
    fc.assert(
      fc.property(docArb, ({ lines, original, cuts }) => {
        const accruals = computeBas({ basis: 'accruals', format: 'full', map: MAP, lines });
        // ADJ-BD is not generated: it is the only accruals-only row.
        const once = computeBas({
          basis: 'cash',
          format: 'full',
          map: MAP,
          lines: [],
          documents: [
            {
              share: { entryId: 'doc', released: cents(original), original: cents(original) },
              lines,
            },
          ],
        });
        expect(once).toEqual(accruals);
        const ps = parts(original, cuts);
        const periods = ps.map((p) =>
          computeBas({
            basis: 'cash',
            format: 'full',
            map: MAP,
            lines: [],
            documents: [
              { share: { entryId: 'doc', released: p, original: cents(original) }, lines },
            ],
          }),
        );
        const bound = new Decimal('0.005').times(ps.length);
        for (const l of BAS_LABELS) {
          const sum = periods.reduce((s, r) => s.plus(r[l] ?? '0'), new Decimal(0));
          expect(
            sum
              .minus(accruals[l] ?? '0')
              .abs()
              .lte(bound),
            l,
          ).toBe(true);
        }
      }),
    );
  });

  it('INV-bas-mirror: a document and its mirror net to zero on every label', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 12 }), (lines) => {
        const mirror = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
        const r = computeBas({
          basis: 'accruals',
          format: 'full',
          map: MAP,
          lines: [...lines, ...mirror],
        });
        for (const l of BAS_LABELS) expect(r[l], l).toBe('0.00');
      }),
    );
  });

  it('INV-bas-simpler: the Simpler BAS equals the full BAS on G1, 1A and 1B', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 0, maxLength: 12 }),
        fc.constantFrom('accruals' as const, 'cash' as const),
        (lines, basis) => {
          const f = computeBas({ basis, format: 'full', map: MAP, lines });
          const s = computeBas({ basis, format: 'simpler', map: MAP, lines });
          expect(s).toEqual({ G1: f.G1, '1A': f['1A'], '1B': f['1B'] });
        },
      ),
    );
  });
});
