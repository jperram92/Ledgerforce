import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

/** What a handler says about the entity it changed; written to the audit row (design §6.8). */
export interface AuditDescription {
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

interface RequestScope {
  trx: Transaction<Database>;
  audit?: AuditDescription;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Runs `fn` with `trx` as the current request's tenant transaction. */
export function runInTenantTx<T>(
  trx: Transaction<Database>,
  fn: (scope: RequestScope) => Promise<T>,
): Promise<T> {
  const scope: RequestScope = { trx };
  return storage.run(scope, () => fn(scope));
}

function scope(): RequestScope {
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
