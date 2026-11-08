import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  dayNumber,
  isoFromDay,
  isoWeekKey,
  monthKey,
  monthStart,
  weekStart,
  weekday,
} from './dates.ts';

describe('calendar arithmetic on whole days (UTC, no time zones)', () => {
  it('converts ISO dates to day numbers and back', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('2026-10-24') - dayNumber('2026-10-01')).toBe(23);
    expect(isoFromDay(dayNumber('2028-02-29'))).toBe('2028-02-29');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60_000 }), (n) => {
        expect(dayNumber(isoFromDay(n))).toBe(n);
      }),
    );
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => dayNumber('2026-02-30')).toThrow();
    expect(() => dayNumber('2026-10-24T00:00:00Z')).toThrow();
    expect(() => dayNumber('24/10/2026')).toThrow();
  });

  it('numbers weekdays from Monday = 0', () => {
    expect(weekday('2026-10-24')).toBe(5); // Saturday
    // The prototype's hand-written "Mon 27 Oct" was wrong: 27 Oct 2026 is a Tuesday. Labels are
    // now always computed from the date.
    expect(weekday('2026-10-27')).toBe(1);
    expect(weekday('2026-10-26')).toBe(0);
  });

  it('finds the ISO week (Monday start; week 1 holds 4 January)', () => {
    expect(weekStart('2026-10-24')).toBe('2026-10-19');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(isoWeekKey('2026-10-24')).toBe('2026-W43');
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
  });

  it('finds the calendar month', () => {
    expect(monthKey('2026-10-24')).toBe('2026-10');
    expect(monthStart('2026-10-24')).toBe('2026-10-01');
  });

  it('labels days in plain English, independent of the machine locale', () => {
    expect(dayLabel('2026-10-27')).toBe('Tue 27 Oct');
    expect(dayLabel('2026-11-05', { weekday: false })).toBe('5 Nov');
  });
});
