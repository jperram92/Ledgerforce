import { useState, type CSSProperties } from 'react';
import {
  aggregateAmounts,
  bucketKey,
  bucketsBetween,
  type AmountItem,
} from '../aggregate/aggregate.ts';
import { offsetOf, pct, rangeDays } from '../layout/geometry.ts';
import { dayNumber } from '../time/dates.ts';
import { SCALES, SCALE_ORDER, type ScaleId } from '../time/scale.ts';
import { Axis } from './Axis.tsx';
import { CashLane } from './CashLane.tsx';
import { Lane } from './Lane.tsx';
import type { CashPoint, DateRange, TimelineLane, TimelineLaneItem } from './types.ts';

export interface TimelineProps {
  label: string;
  today: string;
  lastStatement: string;
  cash: readonly CashPoint[];
  cashScale: { min: string; max: string; grid?: readonly string[] };
  /** In P14 order. */
  lanes: readonly TimelineLane[];
  leavesOut: string;
  initialScale?: ScaleId;
  currency?: string;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** Clip items to the window; keep spans that reach into it. */
function inRange(items: readonly TimelineLaneItem[], range: DateRange): TimelineLaneItem[] {
  const from = dayNumber(range.from);
  const to = dayNumber(range.to);
  return items.flatMap((i) => {
    const s = dayNumber(i.date);
    const e = dayNumber(i.end ?? i.date);
    if (e < from || s > to) return [];
    if (s >= from) return [i];
    return [{ ...i, date: range.from }];
  });
}

/**
 * Quarter and Year (RQ-0021 Q2): one mark per lane, bucket and state. Amounts are summed exactly
 * (aggregateAmounts); actual and expected stay separate marks; overdue spans are kept as they are
 * (they are not counted). Items without an amount are counted.
 */
function aggregateLane(
  lane: TimelineLane,
  scale: ScaleId,
  range: DateRange,
  currency: string,
): TimelineLaneItem[] {
  const items = inRange(lane.items, range);
  const buckets = new Map(bucketsBetween(scale, range.from, range.to).map((b) => [b.key, b]));
  const firstDay = (key: string) => {
    const b = buckets.get(key);
    if (!b) return range.from;
    return dayNumber(b.first) < dayNumber(range.from) ? range.from : b.first;
  };
  const overdue = items.filter((i) => i.state === 'overdue');
  const withAmount = items.filter((i) => i.state !== 'overdue' && i.amount !== undefined);
  const counted = items.filter((i) => i.state !== 'overdue' && i.amount === undefined);
  const leftOutNote = overdue.length ? ', overdue not counted' : '';

  const amountItems: AmountItem[] = withAmount.map((i) => ({
    id: i.id,
    lane: lane.id,
    date: i.date,
    amount: i.amount ?? '0',
    state: i.state,
  }));
  const out: TimelineLaneItem[] = [...overdue];
  for (const c of aggregateAmounts(amountItems, scale, currency).cells) {
    const inCell = withAmount.filter((i) => bucketKey(scale, i.date) === c.bucket);
    for (const state of ['actual', 'expected'] as const) {
      const t = c[state];
      if (t.count === 0) continue;
      out.push({
        id: `${lane.id}-${c.bucket}-${state === 'actual' ? 'a' : 'e'}`,
        date: firstDay(c.bucket),
        label: state === 'actual' ? 'Happened' : 'Expected',
        amount: t.total,
        sub: `${plural(t.count, 'item')}${state === 'expected' ? leftOutNote : ''}`,
        state,
        bucket: c.bucket,
        ...(inCell.some((i) => i.state === state && i.now) ? { now: true } : {}),
      });
    }
  }
  const groups = new Map<string, TimelineLaneItem[]>();
  for (const i of counted) {
    const k = `${bucketKey(scale, i.date)}\u0000${i.state}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const [k, g] of groups) {
    const [bucket = '', state] = k.split('\u0000');
    const one = g[0];
    if (!one) continue;
    out.push({
      id: `${lane.id}-${bucket}-${state === 'actual' ? 'a' : 'e'}`,
      date: firstDay(bucket),
      label: g.length === 1 ? one.label : plural(g.length, 'event'),
      ...(g.length === 1 && one.sub ? { sub: one.sub } : {}),
      state: one.state,
      bucket,
      ...(g.some((i) => i.now) ? { now: true } : {}),
    });
  }
  return out;
}

/**
 * The Timeline: one date axis for cash and every lane, a scale switch (Week, 5 weeks, Quarter,
 * Year), today's rule and a legend that says what solid, dashed, today and hatched mean.
 */
export function Timeline({
  label,
  today,
  lastStatement,
  cash,
  cashScale,
  lanes,
  leavesOut,
  initialScale = '5w',
  currency = 'AUD',
}: TimelineProps) {
  const [scale, setScale] = useState<ScaleId>(initialScale);
  const spec = SCALES[scale];
  const range = spec.window(today);
  const t = offsetOf(today, range);
  const showToday = t >= 0 && t < rangeDays(range);
  const prepared = lanes.map((l) => ({
    ...l,
    items:
      spec.bucket === 'day' ? inRange(l.items, range) : aggregateLane(l, scale, range, currency),
  }));

  return (
    <section className="timeline" aria-label={label} data-scale={scale}>
      <div className="tl-bar">
        <div className="scale" role="group" aria-label="Time span">
          {SCALE_ORDER.map((id) => (
            <button key={id} type="button" aria-pressed={id === scale} onClick={() => setScale(id)}>
              {SCALES[id].label}
            </button>
          ))}
        </div>
      </div>
      <div className="tl-body">
        <div className="tl-axis-row">
          <span className="lane-name" aria-hidden="true" />
          <Axis scale={scale} range={range} today={today} />
        </div>
        <CashLane
          points={cash}
          range={range}
          lastStatement={lastStatement}
          scaleMin={cashScale.min}
          scaleMax={cashScale.max}
          gridLines={cashScale.grid ?? []}
          leavesOut={leavesOut}
          currency={currency}
        />
        {prepared.map((l) => (
          <Lane key={l.id} lane={l} scale={spec} range={range} />
        ))}
        {showToday ? (
          <div className="rule-layer" aria-hidden="true">
            <div className="today-rule" style={{ '--x': pct(t, range) } as Vars} />
          </div>
        ) : null}
      </div>
      <ul className="legend" aria-label="Legend">
        <li>
          <i className="solid" aria-hidden="true" />
          Happened
        </li>
        <li>
          <i className="dashed" aria-hidden="true" />
          Expected
        </li>
        <li>
          <i className="today" aria-hidden="true" />
          Today, and decisions due now
        </li>
        <li>
          <i className="hatch" aria-hidden="true" />
          Overdue, not counted in the expected balance
        </li>
      </ul>
    </section>
  );
}
