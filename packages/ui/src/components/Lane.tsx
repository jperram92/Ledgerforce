import { useId, useState, type CSSProperties } from 'react';
import { layoutLane, type LaneLayoutItem } from '../layout/lane-layout.ts';
import { pct, rangeDays } from '../layout/geometry.ts';
import { dayLabel, dayNumber, isoFromDay } from '../time/dates.ts';
import type { ScaleSpec } from '../time/scale.ts';
import { Money } from './Money.tsx';
import type { DateRange, TimelineLane, TimelineLaneItem } from './types.ts';

export interface LaneProps {
  lane: TimelineLane;
  scale: Pick<ScaleSpec, 'footprintDays' | 'maxRows'>;
  range: DateRange;
}

type Vars = CSSProperties & Record<`--${string}`, string | number>;

function ItemBody({ it }: { it: TimelineLaneItem }) {
  return (
    <>
      <span className="mark" aria-hidden="true" />
      <span className="txt">
        {it.amount !== undefined ? (
          <span className="amt">
            <Money value={it.amount} />
          </span>
        ) : null}
        <span className="lab">{it.label}</span>
        <span className="meta">
          {it.state === 'expected' ? <span className="tag">expected</span> : null}
          {it.state === 'overdue' ? <span className="tag">not counted</span> : null}
          {it.sub ? <span className="sub">{it.sub}</span> : null}
        </span>
        <time className="when" dateTime={it.date}>
          {it.end
            ? `${dayLabel(it.date, { weekday: false })} to ${dayLabel(it.end, { weekday: false })}`
            : dayLabel(it.date)}
        </time>
      </span>
    </>
  );
}

/**
 * One lane of the Timeline. Items sit on their date; collisions are resolved by the RQ-0021 rule
 * (layoutLane): rows up to the scale's cap, the rest behind "+n more", which reveals them on
 * demand and says when it hides a decision due now (P13). Expected items are dashed and say
 * "expected"; overdue spans are hatched and say "not counted" (P15).
 */
export function Lane({ lane, scale, range }: LaneProps) {
  const uid = useId();
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const byId = new Map(lane.items.map((i) => [i.id, i]));
  const input: LaneLayoutItem[] = lane.items.map((i) => {
    const it: LaneLayoutItem = { id: i.id, start: i.date };
    if (i.end !== undefined) it.end = i.end;
    if (i.now) it.now = true;
    return it;
  });
  const layout = layoutLane(input, scale);
  const days = rangeDays(range);
  const from = dayNumber(range.from);

  return (
    <section
      className={`lane${layout.overflow.length ? ' has-more' : ''}`}
      data-lane={lane.id}
      style={
        { '--rows': Math.max(1, layout.rows), '--fw': pct(scale.footprintDays, range) } as Vars
      }
    >
      <h3 className="lane-name">
        {lane.name}
        {lane.sub ? <span className="lane-sub">{lane.sub}</span> : null}
      </h3>
      <div className="lane-track">
        <ol className="lane-items" aria-label={lane.name}>
          {layout.placed.map((p) => {
            const it = byId.get(p.id);
            if (!it) return null;
            const x = p.from - from;
            const style: Vars = { '--x': pct(x, range), '--row': p.row };
            if (it.end !== undefined) style['--w'] = pct(p.itemTo - p.from, range);
            return (
              <li
                key={p.id}
                className={`lane-item${x * 4 > days * 3 ? ' end' : ''}${it.end !== undefined ? ' span' : ''}`}
                data-id={p.id}
                data-row={p.row}
                data-series={it.state}
                data-bucket={it.bucket}
                data-now={it.now ? '' : undefined}
                style={style}
              >
                <ItemBody it={it} />
              </li>
            );
          })}
        </ol>
        {layout.overflow.map((m, k) => {
          const hidden = m.ids.map((id) => byId.get(id)).filter((i): i is TimelineLaneItem => !!i);
          const nowCount = hidden.filter((i) => i.now).length;
          const listId = `${uid}-more-${String(k)}`;
          const isOpen = open[k] === true;
          const x = m.from - from;
          return (
            <div
              key={listId}
              className={`more-wrap${x * 4 > days * 3 ? ' end' : ''}`}
              style={{ '--x': pct(x, range) } as Vars}
            >
              <button
                type="button"
                className={`more${m.hasNow ? ' now' : ''}`}
                aria-expanded={isOpen}
                aria-controls={listId}
                aria-label={`+${String(hidden.length)} more on ${dayLabel(isoFromDay(m.from))}${
                  nowCount ? `, including ${String(nowCount)} due now` : ''
                }`}
                onClick={() => setOpen({ ...open, [k]: !isOpen })}
              >
                +{hidden.length} more
              </button>
              <ul
                id={listId}
                className="more-list"
                aria-label={`More in ${lane.name}`}
                hidden={!isOpen}
              >
                {isOpen
                  ? hidden.map((it) => (
                      <li
                        key={it.id}
                        className="lane-item"
                        data-id={it.id}
                        data-series={it.state}
                        data-bucket={it.bucket}
                        data-now={it.now ? '' : undefined}
                      >
                        <ItemBody it={it} />
                      </li>
                    ))
                  : null}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
