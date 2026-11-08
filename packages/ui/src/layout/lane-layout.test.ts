import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCALES } from '../time/scale.ts';
import { isoFromDay, dayNumber } from '../time/dates.ts';
import { layoutLane, type LaneLayoutItem } from './lane-layout.ts';

const D0 = dayNumber('2026-10-01');
const at = (offset: number): string => isoFromDay(D0 + offset);

describe('SS-PLAT-29 lane collision layout (RQ-0021 Q1)', () => {
  it('has per-scale footprints and row caps from RQ-0021', () => {
    expect(SCALES.week).toMatchObject({ bucket: 'day', footprintDays: 1, maxRows: 3 });
    expect(SCALES['5w']).toMatchObject({ bucket: 'day', footprintDays: 4, maxRows: 2 });
    expect(SCALES.quarter).toMatchObject({ bucket: 'week', footprintDays: 14, maxRows: 2 });
    expect(SCALES.year).toMatchObject({ bucket: 'month', footprintDays: 31, maxRows: 2 });
  });

  it('places the Harbour decisions lane on two rows without overlap', () => {
    const l = layoutLane(
      [
        { id: 'cn', start: '2026-10-24', now: true },
        { id: 'pb', start: '2026-10-27', now: true },
        { id: 'mj', start: '2026-10-31', now: true },
      ],
      SCALES['5w'],
    );
    expect(l.placed.map((p) => [p.id, p.row])).toEqual([
      ['cn', 0],
      ['pb', 1],
      ['mj', 0],
    ]);
    expect(l.overflow).toEqual([]);
    expect(l.rows).toBe(2);
  });

  it('hides what does not fit into one "+n more" marker, and says when it hides a due-now item', () => {
    const l = layoutLane(
      [
        { id: 'a', start: at(5) },
        { id: 'b', start: at(5) },
        { id: 'c', start: at(5), now: true },
        { id: 'd', start: at(6) },
      ],
      { footprintDays: 4, maxRows: 2 },
    );
    // due-now first on a tie, then id: c, a placed; b and d hidden
    expect(l.placed.map((p) => p.id)).toEqual(['c', 'a']);
    expect(l.overflow).toHaveLength(1);
    expect(l.overflow[0]).toMatchObject({ ids: ['b', 'd'], hasNow: false });
  });

  it('flags a marker that hides a due-now item', () => {
    const l = layoutLane(
      [
        { id: 'a', start: at(1), now: true },
        { id: 'b', start: at(1), now: true },
        { id: 'c', start: at(1), now: true },
      ],
      { footprintDays: 4, maxRows: 2 },
    );
    expect(l.overflow[0]).toMatchObject({ ids: ['c'], hasNow: true });
  });

  it('widens spans to at least the footprint and keeps their full length', () => {
    const l = layoutLane(
      [
        { id: 'overdue', start: at(0), end: at(22) },
        { id: 'due', start: at(26) },
      ],
      { footprintDays: 4, maxRows: 2 },
    );
    expect(l.placed.find((p) => p.id === 'overdue')).toMatchObject({
      from: D0,
      to: D0 + 23,
      row: 0,
    });
    expect(l.placed.find((p) => p.id === 'due')).toMatchObject({
      from: D0 + 26,
      to: D0 + 30,
      row: 0,
    });
  });

  it('refuses duplicate ids and an end before the start', () => {
    expect(() =>
      layoutLane(
        [
          { id: 'x', start: at(1) },
          { id: 'x', start: at(2) },
        ],
        { footprintDays: 1, maxRows: 1 },
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      layoutLane([{ id: 'x', start: at(3), end: at(1) }], { footprintDays: 1, maxRows: 1 }),
    ).toThrow(/before/i);
  });
});

const itemArb = fc.record({
  start: fc.integer({ min: 0, max: 60 }),
  len: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
  now: fc.boolean(),
});
const itemsArb = fc.array(itemArb, { maxLength: 40 }).map((xs): LaneLayoutItem[] =>
  xs.map((x, i) => ({
    id: `i${String(i).padStart(2, '0')}`,
    start: at(x.start),
    ...(x.len === undefined ? {} : { end: at(x.start + x.len) }),
    now: x.now,
  })),
);
const optsArb = fc.record({
  footprintDays: fc.integer({ min: 1, max: 31 }),
  maxRows: fc.integer({ min: 1, max: 4 }),
});

function depth(items: LaneLayoutItem[], footprintDays: number): number {
  const ev: [number, number][] = [];
  for (const it of items) {
    const s = dayNumber(it.start);
    const e = Math.max(dayNumber(it.end ?? it.start) + 1, s + footprintDays);
    ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

describe('SS-PLAT-29 lane layout invariants (fast-check)', () => {
  it('never overlaps two items in one row, and never overlaps two markers', () => {
    fc.assert(
      fc.property(itemsArb, optsArb, (items, opts) => {
        const l = layoutLane(items, opts);
        for (const a of l.placed) {
          expect(a.row).toBeGreaterThanOrEqual(0);
          expect(a.row).toBeLessThan(opts.maxRows);
          for (const b of l.placed) {
            if (a.id < b.id && a.row === b.row) {
              expect(a.to <= b.from || b.to <= a.from).toBe(true);
            }
          }
        }
        const ms = [...l.overflow].sort((a, b) => a.from - b.from);
        ms.slice(1).forEach((m, i) => {
          expect(ms[i]?.to ?? -Infinity).toBeLessThanOrEqual(m.from);
        });
      }),
    );
  });

  it('accounts for every item exactly once (placed or behind one marker)', () => {
    fc.assert(
      fc.property(itemsArb, optsArb, (items, opts) => {
        const l = layoutLane(items, opts);
        const seen = [...l.placed.map((p) => p.id), ...l.overflow.flatMap((m) => m.ids)].sort();
        expect(seen).toEqual(items.map((i) => i.id).sort());
        for (const m of l.overflow) {
          expect(m.hasNow).toBe(m.ids.some((id) => items.find((i) => i.id === id)?.now === true));
        }
      }),
    );
  });

  it('is deterministic: the same items in any order give the same layout', () => {
    fc.assert(
      fc.property(
        itemsArb.chain((items) =>
          fc.tuple(
            fc.constant(items),
            fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }),
          ),
        ),
        optsArb,
        ([items, shuffled], opts) => {
          expect(layoutLane(shuffled, opts)).toEqual(layoutLane(items, opts));
        },
      ),
    );
  });

  it('hides nothing when the items fit (depth <= row cap), and uses no more rows than needed', () => {
    fc.assert(
      fc.property(itemsArb, optsArb, (items, opts) => {
        const l = layoutLane(items, opts);
        const d = depth(items, opts.footprintDays);
        if (d <= opts.maxRows) {
          expect(l.overflow).toEqual([]);
          expect(l.rows).toBe(d);
        } else {
          expect(l.rows).toBe(opts.maxRows);
        }
      }),
    );
  });
});
