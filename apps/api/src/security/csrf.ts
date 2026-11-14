/**
 * CSRF guard (T-0144, ADR-0076, DL-0477 item 7; OWASP CSRF Prevention Cheat Sheet, RQ-0141 F6–F8).
 * An unsafe request that carries the `lf_session` cookie must prove it is same-origin:
 *   - Sec-Fetch-Site: same-origin or none → allowed;
 *   - any other Sec-Fetch-Site (same-site, cross-site, …) → 403;
 *   - no Fetch Metadata → allowed only when Origin equals the configured public origin; a foreign
 *     Origin, `null` or no Origin → 403 (fail-safe).
 * Requests without the session cookie (Bearer tokens, webhooks, anonymous) and safe methods are not
 * inspected. A rejection never reaches routing and says nothing beyond the error code.
 */
import type { NextFunction, Request, Response } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_COOKIE = /(?:^|;\s*)lf_session=/;

export function csrfGuard(publicOrigin: string | undefined) {
  const allowedOrigin = publicOrigin ? new URL(publicOrigin).origin : undefined;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) return next();
    const cookie = req.headers.cookie;
    if (typeof cookie !== 'string' || !SESSION_COOKIE.test(cookie)) return next();
    const site = req.headers['sec-fetch-site'];
    let ok: boolean;
    if (typeof site === 'string') {
      ok = site === 'same-origin' || site === 'none';
    } else {
      const origin = req.headers.origin;
      ok = allowedOrigin !== undefined && typeof origin === 'string' && origin === allowedOrigin;
    }
    if (ok) return next();
    res.status(403).json({ error: 'csrf_rejected' });
  };
}
