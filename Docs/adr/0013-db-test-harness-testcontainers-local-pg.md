---
adr: 0013
title: "Database test harness: Testcontainers with local PostgreSQL fallback"
status: Accepted
date: 2026-10-24
author: claude
category: tooling
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0013: Database test harness — Testcontainers with local PostgreSQL fallback

## Status

Accepted — 2026-10-24 (tooling). Records DL-0007 as an ADR because it constrains every migration
(PostgreSQL 16 and 17 compatibility).

## Context and problem statement

The design's key invariants are enforced *in PostgreSQL* (deferred balance trigger, immutability
triggers, forced RLS, role privileges — ADR-0003, ADR-0004), so they can only be tested against a
real PostgreSQL server. The design names Testcontainers (§7.1), which needs a Docker-compatible
container runtime. Agent sandboxes — including the one Sprint 0 was built in — often have
PostgreSQL binaries (here PostgreSQL 16 at `/usr/lib/postgresql/16/bin`) but **no Docker daemon**.
"No Docker" must not become "no database tests" (directive: solve technology blocks, no
shortcuts). The production target is PostgreSQL 17 (§7.1).

## Decision drivers

- Full fidelity: real roles, RLS, triggers, deferred constraints, `SET LOCAL`.
- Runs in CI (Docker available) and in Docker-less sandboxes, with the same tests.
- Throw-away, isolated databases per test run; no shared state between runs.
- Target version 17; locally available version 16.

## Considered options

1. **Testcontainers only** (`@testcontainers/postgresql`, `postgres:17`).
2. **Testcontainers when Docker is reachable, otherwise a throw-away local cluster via
   `initdb` + `pg_ctl` on a temp dir and free port.**
3. **In-process emulators (pg-mem, PGlite).**
4. **Shared long-lived dev database.**
5. **Skip DB tests when Docker is missing.**

### Option 1 — Testcontainers only
- Good: exact target version, standard tool. Bad: zero DB tests in Docker-less sandboxes.

### Option 2 — Testcontainers + local fallback
- Good: real PostgreSQL in both environments; same migrations and tests.
- Bad: two code paths in the harness; local path runs whatever version is installed (16 here),
  so migrations must stay 16-compatible; harness must clean up temp clusters.

### Option 3 — pg-mem / PGlite
- Good: fast, no external process. Bad: pg-mem does not implement RLS/triggers faithfully;
  PGlite is real Postgres compiled to WASM but single-user/single-connection, so role
  separation (`lf_migrator` vs `lf_app`) and concurrent-locking tests are not representative.

### Option 4 — Shared dev database
- Good: simple. Bad: state leaks between runs and agents; not reproducible.

### Option 5 — Skip without Docker
- Bad: a shortcut forbidden by the product owner; invariants would go untested.

## Decision outcome

Chosen option: **Option 2**.

1. Harness (in `packages/db` / `packages/testing`) detects a reachable Docker daemon → starts
   `postgres:17` via Testcontainers; otherwise locates `initdb`/`pg_ctl` (PATH or
   `/usr/lib/postgresql/*/bin`, highest version), creates a temp cluster on a free port, and
   tears it down after the run.
2. If neither is available the harness **fails loudly** (never skips).
3. Both paths create the `lf_migrator` and `lf_app` roles, run the same forward migrations and
   the same tests.
4. **Migrations must be compatible with PostgreSQL 16 and 17** until an ADR supersedes this
   (avoid 17-only syntax/features such as `JSON_TABLE`, `MERGE … RETURNING`, and 17-only
   `COPY` options). CI runs on 17; local runs on 16.
5. Test output records which backend and server version ran.

## Consequences

### Good
- Database invariants are tested everywhere an agent works.

### Bad / accepted trade-offs
- PG17-only features unavailable until the constraint is lifted.
- Harness complexity (port allocation, cleanup of orphaned clusters).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Harness self-test: starts a server, runs a migration, `SELECT version()` reports 16 or 17, tears down | harness tests in `packages/db` / `packages/testing` | §10.8 gate 2 |
| Harness throws (not skips) when no backend is available | harness unit test with PATH/Docker stubbed | gate 2 |
| CI matrix runs migrations + DB tests on PG17 (Testcontainers); local runs on PG16 | CI config (backlog) + run logs | gates 2, 6 |

## Links

- Design: §7.1 (PostgreSQL 17, Testcontainers), §10.8 gates 2, 5, 6
- Decision log: DL-0007
- Related ADRs: ADR-0003, ADR-0004, ADR-0012, ADR-0014
- External: Testcontainers for Node.js, PostgreSQL module — https://node.testcontainers.org/modules/postgresql/ ;
  PostgreSQL `initdb` / `pg_ctl` — https://www.postgresql.org/docs/16/app-initdb.html ;
  PostgreSQL 17 release notes — https://www.postgresql.org/docs/17/release-17.html
