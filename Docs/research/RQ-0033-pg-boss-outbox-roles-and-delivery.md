---
id: RQ-0033
title: Which pg-boss version, API and role model give an atomic outbox with at-least-once, exactly-once-effect delivery under lf_app/lf_migrator and RLS?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0030]
linked_adrs: [ADR-0008]
superseded_by:
---

# RQ-0033 — pg-boss, the transactional outbox and the role model

## Question

T-0030 / SS-PLAT-24: the posting engine must write an outbox event in the posting transaction,
and a worker must deliver it at least once (redelivered after a crash), with handlers whose
effect happens once.

- Q1. Which pg-boss version (Node 22, PostgreSQL 16/17), and does it fit the 14-day dependency
  rule (DL-0061)? What does it pull in?
- Q2. Can a pg-boss job be inserted in the *caller's* (Kysely) transaction, so the job commits or
  rolls back with the journal?
- Q3. Where do pg-boss's tables live, who owns them, and can its schema be created by our
  forward-only plain-SQL migration runner?
- Q4. What does `lf_app` (no DDL, RLS) need to send, fetch and complete jobs? What needs the owner?
- Q5. How is a job redelivered after a worker crashes, and how can a test drive that without
  sleeping (apps/worker AGENTS.md)?
- Q6. How does a relay/worker find events under RLS, since `lf_app` sees one tenant at a time?

## Why it matters

Design §3.9 step 5–6 ("outbox and jobs commit atomically with postings"), §5.6 (retries, Sync
issues), §7.1; ADR-0008 rules 1–5. A wrong answer either loses events (journal committed, no job),
sends phantom events (job committed, journal rolled back), runs the queue with excessive privileges,
or produces duplicate downstream effects.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `npm view pg-boss time` / `npm view <pkg> time` (scratchpad `t0030/probe/dates.mjs`) | 2026-10-25 | registry | pg-boss 12.38.0 published 2026-10-13 (11 days), 12.37.1 2026-10-08 (16 days). Dependencies of 12.37.1 and their ages: cron-parser 5.10.2 (15 d), luxon 3.7.2 (414 d), rrule-temporal 2.2.8 (23 d), temporal-spec 1.0.1 (89 d), serialize-error 13.0.2 (26 d), non-error 0.1.0 (371 d), type-fest 5.10.0 (37 d), tagged-tag 1.0.0 (530 d), pg 8.23.1 (already in the lockfile); peer `@opentelemetry/api` 1.9.1 (213 d). |
| S2 | `pg-boss@12.37.1` package (`npm pack`): `package.json`, `dist/index.d.ts`, `dist/types.d.ts`, `dist/adapters/kysely.js`, `dist/boss.js`, `dist/clock.js`, `dist/plans.js` | 2026-10-25 | source code | `engines.node >=22.12.0`; schema version 45; `send(name, data, { id, db })` where `db: IDatabase { executeSql(text, values) }`; `fromKysely(trx)` runs pg-boss SQL through `trx.executeQuery`; constructor options `migrate`, `createSchema`, `supervise`, `schedule`, `registerInstance`, `options` (passed to `pg`), `clock`; `supervise(name)` is public; `TestClock` with `tick(ms)` and `attach()`; `@opentelemetry/api` is imported statically by `dist/telemetry.js` (a required peer). |
| S3 | `getConstructionPlans('pgboss')` output (scratchpad `t0030/probe/construct.sql`) | 2026-10-25 | generated SQL | Creates schema `pgboss`, enum `job_state`, tables (`version`, `queue`, `schedule`, `subscription`, `bam`, `job` partitioned + `job_common`, `warning`, `queue_stats` partitioned, `job_dependency`, `instance`) and functions; `pgboss.delete_queue` contains `EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', …)`. |
| S4 | `dist/boss.js` `#supervisePass` | 2026-10-25 | source code | Supervise = expire active jobs past `expireInSeconds` (`failJobsByTimeout`) + heartbeat failures + retention deletes + queue-stats partitions (`CREATE TABLE … PARTITION OF`, old partitions dropped) + `REINDEX` of bloated indexes, i.e. DDL. |
| S5 | ADR-0008 (Accepted), `packages/db/src/migrate.ts`, `packages/db/AGENTS.md`, `packages/db/migrations/0002_tenancy.sql` | 2026-10-25 | repo | ADR-0008 is the dependency ADR for pg-boss; rule 5: pg-boss tables in their own schema owned by `lf_migrator`, queue creation not at app start-up under `lf_app`. The runner rejects any DROP, also inside function bodies and DO blocks. `app.tenant` policy `tenant_self`: `lf_app` sees only the tenant in `app.tenant_id`. |
| S6 | Experiment: temporary `packages/outbox/src/probe.db.test.ts` (not committed) on the repo's local PostgreSQL 16 harness | 2026-10-25 | experiment | E1–E5 below. |

S6 results (run output, abridged):

- **E1 install.** As `lf_migrator`: `CREATE SCHEMA pgboss AUTHORIZATION lf_migrator`, `GRANT USAGE`
  to `lf_app`, `ALTER DEFAULT PRIVILEGES FOR ROLE lf_migrator IN SCHEMA pgboss GRANT SELECT,
  INSERT, UPDATE ON TABLES TO lf_app`; then `new PgBoss({ connectionString: <lf_migrator>, schema:
  'pgboss', supervise: false, schedule: false }).start()` installs schema 45 into the existing
  schema and `createQueue()` works.
- **E2 runtime.** `new PgBoss({ <lf_app>, migrate: false, supervise: false, schedule: false })`:
  `send`, `fetch`, `complete` all succeed with SELECT/INSERT/UPDATE only. **Correction found while
  building the acceptance test:** `fail()` (a handler error) reports `permission denied for table
  job_common` without DELETE, because pg-boss settles failed and retried jobs by deleting and
  re-inserting queue rows. lf_app therefore needs DELETE on the pgboss tables. With the default
  `registerInstance: true` the instance emits `permission denied for table instance` (the registry
  prunes rows), so runtime instances set `registerInstance: false`.
- **E3 transaction.** `send(Q, data, { id, db: fromKysely(trx) })` inside a Kysely transaction that
  then throws leaves no job (`getJobById` → null). Committed, it returns the given id; a second
  `send` with the same `id` returns `null` (no duplicate job).
- **E4 crash.** `fetch` (job → active), no `complete` ("crash"), `TestClock.tick(61 s)` with
  `expireInSeconds: 60`, `owner.supervise(Q)` → state `retry`, `retryCount` 0 → next `fetch`
  returns the **same id** with `retryCount` 1. (The probe queue had `retryDelay` 0. With the outbox
  queue's backoff, an expired job is a failed attempt and becomes due only after the first backoff
  step of 60–120 s. The acceptance test moves the TestClock past it.) Completing the stale first attempt
  (`complete(Q, { id, retryCount: 0 })`) reports `affected: 0` (attempt fence).
- **E5.** As `lf_app`, `createQueue('nope')` succeeds (non-partitioned queues are rows in
  `pgboss.queue` written by the `create_queue` function as invoker); `supervise()` resolves but
  emits `permission denied for table instance` from its registry maintenance, and its partition
  and reindex steps are DDL the role cannot run. `lf_app` has no CREATE on the schema, so it cannot run DDL.
- **Clock note.** A `TestClock` is attached by the owner instance (`attach()` replaces
  `pgboss.job_now()` — DDL). Sessions read fake time only if they set `pgboss.test_clock = on`;
  `lf_app` connections opt in with the `pg` startup option `-c pgboss.test_clock=on`. A connection
  that does not opt in stamps jobs with real time (seen in E3: a job sent through a non-opted pool
  was not yet due on fake time). Test-only; production never attaches a TestClock.

## Findings

1. **Q1** — Pin `pg-boss` **12.37.1** exactly (12.38.0 is 11 days old; DL-0061 needs 14). Every
   package it adds is ≥ 15 days old. Its `@opentelemetry/api` peer is a hard import, so it is
   pinned explicitly (1.9.1) rather than left to pnpm's auto-install. Node ≥ 22.12 and PostgreSQL
   ≥ 13 (ADR-0008) are met by Node 22.18+ and PostgreSQL 16/17.
2. **Q2** — Yes: `send(…, { id, db: fromKysely(trx) })` makes the job part of the caller's
   transaction (E3), including the posting engine's `SAVEPOINT lf_posting`. Using the outbox event
   id as the job id makes a repeated send a no-op.
3. **Q3** — pg-boss's construction SQL cannot be a plain migration: `pgboss.delete_queue` contains
   `DROP TABLE` (S3), which the runner rightly rejects, and the SQL is tied to one schema version.
   So migration 0024 creates the **schema** (owned by `lf_migrator`) with grants and default
   privileges, and pg-boss's own installer runs **as `lf_migrator`** right after `migrate` (a
   deploy step, `apps/worker` `install-queue`), creating its tables inside that schema and the
   outbox queues. This keeps ADR-0008 rule 5 (owned by `lf_migrator`, not created under `lf_app`).
4. **Q4** — `lf_app` needs `USAGE` on the schema and SELECT/INSERT/UPDATE/DELETE on its tables.
   It needs no TRUNCATE, TRIGGER or CREATE. DELETE is needed because failed and retried jobs are
   moved by delete and re-insert. The rows are queue state, not tenant records; the outbox event,
   which is the record, stays append-only. Supervision (expiry, retention, stats partitions, reindex)
   is DDL and must run as the owner (S4, E5).
5. **Q5** — Crash recovery is expiry: an `active` job older than `expireInSeconds` is moved to
   `retry` by `supervise()` and redelivered with the same id (E4). Tests drive this with
   `TestClock.tick` plus an explicit `owner.supervise(queue)` — no sleeps.
6. **Q6** — No relay scan is needed: the job is inserted in the same transaction as the outbox
   row, so a committed event always has a job, and nothing has to look across tenants. The job
   payload carries only `{ tenantId, eventId }`; the worker opens `withTenant(tenantId)` and reads
   the event under RLS.

## Conclusion / decision

- `pg-boss` 12.37.1 + `@opentelemetry/api` 1.9.1, exact pins (ADR-0008 is the dependency ADR; no
  new ADR) — DL-0151.
- Outbox = tenant-scoped `app.outbox_event` (RLS) + a pg-boss job with `id = event id`, both
  written in the caller's transaction; delivery = pg-boss `work`/`fetch` → per-handler
  `app.outbox_inbox` row inserted in the **same tenant transaction** as the handler's effect, so a
  redelivery finds the inbox row and skips the effect — DL-0152.
- Role split: schema `pgboss` owned by `lf_migrator`; `lf_app` DML only; install and supervision as
  `lf_migrator` — DL-0153.

**Security implications** (recorded in DL-0153 and raised to the product owner):

- The pg-boss tables have no RLS, and `lf_app` can read, change and delete every tenant's jobs. Mitigation: job payloads
  hold only the tenant id and the event id; the event itself is read under RLS, and the
  consumer cannot be pointed at another tenant's event (a forged tenant id finds nothing). A
  deleted or lost job leaves the append-only event with no inbox row, so it can be detected and
  re-sent; that sweep is a follow-up.
- `lf_app` can create non-partitioned queues through `pgboss.create_queue` (EXECUTE is granted to
  PUBLIC by default). It cannot run DDL. Revoking EXECUTE was not attempted, because the runtime
  statements call other pgboss functions.
- Supervision needs a long-running process holding `lf_migrator` credentials, which is the DDL
  owner. That process never sets a tenant context (FORCE RLS still applies to it). A dedicated
  owner role, for example `lf_queue`, would narrow this, but it needs a bootstrap change, which is
  a security ADR and a human gate. It is listed as an open question, not built.

## Confidence

High for Q1–Q5: each is from the shipped source plus a run on PostgreSQL 16. PostgreSQL 17 is not
run locally (the harness has 16; DL-0007). Nothing used is 17-specific.

## Follow-ups

- Dead-letter queue → Sync issues inbox UI with one-click retry (design §5.6): new card.
- Production supervision schedule (maintenance process or cron) and its credentials: open
  question for the human (dedicated owner role).
- Wire `ledgerOutbox(boss)` into the API composition root once a posting endpoint exists.
