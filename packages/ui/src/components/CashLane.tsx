import { Decimal } from 'decimal.js';
import type { CSSProperties } from 'react';
import { formatMoney } from '../money/format.ts';
import { aggregateCash } from '../aggregate/aggregate.ts';
import { offsetOf, rangeDays, round } from '../layout/geometry.ts';
import { dayLabel, dayNumber } from '../time/dates.ts';
import { Money } from './Money.tsx';
import type { CashPoint, DateRange } from './types.ts';

export interface CashLaneProps {
  points: readonly CashPoint[];
  range: DateRange;
  /** Actuals stop here (P15). */
  lastStatement: string;
  /** Vertical scale, as decimal strings. */
  scaleMin: string;
  scaleMax: string;
  /** What the projection leaves out, said in words (P15). */
  leavesOut: string;
  /** Balances to draw faint reference lines at, e.g. ["120000", "150000"]. */
  gridLines?: readonly string[];
  currency?: string;
}

const W = 1000;
const H = 200;
type Vars = CSSProperties & Record<`--${string}`, string>;

/**
 * Cash in bank as a step line (a balance changes on a date; it does not glide between dates).
 * Actual is solid and stops at the last statement date; expected continues from there, dashed and
 * labelled, and the lowest expected point is called out with its date (P15). Heights are computed
 * from the decimal strings with decimal.js: no money ever becomes a JS float.
 */
export function CashLane({
  points,
  range,
  lastStatement,
  scaleMin,
  scaleMax,
  leavesOut,
  gridLines = [],
  currency = 'AUD',
}: CashLaneProps) {
  const lo = new Decimal(scaleMin);
  const span = new Decimal(scaleMax).minus(lo);
  if (!span.isPositive()) throw new RangeError('scaleMax must be above scaleMin');
  const days = rangeDays(range);
  const y = (v: string): string =>
    new Decimal(H).minus(new Decimal(v).minus(lo).div(span).times(H)).toDecimalPlaces(2).toString();
  const x = (iso: string): number =>
    round((Math.min(Math.max(offsetOf(iso, range), 0), days) * W) / days, 2);

  const cut = dayNumber(lastStatement);
  const start = dayNumber(range.from);
  const sorted = [...points].sort((a, b) => dayNumber(a[0]) - dayNumber(b[0]));
  const before = sorted.filter((p) => dayNumber(p[0]) <= start).at(-1) ?? sorted[0];
  if (!before) throw new Error('CashLane needs at least one balance');
  const actual = sorted.filter((p) => dayNumber(p[0]) > start && dayNumber(p[0]) <= cut);
  const expected = sorted.filter((p) => dayNumber(p[0]) > cut);
  const lastActual = [before, ...actual].at(-1) ?? before;

  const step = (pts: readonly CashPoint[]) =>
    pts.map(([d, v]) => `H${String(x(d))} V${y(v)}`).join(' ');
  const actualD =
    `M${String(x(range.from))},${y(before[1])} ${step(actual)} H${String(x(lastStatement))}`.replace(
      /\s+/g,
      ' ',
    );
  const expectedD =
    `M${String(x(lastStatement))},${y(lastActual[1])} ${step(expected)} H${String(W)}`.replace(
      /\s+/g,
      ' ',
    );

  // Lowest expected point: the minimum of the per-bucket lowest points (aggregateCash, RQ-0021).
  const buckets = aggregateCash(sorted, '5w', lastStatement, currency).filter(
    (b) => b.state === 'expected',
  );
  const lowest = buckets.reduce<{ date: string; balance: string } | undefined>(
    (min, b) => (!min || new Decimal(b.lowest.balance).lt(min.balance) ? b.lowest : min),
    undefined,
  );

  const at = (date: string, balance: string): Vars => ({
    '--x': `${String(round((x(date) * 100) / W, 2))}%`,
    '--y': `${new Decimal(y(balance)).div(H).times(100).toDecimalPlaces(2).toString()}%`,
  });
  const grid = gridLines.map((g) => new Decimal(g));

  const fmt = (v: string) => formatMoney(v, { currency }).text;
  const summary =
    `Cash in bank from ${dayLabel(range.from, { weekday: false })} to ${dayLabel(range.to, { weekday: false })}. ` +
    `Actual to the last statement: ${fmt(lastActual[1])} on ${dayLabel(lastStatement, { weekday: false })}.` +
    (lowest
      ? ` Expected lowest ${fmt(lowest.balance)} on ${dayLabel(lowest.date, { weekday: false })}.`
      : '') +
    ` ${leavesOut}`;

  return (
    <figure className="cash" data-lane="cash" data-last-statement={lastStatement}>
      <figcaption className="lane-name">
        Cash in bank
        <span className="lane-sub">expected after {dayLabel(lastStatement)}</span>
      </figcaption>
      <div className="cash-plot">
        <svg
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={summary}
        >
          {grid.map((g) => (
            <line
              key={g.toString()}
              className="grid"
              x1={0}
              x2={W}
              y1={y(g.toString())}
              y2={y(g.toString())}
            />
          ))}
          <path
            className="series actual"
            data-series="actual"
            data-end-date={lastStatement}
            d={actualD}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="series expected"
            data-series="expected"
            data-end-date={range.to}
            d={expectedD}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2}
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {grid.map((g) => (
          <span
            key={g.toString()}
            className="grid-label"
            aria-hidden="true"
            style={at(range.to, g.toString())}
          >
            {g.div(1000).toString()}k
          </span>
        ))}
        <span className="callout actual end" style={at(lastStatement, lastActual[1])}>
          <span className="pt" aria-hidden="true" />
          <Money value={lastActual[1]} currency={currency} />
          <span className="note">last statement, {dayLabel(lastStatement)}</span>
        </span>
        {lowest ? (
          <span className="callout expected low" style={at(lowest.date, lowest.balance)}>
            <span className="pt" aria-hidden="true" />
            <Money value={lowest.balance} currency={currency} />
            <span className="note">Expected lowest, {dayLabel(lowest.date)}</span>
          </span>
        ) : null}
      </div>
      <p className="leaves-out">{leavesOut}</p>
    </figure>
  );
}
