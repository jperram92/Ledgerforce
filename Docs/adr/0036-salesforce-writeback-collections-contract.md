---
adr: 0036
title: "Salesforce write-back: outbox handler with a versioned writeBack snapshot, mirrors upserted by LF_Id__c, Account/Opportunity updated by Salesforce id"
status: Proposed
date: 2026-10-26
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0036: Salesforce write-back: outbox handler with a versioned writeBack snapshot, mirrors upserted by LF_Id__c, Account/Opportunity updated by Salesforce id

## Status

Proposed — integration category, no human gate. Becomes Accepted on green CI + cross-review by
codex (AGENTS.md §2 step 8). No new third-party runtime dependency.

## Context and problem statement

Design §5.4 writes financial status back to Salesforce from the outbox (invoice.posted,
invoice.paid, invoice.overdue, payment.received, credit_note.posted,
party.credit_hold_changed) as "upserts by external ID (LF_Id__c) through sObject Collections in
batches of up to 200, so retries are idempotent". §5.6 rule 4: an outage never blocks
accounting; rule 3: throttle to a share (default 25 %) of the daily API allocation. ADR-0006
fixes field ownership; ADR-0008 the transactional outbox with per-handler inbox and pg-boss
retries.

Two facts make the design sentence incomplete (RQ-0040):

- The SFDX package (T-0062) has `LF_Id__c` (external ID, unique) only on the mirror objects
  `LF_Invoice__c` and `LF_Payment__c`. Account and Opportunity are Salesforce-owned records that
  LedgerForce never creates; they carry only the LedgerForce-owned fields. An upsert needs an
  external ID field on the object, and an upsert that misses would *create* a record.
- The invoice and payment documents that produce these events do not exist yet (T-0040+), so the
  connector needs a payload contract the producers will satisfy.

## Decision drivers

- Idempotent at the remote end: any retry, redelivery or replay writes the same values once.
- One owner per field, as data; never write a Salesforce-owned field (ADR-0006).
- Accounting never waits for Salesforce; the queue survives an outage (design §5.6).
- Contract-tested offline against the documented API shapes (CI never calls Salesforce).

## Considered options

1. **Outbox handler; versioned `writeBack` snapshot in the event payload; mirrors upserted by
   `LF_Id__c`; Account/Opportunity updated by their Salesforce id; ≤ 200 per request.**
2. **Add `LF_Id__c` external IDs to Account and Opportunity** and upsert everything.
3. **A write-back staging table** (migration) that coalesces events across deliveries into
   larger batches, flushed by a separate job.
4. **Delta events** ("balance reduced by 1,375.00") applied in Salesforce.

### Option 1

- Good, because it uses the documented sObject Collections upsert and update (RQ-0040 F1, F2);
  both are idempotent with absolute values; an update of a missing Id fails instead of creating.
- Good, because the outbox already gives durability, retry with backoff and dead-lettering;
  no new table.
- Bad, because batching happens per delivery: many small events mean many small requests
  (a bulk event — e.g. a batch billing run — still packs 200 per request).

### Option 2

- Good, because one code path (upsert) for every object.
- Bad, because it adds fields on Salesforce-owned objects, needs a backfill of the external IDs
  from LedgerForce, and a miss creates stray Accounts/Opportunities.

### Option 3

- Good, because it minimises API calls under heavy load.
- Bad, because it adds a table, a flush scheduler and a second retry mechanism; not needed for
  MVP volumes (premature).

### Option 4

- Bad, because deltas are not idempotent: a redelivery would subtract twice.

## Decision outcome

Chosen option: **Option 1**, because it meets every driver with the existing outbox and no
schema change; Option 3 stays available if API usage demands it.

Rules:

1. An event that should reach Salesforce carries `payload.writeBack = { version: 1, invoices?,
   payments?, accounts?, opportunities? }`, arrays of **current-state snapshots** (never deltas).
   Unknown sections, keys or statuses, non-decimal money and money with non-zero digits beyond
   the cent are contract errors (TypeError). Events without `writeBack` are a no-op.
2. `FIELD_MAP` (`packages/connectors/salesforce/src/writeback/mapping.ts`) is the only list of
   LedgerForce-owned Salesforce fields; statuses map through `INVOICE_STATUS_LABELS` and
   `CREDIT_STATUS_LABELS`. A contract test pins every mapped field to the package metadata and
   the Account/Opportunity set to the read-only list in `salesforce/AGENTS.md`.
3. `LF_Invoice__c` and `LF_Payment__c` are upserted by `LF_Id__c` (one type per request, the
   invoice before the payment, whose lookup is set by the invoice's external ID). Account and
   Opportunity are updated by Salesforce id. Every request: `allOrNone: false`, ≤ 200 records,
   each key once (merged, later fields win), money as exact two-decimal JSON numbers, API 67.0.
4. The handler `salesforce.writeback` (never renamed) runs inside `deliver`'s tenant
   transaction. Any request-level error (`SalesforceApiError`) or any per-record failure
   (`WriteBackRecordError`) throws: the inbox row rolls back and pg-boss retries with the queue
   backoff (1 min → 6 h, then dead letter). A `401` invalidates the cached token and re-signs
   once. `Retry-After` is parsed and reported; the queue backoff decides when the retry runs.
5. `ApiUsageGate` refuses to send (retryable `throttled`) while the last `Sforce-Limit-Info`
   reading of the org, younger than five minutes, is at or above the share (default 25 %).
6. A company with no active Salesforce connection has nothing to write back (no-op).

## Consequences

### Good

- Outage, throttling and session expiry are all "stay queued, retry later"; postings commit
  independently (SS-UC01-09).
- Field ownership and status words are data, testable against the package metadata.

### Bad / accepted trade-offs

- The HTTP calls run while the delivery's transaction is open and the connection row is locked
  (`getAccessToken` FOR UPDATE): write-backs of one company are serialised. Accepted for MVP
  volumes; it also keeps concurrent long-running calls low (RQ-0040 S5).
- Out-of-order deliveries of two snapshots for the same record could leave the older one in
  Salesforce until the next event or the nightly reconciliation; pg-boss does not guarantee
  order across jobs.
- With 10 retries the backoff ends after about 14.5 hours; a longer outage dead-letters the
  write-back. Design §5.6 rule 2 sends it to the Sync issues inbox (one-click retry), which is
  not built yet.

### Follow-ups

- Sync issues inbox reading `outbox.deliver.dead` (design §5.6 rule 2).
- Conflict logging when a user edited a LedgerForce-owned field in Salesforce (design §5.5):
  needs the inbound CDC side to compare values.
- Producers (T-0040+ invoices, T-0074 payments, T-0068 reminders, T-0055 refunds) emit the
  `writeBack` contract; SS-UC01-02 (scratch-org e2e) and SS-UC11-05/SS-UC12-05 are proven there.
- Record real responses in a scratch org (RQ-0040 follow-up).

## Compliance and verification

| Rule | Enforced by |
|---|---|
| 1, 2 | `writeback.payload.contract.test.ts` (SS-PLAT-83: payload strictness, field map vs package metadata and `salesforce/AGENTS.md`) |
| 3 | `writeback.payload.contract.test.ts` (SS-UC03-04, SS-UC04-02, SS-PLAT-83 batching and dedupe) against the documented fake |
| 4 | `apps/worker/src/salesforce-writeback.outage.db.test.ts` (SS-UC01-09: 503 keeps it queued, recovery with one upsert, redelivery skipped, 401 re-sign) and SS-PLAT-84 classification tests |
| 5 | SS-PLAT-84 gate test |
| 6 | SS-UC01-09 "company without a Salesforce connection" test |
