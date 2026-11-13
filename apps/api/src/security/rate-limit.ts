/**
 * Per-client-address rate limits (ADR-0054 rule 4, RQ-0141 F4–F6): fixed 60-second windows per
 * (route class, address), answered with 429 + Retry-After before routing. Counters live in this
 * process (single API process in the compose MVP); the key map is bounded.
 */
import type { NextFunction, Request, Response } from 'express';

export type RateLimitClass = 'auth' | 'mutating' | 'webhook';

export interface RateLimitPolicy {
  windowMs: number;
  /** Requests per window per client address, by class. */
  auth: number;
  mutating: number;
  webhook: number;
  /** Most (class, address) counters kept; the oldest is evicted beyond it. Default 50 000. */
  maxKeys?: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  windowMs: 60_000,
  auth: 30,
  mutating: 300,
  webhook: 600,
  maxKeys: 50_000,
};

export type Hit = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH = /^\/(?:t\/[^/]+\/auth\/login|auth\/(?:callback|step-up))$/;
const WEBHOOK = /^\/webhooks(?:\/|$)/;

/**
 * The class a request counts against, or null when it is not limited. The path is normalised the
 * way Express routes it (case-insensitive, trailing slash optional), plus repeated slashes, so a
 * spelling variant of a route cannot fall outside its class.
 */
export function rateLimitClass(method: string, path: string): RateLimitClass | null {
  const p = path
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/+$/, '$1');
  if (AUTH.test(p)) return 'auth';
  if (SAFE.has(method.toUpperCase())) return null;
  return WEBHOOK.test(p) ? 'webhook' : 'mutating';
}

export class FixedWindowLimiter {
  // Insertion order = window start order (a new window re-inserts), so the first key is the oldest.
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  hit(cls: RateLimitClass, key: string): Hit {
    const t = this.now();
    const id = `${cls} ${key}`;
    const w = this.windows.get(id);
    if (w && t - w.start < this.policy.windowMs) {
      if (w.count >= this.policy[cls]) {
        const left = w.start + this.policy.windowMs - t;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)) };
      }
      w.count += 1;
      return { allowed: true };
    }
    this.windows.delete(id);
    const max = this.policy.maxKeys ?? DEFAULT_RATE_LIMITS.maxKeys ?? 50_000;
    while (this.windows.size >= max) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    this.windows.set(id, { start: t, count: 1 });
    return { allowed: true };
  }
}

/** Express middleware: refuse over-limit requests with 429 {error:'rate_limited'} + Retry-After. */
export function rateLimitMiddleware(limiter: FixedWindowLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cls = rateLimitClass(req.method, req.path);
    if (cls === null) {
      next();
      return;
    }
    const hit = limiter.hit(cls, (req.ip ?? 'unknown').replace(/^::ffff:/, ''));
    if (hit.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(hit.retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited' });
  };
}
