import { SetMetadata } from '@nestjs/common';

export const OWN_TRANSACTIONS = 'lf:ownTransactions';

/**
 * The handler runs with no request transaction open and opens its own short tenant transactions
 * with `TenantTx.run` (ADR-0108, T-0243): for a read-method route that must call a slow external
 * service (an OAuth code exchange) between two writes. TenantInterceptor still runs every access
 * check first, and repeats them at the start of each `TenantTx.run`. Not allowed with a
 * mutating method or `@SoD` (the interceptor refuses with a 500). Handler-level only.
 */
export const OwnTransactions = (): MethodDecorator => SetMetadata(OWN_TRANSACTIONS, true);

export function ownTransactionsOf(handler: object): boolean {
  return Reflect.getMetadata(OWN_TRANSACTIONS, handler) === true;
}
