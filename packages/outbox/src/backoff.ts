/**
 * The retry schedule of a pg-boss queue, as bounds (design §5.6 rule 2, RQ-0044 finding 3).
 * pg-boss 12.37.1 schedules the retry after a failure of the attempt with `retryCount = c` at
 *   LEAST(retryDelayMax, GREATEST(retryDelay, 1) · (2^min(16, c+1) / 2) · (1 + random()))
 * seconds with backoff, or `retryDelay` seconds without. The bounds are the random() = 0 and
 * random() = 1 ends. Integers only (seconds); this is time, not money.
 */
export interface RetryPolicy {
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number;
}

export interface RetryBounds {
  minSeconds: number;
  maxSeconds: number;
}

/** Delay bounds after the attempt whose retryCount is `retryCount` fails. */
export function retryBounds(p: RetryPolicy, retryCount: number): RetryBounds {
  if (!p.retryBackoff) return { minSeconds: p.retryDelay, maxSeconds: p.retryDelay };
  const base = Math.max(p.retryDelay, 1) * 2 ** (Math.min(16, retryCount + 1) - 1);
  return {
    minSeconds: Math.min(p.retryDelayMax, base),
    maxSeconds: Math.min(p.retryDelayMax, 2 * base),
  };
}

/** Every retry of a fresh job (1..retryLimit) with its delay bounds. */
export function retrySchedule(
  p: RetryPolicy & { retryLimit: number },
): (RetryBounds & { retry: number })[] {
  return Array.from({ length: p.retryLimit }, (_, c) => ({ retry: c + 1, ...retryBounds(p, c) }));
}
