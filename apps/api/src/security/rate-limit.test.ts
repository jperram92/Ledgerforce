/**
 * T-0142 AC-4 (unit) — route classes and the bounded fixed-window counter behind the rate limit
 * middleware (ADR-0054 rule 4, RQ-0141 F6).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, FixedWindowLimiter, rateLimitClass } from './rate-limit.ts';

describe('T-0142 rate limit route classes', () => {
  it.each([
    ['GET', '/t/acme/auth/login', 'auth'],
    ['GET', '/auth/callback', 'auth'],
    ['GET', '/auth/step-up', 'auth'],
    ['HEAD', '/auth/callback', 'auth'],
    ['GET', '/Auth//Callback/', 'auth'],
    ['POST', '/webhooks/stripe', 'webhook'],
    ['POST', '/WEBHOOKS/stripe/', 'webhook'],
    ['POST', '/auth/logout', 'mutating'],
    ['POST', '/ar/invoices', 'mutating'],
    ['put', '/companies/1', 'mutating'],
    ['PATCH', '/users/1', 'mutating'],
    ['DELETE', '/api-tokens/1', 'mutating'],
    ['GET', '/ar/invoices', null],
    ['GET', '/webhooks/stripe', null],
    ['OPTIONS', '/ar/invoices', null],
    ['GET', '/t/acme/auth/login/extra', null],
  ])('AC-4 %s %s → %s [T-0142]', (method, path, cls) => {
    expect(rateLimitClass(method, path)).toBe(cls);
  });
});

describe('T-0142 fixed-window limiter', () => {
  const policy = { windowMs: 10_000, auth: 2, mutating: 1, webhook: 3 };

  it('AC-4 allows the class limit per key, then refuses with the seconds left in the window [T-0142]', () => {
    let t = 1_000_000;
    const l = new FixedWindowLimiter(policy, () => t);
    expect(l.hit('auth', 'a')).toEqual({ allowed: true });
    t += 2_500;
    expect(l.hit('auth', 'a')).toEqual({ allowed: true });
    expect(l.hit('auth', 'a')).toEqual({ allowed: false, retryAfterSeconds: 8 });
    expect(l.hit('auth', 'b')).toEqual({ allowed: true });
    expect(l.hit('mutating', 'a')).toEqual({ allowed: true });
    expect(l.hit('mutating', 'a')).toEqual({ allowed: false, retryAfterSeconds: 8 });
    t += 7_500;
    expect(l.hit('auth', 'a')).toEqual({ allowed: true });
  });

  it('AC-4 Retry-After is at least one second [T-0142]', () => {
    let t = 0;
    const l = new FixedWindowLimiter(policy, () => t);
    l.hit('mutating', 'a');
    t = 9_999;
    expect(l.hit('mutating', 'a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('AC-4 the key map is bounded: the oldest key is evicted, memory never exceeds maxKeys [T-0142]', () => {
    const t = 0;
    const l = new FixedWindowLimiter({ ...policy, maxKeys: 2 }, () => t);
    l.hit('mutating', 'a');
    l.hit('mutating', 'b');
    l.hit('mutating', 'c');
    expect(l.size).toBe(2);
    // 'a' was evicted, so it starts a fresh window; 'c' is still counted.
    expect(l.hit('mutating', 'a')).toEqual({ allowed: true });
    expect(l.hit('mutating', 'c')).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('AC-5 production defaults are 30 auth, 300 mutating, 600 webhook per 60 s [T-0142]', () => {
    expect(DEFAULT_RATE_LIMITS).toEqual({
      windowMs: 60_000,
      auth: 30,
      mutating: 300,
      webhook: 600,
      maxKeys: 50_000,
    });
  });
});
