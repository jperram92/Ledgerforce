import type { ItemState } from '../aggregate/aggregate.ts';

export type { CashPoint } from '../aggregate/aggregate.ts';

/** One thing on a lane: a dated event, or a span (with `end`). */
export interface TimelineLaneItem {
  id: string;
  date: string;
  end?: string;
  label: string;
  /** Decimal string; negative = money out. */
  amount?: string;
  sub?: string;
  /** actual = happened (solid), expected = due to happen (dashed), overdue = not counted. */
  state: ItemState;
  /** A decision due now (today colour). */
  now?: boolean;
  /** Set on aggregated marks (Quarter, Year): the bucket key. */
  bucket?: string;
}

/** Lane order is a P14 contract: new lanes go below, never re-ordered. */
export interface TimelineLane {
  id: string;
  name: string;
  sub?: string;
  items: TimelineLaneItem[];
}

export interface DateRange {
  from: string;
  to: string;
}
