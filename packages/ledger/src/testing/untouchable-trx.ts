/**
 * A stand-in transaction that records and refuses every use. Unit tests pass it to post() /
 * preview() to prove a command is refused before any SQL is issued. Test-only.
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

export interface Untouchable {
  trx: Transaction<Database>;
  /** Property names the engine tried to use (empty = no SQL attempted). */
  touched: string[];
}

export function untouchableTrx(): Untouchable {
  const touched: string[] = [];
  const trx = new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop));
        throw new Error(`SQL attempted on the untouchable transaction (${String(prop)})`);
      },
    },
  ) as Transaction<Database>;
  return { trx, touched };
}
