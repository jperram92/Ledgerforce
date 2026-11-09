/**
 * Ageing of AR open items by due date (T-0049, RQ-0122 findings 1–2, DL-0360/DL-0361).
 * Pure shaping: buckets current / 1–30 / 31–60 / 61–90 / 90+, credits listed separately.
 */
import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  ageOpenItems,
  ageingBucketOf,
  daysOverdue,
  type AgeingInput,
} from './ageing.ts';

let n = 0;
const item = (o: Partial<AgeingInput> & { amount: string; dueDate: string }): AgeingInput => ({
  itemId: `item-${String(++n)}`,
  partyId: 'p-acme',
  partyName: 'Acme Pty Ltd',
  sourceType: 'ar_invoice',
  documentId: null,
  reference: null,
  documentDate: '2026-07-01',
  currency: 'AUD',
  ...o,
});

describe('daysOverdue and ageingBucketOf', () => {
  it('counts calendar days from the due date to the as-at date (negative = not yet due)', () => {
    expect(daysOverdue('2026-11-30', '2026-11-30')).toBe(0);
    expect(daysOverdue('2026-11-30', '2026-12-01')).toBe(1);
    expect(daysOverdue('2026-12-31', '2026-11-30')).toBe(-31);
    // across a month end and a leap day
    expect(daysOverdue('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('places every boundary in exactly one bucket', () => {
    const cases: [number, string][] = [
      [-10, 'current'],
      [0, 'current'],
      [1, 'days1to30'],
      [30, 'days1to30'],
      [31, 'days31to60'],
      [60, 'days31to60'],
      [61, 'days61to90'],
      [90, 'days61to90'],
      [91, 'over90'],
      [4000, 'over90'],
    ];
    for (const [days, bucket] of cases) expect(ageingBucketOf(days), String(days)).toBe(bucket);
    expect(AGEING_BUCKETS).toEqual(['current', 'days1to30', 'days31to60', 'days61to90', 'over90']);
  });

  it('refuses a malformed date', () => {
    expect(() => daysOverdue('2026-13-01', '2026-11-30')).toThrow(RangeError);
  });
});

describe('ageOpenItems', () => {
  it('ages debit items by due date and lists credits separately, per party and in total', () => {
    const asOf = '2026-11-30';
    const a = ageOpenItems(
      [
        item({ amount: '100.0000', dueDate: '2026-12-15' }), // current
        item({ amount: '200.5000', dueDate: '2026-11-30' }), // current (due today)
        item({ amount: '300.0000', dueDate: '2026-11-15' }), // 15 days
        item({ amount: '400.0000', dueDate: '2026-10-01' }), // 60 days
        item({ amount: '500.0000', dueDate: '2026-09-01' }), // 90 days
        item({ amount: '600.0000', dueDate: '2026-08-31' }), // 91 days
        item({ amount: '-50.2500', dueDate: '2026-11-20', sourceType: 'ar_receipt' }), // credit
        item({ amount: '0.0000', dueDate: '2026-08-01' }), // settled: ignored
        item({
          partyId: 'p-bolt',
          partyName: 'Bolt Ltd',
          amount: '-220.0000',
          dueDate: '2026-11-10',
          sourceType: 'ar_credit_note',
        }),
      ],
      asOf,
    );
    expect(a.asOf).toBe(asOf);
    expect(a.parties.map((p) => p.partyName)).toEqual(['Acme Pty Ltd', 'Bolt Ltd']);
    const acme = a.parties[0];
    expect(acme?.totals).toEqual({
      current: '300.5000',
      days1to30: '300.0000',
      days31to60: '400.0000',
      days61to90: '500.0000',
      over90: '600.0000',
      unallocatedCredits: '-50.2500',
      overdue: '1800.0000',
      total: '2050.2500',
    });
    expect(acme?.inCredit).toBe(false);
    expect(acme?.items).toHaveLength(6);
    expect(acme?.items.map((i) => i.bucket)).toEqual([
      'over90',
      'days61to90',
      'days31to60',
      'days1to30',
      'current',
      'current',
    ]);
    expect(acme?.items[0]?.daysOverdue).toBe(91);
    expect(acme?.credits.map((c) => c.amount)).toEqual(['-50.2500']);

    const bolt = a.parties[1];
    expect(bolt?.inCredit).toBe(true);
    expect(bolt?.items).toEqual([]);
    expect(bolt?.totals.total).toBe('-220.0000');
    expect(bolt?.totals.overdue).toBe('0.0000');

    expect(a.totals).toEqual({
      current: '300.5000',
      days1to30: '300.0000',
      days31to60: '400.0000',
      days61to90: '500.0000',
      over90: '600.0000',
      unallocatedCredits: '-270.2500',
      overdue: '1800.0000',
      total: '1830.2500',
    });
  });

  it('is all zeros with no items', () => {
    const a = ageOpenItems([], '2026-11-30');
    expect(a.parties).toEqual([]);
    expect(a.totals.total).toBe('0.0000');
    expect(a.totals.unallocatedCredits).toBe('0.0000');
  });

  it('keeps an item without a party under a null party', () => {
    const a = ageOpenItems(
      [item({ partyId: null, partyName: null, amount: '10', dueDate: '2026-11-01' })],
      '2026-11-30',
    );
    expect(a.parties[0]?.partyId).toBeNull();
    expect(a.parties[0]?.totals.days1to30).toBe('10.0000');
  });

  it('refuses an item dated after the as-at date', () => {
    expect(() =>
      ageOpenItems(
        [item({ amount: '10', documentDate: '2026-12-01', dueDate: '2026-12-31' })],
        '2026-11-30',
      ),
    ).toThrow(RangeError);
  });
});
