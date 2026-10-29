import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { isPermission, isTokenScope, type Permission } from '@ledgerforce/shared/rbac';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import {
  DEFAULT_TOKEN_DAYS,
  MAX_TOKEN_DAYS,
  newTokenSecret,
  tokenString,
} from '../auth/api-token.service.ts';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { Authz } from '../authz/authz.ts';
import {
  AnyMember,
  PermissionDenied,
  RequirePermission,
  RequireStepUp,
} from '../authz/permission.decorator.ts';
import { AuditTrail, scope, TenantTx } from '../tenancy/tenant-tx.ts';

const MAX_SCOPES = 64;

export interface TokenView {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

const VIEW = [
  'id',
  'user_id',
  'name',
  'scopes',
  'created_at',
  'expires_at',
  'last_used_at',
  'revoked_at',
  'revoke_reason',
] as const;

function scopesOf(raw: unknown): Permission[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SCOPES) {
    throw new BadRequestException({ error: 'invalid_scope' });
  }
  const out: Permission[] = [];
  for (const s of raw as unknown[]) {
    if (typeof s !== 'string' || !isPermission(s) || out.includes(s)) {
      throw new BadRequestException({ error: 'invalid_scope' });
    }
    out.push(s);
  }
  for (const s of out) {
    if (!isTokenScope(s)) throw new BadRequestException({ error: 'scope_not_allowed', scope: s });
  }
  return out;
}

function nameOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim().length > 100) {
    throw new BadRequestException({ error: 'invalid_name' });
  }
  return raw.trim();
}

function daysOf(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TOKEN_DAYS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TOKEN_DAYS) {
    throw new BadRequestException({ error: 'invalid_expiry' });
  }
  return raw;
}

export function revokeReasonOf(body: unknown, fallback: string): string {
  const r = (body as { reason?: unknown } | undefined)?.reason;
  if (r === undefined) return fallback;
  if (typeof r !== 'string' || r.trim() === '' || r.trim().length > 200) {
    throw new BadRequestException({ error: 'invalid_reason' });
  }
  return r.trim();
}

/**
 * Personal API tokens (design §6.2, ADR-0027). Any member may hold tokens, but issuing one needs
 * a session with a fresh MFA step-up (a token never satisfies a step-up, so tokens cannot mint
 * tokens). The secret is in the 201 response only (`Cache-Control: no-store`); the database keeps
 * its SHA-256. Scopes must be token-allowed permissions the user holds now; at each request the
 * token's permissions are its scopes ∩ the owner's current role permissions (TenantInterceptor).
 */
@Controller('api-tokens')
export class ApiTokensController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  @Post()
  @AnyMember()
  @RequireStepUp()
  async issue(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string; name: string; scopes: string[]; expires_at: Date; token: string }> {
    const session = principalOf(req);
    if (!session) throw new UnauthorizedException({ error: 'unauthenticated' });
    const b = (body ?? {}) as Record<string, unknown>;
    const name = nameOf(b.name);
    const scopes = scopesOf(b.scopes);
    const days = daysOf(b.expires_in_days);
    const held = scope().access.permissions;
    for (const s of scopes) if (!held.has(s)) throw new PermissionDenied(s);
    const { secret, secretSha256 } = newTokenSecret();
    const row = await this.tx
      .get()
      .insertInto('app.api_token')
      .values({
        user_id: session.userId,
        name,
        scopes,
        secret_sha256: secretSha256,
        // created_at is the database clock (trigger); the expiry counts from it.
        expires_at: sql<Date>`clock_timestamp() + make_interval(days => ${days})`,
      })
      .returning(['id', 'name', 'scopes', 'expires_at'])
      .executeTakeFirstOrThrow();
    this.audit.describe({
      entityType: 'api_token',
      entityId: row.id,
      after: { user_id: session.userId, name, scopes, expires_at: row.expires_at },
    });
    res.setHeader('Cache-Control', 'no-store');
    return { ...row, token: tokenString(session.tenantId, row.id, secret) };
  }

  @Get()
  @AnyMember()
  list(): Promise<TokenView[]> {
    return this.tx
      .get()
      .selectFrom('app.api_token')
      .select(VIEW)
      .where('user_id', '=', this.authz.userId())
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Revokes one of the caller's own tokens. Idempotent: an already revoked token stays as it is. */
  @Post(':tokenId/revoke')
  @AnyMember()
  @HttpCode(200)
  async revoke(
    @Param('tokenId', new ParseUUIDPipe()) tokenId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; revoked: boolean }> {
    const me = this.authz.userId();
    return revokeToken(this.tx, this.audit, me, me, tokenId, revokeReasonOf(body, 'revoked'));
  }
}

/** Revoke `tokenId` of `ownerId` (found under RLS), by `actorId`; audited when it changed. */
export async function revokeToken(
  tx: TenantTx,
  audit: AuditTrail,
  actorId: string,
  ownerId: string,
  tokenId: string,
  reason: string,
): Promise<{ id: string; revoked: boolean }> {
  const trx = tx.get();
  const found = await trx
    .selectFrom('app.api_token')
    .select('id')
    .where('id', '=', tokenId)
    .where('user_id', '=', ownerId)
    .executeTakeFirst();
  if (!found) throw new NotFoundException({ error: 'not_found' });
  const r = await trx
    .updateTable('app.api_token')
    .set({ revoked_at: sql<Date>`clock_timestamp()`, revoked_by: actorId, revoke_reason: reason })
    .where('id', '=', tokenId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  const revoked = r.numUpdatedRows === 1n;
  if (revoked) {
    audit.describe({
      entityType: 'api_token',
      entityId: tokenId,
      before: { revoked: false },
      after: { revoked: true, reason, user_id: ownerId },
    });
  }
  return { id: tokenId, revoked };
}

/** Administrators: list and revoke any user's tokens (incident response, leaver clean-up). */
@Controller('users/:userId/api-tokens')
export class UserApiTokensController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  private async assertUser(userId: string): Promise<void> {
    const u = await this.tx
      .get()
      .selectFrom('app.app_user')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!u) throw new NotFoundException({ error: 'not_found' });
  }

  @Get()
  @RequirePermission('users.read')
  async list(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<TokenView[]> {
    await this.assertUser(userId);
    return this.tx
      .get()
      .selectFrom('app.api_token')
      .select(VIEW)
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  @Post(':tokenId/revoke')
  @RequirePermission('users.manage')
  @HttpCode(200)
  async revoke(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('tokenId', new ParseUUIDPipe()) tokenId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; revoked: boolean }> {
    await this.assertUser(userId);
    const reason = revokeReasonOf(body, 'revoked by administrator');
    return revokeToken(this.tx, this.audit, this.authz.userId(), userId, tokenId, reason);
  }
}
