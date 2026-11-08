/**
 * Horizontal geometry shared by the axis, the cash chart and the lanes: a date range of whole days
 * maps to 0–100% (or 0–1000 viewBox units). These are screen positions, not money.
 */
import { dayNumber } from '../time/dates.ts';
import type { DateRange } from '../components/types.ts';

export function rangeDays(range: DateRange): number {
  const n = dayNumber(range.to) - dayNumber(range.from) + 1;
  if (n < 1) throw new RangeError('range.to is before range.from');
  return n;
}

/** Round a screen coordinate to at most `dp` decimals for stable attribute text. */
export function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Offset in days from the range start → percent of the track width, e.g. "57.5%". */
export function pct(days: number, range: DateRange): string {
  return `${String(round((days * 100) / rangeDays(range)))}%`;
}

export function offsetOf(iso: string, range: DateRange): number {
  return dayNumber(iso) - dayNumber(range.from);
}
