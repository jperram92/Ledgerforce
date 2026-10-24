import type { Request } from 'express';

/**
 * Where a request's tenant comes from. The only production implementation will read the
 * authenticated OIDC session (T-0011). A tenant id is never taken from a header, query string
 * or body (apps/api/AGENTS.md).
 */
export interface TenantResolver {
  resolve(req: Request): Promise<string | null>;
}

export const TENANT_RESOLVER = Symbol('TENANT_RESOLVER');

/** Default until authentication exists: no request has a tenant, so every tenant route is 401. */
export const refuseAllResolver: TenantResolver = {
  resolve: () => Promise.resolve(null),
};
