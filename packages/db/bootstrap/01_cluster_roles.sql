-- LedgerForce cluster bootstrap — run ONCE per PostgreSQL cluster, as a superuser / DBA.
-- This is the only step that needs elevated rights; every migration afterwards runs as
-- lf_migrator. Idempotent: safe to re-run. Passwords are set separately by the caller
-- (compose init script, test harness) so no secret is ever stored in this file.
--
--   lf_migrator  owns every schema object; runs migrations. Not superuser, no BYPASSRLS.
--   lf_app       the application runtime role. Not superuser, no BYPASSRLS, owns nothing,
--                cannot create objects, cannot disable triggers (design §3.3, §6.7).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_migrator') THEN
    CREATE ROLE lf_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_app') THEN
    CREATE ROLE lf_app LOGIN;
  END IF;
END
$$;

-- Enforce the attributes even if the roles pre-existed with something more permissive.
ALTER ROLE lf_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;
ALTER ROLE lf_app      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN NOINHERIT;
