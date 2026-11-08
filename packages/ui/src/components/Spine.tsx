import type { ReactNode } from 'react';
import { dayLabel, dayNumber } from '../time/dates.ts';

export interface SpineEvent {
  id: string;
  date: string;
  /** Second line under the date: a time ("10:14 am") or a condition ("if unpaid"). */
  time?: string;
  title: string;
  body?: string;
  /** past = happened, now = today, future = expected, warn = happened and went wrong. */
  state: 'past' | 'now' | 'future' | 'warn';
  /** A word shown as a flag, e.g. "Failed" (P2: a word, not only a colour). */
  flag?: string;
  /** Extra content, e.g. the posted journal. */
  detail?: ReactNode;
}

export interface SpineProps {
  label: string;
  events: readonly SpineEvent[];
  today: string;
}

/**
 * A document's life story, oldest first, on a vertical spine (DL-0070). Happened = solid,
 * today = the now colour, what comes next = dashed and labelled "expected" (P15). There is no way
 * to remove an event: corrections add events (P5).
 */
export function Spine({ label, events, today }: SpineProps) {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    if (prev && cur && dayNumber(cur.date) < dayNumber(prev.date)) {
      throw new Error(`Spine events must be in date order: ${cur.id} is before ${prev.id}`);
    }
  }
  return (
    <ol className="spine" aria-label={label}>
      {events.map((e) => {
        const isNow = e.state === 'now';
        const future = e.state === 'future';
        return (
          <li
            key={e.id}
            className={e.state}
            data-state={e.state}
            data-series={future ? 'expected' : 'actual'}
            aria-current={isNow ? 'step' : undefined}
          >
            <time dateTime={e.date}>
              <b>{isNow && e.date === today ? 'Today' : dayLabel(e.date, { weekday: false })}</b>
              {e.time ?? (isNow ? dayLabel(e.date) : '')}
            </time>
            <span className="mark" aria-hidden="true" />
            <div className="ev">
              <b>
                {e.flag ? <span className="flag">{e.flag}</span> : null}
                {e.title}
              </b>
              {future ? <span className="tag">expected</span> : null}
              {e.body ? <p>{e.body}</p> : null}
              {e.detail}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
