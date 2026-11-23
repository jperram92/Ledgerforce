---
id: RQ-0188
title: A least-privilege login role for pg_dump on a database whose tenant tables FORCE row-level security
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0227, T-0143]
linked_adrs: [ADR-0106, ADR-0101, ADR-0003, ADR-0004]
superseded_by:
---

# RQ-0188 — Least-privilege backup role (replace the superuser in the compose `backup` service)

## Question

T-0143 (ADR-0101, RQ-0183 Finding 3) ships a nightly `pg_dump` that connects as the cluster
superuser, because every tenant table has RLS `ENABLE` + `FORCE` and `lf_app` / `lf_migrator` are
both `NOBYPASSRLS`. T-0227 must replace the superuser with a role that:

- **Q1** can dump every row of every table (all tenants) and compute the backup manifest;
- **Q2** cannot write anything (no INSERT/UPDATE/DELETE/TRUNCATE, no DDL, no temp objects), cannot
  disable triggers or the hash-chain guards, cannot grant itself more, and owns nothing;
- **Q3** can log in only from the backup service;
- **Q4** reaches existing installs, not only new data directories, idempotently.

Which PostgreSQL mechanisms achieve this on 16 and 17 (DL-0007), what is the residual risk, and
how do comparable systems do it?

## Sources

1. PostgreSQL 17 docs, *Predefined Roles* — `pg_read_all_data`:
   <https://www.postgresql.org/docs/17/predefined-roles.html> ("Read all data (tables, views,
   sequences), as if having SELECT rights on those objects, and USAGE rights on all schemas …
   This role does not have the role attribute BYPASSRLS set. If RLS is being used, an
   administrator may wish to set BYPASSRLS on roles which this role is GRANTed to.") Same text
   in the 16 docs; the role exists since PostgreSQL 14.
2. PostgreSQL 17 docs, *Row Security Policies* (§5.9):
   <https://www.postgresql.org/docs/17/ddl-rowsecurity.html> ("Superusers and roles with the
   BYPASSRLS attribute always bypass the row security system when accessing a table. Table
   owners normally bypass row security as well, though a table owner can choose to be subject to
   row security with ALTER TABLE … FORCE ROW LEVEL SECURITY.")
3. PostgreSQL 17 docs, *pg_dump* — `--enable-row-security`:
   <https://www.postgresql.org/docs/17/app-pgdump.html> ("By default, pg_dump will set
   row_security to off, to ensure that all data is dumped from the table. If the user does not
   have sufficient privileges to bypass row security, then an error is thrown.") and the note
   that pg_dump "internally executes SELECT statements".
4. PostgreSQL 17 docs, *CREATE ROLE* (`BYPASSRLS`, `INHERIT`, `CONNECTION LIMIT`) and *ALTER
   ROLE … SET*: <https://www.postgresql.org/docs/17/sql-createrole.html>,
   <https://www.postgresql.org/docs/17/sql-alterrole.html>. Role attributes are not inherited
   through membership; `SET ROLE` to a role does assume its attributes.
5. PostgreSQL 17 docs, *The pg_hba.conf File*:
   <https://www.postgresql.org/docs/17/auth-pg-hba-conf.html> (first matching record wins;
   `reject` method; `host` matches TCP/IP with or without SSL; the `pg_hba_file_rules` view
   reports parse errors before a reload is relied on).
6. PostgreSQL 17 docs, `session_replication_role` (*Client Connection Defaults*):
   <https://www.postgresql.org/docs/17/runtime-config-client.html> — superuser-only unless a
   `GRANT SET ON PARAMETER` is given (PostgreSQL 15+); it is how replica-mode disables triggers.
7. PostgreSQL 17 docs, *GRANT* — `TEMPORARY` privilege on databases (granted to PUBLIC by
   default) and *Large objects* access control (`lo_compat_privileges`):
   <https://www.postgresql.org/docs/17/sql-grant.html>,
   <https://www.postgresql.org/docs/17/lo-implementation.html>.
8. PostgreSQL 15 release notes — `PUBLIC` no longer has `CREATE` on schema `public`:
   <https://www.postgresql.org/docs/15/release-15.html>. LedgerForce revokes it explicitly in
   `packages/db/bootstrap/02_database_grants.sql` for 16 as well.
9. pgBackRest user guide (dedicated `pgbackrest` OS user; database access through a role, since
   PostgreSQL 15 a non-superuser with `pg_checkpoint`/backup-function grants is supported):
   <https://pgbackrest.org/user-guide.html>; Barman docs (dedicated `barman` / `streaming_barman`
   roles, non-superuser with explicit EXECUTE grants on the backup functions and
   `pg_read_all_settings`, `pg_read_all_stats`): <https://docs.pgbarman.org/>.
10. Supabase docs, *Postgres Roles* (the `postgres` role used for dumps has `BYPASSRLS`; app roles
    `anon`/`authenticated` do not): <https://supabase.com/docs/guides/database/postgres/roles>.
11. Crunchy Data, "Using the pg_read_all_data role" (PostgreSQL 14 feature introduced for backup
    and reporting users without superuser): <https://www.crunchydata.com/blog/>.
12. Docker docs, *Compose networks* (`internal: true`, `ipam.config.subnet`) and container DNS:
    <https://docs.docker.com/reference/compose-file/networks/>.
13. In-repo: RQ-0183 Finding 3, ADR-0101, ADR-0003 (RLS), ADR-0004 (immutable ledger, triggers),
    `infra/compose/initdb/20-keycloak-db.sh` (revokes `CONNECT, TEMPORARY` from PUBLIC on the
    LedgerForce database), `apps/worker/src/setup/setup.ts` (refuses BYPASSRLS for app roles).

## Findings

1. **Reading past FORCE RLS needs BYPASSRLS or superuser (Q1).** FORCE only removes the *owner's*
   exemption (source 2); `pg_read_all_data` explicitly does *not* bypass RLS (source 1), and
   pg_dump errors instead of dumping a partial table when RLS would apply (source 3). So a dump of
   all tenants requires `BYPASSRLS` on the connecting role (or superuser). A policy that lets a
   backup role see every row (`USING (current_user = 'lf_backup')` on ~100 tables) would let
   pg_dump run with `--enable-row-security`, but it changes every tenant policy, is easy to forget
   on a new table and still widens RLS; rejected.
2. **SELECT on everything: `pg_read_all_data` vs explicit grants (Q1).** `pg_read_all_data` covers
   every current and future table, view and sequence and `USAGE` on every schema (`app`, `audit`,
   `pgboss`, `public`), so no migration ever has to remember a grant; LOCK TABLE … ACCESS SHARE
   (which pg_dump takes) needs only SELECT. Explicit `GRANT SELECT` plus `ALTER DEFAULT
   PRIVILEGES FOR ROLE lf_migrator` would work too, but a missing grant makes the nightly backup
   fail silently in production until someone reads the log. Large objects are not covered by
   `pg_read_all_data` (source 7); LedgerForce stores none (no `lo_*` use in the code base), so
   pg_dump has nothing to read there.
3. **What the role can still do (Q2).** With `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
   no table ownership and only `pg_read_all_data`, the role has no INSERT/UPDATE/DELETE/TRUNCATE/
   TRIGGER/REFERENCES privilege anywhere and no CREATE on any schema (LedgerForce schemas are owned
   by `lf_migrator`; CREATE on `public` is revoked from PUBLIC). It cannot ALTER a table (not the
   owner), so it cannot `DISABLE TRIGGER`, and cannot set `session_replication_role` (superuser
   parameter, source 6), so the immutability and hash-chain triggers stay on. Remaining PUBLIC
   defaults are (a) `TEMPORARY` on the database — revoked from PUBLIC by
   `20-keycloak-db.sh` in compose but not by the shared bootstrap, so on other installs any login
   role can create session-private temp tables; (b) `EXECUTE` on functions — every SECURITY
   DEFINER function in the migrations already revokes EXECUTE from PUBLIC (12 of 12 files), and
   functions that are not SECURITY DEFINER run with the caller's (read-only) rights;
   (c) creating large objects needs no privilege at all in PostgreSQL. `ALTER ROLE … SET
   default_transaction_read_only = on` makes (c) and any accidental write fail by default; it can
   be switched off by the session itself, so it is defence in depth, not the boundary. The
   boundary is the absence of privileges, which the tests check table by table.
4. **Membership and attribute hygiene (Q2).** Role attributes such as BYPASSRLS are not
   inherited, but a member of `lf_backup` can `SET ROLE lf_backup` and then has them (source 4).
   The bootstrap must therefore remove any membership *of* `lf_backup` in other roles and any
   role that is a member *of* `lf_backup`, re-assert the attributes on every run (as it does for
   `lf_app` / `lf_migrator`), and the setup refusal for app roles (SS-PLAT-85) stays: `lf_app` and
   `lf_migrator` must still be NOBYPASSRLS. A `CONNECTION LIMIT` (4: the manifest session plus
   pg_dump, for a nightly and a manual run at once) caps the damage of a leaked password used for
   bulk parallel reads.
5. **Log in only from the backup service (Q3).** Only `pg_hba.conf` restricts where a role may
   connect from (source 5); first match wins, so a managed block *before* the image's catch-all
   `host all all all scram-sha-256` decides for `lf_backup`: allow `scram-sha-256` to the
   LedgerForce database from the backup network's subnet, then `reject` from everywhere else and
   over the local socket. Compose service IPs are dynamic, but a dedicated `internal: true`
   network with a declared subnet that only `postgres` and `backup` join gives the backup service
   the only addresses in that subnet (source 12) and, as a side effect, no route out of the host
   for the container that holds the backup key. The subnet is a setting (`LF_BACKUP_SUBNET`) so an
   operator can move it if it collides with a local network. The password exists only as the
   `lf_backup_password` compose secret mounted into `backup` (and into `postgres`, which sets it).
6. **Existing installs (Q4).** Docker's `/docker-entrypoint-initdb.d` scripts run only on an empty
   data directory, so an upgrade step is needed. Making `10-ledgerforce-roles.sh` itself
   idempotent (bootstrap SQL is already idempotent; passwords are re-set; the pg_hba block is
   replaced between markers, validated with `pg_hba_file_rules` and reloaded) lets the same script
   be the documented upgrade step: `docker compose exec -u postgres postgres bash
   /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh`. The script finds the active file with
   `SHOW hba_file` instead of assuming `$PGDATA`.
7. **How comparable systems do it.** Physical-backup tools (pgBackRest, Barman, source 9) use a
   dedicated backup role rather than the application or superuser role, granting only the backup
   functions and predefined monitoring roles since PostgreSQL 15; their replication access reads
   data files, which is a strictly larger capability than SELECT. Supabase (source 10) keeps
   BYPASSRLS off the API roles and on the administrative role used for dumps. Odoo and GitLab
   dump as the database owner, which works only because they do not FORCE RLS. Managed services
   (RDS, Cloud SQL, Azure) do not give customers a superuser at all, so a dump of RLS tables there
   also runs as a role with BYPASSRLS. A dedicated BYPASSRLS + `pg_read_all_data` login role is
   the pattern the PostgreSQL documentation itself suggests (source 1) and matches the
   least-privilege split the product already has (`lf_migrator` / `lf_app`).
8. **Risk compared with the status quo.** Superuser can write, disable triggers
   (`session_replication_role`), read server files and run programs as the OS user
   (`COPY … TO PROGRAM`); a leaked backup credential today is full compromise. The new role can
   read every tenant's data — exactly what the backup file contains — and nothing else, from one
   subnet, with at most four sessions. Reading everything is inherent to a logical backup and is
   mitigated by encryption at rest (ADR-0101), the credential living only in the backup service,
   and the network restriction.

## Conclusion

Create `lf_backup` in the shared cluster bootstrap: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT 4`, member of `pg_read_all_data` only (other
memberships in either direction revoked on every run), `default_transaction_read_only = on`,
`CONNECT` on the LedgerForce database; revoke `TEMPORARY` on the database from PUBLIC in the
shared bootstrap (as compose already does) so no login role without an explicit grant creates
temp objects. Restrict its logins in `pg_hba.conf` to the backup network subnet with a managed,
idempotent block written by `10-ledgerforce-roles.sh`, which doubles as the upgrade step for
existing installs. Switch the compose `backup` service to `lf_backup` with an
`lf_backup_password` secret, on an internal network shared only with `postgres`. Decision:
ADR-0106 (security), DL-0940..DL-0944.
