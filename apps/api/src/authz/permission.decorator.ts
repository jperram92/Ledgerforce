import { ForbiddenException, SetMetadata } from '@nestjs/common';
import type { Permission } from '@ledgerforce/shared/rbac';
import { IS_PUBLIC } from '../tenancy/public.decorator.ts';

export const REQUIRED_PERMISSION = 'lf:requiredPermission';
export const ANY_MEMBER = 'lf:anyMember';

/**
 * The route needs `permission` (design §6.4, ADR-0023). Checked centrally by TenantInterceptor
 * right after the session is verified; never checked ad hoc in a controller.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Any signed-in member of the tenant may use the route (who am I, logout, company list). */
export const AnyMember = (): MethodDecorator & ClassDecorator => SetMetadata(ANY_MEMBER, true);

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

/** 403 `{error:'forbidden', permission}`; `permission` is null when the route declared none. */
export class PermissionDenied extends ForbiddenException {
  constructor(readonly permission: Permission | null) {
    super({ error: 'forbidden', permission });
  }
}
