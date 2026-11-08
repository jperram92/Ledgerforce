/**
 * Timeline scales (RQ-0021, DL-0090). One table, so footprints and row caps can be tuned after
 * user testing without touching the layout rule. Positions are a P14 contract: changing a value
 * here changes what users see and needs a release note.
 */
import { addDays, addMonths, monthEnd, weekStart } from './dates.ts';

export type ScaleId = 'week' | '5w' | 'quarter' | 'year';
export type BucketKind = 'day' | 'week' | 'month';

export interface ScaleSpec {
  id: ScaleId;
  label: string;
  bucket: BucketKind;
  /** Horizontal room one item's label needs, in days. */
  footprintDays: number;
  /** Rows a lane may use before items go behind "+n more". */
  maxRows: number;
  /** The visible window around today (inclusive). */
  window: (today: string) => { from: string; to: string };
}

export const SCALES: Readonly<Record<ScaleId, ScaleSpec>> = {
  week: {
    id: 'week',
    label: 'Week',
    bucket: 'day',
    footprintDays: 1,
    maxRows: 3,
    window: (today) => {
      const from = weekStart(today);
      return { from, to: addDays(from, 13) };
    },
  },
  '5w': {
    id: '5w',
    label: '5 weeks',
    bucket: 'day',
    footprintDays: 4,
    maxRows: 2,
    window: (today) => ({ from: addDays(today, -23), to: addDays(today, 16) }),
  },
  quarter: {
    id: 'quarter',
    label: 'Quarter',
    bucket: 'week',
    footprintDays: 14,
    maxRows: 2,
    window: (today) => {
      const from = addDays(weekStart(today), -42);
      return { from, to: addDays(from, 13 * 7 - 1) };
    },
  },
  year: {
    id: 'year',
    label: 'Year',
    bucket: 'month',
    footprintDays: 31,
    // 2, not 1: the month holding the last statement date shows an actual and an expected mark.
    maxRows: 2,
    window: (today) => {
      const from = addMonths(today, -5);
      return { from, to: monthEnd(addMonths(from, 11)) };
    },
  },
};

export const SCALE_ORDER: readonly ScaleId[] = ['week', '5w', 'quarter', 'year'];
