---
adr: 0109
title: "lf_backup hardening: start-up role check with named errors, no large-object creation, robust pg_hba step, single-address (/32) rule"
status: Accepted
date: 2026-11-23
author: claude
category: security
human_gate: yes (delegated, DL-0691 / DL-0896)
supersedes: ADR-0106 (only the rule that lf_backup may log in from the whole backup subnet)
superseded_by: none
---

# ADR-0109: `lf_backup` hardening after security review r12

## Status

Accepted 2026-11-23 by the building agent under the product owner's standing delegation for
security decisions (DL-0691, AGENTS.md §6 as updated by DL-0896): research RQ-0191, decisions
DL-0970..DL-0975, tests `packages/db/src/ops/backup-role-hardening.db.test.ts` (SS-PLAT-199,
SS-PLAT-200, SS-PLAT-201) and `infra/test/install-contract.test.ts` (SS-PLAT-200, SS-PLAT-201).
The independent security review required by AGENTS.md §6 is part of T-0244's cross-review step.
ADR-0106 stays Accepted; this record amends one rule of it and adds to it.

## Context and problem statement

Security review r12 (DL-0899) passed T-0227 / ADR-0106 with one medium and four low findings:
an install that predates T-0227 fails its nightly backup quietly until the operator runs the
manual upgrade step (M2); with read-only switched off, `lf_backup` can create large objects (L4);
the pg_hba step leaves a new file in place if the validation query itself fails, and a parse
error already in the file makes every run fail with a message blaming the managed block (L5); a
`/0` CIDR is accepted (L6); the host can reach PostgreSQL from the backup network's gateway
address, which the subnet rule allows (L7).

## Decision drivers

- A missing role must be visible the day of the upgrade, not after the first lost night.
- No new container may hold the superuser password or the data directory.
- `lf_backup` must not be able to store anything, even after `SET default_transaction_read_only = off`.
- The pg_hba file must never be left in an unvalidated state, and the role must never be usable
  before its rule is in force.
- The rule must name exactly the backup container.

## Considered options

1. **M2:** (a) a one-shot compose service that runs the role script on every start; (b) a
   pre-flight in the backup service that checks its own role and fails with a named error.
2. **L4:** (a) rely on the read-only default; (b) revoke `EXECUTE` on the large-object creation
   functions from PUBLIC per database.
3. **L5:** (a) keep the count check; (b) restore through an `EXIT` trap while the file is
   unconfirmed, and check the current file for errors before touching it.
4. **L6:** (a) refuse only `/0`; (b) refuse `/0` and any address outside loopback/private space,
   validated by PostgreSQL's `inet` type after the shape check.
5. **L7:** (a) a `reject` line for the gateway before the subnet rule; (b) a static address for
   the backup container and a `/32` rule.

## Decision

1. **(b)** `checkBackupRole` (`packages/db/src/ops/backup-preflight.ts`) runs in the backup CLI at
   start-up and before every nightly run. Login failures map to `LF_BACKUP_ROLE_MISSING`,
   `LF_BACKUP_LOGIN_FAILED`, `LF_BACKUP_LOGIN_REJECTED`; a logged-in `lf_backup` that differs from
   the bootstrap is `LF_BACKUP_ROLE_MISCONFIGURED` with every difference listed; another role that
   is neither superuser nor BYPASSRLS is `LF_BACKUP_ROLE_CANNOT_BYPASS_RLS`. A start-up failure
   exits 2, so compose shows the service restarting with the error and the upgrade command in its
   log. Option (a) was rejected: it puts the superuser password and write access to `pg_hba.conf`
   (inside `pgdata`) into a second container, the opposite of ADR-0106.
2. **(b)** `packages/db/bootstrap/02_database_grants.sql` revokes `EXECUTE` on
   `lo_creat(integer)`, `lo_create(oid)` and `lo_from_bytea(oid, bytea)` from PUBLIC. LedgerForce
   stores no large objects; the superuser (restore) is not affected.
3. **(b)** `10-ledgerforce-roles.sh` reports a pre-existing error (file, line numbers, errors),
   completes the roles, leaves the file, the rule and the `lf_backup` password unchanged and exits
   0; otherwise an `EXIT` trap restores the previous file on any failure between the rewrite and
   a successful reload; the `lf_backup` password is set only after the reload.
4. **(b)** Shape regex, then a message naming `/0`, then `inet`: non-zero prefix inside 10/8,
   172.16/12, 192.168/16, 127/8, fc00::/7 or ::1.
5. **(b)** Compose gives `backup` the fixed address `${LF_BACKUP_ADDRESS:-172.30.227.6}` (the last
   usable address of the /29; local bridge IPAM gives `postgres` the first free one) and sets
   `LF_BACKUP_ALLOWED_CIDR=${LF_BACKUP_ADDRESS:-172.30.227.6}/32`. Option (a) depends on Docker's
   default gateway choice and leaves the rest of the subnet open.

## Consequences

- Good: an un-upgraded install shows a restarting `backup` service with the fix in its log on the
  day of the upgrade; role drift is reported by name before each run.
- Good: `lf_backup` (and `lf_app`) cannot create large objects in any session.
- Good: `pg_hba.conf` is never left unvalidated; a broken hand edit is reported as such.
- Good: only the backup container's address can use the role.
- Bad: one more setting, `LF_BACKUP_ADDRESS`, must be changed together with `LF_BACKUP_SUBNET`
  (Docker refuses to attach the container if it is outside the subnet, which is loud).
- Bad: the pre-flight costs one extra connection per run (negligible).
- Neutral: the static address and the gateway behaviour were not exercised against a Docker daemon
  here (none available, DL-0007); the compose contract test checks the address lies inside the
  subnet and is neither the network, gateway nor broadcast address, and the install smoke
  (SS-PLAT-23) exercises it where Docker exists.
