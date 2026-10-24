/**
 * Quarter and Year aggregation (RQ-0021 Q2, DL-0090).
 *
 *  - Buckets: day (Week, 5 weeks), ISO week starting Monday (Quarter), calendar month (Year).
 *  - Per lane and bucket, actual and expected amounts are summed separately and exactly with
 *    Money (decimal.js). They are never added together (P15).
 *  - Overdue items are not part of expected; their total and count per lane are reported as
 *    `leftOut`, so the screen can say what the projection leaves out.
 *  - Cash: per bucket the closing balance and the lowest point (with its date); a bucket that
 *    straddles the last statement date yields an actual entry and an expected entry.
 */
import { Money } from '@ledgerforce/shared/money';
import {
  addDays,
  addMonths,
  dayLabel,
  dayNumber,
  isoWeekKey,
  monthEnd,
  monthKey,
  monthName,
  monthStart,
  weekStart,
} from '../time/dates.ts';
import { SCALES, type ScaleId } from '../time/scale.ts';

export type ItemState = 'actual' | 'expected' | 'overdue';

export interface AmountItem {
  id: string;
  lane: string;
  date: string;
  /** Decimal string; negative = money out. */
  amount: string;
  state: ItemState;
}

export interface Bucket {
  key: string;
  first: string;
  last: string;
  label: string;
}

export interface StateTotal {
  /** NUMERIC(19,4) text. */
  total: string;
  count: number;
}

export interface LaneBucketCell {
  lane: string;
  bucket: string;
  actual: StateTotal;
  expected: StateTotal;
}

export interface AmountAggregation {
  cells: LaneBucketCell[];
  leftOut: Record<string, StateTotal>;
}

export function bucketKey(scale: ScaleId, iso: string): string {
  switch (SCALES[scale].bucket) {
    case 'day':
      dayNumber(iso);
      return iso;
    case 'week':
      return isoWeekKey(iso);
    case 'month':
      return monthKey(iso);
  }
}

function bucketAt(scale: ScaleId, iso: string): Bucket {
  switch (SCALES[scale].bucket) {
    case 'day':
      return { key: iso, first: iso, last: iso, label: dayLabel(iso) };
    case 'week': {
      const first = weekStart(iso);
      return {
        key: isoWeekKey(iso),
        first,
        last: addDays(first, 6),
        label: `w/c ${dayLabel(first, { weekday: false })}`,
      };
    }
    case 'month': {
      const first = monthStart(iso);
      const jan = first.slice(5, 7) === '01';
      return {
        key: monthKey(iso),
        first,
        last: monthEnd(iso),
        label: jan ? `${monthName(first)} ${first.slice(0, 4)}` : monthName(first),
      };
    }
  }
}

/** Contiguous buckets covering [from, to]. */
export function bucketsBetween(scale: ScaleId, from: string, to: string): Bucket[] {
  const out: Bucket[] = [];
  const end = dayNumber(to);
  let b = bucketAt(scale, from);
  while (dayNumber(b.first) <= end) {
    out.push(b);
    b = bucketAt(scale, SCALES[scale].bucket === 'month' ? addMonths(b.first, 1) : addDays(b.last, 1));
  }
  return out;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function aggregateAmounts(
  items: readonly AmountItem[],
  scale: ScaleId,
  currency: string,
): AmountAggregation {
  const laneOrder: string[] = [];
  const cells = new Map<string, { lane: string; bucket: string; actual: Money[]; expected: Money[] }>();
  const left = new Map<string, Money[]>();
  for (const it of items) {
    if (typeof it.amount !== 'string') {
      throw new TypeError(`Item ${it.id}: amount must be a decimal string, never a JS number`);
    }
    const m = Money.of(it.amount, currency);
    if (!laneOrder.includes(it.lane)) laneOrder.push(it.lane);
    if (it.state === 'overdue') {
      left.set(it.lane, [...(left.get(it.lane) ?? []), m]);
      continue;
    }
    const bucket = bucketKey(scale, it.date);
    const k = `${it.lane}\u0000${bucket}`;
    const cell = cells.get(k) ?? { lane: it.lane, bucket, actual: [], expected: [] };
    cell[it.state].push(m);
    cells.set(k, cell);
  }
  const sum = (xs: Money[]): StateTotal => ({
    total: xs.reduce((a, b) => a.add(b), Money.zero(currency)).toNumericString(),
    count: xs.length,
  });
  const out = [...cells.values()]
    .sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane) || cmp(a.bucket, b.bucket))
    .map((c) => ({ lane: c.lane, bucket: c.bucket, actual: sum(c.actual), expected: sum(c.expected) }));
  const leftOut: Record<string, StateTotal> = {};
  for (const lane of laneOrder) {
    const xs = left.get(lane);
    if (xs) leftOut[lane] = sum(xs);
  }
  return { cells: out, leftOut };
}

export type CashPoint = readonly [date: string, balance: string];

export interface CashBucket {
  bucket: string;
  state: 'actual' | 'expected';
  closing: string;
  lowest: { date: string; balance: string };
}

/**
 * Closing balance and lowest point per bucket. Points are step changes of the balance on a date;
 * those on or before `lastStatement` are actual, later ones expected. Balances keep their text
 * as given (compared with Money, so "9.50" < "10.25").
 */
export function aggregateCash(
  points: readonly CashPoint[],
  scale: ScaleId,
  lastStatement: string,
  currency = 'AUD',
): CashBucket[] {
  const cut = dayNumber(lastStatement);
  const sorted = [...points].sort((a, b) => dayNumber(a[0]) - dayNumber(b[0]));
  const out: CashBucket[] = [];
  for (const [date, balance] of sorted) {
    const state: CashBucket['state'] = dayNumber(date) <= cut ? 'actual' : 'expected';
    const bucket = bucketKey(scale, date);
    const cur = out.at(-1);
    const value = Money.of(balance, currency);
    if (cur && cur.bucket === bucket && cur.state === state) {
      cur.closing = balance;
      if (value.compare(Money.of(cur.lowest.balance, currency)) < 0) cur.lowest = { date, balance };
    } else {
      out.push({ bucket, state, closing: balance, lowest: { date, balance } });
    }
  }
  return out;
}
