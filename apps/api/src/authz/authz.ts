import { Injectable } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { permissionsOf, type Permission } from '@ledgerforce/shared/rbac';
import type { Transaction } from 'kysely';
import { scope } from '../tenancy/tenant-tx.ts';
import { PermissionDenied } from './permission.decorator.ts';

/** The user's permissions: the union over their active role grants (ADR-0023), read under RLS. */
export async function loadPermissions(
  trx: Transaction<Database>,
  userId: string,
): Promise<ReadonlySet<Permission>> {
  const rows = await trx
    .selectFrom('app.user_role')
    .select('role')
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  return permissionsOf(rows.map((r) => r.role));
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
