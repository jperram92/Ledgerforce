import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantClaim, TenantResolver } from '../tenancy/tenant-resolver.ts';
import {
  parseSessionCookie,
  SessionError,
  type Principal,
  type SessionService,
} from './session.service.ts';

export const SESSION_COOKIE = 'lf_session';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the session resolver once the session is verified under RLS. */
    lfPrincipal?: Principal;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * ADR-0016: the cookie claims a tenant; the claim is only accepted after the session is found and
 * matched inside that tenant's RLS-scoped transaction (the `verify` step).
 */
export class SessionTenantResolver implements TenantResolver {
  constructor(private readonly sessions: SessionService) {}

  resolve(req: Request): Promise<TenantClaim | null> {
    const cookie = parseSessionCookie(readCookie(req, SESSION_COOKIE));
    if (!cookie) return Promise.resolve(null);
    return Promise.resolve({
      tenantId: cookie.tenantId,
      verify: async (trx, r) => {
        try {
          r.lfPrincipal = await this.sessions.verify(trx, cookie);
        } catch (e) {
          if (e instanceof SessionError) throw new UnauthorizedException({ error: e.reason });
          throw e;
        }
      },
    });
  }
}
