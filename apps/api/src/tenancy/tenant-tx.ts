import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import type { Permission } from '@ledgerforce/shared/rbac';
import type { Transaction } from 'kysely';

/** What a handler says about the entity it changed; written to the audit row (design §6.8). */
export interface AuditDescription {
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

/** Who is acting and what they may do, loaded once per request by TenantInterceptor (ADR-0023). */
export interface RequestAccess {
  userId: string | null;
  permissions: ReadonlySet<Permission>;
}

interface RequestScope {
  trx: Transaction<Database>;
  access: RequestAccess;
  audit?: AuditDescription;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Runs `fn` with `trx` as the current request's tenant transaction. */
export function runInTenantTx<T>(
  trx: Transaction<Database>,
  access: RequestAccess,
  fn: (scope: RequestScope) => Promise<T>,
): Promise<T> {
  const scope: RequestScope = { trx, access };
  return storage.run(scope, () => fn(scope));
}

export function scope(): RequestScope {
  const s = storage.getStore();
  if (!s) throw new Error('called outside a tenant transaction (route marked @Public?)');
  return s;
}

/** Handlers read the request's tenant transaction from here; it exists only inside the interceptor. */
@Injectable()
export class TenantTx {
  get(): Transaction<Database> {
    return scope().trx;
  }
}

/** Handlers describe what they changed; the interceptor writes one audit row per successful mutation. */
@Injectable()
export class AuditTrail {
  describe(d: AuditDescription): void {
    scope().audit = d;
  }
}
