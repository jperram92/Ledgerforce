import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DEFAULT_STEP_UP_MAX_AGE_SECONDS, isValidMaxAge } from '../authz/mfa.ts';
import { AnyMember } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { OIDC_COOKIE, OIDC_COOKIE_PATH, OIDC_SERVICE } from './login.controller.ts';
import { AUTH_REQUEST_TTL_SECONDS, type OidcService } from './oidc.service.ts';
import { principalOf } from './session-tenant-resolver.ts';
import { SessionService } from './session.service.ts';

/** Same-origin absolute path only: no scheme, no `//host`, no backslash (open-redirect guard). */
export const RETURN_TO = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]{0,511}$/;
const MAX_AGE = /^[0-9]{1,4}$/;

export const SESSION_SERVICE = Symbol('SESSION_SERVICE');

@Controller('auth')
export class AuthController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(OIDC_SERVICE) private readonly oidc: OidcService | null,
  ) {}

  /** Who am I: read under RLS, so it can only ever return the session's own tenant and user. */
  @Get('me')
  @AnyMember()
  async me(
    @Req() req: Request,
  ): Promise<{ tenant_id: string; user_id: string; display_name: string }> {
    const p = principalOf(req);
    if (!p) throw new UnauthorizedException({ error: 'unauthenticated' });
    const user = await this.tx
      .get()
      .selectFrom('app.app_user')
      .select(['id', 'display_name'])
      .where('id', '=', p.userId)
      .executeTakeFirstOrThrow();
    return { tenant_id: p.tenantId, user_id: user.id, display_name: user.display_name };
  }

  /**
   * Step-up re-authentication (ADR-0025): a member route, so a finance user without MFA can use
   * it. Sends the browser to the IdP with prompt=login, max_age and the MFA acr_values; the
   * shared /auth/callback then refreshes this session (no new session) and returns to `return_to`.
   */
  @Get('step-up')
  @AnyMember()
  @Redirect()
  async stepUp(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('max_age') maxAge: unknown,
    @Query('return_to') returnTo: unknown,
  ): Promise<{ url: string; statusCode: number }> {
    const p = principalOf(req);
    if (!p) throw new UnauthorizedException({ error: 'unauthenticated' });
    if (!this.oidc) throw new NotFoundException({ error: 'not_found' });
    const seconds =
      maxAge === undefined
        ? DEFAULT_STEP_UP_MAX_AGE_SECONDS
        : typeof maxAge === 'string' && MAX_AGE.test(maxAge)
          ? Number(maxAge)
          : Number.NaN;
    const to = returnTo === undefined ? '/' : returnTo;
    if (!isValidMaxAge(seconds) || typeof to !== 'string' || !RETURN_TO.test(to)) {
      throw new BadRequestException({ error: 'invalid_request' });
    }
    const { location, cookie } = await this.oidc.beginStepUp(this.tx.get(), p, {
      maxAgeSeconds: seconds,
      returnTo: to,
    });
    res.cookie(OIDC_COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.oidc.secureCookies,
      path: OIDC_COOKIE_PATH,
      maxAge: AUTH_REQUEST_TTL_SECONDS * 1000,
    });
    return { url: location, statusCode: 302 };
  }

  /** Logout ends this session only. Naturally idempotent: a second call finds it already revoked. */
  @Post('logout')
  @AnyMember()
  @HttpCode(204)
  async logout(@Req() req: Request): Promise<void> {
    const p = principalOf(req);
    if (!p) throw new UnauthorizedException({ error: 'unauthenticated' });
    await this.sessions.revokeInTx(this.tx.get(), p.sessionId, 'logout');
    this.audit.describe({
      entityType: 'session',
      entityId: p.sessionId,
      before: { revoked: false },
      after: { revoked: true, reason: 'logout' },
    });
  }
}
