/**
 * SS-PLAT-25 (unit) — the outbox retry schedule is design §5.6 rule 2: exponential backoff from
 * 1 minute, capped at 6 hours, then the dead-letter queue (T-0071, RQ-0044 finding 3). The bounds
 * model pg-boss 12.37.1's own formula; the db test checks every observed retry against them.
 */
import { describe, expect, it } from 'vitest';
import { OUTBOX_QUEUE_OPTIONS } from './queue.ts';
import { retryBounds, retrySchedule } from './backoff.ts';

const MIN = 60;
const H = 3600;

describe('SS-PLAT-25 outbox backoff schedule', () => {
  it('SS-PLAT-25: retries back off from 1 minute to the 6-hour cap, ten times, then dead-letter', () => {
    const s = retrySchedule(OUTBOX_QUEUE_OPTIONS);
    expect(s.map((r) => [r.retry, r.minSeconds, r.maxSeconds])).toEqual([
      [1, 1 * MIN, 2 * MIN],
      [2, 2 * MIN, 4 * MIN],
      [3, 4 * MIN, 8 * MIN],
      [4, 8 * MIN, 16 * MIN],
      [5, 16 * MIN, 32 * MIN],
      [6, 32 * MIN, 64 * MIN],
      [7, 64 * MIN, 128 * MIN],
      [8, 128 * MIN, 256 * MIN],
      [9, 256 * MIN, 6 * H],
      [10, 6 * H, 6 * H],
    ]);
    expect(s[0]?.minSeconds).toBe(60); // "1 min"
    expect(Math.max(...s.map((r) => r.maxSeconds))).toBe(6 * H); // "6 h"
    expect(OUTBOX_QUEUE_OPTIONS.deadLetter).toBe('outbox.deliver.dead');
  });

  it('SS-PLAT-25 the whole retry window is 14.5 h to 20.5 h (eleven attempts)', () => {
    const s = retrySchedule(OUTBOX_QUEUE_OPTIONS);
    expect(s).toHaveLength(OUTBOX_QUEUE_OPTIONS.retryLimit);
    expect(s.reduce((n, r) => n + r.minSeconds, 0)).toBe(52_260);
    expect(s.reduce((n, r) => n + r.maxSeconds, 0)).toBe(73_800);
  });

  it('SS-PLAT-25 retryBounds follows the pg-boss formula for other settings too', () => {
    // No backoff: a fixed delay.
    expect(retryBounds({ retryDelay: 30, retryBackoff: false, retryDelayMax: 100 }, 5)).toEqual({
      minSeconds: 30,
      maxSeconds: 30,
    });
    // A zero delay counts as one second under backoff (GREATEST(retry_delay, 1)).
    expect(retryBounds({ retryDelay: 0, retryBackoff: true, retryDelayMax: 1000 }, 0)).toEqual({
      minSeconds: 1,
      maxSeconds: 2,
    });
    // The exponent stops growing at 16.
    expect(
      retryBounds({ retryDelay: 1, retryBackoff: true, retryDelayMax: 10_000_000 }, 40),
    ).toEqual({ minSeconds: 32_768, maxSeconds: 65_536 });
  });
});
