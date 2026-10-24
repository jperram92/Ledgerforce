import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

const storage = new AsyncLocalStorage<Transaction<Database>>();

/** Runs `fn` with `trx` as the current request's tenant transaction. */
export function runInTenantTx<T>(trx: Transaction<Database>, fn: () => Promise<T>): Promise<T> {
  return storage.run(trx, fn);
}

/** Handlers read the request's tenant transaction from here; it exists only inside the interceptor. */
@Injectable()
export class TenantTx {
  get(): Transaction<Database> {
    const trx = storage.getStore();
    if (!trx)
      throw new Error('TenantTx.get() called outside a tenant transaction (route marked @Public?)');
    return trx;
  }
}
