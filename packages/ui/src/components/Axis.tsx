import type { CSSProperties } from 'react';
import { bucketsBetween } from '../aggregate/aggregate.ts';
import { offsetOf, pct, rangeDays } from '../layout/geometry.ts';
import { dayLabel, dayNumber, isoFromDay, weekday } from '../time/dates.ts';
import type { ScaleId } from '../time/scale.ts';
import type { DateRange } from './types.ts';

export interface Tick {
  date: string;
  label: string;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/**
 * Tick marks per scale: Week = every day; 5 weeks = Mondays (month named on the first tick and on
 * the first Monday of a month; none in the last three days, where the label would not fit);
 * Quarter = the Monday of each ISO week ("w/c 28 Sep"); Year = each month.
 */
export function axisTicks(scale: ScaleId, range: DateRange): Tick[] {
  const from = dayNumber(range.from);
  const to = dayNumber(range.to);
  if (scale === 'quarter' || scale === 'year') {
    return bucketsBetween(scale, range.from, range.to)
      .filter((b) => dayNumber(b.first) >= from)
      .map((b) => ({ date: b.first, label: b.label }));
  }
  const out: Tick[] = [];
  const last = scale === 'week' ? to : to - 3;
  for (let d = from; d <= last; d++) {
    const iso = isoFromDay(d);
    if (scale === '5w' && weekday(iso) !== 0) continue;
    const day = Number.parseInt(iso.slice(8, 10), 10);
    const withMonth = out.length === 0 || day <= 7;
    out.push({ date: iso, label: dayLabel(iso, { month: withMonth }) });
  }
  return out;
}

export interface AxisProps {
  scale: ScaleId;
  range: DateRange;
  today: string;
}

/** The shared date axis. Decorative for assistive tech: every item states its own date. */
export function Axis({ scale, range, today }: AxisProps) {
  const ticks = axisTicks(scale, range);
  const days = rangeDays(range);
  const t = offsetOf(today, range);
  return (
    <div className="axis" aria-hidden="true">
      {ticks.map((k) => (
        <span
          key={k.date}
          className="tick"
          style={{ '--x': pct(offsetOf(k.date, range), range) } as Vars}
        >
          {k.label}
        </span>
      ))}
      {t >= 0 && t < days ? (
        <span className="today" style={{ '--x': pct(t, range) } as Vars}>
          Today, {dayLabel(today)}
        </span>
      ) : null}
    </div>
  );
}
