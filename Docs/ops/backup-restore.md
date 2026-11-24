# Backup and restore drill (self-hosted)

How the single-server install backs up the LedgerForce database, where the key lives, and how to
prove a backup restores to the same books. Decision: [ADR-0101](../adr/0101-encrypted-logical-backup-and-restore-drill.md);
research: [RQ-0183](../research/RQ-0183-encrypted-backup-and-restore-drill.md); task T-0143.

## What runs

The compose `backup` service runs `node packages/db/src/cli/backup.ts --daily --dir /backups`:

- every day at `LF_BACKUP_AT` (UTC, `HH:MM`, default `02:30`) it takes a `pg_dump` (custom format)
  of the `ledgerforce` database under one exported snapshot, together with a manifest: the exact
  row count of every table and, for every company, the number of chained journal entries and the
  chain head hash;
- it encrypts both with a fresh data key wrapped by the backup keyring (`lf-backup/v1`: AES-256-GCM
  in authenticated 64 KiB chunks) and writes `ledgerforce-<UTC time>.lfbackup` (mode 0600) to the
  `backups` volume;
- it deletes backups older than `LF_BACKUP_RETENTION_DAYS` (default `14`), always keeping the
  newest.

Set `LF_BACKUP_AT` and `LF_BACKUP_RETENTION_DAYS` in `infra/compose/ledgerforce.env`. A failed
night is logged (`docker compose … logs backup`) and the service tries again the next day.

## The database role: `lf_backup`

The service connects as `lf_backup`, not as the superuser ([ADR-0106](../adr/0106-least-privilege-backup-role.md),
research [RQ-0188](../research/RQ-0188-least-privilege-backup-role.md), T-0227). `pg_dump` must read
past the forced row-level security of every tenant table, so the role has `BYPASSRLS` and the
built-in `pg_read_all_data` role, and nothing else:

- it cannot insert, update, delete, truncate, create tables, schemas, roles or temporary tables,
  disable triggers or row security, or run the privileged (SECURITY DEFINER) functions; it owns
  nothing and its sessions start read-only;
- at most four sessions at a time (`CONNECTION LIMIT 4`);
- it may log in only to the `ledgerforce` database and only from the `backup` container's own
  address on the internal `backup` network, which only the `postgres` and `backup` services join.
  The rule is a `/32` for that one address (`LF_BACKUP_ADDRESS`, default `172.30.227.6`, the last
  usable address of the subnet `LF_BACKUP_SUBNET`, default `172.30.227.0/29`), so neither another
  address in the subnet nor its gateway (`172.30.227.1`, which is the Docker host itself) can use
  the role ([ADR-0109](../adr/0109-backup-role-hardening.md), T-0244). If the subnet collides with
  a network on your host, change `LF_BACKUP_SUBNET` and `LF_BACKUP_ADDRESS` together in
  `ledgerforce.env` and re-run the upgrade step below.
  `infra/compose/initdb/10-ledgerforce-roles.sh` writes this rule at the top of `pg_hba.conf`
  between `# BEGIN lf_backup` and `# END lf_backup`; do not edit that block by hand, re-run the
  script instead. It refuses a `/0` prefix and any address outside private or loopback space,
  restores the previous `pg_hba.conf` if anything fails before the new rules are loaded, and sets
  the `lf_backup` password only once the rule is in force;
- it cannot create large objects: `EXECUTE` on `lo_creat`, `lo_create` and `lo_from_bytea` is
  revoked from everyone (ADR-0109), so this holds even if a session switches read-only off;
- its password is the `lf_backup_password` secret, mounted only into `postgres` (which sets it)
  and `backup`. The superuser password is no longer mounted into `backup`.

The `backup` network has no route off the host. If you use the OpenBao transit key service on
another machine, also attach `backup` to a network that reaches it.

### Upgrading an install created before T-0227

The init scripts run only when the data directory is empty, so an existing install adds the role
once with the same (idempotent) script:

```bash
bash infra/compose/init-secrets.sh            # adds lf_backup_password; keeps every other secret
docker compose -f infra/compose/compose.yaml --env-file infra/compose/ledgerforce.env up -d
docker compose -f infra/compose/compose.yaml --env-file infra/compose/ledgerforce.env \
  exec -u postgres postgres bash /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh
```

The last command prints `lf_backup logins allowed from <address>/32`. Running it again is safe:
it re-applies the role settings, resets the passwords from the secrets and replaces the
`pg_hba.conf` block. Then take a one-off backup (below) to confirm the role works.

If `pg_hba.conf` already has errors (for example a hand edit), PostgreSQL ignores every change to
the file until they are fixed. The script then prints
`WARNING: <file> already has errors …` with each line number and error, finishes the roles,
leaves the file, the `lf_backup` rule and its password unchanged, and exits 0. Fix the named
lines and run the script again.

### When the backup service will not start

At start-up, and again before every nightly run, the backup checks the role it connects with. A
problem stops the service at once with exit code 2 and a named error, so
`docker compose … ps` shows `backup` restarting and `docker compose … logs backup` says why
(T-0244, ADR-0109):

| Error | Meaning | What to do |
| --- | --- | --- |
| `LF_BACKUP_ROLE_MISSING` | The `lf_backup` role does not exist (an install from before T-0227) | Run the upgrade step above |
| `LF_BACKUP_LOGIN_FAILED` | Password authentication failed: the role is missing (with password authentication PostgreSQL does not say which) or its password differs from the `lf_backup_password` secret | Run `bash infra/compose/init-secrets.sh`, then the upgrade step |
| `LF_BACKUP_LOGIN_REJECTED` | `pg_hba.conf` refuses `lf_backup` from the backup container's address (no rule yet, or `LF_BACKUP_ADDRESS` changed) | Run the upgrade step; check `LF_BACKUP_ADDRESS` lies in `LF_BACKUP_SUBNET` |
| `LF_BACKUP_ROLE_MISCONFIGURED` | `lf_backup` logged in but differs from the bootstrap (each difference is listed: not BYPASSRLS, extra attributes or memberships, sessions not read-only) | Run the upgrade step; it repairs the role |
| `LF_BACKUP_ROLE_CANNOT_BYPASS_RLS` | `LF_BACKUP_DB_USER` names a role that is neither `lf_backup`, BYPASSRLS nor superuser, so it cannot dump the tenant tables | Set `LF_BACKUP_DB_USER=lf_backup` |

A database that is not reachable yet is not a role problem: the service exits with code 1 and
compose starts it again.

## The key: keep it off the host

`bash infra/compose/init-secrets.sh` creates `infra/compose/secrets/backup_keyring`, a JSON keyring
with one random 32-byte key. **Without this file no backup can be restored.** Store a copy off the
host (a password manager or a sealed envelope in a safe), separately from the backup copies. Keep
the backup files somewhere other than the server as well, for example by syncing the `backups`
volume to object storage each morning. A backup that exists only on the lost server, or whose
only key is on the lost server, is not a backup.

Rotation: add a new key to `keys`, set `active` to it, and restart `backup`. Keep the old keys
for as long as backups made with them are retained. To keep the key outside the server entirely,
use the OpenBao transit key service instead (`LF_KMS_PROVIDER=transit`, ADR-0038) with a policy
that allows the backup host to encrypt only.

One-off backup (for example before an upgrade):

```bash
docker compose -f infra/compose/compose.yaml --env-file infra/compose/ledgerforce.env \
  run --rm backup node packages/db/src/cli/backup.ts --out /backups/before-upgrade.lfbackup
```

## Restore drill (quarterly, and before you rely on a backup)

Design §6.9 asks for a restore drill every quarter. The drill restores a backup into a **new**
database, on a server of your choice (a fresh PostgreSQL 17 server is best), then proves it:

1. the file opens with the keyring (any changed byte, a truncated file or a wrong key fails);
2. it restores in one transaction (`pg_restore --single-transaction`) after creating the
   LedgerForce roles if the server is new;
3. every table has exactly the row count recorded at backup time;
4. every company's journal hash chain verifies (each entry's hash recomputed from its rows,
   ADR-0017) with the recorded entry count and head hash.

```bash
LF_KMS_PROVIDER=local LF_KMS_KEYRING_FILE=/secure/backup_keyring \
LF_RESTORE_SERVER_URL=postgres://postgres@drill-host:5432/postgres \
LF_RESTORE_SERVER_PASSWORD_FILE=/secure/drill_superuser_password \
node packages/ledger/src/cli/restore-drill.ts --file ledgerforce-20261122T023000Z.lfbackup \
  --database lf_drill_2026q4
```

It needs `pg_restore` 17 (or newer) on the machine that runs it (`LF_PG_BINDIR` picks a
version). Exit code 0 prints one `company … chain ok entries N` line per company and
`restore drill OK`. Record the output with the date in your operations log. The restored
database is kept for inspection; drop it when done.

Exit code 1 means the drill failed. Each problem is one line on stderr, and the half-restored
database is dropped:

| Code | Meaning | What to do |
| --- | --- | --- |
| `BACKUP_DECRYPT_FAILED` | Wrong keyring, not an lf-backup file, or the file was changed or truncated | Check you used the right keyring; try an older backup; treat a changed file as a security incident |
| `RESTORE_FAILED` | `pg_restore` failed, or the target database already exists | Use a new database name; check the server version (17+) |
| `ROW_COUNT_MISMATCH` | A table has a different row count than at backup time | The dump is incomplete; do not rely on this backup |
| `COMPANY_SET_MISMATCH` | Companies differ from the backup's manifest | As above |
| `CHAIN_BROKEN` | A company's journal hash chain does not verify (seq and reason named) | The journal was altered, possibly before the backup: compare with the live system's chain check; security incident |
| `CHAIN_COUNT_MISMATCH` / `CHAIN_HEAD_MISMATCH` | The chain verifies but differs from the backup's record | As for `CHAIN_BROKEN` |

Exit code 2 means a usage or configuration error (missing `--file`, `--database`, keyring or
server URL).

## Restoring for real

Run the drill against the replacement server, then point the stack at the restored database (set
the passwords of `lf_migrator` and `lf_app` on the new server from `infra/compose/secrets/`) and
start compose. Setup applies any newer migrations. Point-in-time recovery to a moment between
nightly backups is not available on the single-server install (T-0228).
