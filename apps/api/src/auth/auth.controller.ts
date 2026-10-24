import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantTx } from '../tenancy/tenant-tx.ts';
import { SessionService } from './session.service.ts';

export const SESSION_SERVICE = Symbol('SESSION_SERVICE');

@Controller('auth')
export class AuthController {
  constructor(
    private readonly tx: TenantTx,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
  ) {}

  /** Who am I: read under RLS, so it can only ever return the session's own tenant and user. */
  @Get('me')
  async me(
    @Req() req: Request,
  ): Promise<{ tenant_id: string; user_id: string; display_name: string }> {
    const p = req.lfPrincipal;
    if (!p) throw new UnauthorizedException({ error: 'unauthenticated' });
    const user = await this.tx
      .get()
      .selectFrom('app.app_user')
      .select(['id', 'display_name'])
      .where('id', '=', p.userId)
      .executeTakeFirstOrThrow();
    return { tenant_id: p.tenantId, user_id: user.id, display_name: user.display_name };
  }

  /** Logout ends this session only. Naturally idempotent: a second call finds it already revoked. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request): Promise<void> {
    const p = req.lfPrincipal;
    if (!p) throw new UnauthorizedException({ error: 'unauthenticated' });
    await this.sessions.revokeInTx(this.tx.get(), p.sessionId, 'logout');
  }
}
