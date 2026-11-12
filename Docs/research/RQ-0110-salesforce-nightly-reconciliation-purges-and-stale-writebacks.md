---
id: RQ-0110
title: Nightly reconciliation — Recycle-Bin purge detection with getDeleted, and which write-backs are "stale"
status: resolved
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0070]
linked_adrs: [ADR-0006, ADR-0008, ADR-0036]
superseded_by:
---

# RQ-0110 — Nightly reconciliation: purges and stale write-backs

## Question

Q1. The inbound replay (`reconcileInbound`, T-0066, RQ-0103) reads `queryAll` from the watermark, so
it sees soft deletes while they are in the Recycle Bin. A record deleted *and purged* (bin emptied,
hard delete, 15-day expiry) while the connector was away never appears. How does the nightly job
detect such records, at what API cost, and with which Salesforce timestamp?

Q2. What is a "stale write-back" that the nightly job must re-push (SS-PLAT-26), given the outbox
model (ADR-0008: append-only event + per-handler inbox row) and the write-back contract v1
(DL-0191: each event carries *current state*, absent key = not written)?

## Why it matters

A purged Account that stays `active` in LedgerForce keeps receiving invoices; a write-back that was
dead-lettered during a 3-day outage leaves Salesforce users looking at a wrong invoice status
until the next unrelated event. Re-pushing the *wrong* snapshot (an older event after a newer one)
would roll Salesforce back — worse than not re-pushing.

## Sources consulted

`developer.salesforce.com` cannot be fetched from this sandbox (DNS-blocked, as for RQ-0103);
pages were read through WebSearch result extracts.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_getdeleted.htm (196.0, 258.0, 264.0) | 2026-11-02 | primary | `GET /services/data/vXX.X/sobjects/{sObject}/deleted/?start=…&end=…` (API ≥ 29.0); start must precede end; UTC; seconds ignored; ≤ 15 days before the call, less if the Recycle Bin was purged; only records the session user can see; 600,000-id cap (`EXCEEDED_ID_LIMIT`). Response: `deletedRecords` [{`id`, `deletedDate`}], `earliestDateAvailable` = timestamp of the last physically deleted object, `latestDateCovered` = last date covered by the request. |
| S2 | https://developer.salesforce.com/docs/atlas.en-us.224.0.api_rest.meta/api_rest/dome_get_deleted.htm | 2026-11-02 | primary | Worked example of the same resource (GET with `start`/`end`, bearer token); the delete log is purged by a background process (records in the log > 2 h when above a size limit), hence the window may be shorter than 15 days. |
| S3 | RQ-0103 findings 2, 4, 5, 7 and S4/S6 | 2026-11-02 | internal | queryAll returns soft-deleted rows while in the bin; a purged record is invisible to queryAll and getDeleted after the purge — only a full id comparison catches it; watermarks use Salesforce's clock; snapshot key and convergence. |
| S4 | ADR-0008, `packages/outbox/src/deliver.ts`, migration 0024, migration 0030 | 2026-11-02 | internal | One inbox row per (event, handler) commits with the effect; a redelivery finds it and skips; Sync issue status model open → retried → resolved. |
| S5 | DL-0191, `writeback/mapping.ts` (contract v1), design §5.4–§5.6 | 2026-11-02 | internal | Write-back events carry current state, values absolute; absent key = not written; upsert by `LF_Id__c`/update by Salesforce id is idempotent; failures back off 1 min → 6 h then dead-letter. |

## Findings

1. **Delete log window (S1, S2).** getDeleted answers for a window of at most 15 days back, and
   only reliably from `earliestDateAvailable` on: deletes before that timestamp may already have
   been physically removed from the log. So for a window `[start, end]`:
   - every `deletedRecords` entry is a delete Salesforce knows about, purged from the bin or not;
   - if `earliestDateAvailable > start` (or `start` is older than 15 days), deletes in
     `[start, earliestDateAvailable)` may be lost and a **full id comparison** is required.
2. **Full id comparison (S3).** `queryAll` of `SELECT Id, SystemModstamp, IsDeleted FROM <Object>
   WHERE SystemModstamp >= 1970-01-01T00:00:00Z ORDER BY SystemModstamp, Id` returns every record
   that still exists (live or in the bin) — the same query shape as the delta poll, so no new
   query form. Cost: ⌈records / 2,000⌉ calls per object, paid only when the delete log has a gap.
   A record LedgerForce holds as live whose Id is in neither result was purged.
3. **Timestamp of a detected purge.** A purge needs an idempotency key and a convergence timestamp
   on Salesforce's clock (RQ-0103 finding 5). Use `deletedDate` when getDeleted lists the record;
   otherwise `latestDateCovered` of the same getDeleted call (Salesforce's clock, at or after the
   purge). The change enters `applyInboundChange` as a snapshot DELETE (`polledChange` with
   `IsDeleted = true`), so a re-run is a logged duplicate and a later CDC change still wins.
4. **"Live in LedgerForce" (S3).** The processed-change log (`app.salesforce_inbound_change`,
   migration 0050) already holds, per entity and record Id, the last applied change type: live =
   last applied change is not a DELETE. This is entity-agnostic (Account, Contact, Product2 and
   the billing sources) and never reads LedgerForce-owned data.
5. **Stale write-back (S4, S5).** Per Salesforce record and LedgerForce-owned field, the value
   Salesforce *should* hold is the one in the newest write-back event (outbox order: `created_at`,
   then id — uuid v7) that names the field. Salesforce holds it only if that event's
   `salesforce.writeback` inbox row exists **and** no older event naming the same field was
   delivered after it (inbox `processed_at` later — a backed-off retry of an older event overwrites
   a newer value). A field is stale otherwise; a record is stale if any of its fields is.
   - Re-pushing per *event* would be wrong: an old undelivered event after a newer delivered one
     rolls Salesforce back. Re-push per *record*, with the merged newest value of every field.
   - Events younger than a grace period (default 1 h) are left to the outbox (still retrying).
   - Candidates are cheap to find: undelivered write-back events, plus events delivered since the
     last run (out-of-order deliveries). The merge window starts at the oldest candidate: older
     delivered events cannot hold a newer value than a candidate.
6. **Marking.** After Salesforce accepts every record of an event, the reconciliation inserts that
   event's `salesforce.writeback` inbox row (ON CONFLICT DO NOTHING). A later pg-boss retry or
   one-click retry of the old event then skips (no rollback of Salesforce) and `deliver`
   resolves its retried Sync issue. An `open` issue cannot go to `resolved` (migration 0030) and is
   left for the user: retrying it is now a no-op that resolves it.
7. **Out of scope here.** Drift of a LedgerForce-owned field *edited by a user in Salesforce*
   (design §5.5 "next write-back overwrites it and logs a conflict") needs a read of the mirror
   fields and the full current write-back state per record; recorded as a follow-up (DL-0293).

## Conclusion / decision

Nightly job per company = inbound replay (`reconcileInbound`) → purge detection per mapped object
(getDeleted since the object's `deletes_checked_until`, full id comparison when the log has a gap
or no previous check) → re-push of stale write-backs per record (finding 5) with inbox marking
(finding 6). Schedule and run log are data (migration 0053), driven by `next_run_at` because
lf_app's pg-boss never schedules (DL-0298).

## Confidence

High for S1 response fields and the 15-day/`earliestDateAvailable` semantics (consistent across
versions). Medium for the exact meaning of "last physically deleted" — the design takes the
conservative reading (any `earliestDateAvailable` after the window start forces a full compare).

## Follow-ups

- Scratch-org recording of a getDeleted answer into `fixtures/recorded/` (with T-0110).
- Drift detection of LedgerForce-owned fields edited in Salesforce (finding 7).

**Affects:** `packages/connectors/salesforce/src/reconcile/`, `src/testing/fake-salesforce-query.ts`,
migration 0053, design §5.3.
