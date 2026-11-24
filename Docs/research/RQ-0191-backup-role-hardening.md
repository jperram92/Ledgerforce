---
id: RQ-0191
title: Hardening the lf_backup role - start-up detection, large objects, pg_hba script robustness, single-address rule
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0244, T-0227, T-0143]
linked_adrs: [ADR-0109, ADR-0106, ADR-0101]
superseded_by:
---

# RQ-0191 — lf_backup hardening after security review r12 (DL-0899)

## Question

Security review r12 of T-0227 (ADR-0106, RQ-0188) passed with one medium and four low findings,
carried by T-0244:

- **Q1 (M2)** On an install that predates T-0227 the nightly backup fails every night until the
  operator runs the manual upgrade step, and nothing says so until someone reads the log. How do
  we make a missing or misconfigured `lf_backup` loud at start-up (or remove the manual step)?
- **Q2 (L4)** With `default_transaction_read_only` switched off by the session itself, can
  `lf_backup` create large objects, and how is that removed?
- **Q3 (L5)** The pg_hba step restores the previous file only when the error count is non-zero;
  if the validation query itself fails the new file stays. A pre-existing parse error in the
  operator's `pg_hba.conf` makes every run fail with a message that blames the managed block.
- **Q4 (L6)** `LF_BACKUP_ALLOWED_CIDR=0.0.0.0/0` passes validation.
- **Q5 (L7)** The rule allows the whole backup subnet; the Docker host owns the subnet's gateway
  address and can reach PostgreSQL from it.

## Sources

1. PostgreSQL 17 docs, *Large Objects — Server-Side Functions* and *Implementation Features*
   (`lo_creat`, `lo_create`, `lo_from_bytea`; creating a large object needs no privilege;
   `lo_import`/`lo_export` server-side are superuser-only by default; `lo_compat_privileges`
   concerns read/write/unlink checks, not creation):
   <https://www.postgresql.org/docs/17/lo-funcs.html>,
   <https://www.postgresql.org/docs/17/lo-implementation.html>.
2. PostgreSQL 17 docs, *GRANT* (`EXECUTE` on functions, granted to PUBLIC by default; REVOKE on
   a built-in function is stored per database in `pg_proc.proacl`) and *Privileges* (§5.8):
   <https://www.postgresql.org/docs/17/sql-grant.html>,
   <https://www.postgresql.org/docs/17/ddl-priv.html>. libpq's client-side `lo_creat`/`lo_import`
   call the same server functions through the fast-path interface, which checks `EXECUTE`
   (`src/backend/tcop/fastpath.c`, `fetch_fp_info` → `object_aclcheck(… ACL_EXECUTE)`).
3. PostgreSQL 17 docs, *The pg_hba.conf File* and `pg_hba_file_rules`
   (<https://www.postgresql.org/docs/17/auth-pg-hba-conf.html>,
   <https://www.postgresql.org/docs/17/view-pg-hba-file-rules.html>): "If any errors are found
   … the file is not reloaded"; the view reads the file on disk, not the loaded rules.
4. PostgreSQL 17 docs, *Network Address Types* (`inet`, `masklen`, containment `<<=`):
   <https://www.postgresql.org/docs/17/functions-net.html>.
5. RFC 1918 (IPv4 private ranges 10/8, 172.16/12, 192.168/16), RFC 1122 (127/8 loopback),
   RFC 4193 (IPv6 unique-local fc00::/7), RFC 4291 (::1 loopback).
6. Compose specification, `services.networks.ipv4_address` ("Specify a static IP address for a
   service container when joining the network … the network … must have an `ipam` attribute
   with subnet configurations covering each static address"):
   <https://github.com/compose-spec/compose-spec/blob/main/spec.md> (§ ipv4_address,
   ipv6_address); Docker docs, *Compose networks* (`internal`, `ipam.config.subnet`, `ip_range`,
   `gateway`): <https://docs.docker.com/reference/compose-file/networks/>.
7. Docker docs, *Bridge network driver* ("The bridge is normally assigned the network's
   `--gateway` address", `com.docker.network.bridge.inhibit_ipv4`):
   <https://docs.docker.com/engine/network/drivers/bridge/>; the gateway defaults to the first
   address of the subnet. An `internal` network removes external routing, not the host's bridge
   address.
8. moby source, `daemon/libnetwork/ipamapi/labels.go` — `com.docker.network.ipam.serial`
   ("allocation ordering (serial/first available)"); a code search of moby/moby shows the label
   is set only by the Swarm allocator (`cnmallocator/networkallocator.go`), so local bridge
   networks hand out the first free address.
9. Comparable systems: pgBackRest `check` command and Barman `barman check` (both verify the
   backup user's connection and privileges before and independently of a backup run and exit
   non-zero with a named failure): <https://pgbackrest.org/command.html#command-check>,
   <https://docs.pgbarman.org/>; GitLab Omnibus `gitlab-ctl reconfigure` and Mastodon's
   `tootctl` refuse to start a job when a required role or setting is missing rather than
   failing it later. Kubernetes/Compose operators routinely use a one-shot "init" job for role
   creation (Bitnami PostgreSQL chart `initdb` scripts run only on empty data directories, the
   same limitation as the official image).
10. In-repo: RQ-0188 Findings 3, 5, 6; ADR-0106; `infra/compose/initdb/10-ledgerforce-roles.sh`;
    `packages/db/src/cli/backup.ts`; empirical probes on a throw-away PostgreSQL 16 cluster
    (2026-11-23, below).

## Findings

1. **Q1 — detect at start-up rather than add a privileged one-shot service.** A one-shot compose
   service that runs the role script would need the PostgreSQL superuser password *and* write
   access to `pg_hba.conf` inside the `pgdata` volume, i.e. a second container holding the most
   powerful credential and the cluster's data directory — the opposite of ADR-0106. Running the
   script from the `postgres` container's entrypoint on every start is not possible with the
   official image (initdb scripts run once, source 9). The backup service already has everything
   needed to check its own role: it can log in and read `pg_roles`/`pg_auth_members` (readable
   by every role). The tools operators know (pgBackRest `check`, `barman check`, source 9) do
   exactly this: verify connection and privileges up front and fail with a named error. So
   `packages/db/src/cli/backup.ts` runs a pre-flight before the daily loop (and before a one-off
   `--out`) and exits with code 2 (configuration) and a named error; the compose
   `restart: unless-stopped` then keeps the container in a visible restart loop
   (`docker compose ps` shows *Restarting*, `logs backup` shows the error and the upgrade
   command) instead of a quiet nightly failure. The same check runs before every nightly run so
   a role changed later is reported by name.
   Login errors map as follows (probed): SQLSTATE `28000` "role … does not exist" (trust auth) →
   `LF_BACKUP_ROLE_MISSING`; `28P01` password authentication failed (with scram, PostgreSQL does
   not reveal whether the role exists, so a missing role looks like this in compose) →
   `LF_BACKUP_LOGIN_FAILED`; `28000` "pg_hba.conf rejects connection" / "no pg_hba.conf entry" →
   `LF_BACKUP_LOGIN_REJECTED`. After login, `rolsuper`, `rolbypassrls`, `rolcreaterole`,
   `rolcreatedb`, `rolreplication`, memberships in both directions and the effective
   `default_transaction_read_only` decide `LF_BACKUP_ROLE_MISCONFIGURED` (each problem listed).
   The check applies the least-privilege rules when the connecting role is `lf_backup`; another
   role (the documented superuser fallback for manual runs) is accepted only if it can read past
   RLS (superuser or BYPASSRLS), with a warning.
2. **Q2 — large objects: yes, then no.** Probe: as a plain login role with read-only off,
   `SELECT lo_creat(-1)` succeeds by default. After
   `REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea) FROM
   PUBLIC` it fails with `42501 permission denied for function lo_creat` (and
   `lo_from_bytea`); `lo_import`/`lo_export` already carry `{postgres=X/postgres}`. Every other
   `lo_*` write function (`lo_put`, `lo_open` for write, `lowrite`, `lo_truncate`, `lo_unlink`)
   needs an existing large object the caller owns or has UPDATE on, of which `lf_backup` has none
   (LedgerForce stores none, RQ-0188 Finding 2). The ACL is per database, so the revoke belongs in
   `02_database_grants.sql` (run per database, already part of the upgrade step and of
   `restoreBackup`). Fast-path calls from libpq check the same ACL (source 2). Nothing in the
   code base uses large objects; the superuser (`pg_restore` in the restore drill) is not
   affected by ACLs. The revoke also removes the capability from `lf_app`, which never needed it.
3. **Q3 — restore on any failure, recognise a pre-existing error.** Probe: with an invalid line in
   `pg_hba.conf`, `pg_reload_conf()` logs "pg_hba.conf was not reloaded" and keeps the previous
   rules, and `pg_hba_file_rules` reports the line and error. So (a) the script checks the
   *current* file before touching it: if it already has errors, nothing the script writes would
   take effect, and blaming the managed block is wrong; it prints the file, each line number and
   error, says the lf_backup rule was not changed, completes the role bootstrap, leaves
   `lf_backup`'s password unchanged (a role created by this run has none, so it cannot log in
   anywhere until the rule is in force) and exits 0, so it never blocks an otherwise healthy
   upgrade or first start; the backup pre-flight then reports the missing login by name.
   (b) Once the file is rewritten, an `EXIT` trap restores the previous file unless validation
   and the reload both succeeded, so a failing `psql` (connection lost, server stopping) can no
   longer leave an unvalidated file behind. (c) `lf_backup`'s password is set only after the new
   rule is loaded, so the role is never usable before it is confined.
4. **Q4 — refuse `/0` and anything public.** A shape check alone (regex) admits `/0`. The value is
   now checked in two stages before anything changes: the strict shape regex (it still guards the
   pg_hba text against injection), then PostgreSQL's own `inet` parser (source 4) — the prefix
   must be non-zero and within the address width, and the network must lie inside loopback
   (127/8, ::1) or private space (RFC 1918, RFC 4193; source 5). The backup network is an
   `internal` Docker network, which is always private address space; a public or zero-length
   prefix can only be a mistake. A distinct message names `/0`.
5. **Q5 — a single address, not the subnet.** The host's bridge owns the gateway address (first
   address of the subnet, source 7), and `internal: true` does not remove it; a host process (or a
   container on the host network) could therefore reach PostgreSQL's backup-network address from
   172.30.227.1 and match the subnet rule. Options: (a) a `reject` line for the gateway before the
   subnet rule — depends on Docker's default gateway choice and leaves the rest of the subnet
   open; (b) give the backup container a static address (compose `ipv4_address`, source 6) and
   allow only that `/32`. (b) is the stricter rule and the one the reviewer named first. Address
   collision: PostgreSQL is the only container with a dynamic address on that network and local
   bridge IPAM hands out the first free address (source 8), so PostgreSQL takes .2; the backup
   container takes the last usable address of the /29 (172.30.227.6). The new setting
   `LF_BACKUP_ADDRESS` must lie in `LF_BACKUP_SUBNET`; the compose specification requires the
   network's ipam subnets to cover every static address (source 6), so Docker refuses to attach
   the container otherwise, which is loud. Not verified against a Docker daemon in this session
   (none available, DL-0007); the compose contract test checks the address lies in the subnet.

## Conclusion

- Add a backup pre-flight (`checkBackupRole`) with named errors `LF_BACKUP_ROLE_MISSING`,
  `LF_BACKUP_LOGIN_FAILED`, `LF_BACKUP_LOGIN_REJECTED`, `LF_BACKUP_ROLE_MISCONFIGURED`,
  `LF_BACKUP_ROLE_CANNOT_BYPASS_RLS`; the CLI runs it at start-up (exit 2) and before each run.
- Revoke `EXECUTE` on `lo_creat(integer)`, `lo_create(oid)` and `lo_from_bytea(oid, bytea)` from
  PUBLIC in `02_database_grants.sql`.
- In `10-ledgerforce-roles.sh`: two-stage CIDR validation (shape, then `inet`: non-zero prefix,
  private/loopback only); pre-existing pg_hba errors reported and tolerated (exit 0, rule and
  password unchanged); an `EXIT` trap restores the previous file unless validation and reload
  succeed; the lf_backup password is set after the rule is in force.
- Compose: the backup container gets a static address `${LF_BACKUP_ADDRESS:-172.30.227.6}` and
  PostgreSQL allows `lf_backup` from that `/32` only.
- Recorded in ADR-0109 (security, amends ADR-0106; accepted under DL-0691 with this record) and
  DL-0970..DL-0975.
