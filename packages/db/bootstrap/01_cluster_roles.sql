-- LedgerForce cluster bootstrap — run ONCE per PostgreSQL cluster, as a superuser / DBA.
-- This is the only step that needs elevated rights; every migration afterwards runs as
-- lf_migrator. Idempotent: safe to re-run. Passwords are set separately by the caller
-- (compose init script, test harness) so no secret is ever stored in this file.
--
--   lf_migrator  owns every schema object; runs migrations. Not superuser, no BYPASSRLS.
--   lf_app       the application runtime role. Not superuser, no BYPASSRLS, owns nothing,
--                cannot create objects, cannot disable triggers (design §3.3, §6.7).
--   lf_backup    the nightly backup (T-0227, ADR-0106). BYPASSRLS + pg_read_all_data only: reads
--                every row past FORCEd RLS for pg_dump; cannot write, create objects, disable
--                triggers or grant itself anything; owns nothing; sessions start read-only.
--                Its logins are confined to the backup network by pg_hba.conf (compose init script).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_migrator') THEN
    CREATE ROLE lf_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_app') THEN
    CREATE ROLE lf_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_backup') THEN
    CREATE ROLE lf_backup LOGIN;
  END IF;
END
$$;

-- Enforce the attributes even if the roles pre-existed with something more permissive.
ALTER ROLE lf_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;
ALTER ROLE lf_app      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN NOINHERIT;
ALTER ROLE lf_backup   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS LOGIN INHERIT CONNECTION LIMIT 4;
ALTER ROLE lf_backup   SET default_transaction_read_only = on;
GRANT pg_read_all_data TO lf_backup;

-- lf_backup holds pg_read_all_data and nothing else, and nobody holds lf_backup (a member could
-- SET ROLE lf_backup and gain BYPASSRLS). Remove any other membership in either direction,
-- whoever granted it.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT g.rolname AS granted, u.rolname AS member, gr.rolname AS grantor
      FROM pg_auth_members a
      JOIN pg_roles g ON g.oid = a.roleid
      JOIN pg_roles u ON u.oid = a.member
      JOIN pg_roles gr ON gr.oid = a.grantor
     WHERE (u.rolname = 'lf_backup' AND g.rolname <> 'pg_read_all_data')
        OR g.rolname = 'lf_backup'
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.granted, m.member, m.grantor);
  END LOOP;
END
$$;
