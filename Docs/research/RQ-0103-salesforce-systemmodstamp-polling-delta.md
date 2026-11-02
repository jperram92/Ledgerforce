---
id: RQ-0103
title: Salesforce polling fallback — SystemModstamp delta queries, queryAll for deletes, getUpdated/getDeleted, paging, API cost, overlap window and clock skew
status: resolved
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0066, T-0070]
linked_adrs: [ADR-0006, ADR-0032]
superseded_by:
---

# RQ-0103 — Polling fallback (SystemModstamp delta) per object

## Question

Q1. Which field marks "changed since" reliably and cheaply: `SystemModstamp` or `LastModifiedDate`?
Q2. How does a delta poll see deletes and undeletes: `query` vs `queryAll` vs the `getDeleted`
REST resource, and for how long?
Q3. How are large deltas paged, and what does one poll cost in API calls?
Q4. Can a change committed *after* a poll carry a `SystemModstamp` *before* the poll's watermark
(long-running transactions), and how wide must the overlap window be? Whose clock decides?
Q5. How do polled records (current state, no commit number) map onto the inbound idempotency key
of T-0065 (`company, entity, record Id, commit number, sequence number`, migration 0050), and how do
polling and CDC converge?

## Why it matters

Design §5.3: CDC entity selection and the 24-hour delivery allocation are capped, so some objects
must be read by polling; the nightly reconciliation (T-0070) uses the same delta query to replay
what CDC missed (SS-PLAT-26). A wrong change marker, a missed delete or a watermark that skips a
late commit silently loses data; a key that differs from CDC's applies the same change twice.

## Sources consulted

`developer.salesforce.com` pages were read through WebSearch result extracts (direct fetch is
DNS-blocked in this sandbox, as for RQ-0036 and RQ-0101).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/blogs/engineering/2014/11/force-com-soql-performance-tips-systemmodstamp-vs-lastmodifieddate-2 | 2026-11-02 | vendor engineering blog | `SystemModstamp` is indexed, `LastModifiedDate` is not; `LastModifiedDate <= SystemModstamp` always holds; filter on `SystemModstamp` for range queries. |
| S2 | https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/api/system_fields.htm | 2026-11-02 | primary | `SystemModstamp` is updated by users and automated system processes; it does not change when a parent value pulled in through a lookup/formula changes. |
| S3 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_queryall.htm (262.0, 264.0) | 2026-11-02 | primary | `queryAll` returns records deleted by delete or merge (with `IsDeleted = true`); `query` filters them out. `nextRecordsUrl` continuations of a queryAll keep returning deleted matches. |
| S4 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_getdeleted.htm | 2026-11-02 | primary | Get Deleted: deleted ids for a window, no more than 15 days back, shorter if the Recycle Bin was purged; `earliestDateAvailable` = last physically deleted; delete log purged every 2 h above a limit; 600,000 id cap; seconds ignored. |
| S5 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_getupdated.htm | 2026-11-02 | primary | Get Updated uses `SystemModstamp` (fallback `LastModifiedDate`); ≤ 30 days back; 600,000 id cap; seconds ignored; returns ids only (a second call per record set is needed for values). |
| S6 | https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_getupdated_getupdatedresult.htm | 2026-11-02 | primary | `latestDateCovered` ≤ end; while a long-running transaction is open it is pinned to that transaction's **start**; "for safety" use it as the next start to capture changes that started before but completed after the end date. |
| S7 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/headers_queryoptions.htm and resources_query.htm | 2026-11-02 | primary | Query results come in batches: default and max 2,000 records, min 200 (`Sforce-Query-Options: batchSize=`), not guaranteed; `done: false` + `nextRecordsUrl` for the next batch. |
| S8 | RQ-0004 §findings, RQ-0012 line 85, RQ-0036, RQ-0101, DL-0169, DL-0284 | 2026-11-02 | internal | Delta queries alone miss hard deletes → queryAll/getDeleted; CDC retention 72 h; inbound key and mapping semantics. |

## Findings

1. **Change marker (S1, S2, S5).** `SystemModstamp` is the right filter: indexed, never older than
   `LastModifiedDate`, and the field Salesforce's own replication calls use. Formula/lookup-derived
   values do not bump it — the inbound map reads no formula fields, so nothing is missed.
2. **Deletes (S3, S4).** `queryAll` with the same `SystemModstamp` filter returns soft-deleted rows
   (`IsDeleted = true`) while they are in the Recycle Bin (≤ 15 days, less if purged). One
   `queryAll` therefore gives updates *and* deletes in one ordered stream; an undelete shows up as a
   live row with a newer `SystemModstamp`. A record purged from the bin before the poll is invisible
   to both `queryAll` and `getDeleted` after the purge — only a full id comparison catches it
   (reconciliation follow-up, T-0070).
3. **Paging and cost (S7).** A page holds up to 2,000 records; each page (first query or
   `nextRecordsUrl`) is one API call. A poll of one object costs ⌈changed records / 2,000⌉ calls
   (at least 1). Calls respect the shared `ApiUsageGate` (`Sforce-Limit-Info`, design §5.6 rule 3).
4. **Late commits (S6).** Salesforce itself warns that changes of a long-running transaction carry
   timestamps from before they become visible. A poll that sets its next start to its own highest
   `SystemModstamp` can skip them, so each poll re-reads an **overlap window** before the
   watermark (default 300 s, configurable per object 0–3,600 s). Re-read rows have the same key and
   are logged as duplicates (cheap); a transaction longer than the window is caught by the nightly
   reconciliation.
5. **Clock (S5, S6).** The watermark is the highest `SystemModstamp` *read from Salesforce*, never
   the LedgerForce clock, so local clock skew cannot open a gap. The local clock only schedules the
   next poll.
6. **Precision.** `SystemModstamp` has whole-second precision in practice (Get Updated ignores
   seconds; returned values end `.000`). Two changes to one record within one second share a stamp,
   so the stamp alone cannot be the idempotency key.
7. **Idempotency key and convergence (Q5; S8).** A polled row is a *snapshot*: the record's current
   values as of its `SystemModstamp`, not a diff. Decision:
   - key: commit number := `SystemModstamp` in epoch milliseconds; sequence number :=
     2^24 + (SHA-256 of change type + mapped values, mod 2^31 − 1 − 2^24). CDC sequence numbers are
     positions within one transaction (≥ 1, far below 2^24 since a transaction changes at most
     10,000 rows), so polled and CDC keys never coincide; the same snapshot read twice (overlap,
     re-run) is the same key and is logged as a duplicate; a second change within the same second
     has different values and so a different key.
   - convergence: CDC `commitTimestamp` ≥ the `SystemModstamp` of the same transaction. A snapshot
     is skipped (`ignored`, code `ALREADY_CURRENT`) when the record already has an applied change
     at or after its stamp; a CDC change older than an applied snapshot is skipped (`ignored`,
     code `SUPERSEDED`), because the snapshot already carries a newer state. Both Salesforce
     timestamps come from the same server clock.
   - semantics: a live snapshot is applied as an UPDATE naming every mapped field (one path per
     rule, the first non-null alternative), so nulls clear optional columns; `IsDeleted = true` is a
     DELETE; a live snapshot of a record whose last applied change was a DELETE is an UNDELETE.
   - ownership: the poll selects only fields in `INBOUND_FIELD_MAP` (Salesforce-owned), so it can
     never read or overwrite a LedgerForce-owned field; conflict detection of LF-owned fields that
     drifted in Salesforce is the reconciliation's re-push (T-0070).
8. **Field availability.** `CurrencyIsoCode` exists only in multi-currency orgs and
   `Billing*Code` only with state/country picklists; selecting a missing field fails the query
   (`INVALID_FIELD`). The poller takes the object's queryable field names (describe, cached by the
   caller) and selects the intersection.

## Conclusion / decision

Poll per object with `queryAll`:
`SELECT Id, SystemModstamp, IsDeleted, <mapped flat fields> FROM <Object> WHERE SystemModstamp >=
<watermark − overlap> ORDER BY SystemModstamp, Id`, page by `nextRecordsUrl`, feed each row to the
T-0065 `applyInboundChange` with the snapshot key above, advance the watermark per committed page
to the highest `SystemModstamp` read. Per-object mode (`cdc` | `polling`), interval, overlap and
watermark are data (migration 0051). `getUpdated`/`getDeleted` are not used: they return ids only
(a second call per batch for values) and cannot express an overlap; `getDeleted`'s
`earliestDateAvailable` is a useful purge detector for T-0070.

## Confidence

High for S1, S3, S5, S6, S7 (official pages, consistent across versions). Medium for finding 6
(second precision is observed behaviour and implied by S5, not stated as a guarantee — the key
does not depend on it).

## Follow-ups

- T-0070: detect Recycle-Bin purges (`getDeleted.earliestDateAvailable` later than the watermark)
  and fall back to a full id comparison; re-push drifted LedgerForce-owned fields.
- Scratch-org spike (RQ-0036 follow-up): record a real `queryAll` page into `fixtures/recorded/`.

**Affects:** `packages/connectors/salesforce/src/polling/`, `src/inbound/apply.ts`, migration 0051,
design §5.3.
