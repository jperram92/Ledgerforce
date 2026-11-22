---
adr: 0101
title: "Encrypted logical backups: Kms envelope with an AES-256-GCM STREAM payload, snapshot-consistent manifest, and a restore drill that verifies every company's hash chain"
status: Accepted
date: 2026-11-22
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0101: Encrypted logical backups and the hash-chain restore drill

## Status

Accepted 2026-11-22 by the building agent under the product owner's standing instruction DL-0691
(security decisions delegated on condition of research, a decision-log entry and tests):
research RQ-0183, decisions DL-0880..DL-0885, tests in
`packages/ledger/src/ops/restore-drill.db.test.ts` and `infra/test/install-contract.test.ts`.

## Context and problem statement

Design §6.9 requires backups and quarterly restore drills; §7.2 promises the single-VM install
"nightly encrypted backups". A backup holds every tenant's books, bank details and audit trail
in one file, so at rest it must be unreadable without a key held elsewhere, and a restore must
prove the books are the same books: the per-company journal hash chain (ADR-0004 rule 5,
ADR-0017) is the integrity proof the product already has.

## Decision drivers

- No new runtime dependency or extra binary for the crypto; one key-custody model (the `Kms`,
  ADR-0018 / ADR-0038), including OpenBao transit.
- Authenticated encryption that detects any altered, reordered, dropped or truncated byte
  *before* data reaches `pg_restore`.
- Manifest and dump from the same instant; the drill fails loudly and leaves nothing behind.
- Works on the local PostgreSQL 16 harness and on PostgreSQL 17 (CI, compose).

## Considered options

1. `age` file encryption (X25519 recipients) — sound, but a second key system and a new binary;
   transit keys cannot be recipients.
2. `openssl enc` — unauthenticated; rejected. `openssl cms` / `gpg` — authenticated but bring a
   PKI/keyring and a binary.
3. **Envelope encryption through `Kms`, node:crypto only, age-style STREAM payload (chosen).**
4. Physical backups (pgBackRest/WAL-G with their own encryption) — the right tool for PITR, not
   for the single-VM nightly copy; deferred to T-0228.

## Decision

**File format `lf-backup/v1`** (implemented in `packages/db/src/ops/backup-format.ts`):

```
"LFBACKUP" (8 bytes) | header length u32 BE | header JSON | HMAC-SHA256(header) (32 bytes) | payload
header = { format: "lf-backup/v1", backupId, createdAt, keyId, wrappedKey (base64),
           chunkSize: 65536, manifest: { iv, tag, ciphertext } (base64) }
```

- A fresh 32-byte data key per backup, wrapped by the configured `Kms` with AAD
  `lf-backup-v1|<backupId>` (a wrapped key copied into another file does not open it).
- HKDF-SHA256(data key, salt = backupId) derives three independent keys: `header-mac`,
  `manifest`, `payload`. The header MAC is verified (constant time) before anything else.
- The manifest (per-table exact row counts; per-company chain entries, head seq and head hash;
  server version) is sealed with AES-256-GCM, AAD = backupId.
- Payload: the `pg_dump -Fc` stream in 64 KiB plaintext chunks, each AES-256-GCM with nonce =
  11-byte big-endian counter ‖ final flag (0x01 for the last chunk, else 0x00) and AAD = the
  header MAC. The last chunk is non-empty unless the dump is empty. Decryption fails on a
  missing final chunk, trailing data, or any authentication failure.

**Backup** (`createBackup`): one superuser session opens `REPEATABLE READ`, calls
`pg_export_snapshot()`, computes the manifest, and keeps the transaction open while
`pg_dump -Fc --snapshot=<id>` streams through the encryptor into `<file>.partial`, renamed on
success; mode 0600. Superuser because `pg_dump` refuses tables whose RLS it cannot bypass and the
LedgerForce roles are `NOBYPASSRLS` with `FORCE` (RQ-0183 Finding 3); a dedicated `lf_backup`
role is T-0227.

**Restore** (`restoreBackup`): verify the header, unwrap, open the manifest; on the target
server apply the idempotent cluster bootstrap, create the named fresh database (refusing one
that exists), apply the database grants, then stream the authenticated plaintext into
`pg_restore --single-transaction --exit-on-error --dbname=<target>`. Any failure drops the
target database.

**Drill** (`runRestoreDrill`, `packages/ledger/src/ops/restore-drill.ts`, CLI
`packages/ledger/src/cli/restore-drill.ts`): restore, then compare every table's exact row count
with the manifest and run `verifyChain` for every company (`ok`, entry count and head hash equal
the manifest). Prints one line per company; exit 0 only if everything matches, otherwise exit 1
with a named reason (`BACKUP_DECRYPT_FAILED`, `RESTORE_FAILED`, `ROW_COUNT_MISMATCH`,
`CHAIN_BROKEN`, `CHAIN_COUNT_MISMATCH`, `CHAIN_HEAD_MISMATCH`, `COMPANY_SET_MISMATCH`).

**Compose**: a `backup` service (image target `backup`: node runtime + `postgresql17-client`)
runs `packages/db/src/cli/backup.ts --daily`, writing to the `backups` volume at
`LF_BACKUP_AT` (UTC, default 02:30) and pruning files older than `LF_BACKUP_RETENTION_DAYS`
(default 14, always keeping the newest). The key comes from a dedicated keyring secret
(`backup_keyring`, `LF_KMS_PROVIDER=local`) or transit. Runbook: `Docs/ops/backup-restore.md`.

## Consequences

- Positive: no new dependency; tamper-evident, key-bound backups; the restore drill proves the
  books with the same verifier the product already trusts; works with OpenBao.
- Negative: the backup host can decrypt (symmetric KEK) unless transit with an encrypt-only
  policy is used; the superuser password is mounted into the backup service until T-0227;
  RPO is 24 h on the single VM until PITR (T-0228). Off-host copies (object storage) are an
  operator step in the runbook.
- The CI db job installs PostgreSQL 17 binaries so `pg_dump` matches the postgres:17 service.
