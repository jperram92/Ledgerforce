---
adr: 0032
title: "Salesforce Pub/Sub API client: @grpc/grpc-js + @grpc/proto-loader on the vendored proto, avsc for Avro, replay id committed with the batch"
status: Proposed
date: 2026-10-25
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0032: Salesforce Pub/Sub API client: @grpc/grpc-js + @grpc/proto-loader on the vendored proto, avsc for Avro, replay id committed with the batch

## Status

Proposed — integration category, no human gate. Becomes Accepted on green CI + cross-review by
codex (AGENTS.md §2 step 8). Adds three runtime dependencies to
`@ledgerforce/connector-salesforce` (design §10.6).

## Context and problem statement

Design §5.3 receives Salesforce changes through Change Data Capture over the gRPC-based Pub/Sub
API, Avro-encoded, ordered by replay id, with client-controlled flow, and stores the last replay
id per channel after each committed batch (§5.6: idempotency key per inbound message). RQ-0036
established the contract: the published `pubsub_api.proto` (CC0), `Subscribe` as a pull-based
bidirectional stream (≤ 100 events outstanding), opaque `bytes` replay ids with
`LATEST`/`EARLIEST`/`CUSTOM` presets, 72 h retention, the `error-code` trailer for an invalid
replay id, payloads as Avro binary for the schema returned by `GetSchema`, and gap/overflow
events. Node has no gRPC or Avro support in its standard library, so T-0064 needs libraries — a
new runtime dependency needs an ADR.

## Decision drivers

- Follow the published wire contract exactly, and prove it offline (CI never calls Salesforce).
- Pure JavaScript, no native build, pinned exact versions, ≥ 2 weeks old, `pnpm audit --prod` clean.
- Lossless decoding (commit numbers are Avro `long`s; money is not involved).
- No loss and no duplication across restarts (SS-PLAT-27), per tenant and company (RLS).

## Considered options

1. **@grpc/grpc-js 1.14.6 + @grpc/proto-loader 0.8.1 on the vendored proto, avsc 5.7.9** — the
   reference stack (RQ-0036 S2) with a dependency-free Avro library.
2. **Same gRPC stack, avro-js** (Apache's fork of avsc, used by the reference client).
3. **Generated static code (protoc / ts-proto) + a hand-written Avro decoder.**
4. **No Pub/Sub: polling only** (SystemModstamp delta queries).

### Option 1

- Good, because grpc-js is the maintained pure-JS gRPC implementation, used by the reference
  client with the same proto; the client and the fake server load one file, so they cannot drift.
- Good, because avsc has no dependencies, decodes from the writer schema at runtime and lets us
  plug a BigInt `long` type.
- Bad, because proto-loader brings protobufjs and yargs (transitive, pinned in the lockfile).

### Option 2

- Good, because it matches the reference client.
- Bad, because avro-js lags avsc and adds nothing we need.

### Option 3

- Good, because no runtime proto parsing.
- Bad, because a code generator in the build, and a hand-written Avro decoder is exactly the kind
  of code a maintained library does better.

### Option 4

- Good, because no new dependencies.
- Bad, because the design requires CDC (§5.3); polling stays the per-object fallback and the
  nightly reconcile, not the primary path.

## Decision outcome

Chosen option: **Option 1**, because it follows the published contract with the reference
stack, is pure JS and audit-clean, and decodes losslessly.

Rules:

1. `packages/connectors/salesforce/proto/pubsub_api.proto` is the forcedotcom file byte for byte;
   its SHA-256 is pinned in `PUBSUB_PROTO_SHA256` and checked by the contract test. Updating it
   is a deliberate change with a new RQ entry.
2. Dependencies are exact: `@grpc/grpc-js` 1.14.6, `@grpc/proto-loader` 0.8.1, `avsc` 5.7.9, in
   `@ledgerforce/connector-salesforce` only.
3. TLS to the endpoint (default `api.pubsub.salesforce.com:7443`); auth only as call metadata
   (`accesstoken`, `instanceurl`, `tenantid`); plaintext only to a loopback address (tests).
4. Avro `long` decodes to BigInt; replay ids are opaque bytes, stored as `bytea`, never parsed.
5. The replay id moves by compare-and-set in the same tenant transaction as the batch's effects,
   idempotency keys and resync requests (migration 0026). More events are requested only after
   the commit, never more than 100 outstanding.
6. Idempotency key per record: `cdc:<entity>:<record id>:<commit number>:<sequence number>`;
   overflow: `cdc:<entity>:overflow:<transaction key>:<sequence>`; platform event:
   `event:<uuid>` (DL-0169).
7. A rejected replay id (`…subscription.fetch.replayid.*`) clears the cursor and records a resync
   request since the last commit; the next run starts at `LATEST`. Gap events record their
   records, overflow events their entity, for the reconcile job; neither is applied.

## Consequences

### Good

- The subscriber is testable end to end over real gRPC against a local fake built from the
  same proto, with no Salesforce org.
- A restart, a crash mid-batch or a redelivery cannot lose or double an effect.

### Bad / accepted trade-offs

- Three runtime packages (plus protobufjs, yargs, long, lodash.camelcase transitively).
- The event inbox grows with every applied record; a retention job is a follow-up.
- Recovery after a rejected replay id depends on the reconcile job (not built yet).

### Follow-ups

- Reconcile job consuming `app.salesforce_resync_request` (design §5.3 nightly reconciliation).
- Supervisor: one subscriber per channel and company, back-off, token refresh on `auth` errors
  (`invalidateAccessToken`, T-0063), org id stored with the connection.
- Inbox retention (keys older than the 72 h replay window plus a margin).
- Recorded fixtures from a scratch org (RQ-0036 follow-up).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Proto byte-identical (SHA-256), field numbers and presets as published | `packages/connectors/salesforce/src/pubsub/pubsub.decode.contract.test.ts` (SS-PLAT-75) | `pnpm test` |
| Avro decode, BigInt longs, bitmaps, gap/overflow, idempotency keys, error classification | same file | `pnpm test` |
| Restart resumes from R, duplicates dropped, flow control, keepalive, CAS conflict | `packages/connectors/salesforce/src/pubsub/replay-resume.db.test.ts` (SS-PLAT-27) | `pnpm test:db` |
| Invalid replay id → reset + resync; gap/overflow → resync; per tenant | same file (SS-PLAT-74) | `pnpm test:db` |
| New tables isolated by tenant | `packages/db/src/rls.db.test.ts` (SS-PLAT-04) | `pnpm test:db` |
| Dependencies audit-clean | `pnpm audit --prod` | verify.sh |

## Links

- Design: §5.3, §5.6, §10.6
- Research: RQ-0036
- Decision log: DL-0167, DL-0168, DL-0169, DL-0170, DL-0171
- Related ADRs: ADR-0006 (field ownership), ADR-0007 (Salesforce auth), ADR-0008 (outbox and idempotent consumers)
- External sources: https://github.com/forcedotcom/pub-sub-api (2026-10-25); https://developer.salesforce.com/docs/platform/pub-sub-api/guide/handling-errors.html (via search extract, 2026-10-25)
