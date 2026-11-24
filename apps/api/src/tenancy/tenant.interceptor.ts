import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { withTenant, type Database } from '@ledgerforce/db';
import { permissionsOf, rolesRequireMfa, type Permission } from '@ledgerforce/shared/rbac';
import { subjectTypeOf } from '@ledgerforce/shared/sod';
import type { Request } from 'express';
import type { Kysely, Transaction } from 'kysely';
import { catchError, from, lastValueFrom, mergeMap, type Observable } from 'rxjs';
import { CLOCK, DB, MFA_POLICY } from '../tokens.ts';
import { TENANT_RESOLVER, type TenantClaim, type TenantResolver } from './tenant-resolver.ts';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { requestIdOf } from '../audit/request-id.ts';
import { effectivePermissions, loadRoles, SelfGrantRefused } from '../authz/authz.ts';
import {
  isMfa,
  MfaRequired,
  stepUpSatisfied,
  StepUpRequired,
  type MfaPolicy,
} from '../authz/mfa.ts';
import {
  PermissionDenied,
  routeAccess,
  stepUpOf,
  stepUpWhenOf,
} from '../authz/permission.decorator.ts';
import type { Clock } from '../auth/session.service.ts';
import { ownTransactionsOf } from './own-transactions.decorator.ts';
import { runInTenantTx, runOutsideTenantTx } from './tenant-tx.ts';
import { sodOf } from '../sod/sod.decorator.ts';
import { checkSod, recordSod, SodViolation, type SodCheck } from '../sod/sod.service.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a route declares for the access checks (TenantInterceptor.authorize). */
interface RouteChecks {
  readonly access: ReturnType<typeof routeAccess>;
  readonly stepUp: number | null;
  readonly stepUpWhen: ReturnType<typeof stepUpWhenOf>;
  readonly sod: ReturnType<typeof sodOf>;
}

/** The outcome of the access checks for one request (or one @OwnTransactions step). */
interface Authorized {
  readonly userId: string | null;
  readonly permissions: ReadonlySet<Permission>;
  readonly stepUpMet: boolean;
  readonly sodCheck: SodCheck | null;
}

/** Refusals of the access checks: each rolls back the request and is audited on its own. */
type AccessRefusal =
  PermissionDenied | MfaRequired | StepUpRequired | SodViolation | SelfGrantRefused;
const isAccessRefusal = (e: unknown): e is AccessRefusal =>
  e instanceof PermissionDenied ||
  e instanceof MfaRequired ||
  e instanceof StepUpRequired ||
  e instanceof SodViolation ||
  e instanceof SelfGrantRefused;

/** Who acts: the session's user or the API token's owner (ADR-0027), and the token if any. */
function actorOf(req: Request): { userId: string | null; tokenId: string | null } {
  const token = tokenPrincipalOf(req);
  return {
    userId: principalOf(req)?.userId ?? token?.userId ?? null,
    tokenId: token?.tokenId ?? null,
  };
}

const routeOf = (req: Request): string =>
  (req.route as { path?: string } | undefined)?.path ?? req.path;
const ipOf = (req: Request): string | null => (req.ip ? req.ip.replace(/^::ffff:/, '') : null);

/**
 * Wraps every non-public handler in one tenant transaction (design §6.7, SS-PLAT-28):
 * resolve tenant → 401 if none (before any SQL) → withTenant (SET LOCAL, fail-closed leak guard,
 * RQ-0013) → verify the session → on permission routes: MFA for finance roles (ADR-0025:
 * 403 mfa_required) → permission check (ADR-0023: the route's declared permission against the
 * user's active role grants; undeclared routes refused) → step-up (ADR-0025: 401
 * step_up_required when the route needs a fresher MFA authentication) → segregation of duties
 * on routes declaring `@SoD` (ADR-0026: 403 sod_violation, or a small-team exception) → handler
 * runs with the transaction in async-local storage → the SoD step (and any exception) is
 * recorded → for a successful mutation, one audit row in the same transaction (design §6.8,
 * SS-PLAT-30) → commit or roll back.
 * Refused or failed requests write no audit row in the request transaction (it never commits);
 * a permission, MFA, step-up or SoD refusal is audited in its own transaction (SS-UC02-07,
 * SS-PLAT-20, SS-UC06-03, SS-UC05-05). Member routes (who am I, logout, step-up) need no MFA, so a finance
 * user without MFA can still step up.
 *
 * The permission check lives here, not in a Nest guard, because guards run before interceptors
 * and the verified principal exists only inside the tenant transaction (DL-0102).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(TENANT_RESOLVER) private readonly resolver: TenantResolver,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MFA_POLICY) private readonly mfa: MfaPolicy,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const access = routeAccess(ctx.getHandler(), ctx.getClass());
    if (access.kind === 'public') return next.handle();
    const stepUp = stepUpOf(ctx.getHandler(), ctx.getClass(), access);
    const stepUpWhen = stepUpWhenOf(ctx.getHandler(), ctx.getClass());
    const sod = sodOf(ctx.getHandler());
    const own = ownTransactionsOf(ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<Request>();
    return from(this.resolver.resolve(req)).pipe(
      mergeMap((answer) => {
        const claim = typeof answer === 'string' ? { tenantId: answer } : answer;
        if (!claim) throw new UnauthorizedException({ error: 'unauthenticated' });
        const authorize = (trx: Transaction<Database>) =>
          this.authorize(trx, req, claim, { access, stepUp, stepUpWhen, sod });
        const handled: Promise<unknown> = own
          ? this.runOwnTransactions(req, claim.tenantId, authorize, sod !== undefined, stepUp, next)
          : withTenant(this.db, claim.tenantId, async (trx) => {
              const { userId, permissions, stepUpMet, sodCheck } = await authorize(trx);
              return runInTenantTx(
                trx,
                { userId, permissions },
                async (scope) => {
                  const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
                  if (sodCheck) await recordSod(trx, sodCheck, requestIdOf(req) ?? null);
                  if (!READ_METHODS.has(req.method)) {
                    const actor = actorOf(req);
                    await trx
                      .insertInto('audit.audit_log')
                      .values({
                        actor_type: actor.userId ? 'user' : 'system',
                        actor_user_id: actor.userId,
                        api_token_id: actor.tokenId,
                        action: `${req.method} ${routeOf(req)}`,
                        entity_type: scope.audit?.entityType ?? 'request',
                        entity_id: scope.audit?.entityId ?? null,
                        before:
                          scope.audit?.before === undefined
                            ? null
                            : JSON.stringify(scope.audit.before),
                        after:
                          scope.audit?.after === undefined
                            ? null
                            : JSON.stringify(scope.audit.after),
                        ip: ipOf(req),
                        user_agent: req.headers['user-agent'] ?? null,
                        request_id: requestIdOf(req) ?? null,
                      })
                      .execute();
                  }
                  return result;
                },
                stepUpMet ? stepUp : null,
              );
            });
        return from(handled
        ).pipe(
          catchError((e: unknown) => {
            if (!isAccessRefusal(e)) throw e;
            return from(this.auditDenial(claim.tenantId, req, e)).pipe(
              mergeMap(() => {
                throw e;
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * The access checks, inside a tenant transaction: verify the session or token, then (permission
   * routes) MFA for finance roles, the permission, the step-up, and SoD. Throws a refusal.
   */
  private async authorize(
    trx: Transaction<Database>,
    req: Request,
    claim: TenantClaim,
    route: RouteChecks,
  ): Promise<Authorized> {
    const { access, stepUp, stepUpWhen, sod } = route;
    if (claim.verify) await claim.verify(trx, req);
    if (access.kind === 'undeclared') throw new PermissionDenied(null);
    // A session (principal) or an API token (ADR-0027), never both (resolver).
    const principal = principalOf(req);
    const token = tokenPrincipalOf(req);
    const userId = principal?.userId ?? token?.userId ?? null;
    const roles = userId ? await loadRoles(trx, userId) : [];
    const permissions = effectivePermissions(permissionsOf(roles), token?.scopes ?? null);
    if (access.kind === 'permission') {
      // A token was issued under a fresh MFA step-up, so it satisfies the MFA-role rule;
      // it never satisfies a step-up (below: no session principal → step_up_required).
      if (principal && rolesRequireMfa(roles) && !isMfa(principal, this.mfa)) {
        throw new MfaRequired();
      }
      if (!permissions.has(access.permission)) {
        throw new PermissionDenied(access.permission);
      }
    }
    // Whether this session meets the route's step-up, recorded for the handler (r8 F3).
    const stepUpMet =
      stepUp !== null &&
      principal !== undefined &&
      stepUpSatisfied(principal, stepUp, this.clock.now(), this.mfa);
    if (
      stepUp !== null &&
      !stepUpMet &&
      // A conditional step-up (ADR-0083) asks the route, under RLS, whether it applies.
      (stepUpWhen === null || (await stepUpWhen(req, trx)))
    ) {
      throw new StepUpRequired(stepUp);
    }
    let sodCheck: SodCheck | null = null;
    if (sod) {
      // SoD needs a permission route and an acting user (ADR-0026); otherwise fail closed.
      if (access.kind !== 'permission') throw new PermissionDenied(null);
      if (!userId) throw new PermissionDenied(access.permission);
      sodCheck = await checkSod(trx, {
        step: sod.step,
        actorId: userId,
        permission: access.permission,
        subject: await sod.subjectFrom(req, trx, sod.step),
        body: req.body as unknown,
      });
    }
    return { userId, permissions, stepUpMet, sodCheck };
  }

  /**
   * A route marked @OwnTransactions (ADR-0108): the access checks run and commit in their own
   * tenant transaction, then the handler runs with NO transaction open, so it can call a slow
   * provider without holding a pooled connection or a lock. Each TenantTx.run opens a fresh tenant
   * transaction that repeats every access check first (a session revoked or a role removed
   * meanwhile stops the work). Only read-method routes without SoD may opt in; the handler audits
   * its own changes (there is no request-level audit row for read methods). Anything else fails
   * closed.
   */
  private async runOwnTransactions(
    req: Request,
    tenantId: string,
    authorize: (trx: Transaction<Database>) => Promise<Authorized>,
    hasSod: boolean,
    stepUp: number | null,
    next: CallHandler,
  ): Promise<unknown> {
    if (!READ_METHODS.has(req.method) || hasSod) {
      throw new Error('@OwnTransactions is only for read-method routes without @SoD (ADR-0108)');
    }
    const first = await withTenant(this.db, tenantId, authorize);
    const run = <T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> =>
      withTenant(this.db, tenantId, async (trx) => {
        await authorize(trx);
        return fn(trx);
      });
    return runOutsideTenantTx(
      run,
      { userId: first.userId, permissions: first.permissions },
      () => lastValueFrom(next.handle(), { defaultValue: undefined }),
      first.stepUpMet ? stepUp : null,
    );
  }

  /** The request transaction rolled back; the refusal is recorded in its own transaction. */
  private async auditDenial(tenantId: string, req: Request, e: AccessRefusal): Promise<void> {
    const session = principalOf(req);
    const actor = actorOf(req);
    const where = { method: req.method, route: routeOf(req) };
    const row =
      e instanceof SelfGrantRefused
        ? {
            action: 'self_grant_refused',
            entity_type: 'app_user',
            entity_id: e.userId,
            after: where,
          }
        : e instanceof PermissionDenied
          ? {
              action: 'permission_denied',
              entity_type: 'permission',
              entity_id: e.permission,
              after: { ...where, permission: e.permission },
            }
          : e instanceof SodViolation
            ? {
                action: 'sod_violation',
                entity_type: subjectTypeOf(e.step),
                entity_id: e.subjectId,
                after: { ...where, step: e.step, rule: e.rule },
              }
            : e instanceof MfaRequired
              ? {
                  action: 'mfa_required',
                  entity_type: 'session',
                  entity_id: session?.sessionId ?? null,
                  after: where,
                }
              : {
                  action: 'step_up_required',
                  entity_type: 'session',
                  entity_id: session?.sessionId ?? null,
                  after: { ...where, max_age: e.maxAge },
                };
    await withTenant(this.db, tenantId, (trx) =>
      trx
        .insertInto('audit.audit_log')
        .values({
          actor_type: actor.userId ? 'user' : 'system',
          actor_user_id: actor.userId,
          api_token_id: actor.tokenId,
          action: row.action,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          after: JSON.stringify(row.after),
          ip: ipOf(req),
          user_agent: req.headers['user-agent'] ?? null,
          request_id: requestIdOf(req) ?? null,
        })
        .execute(),
    );
  }
}
