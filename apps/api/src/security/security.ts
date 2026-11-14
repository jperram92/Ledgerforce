/**
 * Request-level hardening of the API (ADR-0054, RQ-0141): OWASP REST security headers on every
 * response, no X-Powered-By, HSTS for an https public URL, the trusted proxy hop count, and the
 * rate limits. CORS is deliberately never enabled (rule 3).
 */
import type { INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';
import { csrfGuard } from './csrf.ts';
import { FixedWindowLimiter, rateLimitMiddleware, type RateLimitPolicy } from './rate-limit.ts';

export interface SecurityOptions {
  /** Send Strict-Transport-Security (only when the public URL is https). */
  hsts?: boolean;
  /** Proxies in front of the API whose X-Forwarded-For entries are trusted (0–5). Default 0. */
  trustProxyHops?: number;
  /** Rate limits; absent = none (unit/DB test harness). Production always sets them (config.ts). */
  rateLimits?: RateLimitPolicy;
  /**
   * The browser-facing public origin (LF_PUBLIC_URL). The CSRF guard (ADR-0076) accepts it as
   * `Origin` when a request has no Fetch Metadata; without it only Sec-Fetch-Site can pass.
   */
  publicOrigin?: string;
  /** Test hook: the limiter's clock (ms). */
  now?: () => number;
}

const HEADERS: readonly (readonly [string, string])[] = [
  ['Cache-Control', 'no-store'],
  ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];
const HSTS = ['Strict-Transport-Security', 'max-age=31536000'] as const;

export function securityHeaders(hsts: boolean) {
  const headers = hsts ? [...HEADERS, HSTS] : HEADERS;
  return (_req: Request, res: Response, next: NextFunction): void => {
    for (const [name, value] of headers) res.setHeader(name, value);
    next();
  };
}

/** Installs the hardening on the Express instance; call before any other middleware or route. */
export function applySecurity(app: INestApplication, opts: SecurityOptions = {}): void {
  const hops = opts.trustProxyHops ?? 0;
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('security.trustProxyHops must be an integer 0–5');
  }
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  express.set('trust proxy', hops);
  app.use(securityHeaders(opts.hsts ?? false));
  if (opts.rateLimits) {
    const limiter = new FixedWindowLimiter(opts.rateLimits, opts.now ?? Date.now);
    app.use(rateLimitMiddleware(limiter));
  }
  // CSRF (ADR-0076): always on; cookie-authenticated writes must prove they are same-origin.
  app.use(csrfGuard(opts.publicOrigin));
}
