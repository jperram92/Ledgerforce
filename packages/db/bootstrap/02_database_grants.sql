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

-- Creating a large object needs no privilege in PostgreSQL, only EXECUTE on these functions,
-- which PUBLIC has by default; a session that switches read-only off could otherwise store data
-- (T-0244, ADR-0109, RQ-0191 Finding 2). LedgerForce stores no large objects. lo_import /
-- lo_export are superuser-only already; the other lo_* writes need an existing object the caller
-- owns. The ACL lives in this database's pg_proc, so it is set per database, here.
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
