---
id: RQ-0183
title: Encrypted logical backups, PITR options, and a restore drill that proves the journal hash chain
status: answered
opened: 2026-11-22
resolved: 2026-11-22
opened_by: claude
linked_tasks: [T-0143, T-0097, T-0227, T-0228]
linked_adrs: [ADR-0101, ADR-0004, ADR-0017, ADR-0018, ADR-0038]
superseded_by:
---

# RQ-0183 — Encrypted backup and restore drill that proves the hash chain

T-0143 names this question "RQ-0142". That number was never created (RQ-0141 and RQ-0143 exist),
so the question is recorded here under the reserved number RQ-0183 (DL-0880).

## Question

Design §6.9 asks for backups with point-in-time recovery (RPO 15 min, RTO 4 h hosted) and
quarterly restore drills; §7.2 asks the single-VM install for "nightly encrypted backups". T-0143
must decide:

- **Q1** Logical (`pg_dump`) or physical (`pg_basebackup` + WAL archiving, pgBackRest, WAL-G)
  backups for the self-hosted nightly backup, and where PITR for the hosted RPO belongs.
- **Q2** How to take a dump that is consistent with a manifest of row counts and chain heads.
- **Q3** Which role can dump tables that have RLS `ENABLE` + `FORCE`.
- **Q4** How the backup file is encrypted at rest: `age`, `openssl`/`gpg`, or envelope encryption
  through the existing `Kms` abstraction (ADR-0018, ADR-0038); key custody.
- **Q5** How the restore is verified: what "fresh database/cluster" needs, and how the journal hash
  chain (ADR-0017) is checked after restore.
- **Q6** Which failure modes must fail loudly (wrong key, altered bytes, truncation, tampered
  chain), and how.
- **Q7** Tool versions: which `pg_dump` can dump which server (local PostgreSQL 16, CI and compose
  PostgreSQL 17).

## Sources

1. PostgreSQL 17 docs, *pg_dump* — https://www.postgresql.org/docs/17/app-pgdump.html (fetched
   2026-11-22): `--snapshot`, `--enable-row-security`, version compatibility notes.
2. PostgreSQL 17 docs, *pg_restore* — https://www.postgresql.org/docs/17/app-pgrestore.html:
   `--single-transaction` ("either all the commands complete successfully, or no changes are
   applied", implies `--exit-on-error`); input "If not specified, the standard input is used";
   `--jobs` needs a regular file.
3. PostgreSQL 17 docs, *Continuous Archiving and Point-in-Time Recovery* —
   https://www.postgresql.org/docs/17/continuous-archiving.html: `wal_level`, `archive_mode`,
   `archive_command`/`archive_library`, base backups.
4. PostgreSQL 17 docs, *SQL Dump* — https://www.postgresql.org/docs/17/backup-dump.html.
5. PostgreSQL 17 docs, *Snapshot Synchronization Functions* (`pg_export_snapshot`), Table 9.98 —
   https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION.
6. C2SP *age* v1 specification — https://github.com/C2SP/C2SP/blob/main/age.md (fetched
   2026-11-22): payload in 64 KiB chunks, STREAM nonce = 11-byte big-endian counter + 1 byte
   final flag (0x01 last chunk), final chunk not empty unless the payload is empty, "Streaming
   decryption MUST signal an error if the end of file is reached without successfully decrypting
   a final chunk"; header MAC with a key derived by HKDF from the file key.
7. Hoang, Reyhanitabar, Rogaway, Vizár, *Online Authenticated-Encryption and its Nonce-Reuse
   Misuse-Resistance* (STREAM), CRYPTO 2015 — https://eprint.iacr.org/2015/189.
8. Google Tink streaming AEAD wire format —
   https://github.com/google/tink/blob/master/docs/WIRE-FORMAT.md (segment nonce with last-segment
   bit, per-file key derived by HKDF).
9. pgBackRest user guide — https://pgbackrest.org/user-guide.html (repo encryption
   `repo-cipher-type=aes-256-cbc`, PITR, `--type=time` restore, `check`/`verify` commands).
10. WAL-G PostgreSQL docs — https://github.com/wal-g/wal-g/blob/master/docs/PostgreSQL.md
    (libsodium / OpenPGP encryption, `backup-push`, `wal-push`, `wal-verify`).
11. AWS RDS automated backups and PITR (5-minute restorable window) —
    https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html.
12. In repo: ADR-0004 (immutable ledger, rule 5 hash chain), ADR-0017 / RQ-0016 (canonical form
    v1), `packages/ledger/src/hash-chain.ts` (`verifyChain`), ADR-0018 / RQ-0018 (envelope
    encryption, `Kms`), ADR-0038 (transit `Kms`), `packages/db/src/testing/start-test-database.ts`
    (local initdb/pg_ctl clusters, DL-0007), `infra/compose/compose.yaml` (postgres:17.11).

## Findings

1. **Logical vs physical (Q1).** A logical dump is portable across major versions upward and
   restores into any fresh database or cluster (Source 1, 4); it is a full copy at one instant,
   so its RPO equals the dump interval (24 h nightly). PITR needs a physical base backup plus a
   continuous WAL archive (Source 3); the tools that do this well (pgBackRest, WAL-G; Sources
   9, 10) are separate daemons with their own repositories and encryption, and managed Postgres
   (Source 11) provides PITR natively. The hosted RPO 15 min is therefore a property of the
   hosted platform (managed PITR, or pgBackRest/WAL-G on self-run hosts), not of the
   single-VM nightly backup. The single-VM compose install gets nightly logical backups as §7.2
   says; PITR for self-hosters and the hosted offering is follow-up card T-0228.
2. **Consistency (Q2).** `pg_dump` takes its own REPEATABLE READ snapshot, so a manifest computed
   in a separate transaction could disagree with the dump under concurrent posting. A session
   that opens `REPEATABLE READ`, calls `pg_export_snapshot()`, computes the manifest and keeps
   the transaction open while `pg_dump --snapshot=<id>` runs makes the dump and the manifest
   the same instant (Sources 1, 5).
3. **RLS (Q3).** "By default, pg_dump will set row_security to off ... If the user does not have
   sufficient privileges to bypass row security, then an error is thrown" (Source 1). `lf_app`
   and `lf_migrator` are both `NOBYPASSRLS` and every tenant table is `FORCE`d, so neither can
   dump. The backup runs as the cluster superuser (the compose `postgres` user) for now; a
   least-privilege `lf_backup` role (`BYPASSRLS` + `pg_read_all_data`, no write) is follow-up
   card T-0227 because it changes the cluster bootstrap that existing installs already ran.
   `--enable-row-security` is not an option: it would silently dump only the visible rows.
4. **Encryption tool (Q4).** Options:
   - `age` (Source 6): sound, small format, X25519 recipients (backup host needs only the public
     key). But it is a new binary in the image and a second key system beside the `Kms`, with
     its own custody story, and the OpenBao transit keys cannot be used as recipients.
   - `openssl enc`: no authentication in `enc` mode (CBC/CTR without MAC; GCM unsupported by
     `enc`), so a tampered backup could decrypt to garbage silently — rejected. `openssl cms`
     and `gpg` authenticate, but add a binary, a PKI or keyring, and a format the app cannot
     check before restore.
   - Envelope encryption through the existing `Kms` (ADR-0018 / ADR-0038), node:crypto only: a
     fresh 32-byte data key per backup, wrapped by the configured `Kms` (local keyring file or
     OpenBao transit), the dump encrypted as an age-style STREAM of AES-256-GCM chunks
     (Sources 6–8). No new dependency, one key-custody model for the whole product (rotation
     and transit come for free), and the restore side authenticates every chunk before a byte
     reaches `pg_restore`. **Chosen** (ADR-0101).
   Key custody: the backup keyring must live off the host as well (a backup whose only key sits
   on the lost VM is not a backup); the runbook makes that a step. A separate backup keyring
   from the field-encryption keyring is recommended so a leaked app key does not open backups.
5. **Format details (Q4, Q6).** Following age/Tink: per-file key derivation by HKDF-SHA256 from
   the data key, salted with the backup id, into three keys (header MAC, manifest, payload);
   the header (format id, backup id, time, key id, wrapped key, chunk size) is MACed with
   HMAC-SHA256 and the MAC is checked before anything else; the manifest is sealed with
   AES-256-GCM so counts and ids are not readable at rest; payload chunks of 64 KiB, nonce =
   11-byte counter + final flag; a missing final chunk (truncation), a reordered, dropped or
   altered chunk, a wrong key or an altered header all fail authentication. The data key is
   wrapped with AAD `lf-backup-v1|<backup id>` so a wrapped key copied into another file does not
   open it (same rule as ADR-0018 record binding).
6. **Restore verification (Q5).** A fresh target needs the cluster roles (`lf_migrator`,
   `lf_app`) before the dump's `OWNER TO` / `GRANT` statements run, so the restore applies the
   idempotent bootstrap (`01_cluster_roles.sql`, then `02_database_grants.sql`) to the target,
   then `pg_restore --single-transaction --exit-on-error` from the authenticated stream (Source
   2: a failed restore leaves nothing behind). The drill then compares the exact row count of
   every table with the manifest and, for every company in `app.journal_chain_head`, runs
   `verifyChain` (`packages/ledger/src/hash-chain.ts`, canonical form v1, ADR-0017), checking
   `ok`, the entry count and the head hash against the manifest. `verifyChain` recomputes every
   hash from the stored rows, so a chain altered before the backup (or in the restore path) is
   reported with the first broken `chain_seq` and reason. Because the verifier lives in
   `@ledgerforce/ledger` (which depends on `@ledgerforce/db`), the drill and its test live in
   `packages/ledger/src/ops/` and the backup/restore primitives in `packages/db/src/ops/`
   (DL-0882), avoiding a package cycle.
7. **Failure signalling (Q6).** Each failure is a distinct, named error and a non-zero exit:
   `BACKUP_DECRYPT_FAILED` (wrong key, altered header/manifest/chunk, truncation),
   `RESTORE_FAILED` (pg_restore error), `ROW_COUNT_MISMATCH`, `CHAIN_BROKEN` (company, seq,
   reason), `CHAIN_COUNT_MISMATCH`/`CHAIN_HEAD_MISMATCH`. On any failure the drill drops the
   target database it created, so a failed drill leaves no half-restored copy.
8. **Versions (Q7).** "pg_dump cannot dump from PostgreSQL servers newer than its own major
   version; it will refuse to even try" (Source 1). Locally the host has PostgreSQL 16 (server and
   client). CI's service is postgres:17 and the runner's preinstalled client is older, so the CI
   db job installs the PostgreSQL 17 client and server binaries from the PGDG apt repository
   (`apt.postgresql.org.sh`), which the drill uses for `pg_dump`/`pg_restore` and for the fresh
   cluster (`initdb`). The compose backup image installs `postgresql17-client` (Alpine) to match
   the postgres:17.11 service. The tools pick the newest `/usr/lib/postgresql/<v>/bin` (or
   `LF_PG_BINDIR`) and fall back to `PATH`.

## Conclusion

- Self-hosted single VM: nightly **logical** backups (`pg_dump -Fc` under an exported snapshot,
  as the cluster superuser), **envelope-encrypted** through the existing `Kms` with an age-style
  AES-256-GCM STREAM format (ADR-0101), kept with a retention setting, plus a scripted restore
  drill that restores into a fresh database (or a fresh cluster) and proves row counts and every
  company's hash chain.
- PITR (WAL archiving, hosted RPO 15 min) → T-0228. Least-privilege `lf_backup` role → T-0227.
- Every failure mode exits non-zero with a named reason; tested in
  `packages/ledger/src/ops/restore-drill.db.test.ts`.
