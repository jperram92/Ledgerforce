---
id: RQ-0008
title: Integration-test PostgreSQL without Docker — fidelity of local cluster, embedded-postgres, PGlite, pg-mem
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0008 — Test database without Docker

## Question

Testcontainers needs a Docker daemon, which agent sandboxes often lack. Which alternative gives
real fidelity for RLS, roles, triggers and deferred constraints?

## Why it matters

The ledger's safety rests on DB-level invariants (RQ-0007). A test DB that does not implement
them would make green tests meaningless (AGENTS.md directive 3: no shortcuts). DL-0007 already
chose "Testcontainers if Docker, else local initdb/pg_ctl" — this RQ verifies it.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | Experiment: local PostgreSQL 16.15 binaries (`/usr/lib/postgresql/16/bin`), `initdb` + `pg_ctl` throwaway cluster, RQ-0007 script | 2026-10-24 | experiment | Full fidelity (it *is* PostgreSQL); all RQ-0007 tests pass. `initdb` as root → `initdb: error: cannot be run as root`; data dir must be traversable by the cluster's OS user. |
| S2 | `npm view` `@electric-sql/pglite` 0.5.11 (2026-10-21), `pg-mem` 3.0.14 (2026-02-26), `embedded-postgres` 18.4.0-beta.17 (2026-06-05; latest 17.x = 17.10.0-beta.17), `@testcontainers/postgresql` 12.2.1 | 2026-10-24 | primary (registry) | Versions/maintenance. embedded-postgres only publishes `-beta` tags; its newest 17.x lacks 17.11. |
| S3 | Experiment `scripts/fidelity.mjs` (scratchpad) on PGlite 0.5.11 | 2026-10-24 | experiment | Reports `PostgreSQL 18.6 (PGlite 0.5.11) on wasm32`; deferred constraint trigger rejects unbalanced commit ✔; `CREATE ROLE` + `SET ROLE` + FORCE RLS hides other tenant ✔; WITH CHECK rejects cross-tenant insert ✔; non-owner cannot DISABLE TRIGGER ✔. Single connection only. |
| S4 | Same experiment on pg-mem 3.0.14 | 2026-10-24 | experiment | Fails to parse `CREATE ROLE`, `CREATE CONSTRAINT TRIGGER`, `ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `GRANT`; `Unknown language "plpgsql"`. |

## Findings

| Option | RLS/roles | Triggers / deferred | Concurrency (row locks, 2 sessions) | Version match (16/17) | Verdict |
|---|---|---|---|---|---|
| Testcontainers | full | full | full | any | needs Docker |
| Local `initdb`/`pg_ctl` cluster | full | full | full | whatever is installed (16.15 here) | **best without Docker** |
| embedded-postgres (npm binaries) | full | full | full | 17.10 / 18.x, beta-tagged, behind security minors | acceptable fallback when no local binaries |
| PGlite (WASM) | works for basic RLS/roles | works | **single connection** — cannot test gapless counter contention or concurrent posting | 18.6 only | fast unit smoke only |
| pg-mem | not supported | not supported | n/a | n/a | **reject** |

Harness constraints discovered: refuse-root (`initdb`/`postgres` will not run as root → use
`runuser -u postgres` or a dedicated non-root user when the sandbox runs as root); the data and
socket directories must be accessible to that user (session scratch dirs with 0700 parents are
not); use a Unix socket + random port and `-c listen_addresses=''`.

## Conclusion / decision

- Confirm DL-0007: integration tests use **Testcontainers when a Docker daemon is reachable,
  otherwise a throwaway local cluster** from `pg_config --bindir`, same migrations, same tests.
- Harness (`packages/testing/pg-harness`): discover binaries (`PG_BINDIR` → `pg_config` →
  `/usr/lib/postgresql/*/bin`), `mktemp -d` data dir owned by the runtime user, drop privileges
  if running as root, start on a socket dir, create roles `lf_owner`/`lf_migrator`/`lf_app`,
  run migrations as `lf_migrator`, run tests as `lf_app`, stop + remove on exit.
- Assert `server_version_num >= 160015` in the harness; fail loudly below.
- PGlite may be used for fast pure-SQL unit tests of functions only, never as evidence for
  RLS/concurrency acceptance criteria. pg-mem is not used.
- embedded-postgres only as a last resort (dev-only dependency ⇒ decision-log entry).

## Confidence

High — all three in-process options and the local cluster were executed today.

## Follow-ups

- Task: build `pg-harness` with its own tests (start/stop, refuse-root handling, version gate).

**Affects:** test infrastructure, `verify.sh`, CI (GitHub Actions has Docker → Testcontainers),
DL-0007, design §7.1 Testing row.
