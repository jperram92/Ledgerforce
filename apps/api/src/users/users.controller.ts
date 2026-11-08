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
} from '@nestjs/common';
import { isRoleId, permissionToAssign, type RoleId } from '@ledgerforce/shared/rbac';
import { sql } from 'kysely';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

interface Invite {
  email: string;
  display_name: string;
  idp_issuer: string;
  idp_subject: string;
  roles: RoleId[];
}

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null;

function inviteOf(body: unknown): Invite {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = text(b.email, 254);
  const name = text(b.display_name, 200);
  const issuer = text(b.idp_issuer, 500);
  const subject = text(b.idp_subject, 255);
  const roles = b.roles === undefined ? [] : b.roles;
  if (
    !email ||
    !EMAIL.test(email) ||
    !name ||
    !issuer ||
    !subject ||
    !Array.isArray(roles) ||
    !roles.every((r): r is RoleId => typeof r === 'string' && isRoleId(r))
  ) {
    throw new BadRequestException({ error: 'invalid_user' });
  }
  return {
    email,
    display_name: name,
    idp_issuer: issuer,
    idp_subject: subject,
    roles: [...new Set(roles)].sort(),
  };
}

function offboardOf(body: unknown): { reason: string; successor: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reason = text(b.reason, 500);
  if (!reason) throw new BadRequestException({ error: 'invalid_reason' });
  const s = b.successor_user_id;
  if (s === undefined || s === null) return { reason, successor: null };
  if (typeof s !== 'string' || !UUID.test(s)) {
    throw new BadRequestException({ error: 'invalid_successor' });
  }
  return { reason, successor: s.toLowerCase() };
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string }).code === '23505';

/**
 * Joiner and leaver (design §6.3, ADR-0027). Mover is UserRolesController (ADR-0023).
 *
 * Joiner: invite = an `invited` user bound to an IdP subject, with role grants; the first OIDC
 * login activates it (MFA first for MFA roles, OidcService). Leaver: offboard = status
 * `disabled`; the database revokes every session, token and role grant in the same statement
 * (migration 0022) and keeps them. The response reports the leaver's pending items and who now
 * acts on their approvals. RLS confines everything to the caller's tenant.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  @Post()
  @RequirePermission('users.manage')
  async invite(@Body() body: unknown): Promise<{
    id: string;
    email: string;
    display_name: string;
    status: string;
    roles: RoleId[];
  }> {
    const inv = inviteOf(body);
    for (const role of inv.roles) this.authz.require(permissionToAssign(role));
    const actor = this.authz.userId();
    const trx = this.tx.get();
    await sql`SAVEPOINT lf_invite`.execute(trx);
    let user: { id: string; status: string };
    try {
      user = await trx
        .insertInto('app.app_user')
        .values({
          email: inv.email,
          display_name: inv.display_name,
          idp_issuer: inv.idp_issuer,
          idp_subject: inv.idp_subject,
          status: 'invited',
          invited_by: actor,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await sql`ROLLBACK TO SAVEPOINT lf_invite`.execute(trx);
      throw new ConflictException({ error: 'user_exists' });
    }
    for (const role of inv.roles) {
      await trx
        .insertInto('app.user_role')
        .values({ user_id: user.id, role, granted_by: actor })
        .execute();
    }
    this.audit.describe({
      entityType: 'app_user',
      entityId: user.id,
      after: { email: inv.email, status: 'invited', roles: inv.roles, idp_issuer: inv.idp_issuer },
    });
    return {
      id: user.id,
      email: inv.email,
      display_name: inv.display_name,
      status: user.status,
      roles: inv.roles,
    };
  }

  /**
   * Every user of the tenant with status and active roles, by name (T-0093 admin screens,
   * ADR-0034). RLS confines it to the caller's tenant.
   */
  @Get()
  @RequirePermission('users.read')
  async list(): Promise<Record<string, unknown>[]> {
    const trx = this.tx.get();
    const users = await trx
      .selectFrom('app.app_user')
      .select([
        'id',
        'email',
        'display_name',
        'status',
        'created_at',
        'disabled_at',
        'successor_user_id',
      ])
      .orderBy('display_name')
      .orderBy('id')
      .execute();
    const grants = await trx
      .selectFrom('app.user_role')
      .select(['user_id', 'role'])
      .where('revoked_at', 'is', null)
      .orderBy('role')
      .execute();
    const roles = new Map<string, string[]>();
    for (const g of grants) roles.set(g.user_id, [...(roles.get(g.user_id) ?? []), g.role]);
    return users.map((u) => ({ ...u, roles: roles.get(u.id) ?? [] }));
  }

  @Get(':userId')
  @RequirePermission('users.read')
  async get(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<Record<string, unknown>> {
    const trx = this.tx.get();
    const u = await trx
      .selectFrom('app.app_user')
      .select([
        'id',
        'email',
        'display_name',
        'status',
        'created_at',
        'invited_by',
        'disabled_at',
        'disabled_by',
        'disable_reason',
        'successor_user_id',
      ])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!u) throw new NotFoundException({ error: 'not_found' });
    const roles = await trx
      .selectFrom('app.user_role')
      .select('role')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('role')
      .execute();
    return { ...u, roles: roles.map((r) => r.role) };
  }

  @Post(':userId/offboard')
  @RequirePermission('users.manage')
  @HttpCode(200)
  async offboard(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const { reason, successor } = offboardOf(body);
    const actor = this.authz.userId();
    const trx = this.tx.get();
    // Lock the user row: two concurrent offboards (or an offboard and a login) serialise here.
    const user = await trx
      .selectFrom('app.app_user')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new NotFoundException({ error: 'not_found' });
    if (userId === actor) throw new ConflictException({ error: 'cannot_offboard_self' });
    if (user.status === 'disabled') {
      return { user_id: userId, status: 'disabled', changed: false };
    }
    if (successor !== null) {
      const s = await trx
        .selectFrom('app.app_user')
        .select('id')
        .where('id', '=', successor)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!s || successor === userId) {
        throw new BadRequestException({ error: 'invalid_successor' });
      }
    }
    const counts = await sql<{ sessions: number; tokens: number; roles: number }>`
      SELECT (SELECT count(*)::int FROM app.session
               WHERE user_id = ${userId} AND revoked_at IS NULL) AS sessions,
             (SELECT count(*)::int FROM app.api_token
               WHERE user_id = ${userId} AND revoked_at IS NULL) AS tokens,
             (SELECT count(*)::int FROM app.user_role
               WHERE user_id = ${userId} AND revoked_at IS NULL) AS roles`.execute(trx);
    const c = counts.rows[0] ?? { sessions: 0, tokens: 0, roles: 0 };
    // The trigger app_user_offboard revokes sessions, tokens and role grants (migration 0022).
    await trx
      .updateTable('app.app_user')
      .set({
        status: 'disabled',
        disabled_by: actor,
        disable_reason: reason,
        successor_user_id: successor,
      })
      .where('id', '=', userId)
      .execute();
    // Pending items the leaver raised (RQ-0031 F8): reported; they stay approvable by any other
    // holder of the permission and are immutable history (migration 0018).
    const pending = (
      await sql<{ id: string }>`
        SELECT id FROM app.period_reopen_request
         WHERE requested_by = ${userId} AND status = 'pending' ORDER BY id`.execute(trx)
    ).rows;
    const assignee = await sql<{ a: string | null }>`
      SELECT app.approval_assignee(${userId}::uuid) AS a`.execute(trx);
    const result = {
      user_id: userId,
      status: 'disabled',
      changed: true,
      sessions_revoked: c.sessions,
      tokens_revoked: c.tokens,
      roles_revoked: c.roles,
      successor_user_id: successor,
      approvals_assignee: assignee.rows[0]?.a ?? null,
      pending: { period_reopen_requests: pending.map((p) => p.id) },
    };
    this.audit.describe({
      entityType: 'app_user',
      entityId: userId,
      before: { status: user.status },
      after: { ...result, reason },
    });
    return result;
  }
}
