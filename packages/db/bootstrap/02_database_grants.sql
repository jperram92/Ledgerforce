-- LedgerForce per-database bootstrap — run as a superuser / DBA while connected to the target
-- database, after 01_cluster_roles.sql. Idempotent.

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO lf_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lf_app', current_database());
END
$$;

-- public holds only public.schema_migrations (owned by lf_migrator). Nobody else creates there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO lf_migrator;
