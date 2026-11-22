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

The service connects as the `postgres` superuser, because `pg_dump` must read past the forced
row-level security of every tenant table. A read-only `lf_backup` role is planned (T-0227).

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
