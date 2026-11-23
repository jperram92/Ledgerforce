-- LedgerForce per-database bootstrap — run as a superuser / DBA while connected to the target
-- database, after 01_cluster_roles.sql. Idempotent.

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO lf_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lf_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lf_backup', current_database());
  -- No temp objects for roles without an explicit grant (lf_app, lf_backup); compose revoked this
  -- already (20-keycloak-db.sh), now every install does (T-0227, ADR-0106).
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

-- public holds only public.schema_migrations (owned by lf_migrator). Nobody else creates there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO lf_migrator;
