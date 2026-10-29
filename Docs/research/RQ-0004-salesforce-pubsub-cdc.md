---
id: RQ-0004
title: Salesforce Pub/Sub API from Node.js — client, replay semantics, CDC retention and allocations
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: [ADR-0006]
---

# RQ-0004 — Salesforce Pub/Sub API and CDC

## Question

Q1. Which maintained Node.js client for the gRPC/Avro Pub/Sub API?
Q2. Replay ID semantics and what happens after retention expiry.
Q3. CDC event retention window.
Q4. Current CDC delivery allocations per edition, and the entity-selection cap without add-on.

## Why it matters

Design §5.3: CDC on 8 objects, resume from stored replay ID, polling fallback, nightly
reconciliation; risk table §11.1 names allocation limits as a top-3 risk.

## Sources consulted

`developer.salesforce.com` / `help.salesforce.com` were **not directly fetchable** from this
sandbox (proxy 403); their content was obtained through WebSearch result extracts, which quote the
pages. GitHub and npm were fetched directly.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://github.com/forcedotcom/pub-sub-api `pubsub_api.proto` (clone) | 2026-10-24 | primary | `ReplayPreset { LATEST = 0; EARLIEST = 1; CUSTOM = 2; }`; default LATEST; "replay_preset and replay_id values are only consumed as part of the first FetchRequest"; empty keep-alive batches carry `latest_replay_id`; managed subscriptions with `CommitReplayRequest`. README lists `avro-js` as the Node Avro library. |
| S2 | `npm view salesforce-pubsub-api-client` + https://github.com/pozil/pub-sub-api-node-client README | 2026-10-24 | primary | v5.6.2 (2026-10-22), CC0-1.0, deps `@grpc/grpc-js`, `@grpc/proto-loader`, `avro-js`, `jsforce`; auth types `user-supplied`, `oauth-jwt-bearer`, `oauth-client-credentials`, `username-password`; `subscribeFromReplayId`, `subscribeFromEarliestEvent`, managed subscriptions + `commitReplayId`, flow control via `numRequested`; BigInt for `commitNumber`. Maintained by a Salesforce developer advocate (not an official SDK). |
| S3 | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html (via WebSearch) | 2026-10-24 | primary (extract) | "Salesforce stores platform events and change data capture events for 72 hours"; no guarantee beyond 72 h. |
| S4 | https://developer.salesforce.com/docs/platform/pub-sub-api/references/methods/subscribe-rpc.html (via WebSearch) | 2026-10-24 | primary (extract) | Use EARLIEST "after a client has been disconnected for more than 3 days and the last saved replay ID is no longer valid"; an old replay ID outside retention fails with an error. |
| S5 | https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-allocations.html (via WebSearch) | 2026-10-24 | primary (extract) | Without add-on: up to **5 selected entities** (standard + custom) across channels; default 24-h event delivery allocation **50,000 (Performance/Unlimited), 25,000 (Enterprise)**, shared with high-volume platform events; deliveries counted per subscriber; add-on removes entity cap and moves delivery to a monthly entitlement. |
| S6 | Change Data Capture Developer Guide v68.0 Winter '27 PDF (title via WebSearch) | 2026-10-24 | primary (title only) | Confirms current guide version; contents not retrievable here. |

## Findings

1. **Client (S1, S2).** There is no official Salesforce Node SDK; the de-facto client is
   `salesforce-pubsub-api-client` (CC0, actively released, written by a Salesforce employee)
   built on `@grpc/grpc-js` + `avro-js`. Alternative: generate stubs from the official proto with
   `@grpc/proto-loader` and decode Avro with `avro-js` ourselves (~300 LOC).
2. **Replay semantics (S1, S4).** Replay IDs are opaque `bytes`; store them as received
   (base64), never as numbers. Presets: LATEST (default), EARLIEST, CUSTOM (with replay_id).
   Only the first FetchRequest's preset/replay_id count. Keep-alive responses carry
   `latest_replay_id` — persist it too so idle channels don't drift out of retention.
3. **Retention (S3): 72 hours** for CDC and platform events. A stored replay ID older than that
   is rejected; recovery is resubscribe (EARLIEST or LATEST) **plus a data reconciliation**, since
   events are lost.
4. **Allocations (S5).** Enterprise Edition: 25,000 deliveries / 24 h; Performance & Unlimited:
   50,000. Each subscriber connection consumes its own deliveries. Without the add-on only
   **5 entities** can be selected for CDC.
5. **Design conflict:** §5.3 lists **8** CDC entities (Account, Contact, AccountContactRelation,
   Product2, Opportunity, OpportunityLineItem, Order, OrderItem). Without the add-on at most 5
   fit; and §5.3/§11.1 cite only the Unlimited figure (50,000) while the typical SMB org is
   Enterprise (25,000). Note also that installed *managed-package* custom channels are exempt
   from the 5-entity count (S5) — relevant only once LedgerForce ships as a managed 2GP package.
6. CDC support for `AccountContactRelation` could not be confirmed from a primary source here
   (unverified); treat it as polling-only until a scratch-org test proves otherwise.

## Conclusion / decision

- Use `salesforce-pubsub-api-client` (pin exact version) behind a `SalesforceEventSource`
  port; new runtime dependency ⇒ ADR. Keep a contract test against a scratch org.
- Persist `(org, channel) → last committed replay_id (bytes, base64)` **in the same DB
  transaction** as the processed batch; also persist `latest_replay_id` from keep-alives.
- On replay-ID-invalid error: alert, resubscribe with LATEST, and immediately run the
  SystemModstamp delta reconciliation from the last committed watermark (not just the nightly
  job). Use `queryAll`/`getDeleted` for deletions (delta queries alone miss hard deletes).
- Default CDC selection = **5 entities**: Account, Contact, Opportunity, OpportunityLineItem,
  Product2; **Order/OrderItem and AccountContactRelation use polling** unless the org has the
  add-on or the tenant picks Order-based invoicing (then swap Opportunity/OLI for Order/OrderItem).
  The setup wizard must read current selections (Tooling API `PlatformEventChannelMember`) and
  warn before exceeding 5.
- Budget allocations against **25,000/day (Enterprise)** by default; monitor via `/limits`.

## Confidence

Medium-high: proto, client and npm metadata are primary; allocation and retention numbers come
from Salesforce doc extracts via search (consistent across sources). Re-verify numbers each
Salesforce release (3×/year).

## Follow-ups

- Scratch-org spike: confirm CDC availability for AccountContactRelation and the exact
  replay-invalid error code text (to build a precise matcher).
- Human decision / design update: default CDC entity set (design §5.3 lists 8).

**Affects:** `packages/connectors/salesforce`, setup wizard step 5, nightly reconciliation job,
design §5.3, §5.6, §11.1, ADR-0006.
