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
import { runInTenantTx } from './tenant-tx.ts';

/**
 * Wraps every non-public handler in one tenant transaction (design §6.7, SS-PLAT-28):
 * resolve tenant → 401 if none (before any SQL) → withTenant (SET LOCAL, fail-closed leak guard,
 * RQ-0013) → handler runs with the transaction in async-local storage → commit or roll back.
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
            return runInTenantTx(trx, () =>
              lastValueFrom(next.handle(), { defaultValue: undefined }),
            );
          }),
        );
      }),
    );
  }
}
