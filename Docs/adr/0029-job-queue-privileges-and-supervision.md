---
adr: 0029
title: "Job queue (pg-boss) privileges: lf_app DML on the shared pgboss schema, owner-run supervision"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0029: Job queue (pg-boss) privileges: lf_app DML on the shared pgboss schema, owner-run supervision

## Status

Proposed — security category, waiting for product-owner acceptance. It refines ADR-0008
(Postgres job queue and transactional outbox, Accepted) and does not change it. T-0030 is built to
this proposal (migration 0024, DL-0153) so it can be judged on working, tested code. The lead
wrote this record at merge, because DL-0153 changes the database privilege model and AGENTS.md /
design §10.6 put such changes behind a security ADR.

## Context and problem statement

ADR-0008 picks pg-boss for the queue and the transactional outbox for events. Every other
table that lf_app can write is tenant-scoped with forced RLS, and lf_app has no DELETE anywhere
(AGENTS.md §4, packages/db/AGENTS.md). pg-boss does not fit that model:

1. Its tables (`pgboss.job`, `pgboss.queue`, …) are shared by every tenant and have no
   `tenant_id`.
2. To settle failed and retried jobs it DELETEs and re-inserts rows. The SS-PLAT-24 acceptance
   test showed that a worker without DELETE cannot complete a retry.
3. Its construction SQL contains `DROP TABLE` inside a function, so it cannot be a migration
   (the runner refuses DROP). It also versions its own schema.
4. Supervision (expiring jobs held by crashed workers, retention, partition maintenance) runs
   DDL, so it needs the schema owner.

## Decision drivers

- Tenant isolation must not depend on queue rows: a job must never carry tenant data.
- Least privilege for lf_app: no DDL, no TRUNCATE, no TRIGGER.
- At-least-once delivery that survives a worker crash (SS-PLAT-24).
- Keep the migration runner's forward-only policy intact (no exemptions).

## Considered options

1. **lf_app gets DML on pgboss tables; payloads hold ids only; supervision runs as lf_migrator**
   (built).
2. Add RLS to pg-boss tables: rejected for now. They have no tenant column, pg-boss owns their
   shape and an upgrade could drop it, and a tenant-filtered worker would need one worker per
   tenant.
3. A dedicated `lf_queue_owner` role for install and supervision instead of lf_migrator:
   narrower than option 1's supervision credential, but it is a bootstrap change (security ADR
   plus a human gate). It is proposed as a follow-up.
4. A separate database for the queue: loses atomic commit with the posting, which breaks the
   outbox guarantee.

## Decision outcome

Option 1, as built in migration 0024:

- Schema `pgboss` is owned by lf_migrator. lf_app gets USAGE, plus default
  SELECT/INSERT/UPDATE/DELETE on tables and USAGE/SELECT on sequences. lf_app gets no CREATE,
  TRUNCATE or TRIGGER.
- pg-boss installs itself as lf_migrator at deploy (the `install-queue` CLI), right after
  `migrate`; the install refuses any other role.
- Job payloads are `{tenantId, eventId}` only. The handler reads the event under `withTenant`
  (RLS), so a forged tenant id finds nothing.
- Events (`app.outbox_event`) and the inbox (`app.outbox_inbox`) are tenant tables, append-only
  for every role.
- Supervision runs on an owner instance (`startMaintenance`). Runtime lf_app instances run with
  migrate, supervise, schedule and registerInstance switched off.

### Consequences

- Good: atomic event and job commit; crash-safe at-least-once delivery; the runner policy is
  unchanged.
- Bad, accepted only if the product owner agrees:
  - (a) lf_app can read, change or delete any tenant's queued jobs. A deleted job leaves an event
    with no inbox row; a re-send sweep is a follow-up.
  - (b) lf_app can create non-partitioned queues, because `pgboss.create_queue` has EXECUTE
    granted to PUBLIC.
  - (c) Production supervision needs a long-running process with lf_migrator (DDL) credentials,
    until option 3 is done.

## Compliance and verification

- SS-PLAT-24 (crash and redelivery, effect once) and SS-PLAT-68 (atomic event and job;
  ids-only payload).
- SS-PLAT-69 (outbox append-only for every role; pgboss privileges as listed; install refuses
  non-owner roles).
- The cross-tenant suite covers both outbox tables.

## Links

- ADR-0008; DL-0151..0155 (DL-0153 security); RQ-0033; card T-0030; migration 0024.
