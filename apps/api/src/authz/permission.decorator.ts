import { ForbiddenException, SetMetadata } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import type { Request } from 'express';
import type { Transaction } from 'kysely';
import { STEP_UP_PERMISSIONS, type Permission } from '@ledgerforce/shared/rbac';
import { IS_PUBLIC } from '../tenancy/public.decorator.ts';
import { DEFAULT_STEP_UP_MAX_AGE_SECONDS, isValidMaxAge } from './mfa.ts';

export const REQUIRED_PERMISSION = 'lf:requiredPermission';
export const ANY_MEMBER = 'lf:anyMember';
/**
 * One metadata value `{ maxAge, when }` (security review r8 F2): a handler's declaration replaces
 * its controller's as a whole, so an unconditional handler step-up never inherits a class-level
 * condition.
 */
export const STEP_UP = 'lf:stepUp';

interface StepUpDeclaration {
  readonly maxAge: number;
  readonly when: StepUpCondition | null;
}

/**
 * A condition for a route's step-up (ADR-0083): evaluated by TenantInterceptor inside the tenant
 * transaction, after the permission check. Return true when this request needs the step-up.
 */
export type StepUpCondition = (req: Request, trx: Transaction<Database>) => Promise<boolean>;

/**
 * The route needs `permission` (design §6.4, ADR-0023). Checked centrally by TenantInterceptor
 * right after the session is verified; never checked ad hoc in a controller.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Any signed-in member of the tenant may use the route (who am I, logout, company list). */
export const AnyMember = (): MethodDecorator & ClassDecorator => SetMetadata(ANY_MEMBER, true);

/**
 * The route needs a fresh step-up re-authentication (design §6.2, ADR-0025): an MFA session
 * whose last authentication is at most `maxAgeSeconds` old. Checked by TenantInterceptor after
 * the permission. Routes whose permission is in STEP_UP_PERMISSIONS get it even without this.
 */
export const RequireStepUp = (
  maxAgeSeconds: number = DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  when?: StepUpCondition,
): MethodDecorator & ClassDecorator => {
  if (!isValidMaxAge(maxAgeSeconds)) {
    throw new Error(
      `RequireStepUp: max age must be whole seconds in 1..3600, got ${String(maxAgeSeconds)}`,
    );
  }
  const declaration: StepUpDeclaration = { maxAge: maxAgeSeconds, when: when ?? null };
  return SetMetadata(STEP_UP, declaration);
};

/** The route's step-up condition (ADR-0083), or null when the step-up is unconditional. */
export function stepUpWhenOf(handler: Target, cls: Target): StepUpCondition | null {
  return meta<StepUpDeclaration>(STEP_UP, handler, cls)?.when ?? null;
}

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'member' }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'undeclared' };

type Target = object;

function meta<T>(key: string, handler: Target, cls: Target): T | undefined {
  const own = Reflect.getMetadata(key, handler) as T | undefined;
  return own !== undefined ? own : (Reflect.getMetadata(key, cls) as T | undefined);
}

/** What a route declares; the handler's own declaration wins over its controller's. */
export function routeAccess(handler: Target, cls: Target): RouteAccess {
  if (meta<boolean>(IS_PUBLIC, handler, cls)) return { kind: 'public' };
  const own = Reflect.getMetadata(REQUIRED_PERMISSION, handler) as Permission | undefined;
  if (own) return { kind: 'permission', permission: own };
  if (Reflect.getMetadata(ANY_MEMBER, handler)) return { kind: 'member' };
  const cp = Reflect.getMetadata(REQUIRED_PERMISSION, cls) as Permission | undefined;
  if (cp) return { kind: 'permission', permission: cp };
  if (Reflect.getMetadata(ANY_MEMBER, cls)) return { kind: 'member' };
  return { kind: 'undeclared' };
}

/** The step-up max age a route needs, or null. Fail closed for step-up permissions. */
export function stepUpOf(handler: Target, cls: Target, access: RouteAccess): number | null {
  const declared = meta<StepUpDeclaration>(STEP_UP, handler, cls);
  if (declared !== undefined) return declared.maxAge;
  if (access.kind === 'permission' && STEP_UP_PERMISSIONS.includes(access.permission)) {
    return DEFAULT_STEP_UP_MAX_AGE_SECONDS;
  }
  return null;
}

/** 403 `{error:'forbidden', permission}`; `permission` is null when the route declared none. */
export class PermissionDenied extends ForbiddenException {
  constructor(readonly permission: Permission | null) {
    super({ error: 'forbidden', permission });
  }
}
