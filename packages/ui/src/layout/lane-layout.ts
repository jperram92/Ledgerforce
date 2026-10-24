/**
 * Lane collision layout (RQ-0021 Q1, DL-0090).
 *
 * Each item occupies a footprint of whole days: [start, max(end + 1, start + footprintDays)).
 * Items are sorted by start, then due-now first, then id, and each goes to the lowest row whose
 * last footprint ends at or before its start (greedy first-fit interval partitioning, which uses
 * the minimum number of rows). Rows are capped; an item with no free row is hidden behind a
 * "+n more" marker. A marker starts at its first hidden item and absorbs every later hidden item
 * that starts inside its footprint, so markers never overlap.
 *
 * Pure and deterministic: no text measuring, no dependence on input order.
 */
import { dayNumber } from '../time/dates.ts';

export interface LaneLayoutItem {
  id: string;
  start: string;
  end?: string;
  now?: boolean;
}

export interface LaneLayoutOptions {
  footprintDays: number;
  maxRows: number;
}

export interface PlacedItem {
  id: string;
  row: number;
  /** First day of the footprint (day number). */
  from: number;
  /** Day after the footprint ends (exclusive). */
  to: number;
  /** Day after the item itself ends (exclusive); for drawing spans at their true length. */
  itemTo: number;
}

export interface OverflowMarker {
  from: number;
  to: number;
  ids: string[];
  hasNow: boolean;
}

export interface LaneLayout {
  placed: PlacedItem[];
  overflow: OverflowMarker[];
  rows: number;
}

interface Norm {
  id: string;
  from: number;
  to: number;
  itemTo: number;
  now: boolean;
}

export function layoutLane(items: readonly LaneLayoutItem[], opts: LaneLayoutOptions): LaneLayout {
  if (!Number.isSafeInteger(opts.footprintDays) || opts.footprintDays < 1) {
    throw new RangeError('footprintDays must be a whole number of days >= 1');
  }
  if (!Number.isSafeInteger(opts.maxRows) || opts.maxRows < 1) {
    throw new RangeError('maxRows must be a whole number >= 1');
  }
  const ids = new Set<string>();
  const norm: Norm[] = items.map((it) => {
    if (ids.has(it.id)) throw new Error(`Duplicate lane item id ${JSON.stringify(it.id)}`);
    ids.add(it.id);
    const from = dayNumber(it.start);
    const last = it.end === undefined ? from : dayNumber(it.end);
    if (last < from) throw new RangeError(`Item ${it.id} ends before it starts`);
    return {
      id: it.id,
      from,
      to: Math.max(last + 1, from + opts.footprintDays),
      itemTo: last + 1,
      now: it.now === true,
    };
  });
  norm.sort(
    (a, b) =>
      a.from - b.from ||
      (b.now ? 1 : 0) - (a.now ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const rowEnds: number[] = [];
  const placed: PlacedItem[] = [];
  const hidden: Norm[] = [];
  for (const it of norm) {
    let row = rowEnds.findIndex((end) => end <= it.from);
    if (row === -1 && rowEnds.length < opts.maxRows) {
      row = rowEnds.length;
      rowEnds.push(it.to);
    } else if (row !== -1) {
      rowEnds[row] = it.to;
    }
    if (row === -1) hidden.push(it);
    else placed.push({ id: it.id, row, from: it.from, to: it.to, itemTo: it.itemTo });
  }

  const overflow: OverflowMarker[] = [];
  for (const it of hidden) {
    const m = overflow.at(-1);
    if (m && it.from < m.to) {
      m.ids.push(it.id);
      m.hasNow ||= it.now;
    } else {
      overflow.push({
        from: it.from,
        to: it.from + opts.footprintDays,
        ids: [it.id],
        hasNow: it.now,
      });
    }
  }
  return { placed, overflow, rows: rowEnds.length };
}
