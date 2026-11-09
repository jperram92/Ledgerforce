/**
 * Ageing invariants (T-0049, RQ-0122), default fast-check run count.
 *
 * INV-ageing-sum    Σ buckets + unallocated credits = Σ open amounts, per party and in total;
 *                   overdue = Σ of the 1–30 … 90+ buckets.
 * INV-ageing-one    every non-zero debit item is in exactly one bucket, matching its days
 *                   overdue; every credit item is listed once as a credit; zero items vanish.
 */
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AGEING_BUCKETS, ageOpenItems, ageingBucketOf, daysOverdue } from './ageing.ts';

const X = 'XXX';
const m = (s: string) => Money.of(s, X);
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 6, 1);
const iso = (offset: number) => new Date(BASE + offset * DAY).toISOString().slice(0, 10);
/** Signed integer ten-thousandths → NUMERIC text (bigint, never floats). */
const text = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};

const itemArb = fc.record({
  party: fc.constantFrom('p1', 'p2', 'p3'),
  docOffset: fc.integer({ min: 0, max: 300 }),
  dueAfter: fc.integer({ min: 0, max: 120 }),
  units: fc.bigInt({ min: -100_000_000n, max: 100_000_000n }),
});

describe('ageing invariants (INV-ageing-sum, INV-ageing-one)', () => {
  it('hold for any set of open items and as-at date', () => {
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 200 }),
        (raw, extra) => {
          const asOffset = Math.max(0, ...raw.map((r) => r.docOffset)) + extra;
          const asOf = iso(asOffset);
          const items = raw.map((r, i) => ({
            itemId: `i${String(i)}`,
            partyId: r.party,
            partyName: r.party.toUpperCase(),
            sourceType: r.units < 0n ? 'ar_receipt' : 'ar_invoice',
            documentId: null,
            reference: null,
            documentDate: iso(r.docOffset),
            dueDate: iso(r.docOffset + r.dueAfter),
            currency: 'AUD',
            amount: text(r.units),
          }));
          const a = ageOpenItems(items, asOf);

          const sum = (xs: readonly string[]) => xs.reduce((s, x) => s.add(m(x)), m('0'));
          const check = (t: (typeof a)['totals'], subset: typeof items) => {
            const buckets = sum(AGEING_BUCKETS.map((b) => t[b]));
            expect(buckets.add(m(t.unallocatedCredits)).toNumericString()).toBe(
              sum(subset.map((x) => x.amount)).toNumericString(),
            );
            expect(t.total).toBe(sum(subset.map((x) => x.amount)).toNumericString());
            expect(t.overdue).toBe(
              sum([t.days1to30, t.days31to60, t.days61to90, t.over90]).toNumericString(),
            );
          };
          check(a.totals, items);
          for (const p of a.parties) {
            check(
              p.totals,
              items.filter((x) => x.partyId === p.partyId),
            );
            expect(p.inCredit).toBe(m(p.totals.total).isNegative());
            for (const line of p.items) {
              expect(m(line.amount).isPositive()).toBe(true);
              expect(line.daysOverdue).toBe(daysOverdue(line.dueDate, asOf));
              expect(line.bucket).toBe(ageingBucketOf(line.daysOverdue));
            }
            for (const c of p.credits) expect(m(c.amount).isNegative()).toBe(true);
          }
          const listed = a.parties.flatMap((p) => [...p.items, ...p.credits].map((x) => x.itemId));
          expect(new Set(listed).size).toBe(listed.length);
          expect(listed.sort()).toEqual(
            items
              .filter((x) => !m(x.amount).isZero())
              .map((x) => x.itemId)
              .sort(),
          );
        },
      ),
    );
  });
});
