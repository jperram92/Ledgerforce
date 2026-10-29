import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { permissionsOf, type Permission } from '@ledgerforce/shared/rbac';
import type { Transaction } from 'kysely';
import { scope } from '../tenancy/tenant-tx.ts';
import { PermissionDenied } from './permission.decorator.ts';

/**
 * 403 `{error:'self_grant'}` (ADR-0027 mover rule): nobody grants a role to themselves. Audited
 * by TenantInterceptor in its own transaction, like the other access refusals.
 */
export class SelfGrantRefused extends ForbiddenException {
  constructor(readonly userId: string) {
    super({ error: 'self_grant' });
  }
}

/** Permissions a request may use: the role permissions, cut down to a token's scopes (ADR-0027). */
export function effectivePermissions(
  rolePermissions: ReadonlySet<Permission>,
  tokenScopes: readonly Permission[] | null,
): ReadonlySet<Permission> {
  if (tokenScopes === null) return rolePermissions;
  return new Set(tokenScopes.filter((p) => rolePermissions.has(p)));
}

/** The user's active role grants (ADR-0023), read under RLS. */
export async function loadRoles(trx: Transaction<Database>, userId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('app.user_role')
    .select('role')
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  return rows.map((r) => r.role);
}

/** The user's permissions: the union over their active role grants (ADR-0023), read under RLS. */
export async function loadPermissions(
  trx: Transaction<Database>,
  userId: string,
): Promise<ReadonlySet<Permission>> {
  return permissionsOf(await loadRoles(trx, userId));
}

/**
 * For checks that depend on the request's input (e.g. which role is being granted). The route's
 * own permission is already checked by TenantInterceptor. A refusal here takes the same path:
 * 403, the transaction rolls back, the denial is audited.
 * Hook point: segregation-of-duties checks (T-0015) belong beside `require`, not in controllers.
 */
@Injectable()
export class Authz {
  require(permission: Permission): void {
    if (!scope().access.permissions.has(permission)) throw new PermissionDenied(permission);
  }

  /** The acting user; permission routes always have one (TenantInterceptor refuses otherwise). */
  userId(): string {
    const id = scope().access.userId;
    if (!id) throw new PermissionDenied(null);
    return id;
  }
}
