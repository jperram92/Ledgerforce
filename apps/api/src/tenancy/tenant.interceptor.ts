import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { withTenant, type Database } from '@ledgerforce/db';
import type { Permission } from '@ledgerforce/shared/rbac';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { catchError, from, lastValueFrom, mergeMap, type Observable } from 'rxjs';
import { DB } from '../tokens.ts';
import { TENANT_RESOLVER, type TenantResolver } from './tenant-resolver.ts';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { requestIdOf } from '../audit/request-id.ts';
import { loadPermissions } from '../authz/authz.ts';
import { PermissionDenied, routeAccess } from '../authz/permission.decorator.ts';
import { runInTenantTx } from './tenant-tx.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NO_PERMISSIONS: ReadonlySet<Permission> = new Set();

const routeOf = (req: Request): string =>
  (req.route as { path?: string } | undefined)?.path ?? req.path;
const ipOf = (req: Request): string | null => (req.ip ? req.ip.replace(/^::ffff:/, '') : null);

/**
 * Wraps every non-public handler in one tenant transaction (design §6.7, SS-PLAT-28):
 * resolve tenant → 401 if none (before any SQL) → withTenant (SET LOCAL, fail-closed leak guard,
 * RQ-0013) → verify the session → permission check (ADR-0023: the route's declared permission
 * against the user's active role grants; undeclared routes refused) → handler runs with the
 * transaction in async-local storage → for a successful mutation, one audit row in the same
 * transaction (design §6.8, SS-PLAT-30) → commit or roll back.
 * Refused or failed requests write no audit row in the request transaction (it never commits);
 * a permission refusal is audited in its own transaction (SS-UC02-07).
 *
 * The permission check lives here, not in a Nest guard, because guards run before interceptors
 * and the verified principal exists only inside the tenant transaction (DL-0102).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(TENANT_RESOLVER) private readonly resolver: TenantResolver,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const access = routeAccess(ctx.getHandler(), ctx.getClass());
    if (access.kind === 'public') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    return from(this.resolver.resolve(req)).pipe(
      mergeMap((answer) => {
        const claim = typeof answer === 'string' ? { tenantId: answer } : answer;
        if (!claim) throw new UnauthorizedException({ error: 'unauthenticated' });
        return from(
          withTenant(this.db, claim.tenantId, async (trx) => {
            if (claim.verify) await claim.verify(trx, req);
            if (access.kind === 'undeclared') throw new PermissionDenied(null);
            const userId = principalOf(req)?.userId ?? null;
            const permissions = userId ? await loadPermissions(trx, userId) : NO_PERMISSIONS;
            if (access.kind === 'permission' && !permissions.has(access.permission)) {
              throw new PermissionDenied(access.permission);
            }
            return runInTenantTx(trx, { userId, permissions }, async (scope) => {
              const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
              if (!READ_METHODS.has(req.method)) {
                const actor = principalOf(req);
                await trx
                  .insertInto('audit.audit_log')
                  .values({
                    actor_type: actor ? 'user' : 'system',
                    actor_user_id: actor?.userId ?? null,
                    action: `${req.method} ${routeOf(req)}`,
                    entity_type: scope.audit?.entityType ?? 'request',
                    entity_id: scope.audit?.entityId ?? null,
                    before:
                      scope.audit?.before === undefined ? null : JSON.stringify(scope.audit.before),
                    after:
                      scope.audit?.after === undefined ? null : JSON.stringify(scope.audit.after),
                    ip: ipOf(req),
                    user_agent: req.headers['user-agent'] ?? null,
                    request_id: requestIdOf(req) ?? null,
                  })
                  .execute();
              }
              return result;
            });
          }),
        ).pipe(
          catchError((e: unknown) => {
            if (!(e instanceof PermissionDenied)) throw e;
            return from(this.auditDenial(claim.tenantId, req, e.permission)).pipe(
              mergeMap(() => {
                throw e;
              }),
            );
          }),
        );
      }),
    );
  }

  /** The request transaction rolled back; the refusal is recorded in its own transaction. */
  private async auditDenial(
    tenantId: string,
    req: Request,
    permission: Permission | null,
  ): Promise<void> {
    const actor = principalOf(req);
    await withTenant(this.db, tenantId, (trx) =>
      trx
        .insertInto('audit.audit_log')
        .values({
          actor_type: actor ? 'user' : 'system',
          actor_user_id: actor?.userId ?? null,
          action: 'permission_denied',
          entity_type: 'permission',
          entity_id: permission,
          after: JSON.stringify({ method: req.method, route: routeOf(req), permission }),
          ip: ipOf(req),
          user_agent: req.headers['user-agent'] ?? null,
          request_id: requestIdOf(req) ?? null,
        })
        .execute(),
    );
  }
}
