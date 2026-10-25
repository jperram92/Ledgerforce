import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { isRoleId, permissionToAssign, type RoleId } from '@ledgerforce/shared/rbac';
import type { Response } from 'express';
import { sql } from 'kysely';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { Authz, SelfGrantRefused } from './authz.ts';
import { RequirePermission } from './permission.decorator.ts';

interface GrantView {
  id: string;
  user_id: string;
  role: string;
  granted_at: Date;
  granted_by: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

function roleOf(value: unknown): RoleId {
  if (typeof value !== 'string' || !isRoleId(value)) {
    throw new BadRequestException({ error: 'invalid_role' });
  }
  return value;
}

function reasonOf(body: unknown): string {
  const r = (body as { reason?: unknown } | undefined)?.reason;
  if (r === undefined) return 'revoked';
  if (typeof r !== 'string' || r.trim() === '' || r.length > 500) {
    throw new BadRequestException({ error: 'invalid_reason' });
  }
  return r.trim();
}

/**
 * Role administration (design §6.3 mover, §6.4; ADR-0023). Every grant and revoke bumps the
 * user's session_epoch in the database (revoke-all) and is audited by the request's audit row.
 * Grants are never deleted: a revoke keeps the row as history. Both actions are naturally
 * idempotent: granting an active role returns it (200); revoking an inactive one changes nothing.
 * RLS confines everything to the caller's tenant: another tenant's user is simply not found.
 */
@Controller('users/:userId/roles')
export class UserRolesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  private async assertUser(userId: string): Promise<{ status: string }> {
    const u = await this.tx
      .get()
      .selectFrom('app.app_user')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!u) throw new NotFoundException({ error: 'not_found' });
    return u;
  }

  @Get()
  @RequirePermission('users.read')
  async list(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<GrantView[]> {
    await this.assertUser(userId);
    return this.tx
      .get()
      .selectFrom('app.user_role')
      .select([
        'id',
        'user_id',
        'role',
        'granted_at',
        'granted_by',
        'revoked_at',
        'revoked_by',
        'revoke_reason',
      ])
      .where('user_id', '=', userId)
      .orderBy('granted_at')
      .orderBy('id')
      .execute();
  }

  @Post()
  @RequirePermission('users.roles.assign')
  async grant(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string; user_id: string; role: string; granted_at: Date }> {
    const role = roleOf((body as { role?: unknown } | undefined)?.role);
    this.authz.require(permissionToAssign(role));
    // Mover rule (ADR-0027): nobody grants a role to themselves (also refused by the database).
    if (userId === this.authz.userId()) throw new SelfGrantRefused(userId);
    const target = await this.assertUser(userId);
    if (target.status === 'disabled') throw new ConflictException({ error: 'user_disabled' });
    const trx = this.tx.get();
    const inserted = await trx
      .insertInto('app.user_role')
      .values({ user_id: userId, role, granted_by: this.authz.userId() })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'user_id', 'role']).where('revoked_at', 'is', null).doNothing(),
      )
      .returning(['id', 'user_id', 'role', 'granted_at'])
      .executeTakeFirst();
    if (inserted) {
      this.audit.describe({
        entityType: 'user_role',
        entityId: inserted.id,
        after: { user_id: userId, role },
      });
      return inserted;
    }
    res.status(200);
    return trx
      .selectFrom('app.user_role')
      .select(['id', 'user_id', 'role', 'granted_at'])
      .where('user_id', '=', userId)
      .where('role', '=', role)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @Post(':role/revoke')
  @HttpCode(200)
  @RequirePermission('users.roles.assign')
  async revoke(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('role') roleParam: string,
    @Body() body: unknown,
  ): Promise<{ user_id: string; role: string; revoked: boolean }> {
    const role = roleOf(roleParam);
    this.authz.require(permissionToAssign(role));
    const reason = reasonOf(body);
    await this.assertUser(userId);
    const trx = this.tx.get();
    if (role === 'owner') {
      // Lock every active Owner grant so two concurrent revokes cannot remove the last two.
      const owners = await trx
        .selectFrom('app.user_role')
        .select('user_id')
        .where('role', '=', 'owner')
        .where('revoked_at', 'is', null)
        .forUpdate()
        .execute();
      if (owners.some((o) => o.user_id === userId) && owners.length <= 1) {
        throw new ConflictException({ error: 'last_owner' });
      }
    }
    const revoked = await trx
      .updateTable('app.user_role')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: this.authz.userId(), revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('role', '=', role)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (revoked) {
      this.audit.describe({
        entityType: 'user_role',
        entityId: revoked.id,
        before: { user_id: userId, role, active: true },
        after: { user_id: userId, role, active: false, reason },
      });
    }
    return { user_id: userId, role, revoked: revoked !== undefined };
  }
}
