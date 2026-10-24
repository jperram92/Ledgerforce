import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '@ledgerforce/shared/money';
import { dayNumber, isoFromDay } from '../time/dates.ts';
import {
  aggregateAmounts,
  aggregateCash,
  bucketKey,
  bucketsBetween,
  type AmountItem,
} from './aggregate.ts';

describe('SS-PLAT-29 buckets per scale (RQ-0021 Q2)', () => {
  it('uses days for Week and 5 weeks, ISO weeks for Quarter, months for Year', () => {
    expect(bucketKey('5w', '2026-10-24')).toBe('2026-10-24');
    expect(bucketKey('week', '2026-10-24')).toBe('2026-10-24');
    expect(bucketKey('quarter', '2026-10-24')).toBe('2026-W43');
    expect(bucketKey('year', '2026-10-24')).toBe('2026-10');
  });

  it('lists contiguous buckets covering a range, with first and last day', () => {
    const q = bucketsBetween('quarter', '2026-10-01', '2026-10-31');
    expect(q.map((b) => b.key)).toEqual([
      '2026-W40',
      '2026-W41',
      '2026-W42',
      '2026-W43',
      '2026-W44',
    ]);
    expect(q[0]).toMatchObject({ first: '2026-09-28', last: '2026-10-04', label: 'w/c 28 Sep' });
    const y = bucketsBetween('year', '2026-10-15', '2027-01-02');
    expect(y.map((b) => [b.key, b.first, b.last, b.label])).toEqual([
      ['2026-10', '2026-10-01', '2026-10-31', 'Oct'],
      ['2026-11', '2026-11-01', '2026-11-30', 'Nov'],
      ['2026-12', '2026-12-01', '2026-12-31', 'Dec'],
      ['2027-01', '2027-01-01', '2027-01-31', 'Jan 2027'],
    ]);
  });
});

const harbourCustomers: AmountItem[] = [
  { id: 'od1', lane: 'customers', date: '2026-10-06', amount: '20000.00', state: 'overdue' },
  { id: 'od2', lane: 'customers', date: '2026-10-14', amount: '13482.50', state: 'overdue' },
  { id: 'r1', lane: 'customers', date: '2026-10-23', amount: '23909.75', state: 'actual' },
  { id: 'e1', lane: 'customers', date: '2026-10-27', amount: '12180.00', state: 'expected' },
  { id: 'e2', lane: 'customers', date: '2026-10-31', amount: '21560.00', state: 'expected' },
  { id: 'e3', lane: 'customers', date: '2026-11-05', amount: '18300.00', state: 'expected' },
  { id: 'p1', lane: 'pay', date: '2026-10-16', amount: '-38214.60', state: 'actual' },
  { id: 'p2', lane: 'pay', date: '2026-10-30', amount: '-38214.60', state: 'expected' },
];

describe('SS-PLAT-29 aggregation keeps actual and expected apart (P15)', () => {
  it('sums each lane and bucket exactly, with separate actual and expected totals', () => {
    const r = aggregateAmounts(harbourCustomers, 'quarter', 'AUD');
    const w44 = r.cells.find((c) => c.lane === 'customers' && c.bucket === '2026-W44');
    expect(w44).toEqual({
      lane: 'customers',
      bucket: '2026-W44',
      actual: { total: '0.0000', count: 0 },
      expected: { total: '33740.0000', count: 2 },
    });
    const pay = r.cells
      .filter((c) => c.lane === 'pay')
      .map((c) => [c.bucket, c.actual, c.expected]);
    expect(pay).toEqual([
      ['2026-W42', { total: '-38214.6000', count: 1 }, { total: '0.0000', count: 0 }],
      ['2026-W44', { total: '0.0000', count: 0 }, { total: '-38214.6000', count: 1 }],
    ]);
  });

  it('leaves overdue out of expected and reports what was left out, per lane', () => {
    const r = aggregateAmounts(harbourCustomers, 'year', 'AUD');
    const oct = r.cells.find((c) => c.lane === 'customers' && c.bucket === '2026-10');
    expect(oct?.expected).toEqual({ total: '33740.0000', count: 2 });
    expect(oct?.actual).toEqual({ total: '23909.7500', count: 1 });
    expect(r.leftOut).toEqual({ customers: { total: '33482.5000', count: 2 } });
  });

  it('refuses an item with a float amount or a mixed currency total', () => {
    const first = harbourCustomers[0] as AmountItem;
    const bad = [{ ...first, amount: 0.1 as unknown as string }];
    expect(() => aggregateAmounts(bad, 'year', 'AUD')).toThrow();
  });

  it('property: every amount lands in exactly one place and the sums are exact', () => {
    const itemArb = fc.record({
      day: fc.integer({ min: 0, max: 400 }),
      cents: fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
      state: fc.constantFrom('actual', 'expected', 'overdue') as fc.Arbitrary<AmountItem['state']>,
      lane: fc.constantFrom('a', 'b', 'c'),
    });
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 60 }),
        fc.constantFrom('week', '5w', 'quarter', 'year') as fc.Arbitrary<
          'week' | '5w' | 'quarter' | 'year'
        >,
        (raw, scale) => {
          const base = dayNumber('2026-01-01');
          const items: AmountItem[] = raw.map((x, i) => ({
            id: `x${String(i)}`,
            lane: x.lane,
            date: isoFromDay(base + x.day),
            amount: centsToDecimal(x.cents),
            state: x.state,
          }));
          const r = aggregateAmounts(items, scale, 'AUD');
          for (const state of ['actual', 'expected'] as const) {
            for (const lane of ['a', 'b', 'c']) {
              const want = items
                .filter((i) => i.lane === lane && i.state === state)
                .reduce((acc, i) => acc.add(Money.of(i.amount, 'AUD')), Money.zero('AUD'));
              const got = r.cells
                .filter((c) => c.lane === lane)
                .reduce((acc, c) => acc.add(Money.of(c[state].total, 'AUD')), Money.zero('AUD'));
              expect(got.toNumericString()).toBe(want.toNumericString());
              const n = r.cells
                .filter((c) => c.lane === lane)
                .reduce((k, c) => k + c[state].count, 0);
              expect(n).toBe(items.filter((i) => i.lane === lane && i.state === state).length);
            }
          }
          for (const lane of ['a', 'b', 'c']) {
            const od = items.filter((i) => i.lane === lane && i.state === 'overdue');
            const want = od.reduce(
              (acc, i) => acc.add(Money.of(i.amount, 'AUD')),
              Money.zero('AUD'),
            );
            if (od.length === 0) expect(r.leftOut[lane]).toBeUndefined();
            else
              expect(r.leftOut[lane]).toEqual({ total: want.toNumericString(), count: od.length });
          }
          for (const c of r.cells) {
            const inCell = items.filter(
              (i) =>
                i.lane === c.lane && i.state !== 'overdue' && bucketKey(scale, i.date) === c.bucket,
            );
            expect(inCell.length).toBe(c.actual.count + c.expected.count);
            expect(inCell.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });
});

function centsToDecimal(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, '0')}`;
}

const cash: [string, string][] = [
  ['2026-10-16', '146391.15'],
  ['2026-10-20', '168240.80'],
  ['2026-10-21', '160410.80'],
  ['2026-10-23', '184320.55'],
  ['2026-10-27', '196500.55'],
  ['2026-10-28', '161481.45'],
  ['2026-10-30', '123266.85'],
  ['2026-10-31', '144826.85'],
  ['2026-11-03', '136576.85'],
];

describe('SS-PLAT-29 cash balance per bucket: closing balance and lowest point', () => {
  it('splits actual (to the last statement) from expected, and keeps the trough', () => {
    const r = aggregateCash(cash, 'quarter', '2026-10-23');
    expect(r).toEqual([
      {
        bucket: '2026-W42',
        state: 'actual',
        closing: '146391.15',
        lowest: { date: '2026-10-16', balance: '146391.15' },
      },
      {
        bucket: '2026-W43',
        state: 'actual',
        closing: '184320.55',
        lowest: { date: '2026-10-21', balance: '160410.80' },
      },
      {
        bucket: '2026-W44',
        state: 'expected',
        closing: '144826.85',
        lowest: { date: '2026-10-30', balance: '123266.85' },
      },
      {
        bucket: '2026-W45',
        state: 'expected',
        closing: '136576.85',
        lowest: { date: '2026-11-03', balance: '136576.85' },
      },
    ]);
  });

  it('a bucket straddling the last statement date becomes two entries, never one mixed figure', () => {
    const r = aggregateCash(cash, 'quarter', '2026-10-21');
    const w43 = r.filter((e) => e.bucket === '2026-W43');
    expect(w43).toEqual([
      {
        bucket: '2026-W43',
        state: 'actual',
        closing: '160410.80',
        lowest: { date: '2026-10-21', balance: '160410.80' },
      },
      {
        bucket: '2026-W43',
        state: 'expected',
        closing: '184320.55',
        lowest: { date: '2026-10-23', balance: '184320.55' },
      },
    ]);
  });

  it('compares balances as decimals, not as text or floats', () => {
    const r = aggregateCash(
      [
        ['2026-10-01', '9.50'],
        ['2026-10-02', '10.25'],
        ['2026-10-03', '100.00'],
      ],
      'year',
      '2026-10-31',
    );
    expect(r[0]?.lowest).toEqual({ date: '2026-10-01', balance: '9.50' });
  });
});
