---
adr: 0106
title: "Least-privilege lf_backup login role (BYPASSRLS + pg_read_all_data, read-only, pg_hba-confined) for the nightly backup instead of the superuser"
status: Accepted
date: 2026-11-23
author: claude
category: security
human_gate: yes (delegated, DL-0691 / DL-0896)
supersedes: ADR-0101 (only the rule that the backup connects as the cluster superuser)
superseded_by: ADR-0109 (only the rule that lf_backup may log in from the whole backup subnet)
---

# ADR-0106: Least-privilege `lf_backup` role for the nightly backup

## Status

Accepted 2026-11-23 by the building agent under the product owner's standing delegation for
security decisions (DL-0691, AGENTS.md §6 as updated by DL-0896): research RQ-0188, decisions
DL-0940..DL-0944, tests in `packages/db/src/ops/backup-role.db.test.ts` (SS-PLAT-193, SS-PLAT-194),
`packages/ledger/src/ops/restore-drill.db.test.ts` (the drill now verifies a backup taken as
`lf_backup`) and `infra/test/install-contract.test.ts` (SS-PLAT-195). An independent security
review follows (AGENTS.md §6); its findings are handled as follow-up on T-0227.

## Context and problem statement

ADR-0101 (T-0143) runs `pg_dump` as the cluster superuser because every tenant table has RLS
`ENABLE` + `FORCE` and `lf_app` / `lf_migrator` are `NOBYPASSRLS`. The superuser password is
therefore mounted into the long-running `backup` container. Superuser can write any row, switch
off the immutability and hash-chain triggers (`session_replication_role = replica`), read server
files and execute programs as the database OS user (`COPY … TO PROGRAM`). A backup needs none of
that: it needs to *read* every row.

## Decision drivers

- Dump every tenant's rows past `FORCE` RLS, and every future table without a per-table grant.
- No write, DDL, temp objects, trigger or RLS change, role grant, or ownership.
- Log in only from the backup service; the password only where it is used.
- One idempotent mechanism for new data directories and existing installs; PostgreSQL 16 and 17.
- `lf_app` and `lf_migrator` stay `NOBYPASSRLS` (ADR-0003, setup refusal SS-PLAT-85).

## Considered options

1. Keep the superuser (status quo) — maximal blast radius; rejected.
2. **Dedicated login role with `BYPASSRLS` and membership in `pg_read_all_data` only (chosen).**
   The pattern the PostgreSQL docs give for `pg_read_all_data` under RLS (RQ-0188 source 1).
3. `BYPASSRLS` role with explicit `GRANT SELECT` + `ALTER DEFAULT PRIVILEGES` — same power, but a
   forgotten grant on a new schema fails the nightly backup in production; rejected.
4. A see-all RLS policy for a backup role on every table, dumping with
   `--enable-row-security` — touches every tenant policy and widens RLS itself; rejected.
5. Physical backup with a `REPLICATION` role (pgBackRest / WAL-G) — reads raw data files (more
   than SELECT) and is the PITR track (T-0228), not the nightly logical copy.

## Decision

1. **Role** (`packages/db/bootstrap/01_cluster_roles.sql`, run by the compose init script, the
   test harness and the restore): `lf_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT 4`, `GRANT pg_read_all_data`, and
   `ALTER ROLE lf_backup SET default_transaction_read_only = on`. Every run re-asserts these and
   revokes any other membership of `lf_backup` *and* any role's membership in `lf_backup` (a
   member could `SET ROLE lf_backup` and gain BYPASSRLS). `lf_backup` owns nothing and receives
   no other grant; migrations never mention it.
2. **Database grants** (`02_database_grants.sql`): `GRANT CONNECT … TO lf_backup`, and
   `REVOKE TEMPORARY … FROM PUBLIC` (compose already did this in `20-keycloak-db.sh`; now every
   install does). `lf_migrator` keeps its explicit `TEMPORARY`.
3. **Logins** (`infra/compose/initdb/10-ledgerforce-roles.sh`): a managed block, written before
   every other rule of the active `pg_hba.conf` (`SHOW hba_file`) and replaced on each run:

   ```
   # BEGIN lf_backup (T-0227, ADR-0106) — managed by 10-ledgerforce-roles.sh
   host   <POSTGRES_DB>  lf_backup  <LF_BACKUP_ALLOWED_CIDR>  scram-sha-256   (only if set)
   host   all            lf_backup  all                       reject
   local  all            lf_backup                            reject
   # END lf_backup
   ```

   The CIDR and database name are validated before writing; the new file is checked with
   `pg_hba_file_rules` and the old one restored if PostgreSQL reports an error; then
   `pg_reload_conf()`. Without `LF_BACKUP_ALLOWED_CIDR`, or without `LF_BACKUP_PASSWORD`, the role
   exists but cannot log in.
4. **Compose**: a `backup` network (`internal: true`, subnet `${LF_BACKUP_SUBNET:-172.30.227.0/29}`)
   joined only by `postgres` and `backup`; `backup` is on no other network. `postgres` receives
   `LF_BACKUP_ALLOWED_CIDR` = the same subnet and the `lf_backup_password` secret; `backup`
   connects as `lf_backup` with `lf_backup_password` and no longer holds `postgres_password`.
   `init-secrets.sh` generates `lf_backup_password`. Compose sets `LF_BACKUP_DB_USER=lf_backup`
   explicitly (the CLI's fallback stays `postgres` for installs outside compose that have not
   created the role yet; the runbook names `lf_backup` as the recommended user).
5. **Existing installs** run the same init script once as the upgrade step
   (`Docs/ops/backup-restore.md`): `bash infra/compose/init-secrets.sh`, `docker compose … up -d`,
   then `docker compose … exec -u postgres postgres bash
   /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh`.

## Consequences

- Positive: a leaked backup credential reads data (what a backup is) but cannot change the books,
  disable the chain, run programs or escalate; it works only from the backup network and with at
  most four sessions. The backup container has no route off the host.
- Negative / residual: `lf_backup` reads every tenant — inherent to a logical backup, mitigated
  by ADR-0101 encryption and key custody. `default_transaction_read_only` can be switched off by
  the session; the write boundary is the absence of privileges, which the tests check for every
  table, sequence, schema and SECURITY DEFINER function. PostgreSQL lets any role create large
  objects; LedgerForce uses none and the read-only default blocks it. If the backup uses transit
  KMS on another host, the operator must also attach `backup` to a network that reaches it
  (runbook). `LF_BACKUP_SUBNET` must not collide with a host network.
- `pg_read_all_data` exists since PostgreSQL 14; the stack requires 16+ (DL-0007).
