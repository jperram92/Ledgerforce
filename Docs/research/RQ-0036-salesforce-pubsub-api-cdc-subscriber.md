---
id: RQ-0036
title: Salesforce Pub/Sub API for CDC — gRPC contract, flow control, replay ids, Avro decoding, gap and overflow events, 72 h retention
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0064]
linked_adrs: [ADR-0032, ADR-0008, ADR-0006]
superseded_by:
---

# RQ-0036 — Salesforce Pub/Sub API: a CDC subscriber with a replay-id store

## Question

Q1. What is the wire contract of the Pub/Sub API (transport, endpoint, proto, auth metadata), and
can we contract-test against it offline?
Q2. How does `Subscribe` flow control work (`num_requested`, limits, keepalives)?
Q3. What is a replay id, how does a subscription start (`ReplayPreset`), and how long are events
retained?
Q4. What happens when a stored replay id is invalid or expired, and how is that reported?
Q5. How are payloads encoded (Avro, `GetSchema`), and what does a CDC `ChangeEventHeader` hold?
Q6. What are gap and overflow events, and what must a subscriber do with them?
Q7. Which Node libraries implement gRPC and Avro, and are they safe to adopt (pinned, ≥ 2 weeks
old, audited)?

## Why it matters

Design §5.3 and §5.6 require the connector to store the last replay id per channel after each
committed batch and to resume from it after restarts, with idempotency keys on every inbound
message (SS-PLAT-27). CI never contacts Salesforce, so the offline fake must follow the published
contract as closely as we can establish it.

## Sources consulted

Direct fetches of `developer.salesforce.com` failed in this session (WebFetch DNS failure; proxy
`CONNECT` 403 with curl), as in RQ-0005 and RQ-0024. Salesforce facts come from WebSearch extracts
of those pages; the proto and the reference Node client were fetched verbatim from GitHub.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://github.com/forcedotcom/pub-sub-api/blob/main/pubsub_api.proto (raw, fetched; licence CC0-1.0 in the same repo) | 2026-10-25 | primary (verbatim) | Package `eventbus.v1`, service `PubSub` with `Subscribe(stream FetchRequest) returns (stream FetchResponse)`, `GetSchema`, `GetTopic`, `Publish`, `PublishStream`, `ManagedSubscribe`. `FetchRequest{topic_name=1, replay_preset=2, replay_id=3 (bytes), num_requested=4, auth_refresh=5}`; `FetchResponse{events=1, latest_replay_id=2 (bytes), rpc_id=3, pending_num_requested=4}`; `ConsumerEvent{event=1, replay_id=2}`; `ProducerEvent{id=1, schema_id=2, payload=3 (bytes), headers=4}`; `ReplayPreset{LATEST=0, EARLIEST=1, CUSTOM=2}`; `SchemaRequest{schema_id=1}`, `SchemaInfo{schema_json=1, schema_id=2, rpc_id=3}`. Comments: the replay option is honoured only in the first FetchRequest; more requests add to the outstanding amount; "If there are no events to deliver, the server sends an empty batch fetch response with the latest replay ID … within 270 seconds". SHA-256 of the fetched file: `0a651295ff3ff13551b3ae7cb6fe87cf91b749a8ae33b6079617dbc62f304eb5`. |
| S2 | https://github.com/pozil/pub-sub-api-node-client (raw `src/client.js`, `src/utils/eventParser.js`, `src/utils/avroHelper.js`, `package.json`, fetched) | 2026-10-25 | secondary (reference client by a Salesforce developer advocate) | Uses `@grpc/grpc-js` ^1.14.6 + `@grpc/proto-loader` ^0.8.1 with the S1 proto; call metadata `accesstoken`, `instanceurl`, `tenantid` (org id); `MAX_EVENT_BATCH_SIZE = 100`; replay ids handled as 8-byte big-endian buffers; payload decoded with the schema from `GetSchema`, cached by schema id; Avro `long` needs a BigInt-aware type for large values; `changedFields`/`nulledFields`/`diffFields` are hex bitmaps over the schema's field order. |
| S3 | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/handling-errors.html (via WebSearch) | 2026-10-25 | primary (extract) | Errors are gRPC status exceptions that end the long-lived Subscribe stream. A custom code is in the trailers under `error-code`; the example is `sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted` with status `INVALID_ARGUMENT`, meaning the replay id is invalid; the RPC id is in the message after `rpcId:` and in the trailers. |
| S4 | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/retry-rpc-calls.html (via WebSearch) | 2026-10-25 | primary (extract) | A possible cause of the invalid replay id error is a replay id older than the 72-hour retention; retry with back-off; after a transient error resubscribe with `CUSTOM` and the last saved replay id. |
| S5 | https://developer.salesforce.com/docs/platform/pub-sub-api/references/methods/subscribe-rpc.html and …/guide/flow-control.html (via WebSearch) | 2026-10-25 | primary (extract) | Retention for platform events and change data capture events is 3 days. `num_requested` maximum is 100; a larger value is treated as 100; the outstanding total across FetchRequests in one Subscribe call is capped at 100; batches vary in size. |
| S6 | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/pub-sub-endpoints.html (via WebSearch) | 2026-10-25 | primary (extract) | Global endpoint `api.pubsub.salesforce.com`, port 443 or 7443; a region-specific endpoint exists for data-in-transit requirements; do not hard-code IPs. |
| S7 | https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_event_fields_header.htm and …/cdc_message_structure.htm (via WebSearch) | 2026-10-25 | primary (extract) | `ChangeEventHeader`: `entityName`, `recordIds` (array), `changeType` (CREATE, UPDATE, DELETE, UNDELETE; SNAPSHOT reserved; GAP_* and GAP_OVERFLOW), `changeOrigin`, `transactionKey`, `sequenceNumber`, `commitTimestamp`, `commitNumber`, `commitUser`, plus `nulledFields`, `diffFields`, `changedFields` (Pub/Sub only). Example commitNumber 1082985383811. Pub/Sub delivers the payload as binary Avro; the schema id changes when the object's fields change. |
| S8 | https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_other_events_gap.htm and …/cdc_other_events_overflow.htm (via WebSearch) | 2026-10-25 | primary (extract) | Gap events (`GAP_CREATE`, `GAP_UPDATE`, `GAP_DELETE`, `GAP_UNDELETE`) replace change events Salesforce could not generate (> 1 MB, some type conversions, internal errors, database-level changes); they carry the record ids but no field data — retrieve the record. Overflow: a transaction with > 100,000 changes produces change events for the first 100,000 and then one `GAP_OVERFLOW` event per entity type, with `recordIds` = placeholder `000000000000000AAA`. |
| S9 | Design §5.3 (CDC allocation 50,000 / 24 h, Unlimited Edition default) | 2026-10-25 | internal | Event delivery counts against a 24-hour allocation, so replaying with `EARLIEST` is not free. |
| S10 | npm registry (`pnpm view … time`, `pnpm audit --prod`) — executed locally | 2026-10-25 | experiment | `@grpc/grpc-js` 1.14.6 published 2026-10-08; `@grpc/proto-loader` 0.8.1 published 2026-05-07 (deps protobufjs 7.6.6 of 2026-08-27, yargs 17.7.3 of 2026-06-19, long, lodash.camelcase); `avsc` 5.7.9 published 2025-07-13, no dependencies. `pnpm audit --prod`: no known vulnerabilities. |

## Findings

1. **Wire contract (S1, S2, S6).** gRPC over HTTP/2 with TLS to `api.pubsub.salesforce.com:7443`
   (or 443). Auth is call metadata: `accesstoken` (the OAuth access token from T-0063),
   `instanceurl` and `tenantid` (the 18-character org id). The proto is published under CC0, so we
   vendor it byte-for-byte and pin its SHA-256; the offline fake server and the client are both
   generated from that file at runtime, so the fake cannot drift from the real message layout.
2. **Flow control (S1, S5).** Pull-based: the client sends `FetchRequest{num_requested}`; the
   server delivers up to that many events in one or more `FetchResponse`s; further requests add
   to the outstanding amount, which is capped at 100 per stream. With no events, a keepalive
   (empty `events`, current `latest_replay_id`, `pending_num_requested`) arrives within 270 s.
3. **Replay ids and presets (S1, S4, S5).** A replay id is an opaque `bytes` value (in practice 8
   bytes big-endian, S2). The first FetchRequest chooses `LATEST` (tip), `EARLIEST` (oldest
   retained) or `CUSTOM` (start *after* `replay_id`); later presets are ignored. CDC events are
   retained for 72 hours. *Inference:* storing the keepalive's `latest_replay_id` when no batch is
   in flight is safe (every delivered event has already committed) and keeps a quiet channel's
   cursor inside the retention window.
4. **Invalid or expired replay id (S3, S4).** The Subscribe stream ends with status
   `INVALID_ARGUMENT` and trailer `error-code: sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted`
   (an id older than 72 h is one cause). Only that code is documented in the extracts; other
   `…subscription.fetch.replayid…` codes may exist, so we match the `fetch.replayid` family.
   The documented recovery is to subscribe again with a different preset; events between the
   last commit and the new start point are then not delivered and must be reconciled.
5. **Payload (S1, S2, S7).** `ProducerEvent.payload` is Avro binary for the writer schema named by
   `schema_id`, fetched with `GetSchema` (cache by id; ids change when fields change). Avro
   `long` values (`commitNumber`, `commitTimestamp`) can exceed 2^53 in principle and must be
   decoded losslessly. The header fields are those of S7. `ProducerEvent.id` is the event uuid.
6. **Gap and overflow events (S8).** A `GAP_*` event names the affected records but carries no
   field data: the subscriber must re-read those records (reconcile), not apply a change. A
   `GAP_OVERFLOW` event names only the entity type; that entity must be reconciled for the
   transaction's commit time.
7. **Libraries (S2, S10).** `@grpc/grpc-js` is the maintained pure-JS gRPC implementation (no
   native build); `@grpc/proto-loader` loads `.proto` files for it. `avsc` is a dependency-free
   Avro implementation with schema-driven decoding and a pluggable `long` type. The reference
   client uses `avro-js` (Apache's fork of avsc), which brings the same API; we choose `avsc`
   (newer release, zero dependencies). All three are pinned exact, older than two weeks and
   audit-clean.

## Conclusion / decision

- Vendor `pubsub_api.proto` (S1) under `packages/connectors/salesforce/proto/`, pinned by SHA-256
  in a contract test; build the client and a local fake `PubSub` server from it with
  `@grpc/grpc-js` + `@grpc/proto-loader`; decode payloads with `avsc`, `long` as BigInt
  (ADR-0032).
- Subscribe with `CUSTOM` + stored replay id when one exists, else `LATEST` (an initial load is
  a reconcile job, not a 72 h replay that spends the event allocation, S9). Request at most 100
  events; request more only after a batch has committed.
- For every response with events, one tenant transaction: drop duplicates by idempotency key
  (`<entity>:<recordId>:<commitNumber>` per record for CDC, `event:<uuid>` otherwise), apply the
  handler, turn `GAP_*` and `GAP_OVERFLOW` into resync requests, and move the stored replay id
  to the last event's id (compare-and-set against the id the stream started from). A keepalive
  with no batch in flight advances the stored id to `latest_replay_id`.
- On the `fetch.replayid` error family: clear the stored replay id and record a resync request
  "since the last commit"; the next run subscribes from `LATEST` and the reconcile job (design
  §5.3, nightly SystemModstamp delta) fills the gap.

## Confidence

Medium-high for the proto (verbatim, S1) and the flow-control and retention rules (consistent
across S1, S4, S5 and S2). Medium for the error trailer (one documented example, S3) and the
exact Avro schema of a change event: no `GetSchema` response could be recorded without an org,
so the fixture schema is *documented* (written from S7), and the decoder is schema-driven so a
real schema with more fields decodes the same way.

## Follow-ups

- Scratch-org spike (human-authorised org): record and redact a `GetSchema` response for
  `AccountChangeEvent`, one CREATE/UPDATE change event, a keepalive and the replay-id error
  trailer into `packages/connectors/salesforce/fixtures/recorded/`.
- Re-try `developer.salesforce.com` for the full error-code table when the proxy allows it.
- The reconcile job that consumes resync requests (design §5.3) and the supervisor that runs
  one subscriber per channel with back-off belong to later connector tasks.

**Affects:** `packages/connectors/salesforce`, migration 0026, ADR-0032, ADR-0008 (idempotent
consumers), design §5.3, §5.6.
