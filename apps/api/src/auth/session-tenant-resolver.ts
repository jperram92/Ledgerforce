import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantClaim, TenantResolver } from '../tenancy/tenant-resolver.ts';
import {
  parseBearerToken,
  TokenError,
  type ApiTokenService,
  type TokenPrincipal,
} from './api-token.service.ts';
import {
  parseSessionCookie,
  SessionError,
  type Principal,
  type SessionService,
} from './session.service.ts';

export const SESSION_COOKIE = 'lf_session';

/** The verified principal per request, set only after verify() succeeds under RLS. */
const principals = new WeakMap<Request, Principal>();

export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}

/** The verified API-token principal per request (ADR-0027); never set together with a session. */
const tokenPrincipals = new WeakMap<Request, TokenPrincipal>();

export function tokenPrincipalOf(req: Request): TokenPrincipal | undefined {
  return tokenPrincipals.get(req);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * ADR-0016: the cookie claims a tenant; the claim is only accepted after the session is found and
 * matched inside that tenant's RLS-scoped transaction (the `verify` step).
 * ADR-0027: likewise an `Authorization: Bearer lfpat.…` token. A request carrying both a session
 * cookie and an Authorization header is refused (no ambiguity about who acts); a token anywhere
 * else (query string, body) is never read.
 */
export class SessionTenantResolver implements TenantResolver {
  constructor(
    private readonly sessions: SessionService,
    private readonly tokens: ApiTokenService | null = null,
  ) {}

  resolve(req: Request): Promise<TenantClaim | null> {
    const raw = readCookie(req, SESSION_COOKIE);
    if (req.headers.authorization !== undefined) {
      if (raw !== undefined || !this.tokens) return Promise.resolve(null);
      return Promise.resolve(this.tokenClaim(req.headers.authorization, this.tokens));
    }
    const cookie = parseSessionCookie(raw);
    if (!cookie) return Promise.resolve(null);
    return Promise.resolve({
      tenantId: cookie.tenantId,
      verify: async (trx, r) => {
        try {
          principals.set(r, await this.sessions.verify(trx, cookie));
        } catch (e) {
          if (e instanceof SessionError) throw new UnauthorizedException({ error: e.reason });
          throw e;
        }
      },
    });
  }

  private tokenClaim(header: string, tokens: ApiTokenService): TenantClaim | null {
    const parsed = parseBearerToken(header);
    if (!parsed) return null;
    return {
      tenantId: parsed.tenantId,
      verify: async (trx, r) => {
        try {
          tokenPrincipals.set(r, await tokens.verify(trx, parsed));
        } catch (e) {
          if (e instanceof TokenError) throw new UnauthorizedException({ error: 'invalid_token' });
          throw e;
        }
      },
    };
  }
}
