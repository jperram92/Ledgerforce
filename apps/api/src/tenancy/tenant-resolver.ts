import type { Database } from '@ledgerforce/db';
import type { Request } from 'express';
import type { Transaction } from 'kysely';

/**
 * A resolver's answer. `verify`, if present, runs as the first step inside the request's tenant
 * transaction (under that tenant's RLS), before the handler. Session resolvers use it to prove
 * the claimed tenant is genuine (ADR-0016); throwing refuses the request.
 */
export interface TenantClaim {
  tenantId: string;
  verify?: (trx: Transaction<Database>, req: Request) => Promise<void>;
}

/**
 * Where a request's tenant comes from. Production uses the session resolver (T-0105, ADR-0016).
 * A tenant id is never taken from a header, query string or body (apps/api/AGENTS.md).
 */
export interface TenantResolver {
  resolve(req: Request): Promise<string | TenantClaim | null>;
}

export const TENANT_RESOLVER = Symbol('TENANT_RESOLVER');

/** Default when sessions are not configured: no request has a tenant, so every tenant route is 401. */
export const refuseAllResolver: TenantResolver = {
  resolve: () => Promise.resolve(null),
};
