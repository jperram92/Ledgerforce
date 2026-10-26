---
id: RQ-0044
title: Sync issues inbox — pg-boss 12 dead-letter semantics, the real backoff schedule, permanent failures, one-click retry, and the API-budget share as data
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0071]
linked_adrs: [ADR-0008, ADR-0029, ADR-0036]
superseded_by:
---

# RQ-0044 — Sync issues inbox: dead letters, backoff, permanent failures, retry, throttle

## Question

Q1. When the outbox queue's retries are exhausted, what exactly does pg-boss 12.37.1 put in the
dead-letter queue (`outbox.deliver.dead`)? Does the dead-letter job carry the error and the
attempt count, or must we record them ourselves?
Q2. How can a **permanent** failure (Salesforce `400`, a refused record type) land in the inbox
at once, instead of spending ten retries over most of a day?
Q3. What is the real retry schedule of `OUTBOX_QUEUE_OPTIONS` (retryLimit 10, retryDelay 60 s,
retryBackoff, retryDelayMax 6 h)? Does it match design §5.6 rule 2 ("1 min to 6 h")?
Q4. How should "one-click retry" re-queue a delivery: `retry()`, `redrive()` or a new job?
Q5. Where does the API-budget share (design §5.6 rule 3, default 25 %) live so that it is data,
not a constant?
Q6. How do db tests move pg-boss time through ten backoffs deterministically and cheaply
(the T-0067 outage test was flaky with `TestClock.tick`, DL-0205)?

## Why it matters

Design §5.6 rules 2–3 and apps/worker AGENTS.md ("terminal failure → sync issue"). If the inbox
reads data pg-boss does not write, failures vanish silently; if permanent failures retry for a
day, users see the problem a day late; if the retry path changes the job contract, the
exactly-once inbox (ADR-0008) breaks.

## Sources consulted

pgboss.io and GitHub were not reachable from this session (WebFetch `ENOTFOUND pgboss.io`,
GitHub API not enabled for the repository); WebSearch returned no pg-boss material. pg-boss is
pinned at 12.37.1 (ADR-0008), so its shipped source is the primary and exact source for the
behaviour we run.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `node_modules/pg-boss/dist/plans.js` 12.37.1, `failJobsBody()` | 2026-10-26 | source code (pinned) | A failed job is deleted and re-inserted as `retry` when `retry_count < retry_limit`, else `failed`. Every re-insert stores the given `output`. For each `failed` job of a queue with `dead_letter`, a new job is inserted into the dead-letter queue with the same `data`, `source_name` = original queue, `source_id` = original id, `source_retry_count` = `retry_count`, **`source_output` = the failed job's output** (the copy's own output starts empty). `forceTerminal` sends a job to `failed` (and so to the dead letter) regardless of remaining retries. |
| S2 | same file, `start_after` expression of `failJobsBody()` | 2026-10-26 | source code (pinned) | With backoff: `start_after = job_now() + LEAST(retry_delay_max, GREATEST(retry_delay,1) * (2^LEAST(16, retry_count+1)/2 + 2^LEAST(16, retry_count+1)/2 * random())) s`. |
| S3 | `node_modules/pg-boss/dist/manager.js` 12.37.1, `#settlePerJob()` | 2026-10-26 | source code (pinned) | A `work()` handler with `perJobResults: true` returns `{ id, status: 'completed' \| 'failed' \| 'deadletter', output }` per job; `deadletter` "fails the job terminally and routes it straight to the queue's configured dead letter queue, bypassing remaining retries"; each job keeps its own `output`. A job without a disposition is failed (and retried). |
| S4 | `node_modules/pg-boss/dist/types.d.ts` 12.37.1, `Job`, `JobWithMetadata`, `JobResult`, `WorkOptions` | 2026-10-26 | source code (pinned) | `retryCount` "goes up by one each time the job is claimed again"; with `includeMetadata` a dead-lettered job exposes `sourceName`, `sourceId`, `sourceRetryCount`, `sourceOutput` ("the `output` of the original job when it failed, usually its error"). `retry(name, id)` and `redrive(name, …)` exist. |
| S5 | same, `plans.js` `retryJobs()` | 2026-10-26 | source code (pinned) | `retry()` only touches jobs in state `failed` and adds **one** attempt (`retry_limit = retry_limit + 1`). |
| S6 | `node_modules/pg-boss/dist/clock.js` 12.37.1, `TestClock.setTime()` vs `tick()` | 2026-10-26 | source code (pinned) | `tick(ms)` fires every due timer in order and settles after each; `setTime(t)` "jumps to a time … firing nothing"; each timer the jump passed fires once on the next tick. |
| S7 | `packages/outbox/src/queue.ts`, `install.ts`; ADR-0008; ADR-0029; RQ-0033 | 2026-10-26 | internal | `OUTBOX_QUEUE_OPTIONS = { retryLimit: 10, retryDelay: 60, retryBackoff: true, retryDelayMax: 21600, deadLetter: 'outbox.deliver.dead' }`; lf_app has DML on pgboss tables; job payload is `{ tenantId, eventId }` only. |
| S8 | `packages/connectors/salesforce/src/writeback/collections.ts`; RQ-0040 S6/S7 and findings 6–8 | 2026-10-26 | internal + vendor (via RQ-0040) | `SalesforceApiError.retryable` is false only for `rejected` and `malformed_response`; the `ApiUsageGate` learns usage from `Sforce-Limit-Info` on every answer and refuses at the share. |

## Findings

1. **Dead letters carry the error (S1, S4).** The dead-letter copy has the original `data`
   (`{ tenantId, eventId }`), `sourceRetryCount` and `sourceOutput` — whatever output the last
   failing attempt stored. So the worker must store a **secret-free failure summary** (handler,
   error name/kind/code/status, short message, retryable) as the job's output on every failed
   attempt; the dead-letter consumer turns it into a Sync issue. Nothing tenant-specific beyond
   the error text goes into pg-boss (the event payload stays in `app.outbox_event`).
2. **Permanent failures skip the retries (S3).** A `perJobResults` worker can answer
   `deadletter` for a job whose error is permanent (`retryable === false`): the job fails
   terminally and its dead-letter copy appears at once, with the same `sourceOutput` path as an
   exhausted job. One inbox path serves both.
3. **The schedule (S2, S4, S7).** The delay after the failure of the attempt with
   `retry_count = c` is between `60·2^c` and `60·2^(c+1)` seconds, capped at 21 600 s:

   | retry | c | min | max |
   |---|---|---|---|
   | 1 | 0 | 60 s | 120 s |
   | 2 | 1 | 2 min | 4 min |
   | 3 | 2 | 4 min | 8 min |
   | 4 | 3 | 8 min | 16 min |
   | 5 | 4 | 16 min | 32 min |
   | 6 | 5 | 32 min | 64 min |
   | 7 | 6 | 64 min | 128 min |
   | 8 | 7 | 128 min | 256 min |
   | 9 | 8 | 256 min | 6 h (cap) |
   | 10 | 9 | 6 h (cap) | 6 h (cap) |

   Eleven attempts in all; the job dead-letters after the 11th fails (`sourceRetryCount` = 10).
   The whole window is 52 260 s (14.5 h) to 73 800 s (20.5 h). That is design §5.6's "1 min to
   6 h". A test can check every observed `startAfter` against these bounds.
4. **Re-queue (S4, S5).** `retry()` gives a single extra attempt and only while the original job
   still exists in state `failed` (retention may remove it). `redrive()` moves dead-letter jobs,
   which our consumer has already completed. A **new delivery job** with the same
   `{ tenantId, eventId }` sent in the caller's transaction (`fromKysely(trx)`, as `enqueue` does)
   gets the full retry policy again and commits atomically with the issue's status change. The
   per-handler inbox (`app.outbox_inbox`) still guarantees exactly-once effects: handlers that
   already succeeded are skipped. *Inference:* the job id can no longer be the event id for a
   re-queue (the original job row may still exist); it does not need to be, because `deliver`
   reads only the job data.
5. **Budget share as data (S8).** The share belongs to the org connection: a
   `salesforce_connection.api_budget_share NUMERIC(5,4)` column, default `0.2500`, CHECK
   `0 < share ≤ 1`, read by the write-back handler and handed to the gate per request. The gate
   compares `used · 10 000 ≥ max · basis points` in integers. A missing gate in the handler means
   no throttle, so the handler builds a default one.
6. **Deterministic time (S6).** Move the clock with `setTime(job.startAfter + 1 s)` — no timer
   fires during the jump; one `tick` afterwards settles each passed timer once. Ten backoffs then
   cost ten jumps, not 20 h of simulated timer firing.

## Conclusion / decision

- The outbox worker settles each job itself (`perJobResults`): `completed`; `failed` with the
  failure summary as output (retryable errors); `deadletter` with the same summary (permanent
  errors, `retryable === false`).
- A dead-letter worker (lf_app, `outbox.deliver.dead`, `includeMetadata`) records one Sync issue
  per (event, handler) from `data` + `sourceOutput` + `sourceRetryCount` in a tenant transaction
  and completes the dead-letter job; a redelivered dead-letter job (same id) changes nothing.
- One-click retry sends a new delivery job in the same transaction that marks the issue
  `retried`; a successful delivery marks the event's `retried` issues `resolved`; a new dead
  letter re-opens the issue with the new error and the summed attempts.
- `api_budget_share` on the connection (default 25 %) drives the throttle.
- Tests jump the TestClock with `setTime` to each job's own `startAfter`.

## Confidence

High: read from the exact pinned source and checked by the db tests of T-0071, which observe the
`startAfter` of every retry, the dead-letter copy and its `sourceOutput`. Re-check when pg-boss is
upgraded (the `source_*` columns appeared in the 12.x series).

## Follow-ups

- When pg-boss is upgraded, re-run `apps/worker/src/sync-issues.db.test.ts` before merging.
- CDC resync requests (T-0064) are worked by the reconcile job, not the outbox; when that job
  exists, its terminal failures should land in the same inbox (new card).

**Affects:** `packages/outbox`, `apps/worker`, `apps/api`, `packages/connectors/salesforce/src/writeback`,
migration 0030.
