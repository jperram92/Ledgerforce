---
adr: 0008
title: "Postgres-backed job queue (pg-boss) and transactional outbox"
status: Accepted
date: 2026-10-24
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0008: Postgres-backed job queue (pg-boss) and transactional outbox

## Status

Accepted — 2026-10-24. Design-committed (§3.9, §7.1); architecture category, no human gate.
This ADR also serves as the dependency ADR for the `pg-boss` runtime dependency.

## Context and problem statement

When the posting engine posts a document it must also trigger side effects: write status back
to Salesforce, email the PDF, update dunning, etc. (§3.9 step 6, §5.4). If the posting commits
but the message is lost (or the message is sent but the posting rolls back), Salesforce and the
GL diverge. The design requires that "outbox and jobs commit atomically with postings" and that
a Salesforce outage never blocks accounting (§5.6). Batch billing (UC-02) and scheduled jobs
(revaluation, reminders, reconciliation) also need a durable queue with retries and backoff
(1 min to 6 h, §5.6). The target deployment is a single VM with Docker Compose (§7.2).

Facts (checked 2026-10-24): `pg-boss` is actively maintained (npm latest 12.38.0, published
2026-10-13), requires PostgreSQL 13 or higher and Node.js ≥ 22.12.0, and uses
`SELECT … FOR UPDATE SKIP LOCKED` for concurrent workers — so it runs on our PostgreSQL 16
(local harness) and 17 (target).

## Decision drivers

- Atomicity: outbox row written in the same transaction as the journal (exactly-once *intent*).
- Fewest moving parts for self-hosters (no extra broker).
- Retries with backoff, scheduling (cron), dead-letter → "Sync issues" inbox.
- RLS-compatible and testable with the same DB harness (ADR-0013).

## Considered options

1. **Redis + BullMQ.**
2. **PostgreSQL-backed queue (pg-boss) + transactional outbox table.**
3. **Managed cloud queue (AWS SQS / SNS) + outbox relay.**
4. **Hand-written queue on a Postgres table.**

### Option 1 — Redis/BullMQ

- Good, because very fast, popular, rich features.
- Bad, because a second stateful service to run, back up and secure on an SMB VM.
- Bad, because Redis writes are not in the Postgres transaction: still needs an outbox relay
  for atomicity; two systems to reason about during recovery.

### Option 2 — pg-boss + outbox

- Good, because jobs and outbox rows can be inserted in the posting transaction — they commit
  or roll back together.
- Good, because backups/PITR of one database cover ledger and queue consistently.
- Good, because built-in retries, backoff, scheduling, dead-letter queues; maintained.
- Bad, because throughput is lower than Redis and the queue adds load to the primary DB
  (fine at SMB volumes; revisit if hosted scale requires).

### Option 3 — SQS

- Good, because fully managed and elastic.
- Bad, because unavailable to self-hosters without AWS; cloud lock-in; still needs an outbox.

### Option 4 — Hand-written queue

- Good, because no dependency.
- Bad, because re-implements locking, retries, scheduling and archiving that pg-boss already
  provides and tests; contradicts "boring technology".

## Decision outcome

Chosen option: **Option 2**.

Rules:

1. The posting engine writes an `outbox_event` row (tenant-scoped, RLS) in the same transaction
   as the journal (§3.9 step 5).
2. A relay in `apps/worker` reads committed outbox events and enqueues/handles pg-boss jobs;
   consumers are idempotent (keyed by event id) — at-least-once delivery, exactly-once effect.
3. Retries with exponential backoff (1 min → 6 h); exhausted jobs land in the Sync issues inbox
   with payload and one-click retry (§5.6).
4. Every job sets the tenant context (`SET LOCAL app.tenant_id`) before touching tenant data.
5. pg-boss tables live in their own schema owned by `lf_migrator`; queue creation runs in
   migrations, not at app start-up under `lf_app`.

## Consequences

### Good

- One database to run, back up and restore; atomic posting + side-effect intent.

### Bad / accepted trade-offs

- DB load from polling/locking; must monitor queue table bloat.
- pg-boss major versions may change schema — pin the major version; upgrades need a DL entry
  and migration test.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Posting rolled back ⇒ no outbox row and no job exists | `packages/ledger/test/outbox-atomicity.spec.ts` (backlog) | §10.8 gate 2 |
| Same outbox event delivered twice ⇒ one Salesforce upsert effect | worker idempotency test | gate 2 |
| Exhausted retries ⇒ item in Sync issues inbox | worker test | gate 2 |
| Job without tenant context cannot read tenant rows | cross-tenant suite | gate 5 |
| Works on PG16 and PG17 | ADR-0013 harness | gate 2 |

## Links

- Design: §3.9, §5.4, §5.6, §7.1, §7.2, UC-02
- Related ADRs: ADR-0002, ADR-0003, ADR-0006, ADR-0013
- External (retrieved 2026-10-24): pg-boss README (PostgreSQL ≥ 13, SKIP LOCKED) —
  https://github.com/timgit/pg-boss ; npm registry `pg-boss` 12.38.0 (engines node ≥ 22.12.0) —
  https://www.npmjs.com/package/pg-boss ; transactional outbox pattern —
  https://microservices.io/patterns/data/transactional-outbox.html
