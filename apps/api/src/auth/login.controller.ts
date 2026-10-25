import { Controller, Get, HttpException, Inject, Param, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { requestIdOf } from '../audit/request-id.ts';
import { Public } from '../tenancy/public.decorator.ts';
import { AUTH_REQUEST_TTL_SECONDS, LoginError, type OidcService } from './oidc.service.ts';
import { SESSION_COOKIE, readCookie } from './session-tenant-resolver.ts';

export const OIDC_SERVICE = Symbol('OIDC_SERVICE');
export const OIDC_COOKIE = 'lf_oidc';
export const OIDC_COOKIE_PATH = '/auth';

const STATUS: Record<LoginError['reason'], number> = {
  not_found: 404,
  invalid_request: 400,
  login_failed: 400,
  not_invited: 403,
  step_up_mismatch: 403,
  mfa_required: 403,
  mfa_enrolment_required: 403,
};

function refuse(e: unknown): never {
  if (e instanceof LoginError) throw new HttpException({ error: e.reason }, STATUS[e.reason]);
  throw e;
}

/**
 * OIDC login (ADR-0016). Both routes are public: no tenant is known before the slug (login) or
 * before the lf_oidc cookie is matched against a pre-auth row under its tenant's RLS (callback).
 */
@Controller()
export class LoginController {
  constructor(@Inject(OIDC_SERVICE) private readonly oidc: OidcService) {}

  private cookie(extra: CookieOptions): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.oidc.secureCookies, ...extra };
  }

  @Public()
  @Get('t/:slug/auth/login')
  async login(@Param('slug') slug: string, @Res() res: Response): Promise<void> {
    const { location, cookie } = await this.oidc.begin(slug).catch(refuse);
    res.cookie(
      OIDC_COOKIE,
      cookie,
      this.cookie({ path: OIDC_COOKIE_PATH, maxAge: AUTH_REQUEST_TTL_SECONDS * 1000 }),
    );
    res.redirect(302, location);
  }

  @Public()
  @Get('auth/callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    // The token request must name the registered redirect URI, so rebuild it from the public URL.
    const q = req.originalUrl.indexOf('?');
    const callbackUrl = new URL(this.oidc.redirectUri + (q >= 0 ? req.originalUrl.slice(q) : ''));
    const result = await this.oidc
      .complete(
        readCookie(req, OIDC_COOKIE),
        callbackUrl,
        {
          ip: req.ip ? req.ip.replace(/^::ffff:/, '') : null,
          userAgent: req.headers['user-agent'] ?? null,
          requestId: requestIdOf(req) ?? null,
        },
        readCookie(req, SESSION_COOKIE),
      )
      .catch(refuse);
    res.clearCookie(OIDC_COOKIE, this.cookie({ path: OIDC_COOKIE_PATH }));
    if (result.kind === 'step_up') {
      // ADR-0025: the existing session was re-authenticated; its cookie stays as it is.
      res.redirect(303, result.returnTo);
      return;
    }
    res.cookie(SESSION_COOKIE, result.cookie, this.cookie({ path: '/' }));
    res.redirect(303, '/');
  }
}
