import { useRef, useState, type KeyboardEvent } from 'react';
import { dayLabel, dayNumber } from '../time/dates.ts';
import { Money } from './Money.tsx';

export type Turn =
  | { kind: 'you' }
  | { kind: 'person'; name: string }
  | { kind: 'customer'; name: string }
  | { kind: 'system'; name: string };

export interface OpenItem {
  id: string;
  what: string;
  why?: string;
  amount?: string;
  /** Who acts next (P13). */
  turn: Turn;
  /** The date it blocks something, with a short note ("by 5 pm"). */
  due: { date: string; note?: string };
}

export interface TurnQueueProps {
  label: string;
  items: readonly OpenItem[];
  today: string;
  onOpen: (id: string) => void;
}

function turnText(t: Turn): string {
  switch (t.kind) {
    case 'you':
      return 'Your turn';
    case 'person':
      return `${t.name}'s turn`;
    case 'customer':
      return `Waiting on ${t.name} (customer)`;
    case 'system':
      return `${t.name} (system)`;
  }
}

function check(item: OpenItem): void {
  if (!item.turn || !item.turn.kind) {
    throw new Error(`Open item ${item.id} has no turn: say who acts next (P13)`);
  }
  if (!item.due || !item.due.date) {
    throw new Error(`Open item ${item.id} has no due date (P13)`);
  }
  dayNumber(item.due.date);
}

/**
 * Direction A's turn queue inside the Timeline (P13, P10): every open item names who acts next
 * and the date it blocks. Keyboard: J / ArrowDown next, K / ArrowUp previous, Home / End, Enter
 * opens. One item is in the tab order at a time (roving tabindex).
 */
export function TurnQueue({ label, items, today, onOpen }: TurnQueueProps) {
  items.forEach(check);
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(items.length - 1, to));
    setActive(i);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === 'j' || k === 'J' || k === 'ArrowDown') move(i + 1);
    else if (k === 'k' || k === 'K' || k === 'ArrowUp') move(i - 1);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="turns">
      <ol className="queue" aria-label={label}>
        {items.map((it, i) => (
          <li
            key={it.id}
            data-open-item=""
            data-turn={it.turn.kind}
            data-due={it.due.date}
            className={it.turn.kind === 'you' ? 'yours' : undefined}
          >
            <button
              type="button"
              ref={(el) => {
                refs.current[i] = el;
              }}
              tabIndex={i === active ? 0 : -1}
              onFocus={() => setActive(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onClick={() => onOpen(it.id)}
            >
              <span className="by">
                <b>{it.due.date === today ? 'Today' : dayLabel(it.due.date)}</b>
                {it.due.note ? <small>{it.due.note}</small> : null}
              </span>
              <span className="body">
                <span className="what">{it.what}</span>
                {it.why ? <span className="why">{it.why}</span> : null}
                <span className="turn">{turnText(it.turn)}</span>
              </span>
              <span className="amt">{it.amount ? <Money value={it.amount} /> : null}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="keys">
        <span>
          <kbd>J</kbd> <kbd>K</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Tab</kbd> leave the list
        </span>
      </p>
    </div>
  );
}
