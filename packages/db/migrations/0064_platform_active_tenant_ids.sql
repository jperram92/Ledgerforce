-- 0064 — Tenant enumeration for scheduled daily jobs, owner role only (T-0147, ADR-0062 option 1,
-- accepted by the product owner 2026-11-13, DL-0466, RQ-0144). Owner: apps/worker (queue-admin).
--
-- * Policy daily_job_fanout lets lf_migrator SELECT the rows of active tenants (permissive; it adds
--   to slug_lookup from 0014). lf_app's view of app.tenant is unchanged (tenant_self only).
-- * app.active_tenant_ids() returns only the ids of active tenants, one column, for the
--   maintenance instance that fans out one job per tenant. EXECUTE is revoked from PUBLIC and
--   never granted to lf_app, so the application role cannot enumerate tenants.
-- * Per-tenant work still runs as lf_app inside withTenant (RLS applies).

CREATE POLICY daily_job_fanout ON app.tenant
  FOR SELECT TO lf_migrator
  USING (status = 'active');

CREATE FUNCTION app.active_tenant_ids() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id FROM app.tenant t WHERE t.status = 'active' ORDER BY t.id
$$;
COMMENT ON FUNCTION app.active_tenant_ids() IS
  'Daily job fan-out only (ADR-0062): ids of active tenants. Executable by the owner (lf_migrator) only; never lf_app.';
REVOKE ALL ON FUNCTION app.active_tenant_ids() FROM PUBLIC;
