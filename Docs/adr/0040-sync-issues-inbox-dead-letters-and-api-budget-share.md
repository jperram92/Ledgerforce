---
adr: 0040
title: "Sync issues inbox: dead letters become tenant issues, failure log outside pg-boss, one-click retry as a new delivery job, API budget share as connection data"
status: Proposed
date: 2026-10-26
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0040: Sync issues inbox, dead letters, one-click retry and the API budget share

## Status

Proposed — classed `security` because it adds tenant-owned tables (RLS), two permissions to the
role catalogue (ADR-0023) and a public API resource. Human gate: the product owner accepts with
label `adr:security`. Work proceeds on the design-committed option (design §5.6 rules 2–3). No
new third-party runtime dependency (pg-boss is ADR-0008's; `apps/api` now uses it too).

## Context and problem statement

Design §5.6 rule 2: "Failures retry with exponential backoff (1 min to 6 h), then land in a
**Sync issues** inbox with the error, payload and a one-click retry." Rule 3: "The worker …
throttles itself to stay under a configurable share (default 25 %) of the daily API allocation."
T-0030 gave the outbox queue its retry policy and a dead-letter queue that nobody read; T-0067
classified Salesforce errors (retryable or not) and throttled with an in-memory 25 % gate that
was off unless a gate was injected. pg-boss tables have no RLS, so tenant data must not be
copied into jobs (ADR-0008, packages/outbox AGENTS.md).

## Decision drivers

- Failures must never vanish: every exhausted or permanent delivery becomes a visible issue.
- Tenant isolation: issue data under RLS; nothing tenant-specific in pg-boss.
- Exactly-once effects must survive retries (per-handler inbox, ADR-0008).
- A permanent error should not wait a day of retries to become visible.
- Configurable throttle share, exact comparison, no floats.
- Deterministic tests (pg-boss TestClock, no sleeps).

## Considered options

1. **Dead-letter consumer + failure log (chosen).** The outbox worker settles each job itself
   (pg-boss `perJobResults`): `completed`, `failed` (retryable) or `deadletter` (permanent,
   `retryable === false`). Each failed attempt is logged in `app.outbox_delivery_failure` (tenant
   table) and the job output is only `{ handler, failureId }`. A dead-letter worker turns each
   dead letter (`sourceOutput`, `sourceRetryCount`) into one `app.sync_issue` per (event, handler).
2. **Worker decides "last attempt" itself** from `retryCount == retryLimit` and writes the issue
   directly. Rejected: misses jobs that expire with a crashed worker, and duplicates pg-boss's
   own retry bookkeeping.
3. **Error text in the pg-boss output** (the default `work()` behaviour). Rejected: Salesforce
   messages can name records and values; pg-boss tables have no RLS.
4. **Retry with `boss.retry()`** on the original failed job. Rejected: one extra attempt only,
   and the job may already be gone through retention (RQ-0044 finding 4). **Chosen:** a new
   delivery job `{ tenantId, eventId }` sent in the request transaction (`fromKysely`), full retry
   policy, committed with the status change; the per-handler inbox keeps effects exactly-once.
5. **Throttle share as an environment setting.** Rejected: one value for all tenants. **Chosen:**
   `salesforce_connection.api_budget_share NUMERIC(5,4)` default 0.2500, CHECK (0, 1].

## Decision outcome

Option 1 with the chosen retry and share.

- Status model (`open → retried → resolved | open`, `open → ignored → retried`; a new dead letter
  re-opens from any status) enforced by a trigger for every role; lf_app may update only the
  mutable columns; nothing is deleted. The failure log is append-only.
- `deliver` resolves the event's `retried` issues once every handler has succeeded.
- API: `GET /sync-issues` (status filter, keyset `after`, `limit` ≤ 200, newest failure first),
  `GET /sync-issues/:id` (adds the event payload), `POST /sync-issues/:id/retry`,
  `POST /sync-issues/:id/ignore` (`{ note? }`). Both actions are naturally idempotent and audited
  by the interceptor. Retry answers 503 `queue_not_configured` without a queue.
- Permissions: `sync.issues.read` (read; the Auditor holds it through all reads) and
  `sync.issues.manage` (write: Owner, Finance Admin, Accountant). Mirrored in
  `app.permission_known`; allowed as API-token scopes.
- The write-back handler always throttles (a default gate per handler) and passes the
  connection's share; the gate compares `used · 10 000 ≥ max · basis points`.

## Consequences

- Positive: §5.6 rules 2–3 are met with one inbox path for exhausted and permanent failures;
  the inbox is tenant data under RLS; retries cannot double-apply effects.
- Negative: the job id of a re-queued delivery is no longer the event id (only the first job's
  is). `deliver` runs one extra statement per delivery (resolve retried issues).
- Follow-ups: a Sync issues screen in apps/web (deferred, no UI this round); a settings route
  for `api_budget_share`; CDC resync failures (T-0064) and other connectors' terminal failures
  into the same inbox when their workers exist; register the Salesforce handler in the worker's
  production registry once the worker has KMS configuration.

## Compliance and verification

- `apps/worker/src/sync-issues.db.test.ts` (SS-PLAT-25, SS-PLAT-91, SS-PLAT-92),
  `apps/api/src/sync/sync-issues.db.test.ts`, `packages/outbox/src/backoff.test.ts`,
  `packages/outbox/src/sync-issues.test.ts`,
  `packages/connectors/salesforce/src/writeback/budget.test.ts`, the cross-tenant suite
  (`packages/db/src/rls.db.test.ts`) and the RBAC matrix test.
- Sources: RQ-0044 (pg-boss 12.37.1 source), RQ-0040, RQ-0033.
