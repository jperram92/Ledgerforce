import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant, type Database } from '@ledgerforce/db';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { from, lastValueFrom, mergeMap, type Observable } from 'rxjs';
import { DB } from '../tokens.ts';
import { IS_PUBLIC } from './public.decorator.ts';
import { TENANT_RESOLVER, type TenantResolver } from './tenant-resolver.ts';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { requestIdOf } from '../audit/request-id.ts';
import { runInTenantTx } from './tenant-tx.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wraps every non-public handler in one tenant transaction (design §6.7, SS-PLAT-28):
 * resolve tenant → 401 if none (before any SQL) → withTenant (SET LOCAL, fail-closed leak guard,
 * RQ-0013) → handler runs with the transaction in async-local storage → for a successful
 * mutation, one audit row in the same transaction (design §6.8, SS-PLAT-30) → commit or roll back.
 * Refused or failed requests write no audit row here (the transaction never commits).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(TENANT_RESOLVER) private readonly resolver: TenantResolver,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    return from(this.resolver.resolve(req)).pipe(
      mergeMap((answer) => {
        const claim = typeof answer === 'string' ? { tenantId: answer } : answer;
        if (!claim) throw new UnauthorizedException({ error: 'unauthenticated' });
        return from(
          withTenant(this.db, claim.tenantId, async (trx) => {
            if (claim.verify) await claim.verify(trx, req);
            return runInTenantTx(trx, async (scope) => {
              const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
              if (!READ_METHODS.has(req.method)) {
                const actor = principalOf(req);
                const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
                await trx
                  .insertInto('audit.audit_log')
                  .values({
                    actor_type: actor ? 'user' : 'system',
                    actor_user_id: actor?.userId ?? null,
                    action: `${req.method} ${route}`,
                    entity_type: scope.audit?.entityType ?? 'request',
                    entity_id: scope.audit?.entityId ?? null,
                    before:
                      scope.audit?.before === undefined ? null : JSON.stringify(scope.audit.before),
                    after:
                      scope.audit?.after === undefined ? null : JSON.stringify(scope.audit.after),
                    ip: req.ip ? req.ip.replace(/^::ffff:/, '') : null,
                    user_agent: req.headers['user-agent'] ?? null,
                    request_id: requestIdOf(req) ?? null,
                  })
                  .execute();
              }
              return result;
            });
          }),
        );
      }),
    );
  }
}
