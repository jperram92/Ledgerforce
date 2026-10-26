---
id: RQ-0040
title: Salesforce sObject Collections for write-back — upsert by external ID, update by Id, allOrNone, 200-record limit, per-record errors, API version, 401/403/429/503 and Retry-After
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0067]
linked_adrs: [ADR-0036, ADR-0006, ADR-0008]
superseded_by:
---

# RQ-0040 — Salesforce sObject Collections for the outbox write-back

## Question

Q1. What is the request and response contract of sObject Collections **upsert** (URI, method,
body, minimum API version, record limit, same-type rule)?
Q2. How do we write LedgerForce-owned fields on **Account** and **Opportunity**, which have no
`LF_Id__c` external ID (salesforce/ metadata, T-0062)?
Q3. What does `allOrNone` do, and how are per-record failures reported?
Q4. Which API version do we call?
Q5. How does the REST API signal outage, rate limiting and an exhausted daily allocation
(503, 429, 403 `REQUEST_LIMIT_EXCEEDED`), expired sessions (401), and is `Retry-After` sent?
Q6. How can the worker respect the design's `/limits` throttle (default 25 % of the daily API
allocation) without spending extra calls?

## Why it matters

Design §5.4 (write-back driven by the outbox, upsert by `LF_Id__c` through sObject Collections in
batches of up to 200) and §5.6 rules 2–4 (backoff, throttle, an outage never blocks accounting).
T-0067's contract tests (SS-UC03-04, SS-UC04-02) and outage test (SS-UC01-09) run against a local
fake: if the fake's shapes are wrong, green tests prove nothing.

## Sources consulted

Direct fetches of `developer.salesforce.com` failed again in this session (WebFetch:
`getaddrinfo ENOTFOUND`; curl through the agent proxy: `CONNECT tunnel failed, response 403`), as
in RQ-0005, RQ-0024 and RQ-0036. Salesforce facts below come from WebSearch extracts of the
vendor pages, cross-checked across several versioned copies of each page.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_sobjects_collections_upsert.htm (and versioned copies 242.0–262.0, via WebSearch) | 2026-10-26 | primary (extract) | `PATCH /services/data/vXX.X/composite/sobjects/SobjectName/ExternalIdFieldName`, Bearer token. Creates or updates **up to 200 records** matched on the external ID field. The list may contain only objects of the type in the URI. Body `{ "allOrNone": bool, "records": [ { "attributes": { "type": … }, <ExternalIdField>: …, … } ] }`; do not set `Id`. `allOrNone` is optional, default `false`. Records are processed in order and `UpsertResult`s come back in the same order. A malformed request is `400`; a well-formed request is `200` **even when individual records fail** — check each result's `success` and `errors`. Each result: `id`, `success`, `errors[]` (`statusCode`, `message`, `fields`), `created`. With `allOrNone: true` a failure returns every record with `success: false` and `ALL_OR_NONE_OPERATION_ROLLED_BACK`. Available in **API 46.0** and later. |
| S2 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_sobjects_collections_update.htm (and versioned copies, via WebSearch) | 2026-10-26 | primary (extract) | `PATCH /services/data/vXX.X/composite/sobjects/`, up to 200 records, each with `attributes.type` and a valid `id`; mixed types are allowed and are split into chunks by type, **at most 10 chunks per request**. Response is a list of `SaveResult` (`id`, `success`, `errors[]`) in request order; `400` when malformed, `200` otherwise even with per-record failures. `allOrNone` default `false`. Example uses `v61.0`. |
| S3 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/errorcodes.htm (via WebSearch) | 2026-10-26 | primary (extract) | `401`: session ID or OAuth token expired or invalid; body has `message` and `errorCode`. `403`: request refused; if the error code is `REQUEST_LIMIT_EXCEEDED`, the org's API request limit is exceeded. `503`: server unavailable, typically maintenance or overload. No mention of `Retry-After` for the Platform REST API. |
| S4 | https://developer.salesforce.com/docs/platform/connect-rest-api/guide/connect_error_responses.html (via WebSearch) | 2026-10-26 | primary (extract) | Error bodies are a JSON array of `{ "errorCode", "message" }` objects (plus field info where relevant). |
| S5 | https://developer.salesforce.com/docs/platform/salesforce-app-limits-cheatsheet/guide/salesforce-app-limits-platform-api.html (via WebSearch) | 2026-10-26 | primary (extract) | Concurrent long-running calls (≥ 20 s) are capped (5 Developer/trial, 25 production/sandbox); calls over the cap fail with `REQUEST_LIMIT_EXCEEDED`. |
| S6 | https://developer.salesforce.com/docs/platform/api-rest/guide/headers-api-usage.html (via WebSearch) | 2026-10-26 | primary (extract) | Every REST response (except the versions URI `/`) carries `Sforce-Limit-Info: api-usage=10018/100000` (used / daily limit for the org); newer examples add `; api-bursts=1/750`. |
| S7 | https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_limits.htm (versioned copies, via WebSearch) | 2026-10-26 | primary (extract) | `GET /services/data/vXX.X/limits/` returns `DailyApiRequests { Max, Remaining }` among others; values are accurate within about five minutes. |
| S8 | https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm (via WebSearch); https://docs.gearset.com/articles/2841295-resolving-data-deployment-errors-duplicate_value-duplicate_external_id | 2026-10-26 | primary (extract) + secondary | Upsert: no match → create, one match → update, several matches → error. Gearset: `DUPLICATE_VALUE` when the *sent* records share an external ID value. |
| S9 | https://developer.salesforce.com/docs/atlas.en-us.noversion.mc-apis.meta/mc-apis/rate-limiting-errors.htm; https://hub.cognite.com/ideas/feature-request-add-retry-after-header-when-the-api-returns-429-status-code-5559; https://docs.cloud-elements.com/home/9838da8 (via WebSearch) | 2026-10-26 | secondary for the Platform API | Marketing Cloud (a *different* API) answers `429` with `Retry-After: 5`. Third parties report Salesforce rate-limit errors as `403 REQUEST_LIMIT_EXCEEDED`, and `429`s without `Retry-After`. |
| S10 | RFC 9110 §10.2.3 (Retry-After: delay-seconds or HTTP-date) | 2026-10-26 | primary (standard) | A server may send `Retry-After` with `503` or `429`, as seconds or as an HTTP-date. |
| S11 | `salesforce/force-app/main/default/objects/**` (T-0062), DL-0095 / RQ-0022 | 2026-10-26 | internal | `LF_Invoice__c.LF_Id__c` and `LF_Payment__c.LF_Id__c` are Text(36), `externalId` + `unique`. Account and Opportunity carry only the LedgerForce-owned fields (no `LF_Id__c`). The invoice number is the object's Name field. Package API version 67.0. |
| S12 | `node_modules/pg-boss/dist/index.d.ts` (12.37.1) — read locally | 2026-10-26 | source code | `fail(name, id, data?, options?)` has no per-call retry delay: the queue's `retryDelay`/`retryBackoff`/`retryDelayMax` decide when a failed job runs again. |

## Findings

1. **Upsert contract (S1).** `PATCH …/composite/sobjects/{type}/{externalIdField}`, body
   `{ allOrNone, records }`, every record with `attributes.type` equal to the URI type and the
   external ID field set, `Id` absent; ≤ 200 records; one type per request; API ≥ 46.0. The answer
   is an ordered array of `{ id, success, errors, created }`. HTTP `200` does **not** mean every
   record was written.
2. **Account and Opportunity (S2, S11).** They have no `LF_Id__c`, and LedgerForce never creates
   them (they are Salesforce-owned records, ADR-0006). Upserting them by an external ID would
   either need new fields on Salesforce-owned objects or could create stray records. The
   documented way to write fields on existing records is the sObject Collections **update**
   (`PATCH …/composite/sobjects/` with `attributes.type` + `id`), ≤ 200 records, mixed types in
   ≤ 10 chunks. *Inference:* an update by Salesforce Id with full values is as idempotent as an
   upsert (repeating it sets the same values).
3. **allOrNone (S1, S2).** Default `false`: records are independent and failures are per record.
   With `true`, any failure rolls back the request and every record reports
   `ALL_OR_NONE_OPERATION_ROLLED_BACK`.
4. **Duplicates in one request (S8).** Two records with the same external ID value in one upsert
   fail (`DUPLICATE_VALUE`); *inference:* the same applies to two updates of one Id. A batch
   must hold each key once.
5. **API version (S1, S11).** Upsert needs ≥ 46.0; the package is on 67.0 (DL-0095), which every
   current org serves.
6. **Error statuses (S3–S5, S9).** `401` + `INVALID_SESSION_ID` → token expired/invalid.
   `403` + `REQUEST_LIMIT_EXCEEDED` → daily allocation or concurrent long-running cap reached.
   `503` → unavailable (maintenance/overload). A body is a JSON array of `{errorCode, message}`.
   `429` is not documented for the Platform REST API but is reported by third parties.
7. **Retry-After (S3, S9, S10, S12).** Not documented for the Platform REST API (only for
   Marketing Cloud). RFC 9110 allows it on `503`/`429`. pg-boss cannot set a delay per failure.
8. **Throttle without extra calls (S6, S7).** Every response's `Sforce-Limit-Info: api-usage=u/m`
   reports the org's daily usage, so the worker can learn its budget from its own traffic; the
   `/limits` resource gives the same number on demand (one call).

## Conclusion / decision

- Mirror objects (`LF_Invoice__c`, `LF_Payment__c`): **upsert** by `LF_Id__c` with
  `allOrNone: false`, one object type per request, ≤ 200 records, each `LF_Id__c` once per request.
- Account and Opportunity: **update by Salesforce Id** through sObject Collections, ≤ 200 records,
  records sorted by type (≤ 2 chunks), each Id once per request, `allOrNone: false`. The Ids come
  from the event payload (the billing source's Salesforce ids). This refines design §5.4's
  "upsert by LF_Id__c", which cannot apply to objects without that field (ADR-0036).
- Read every per-record result. Any `success: false` fails the delivery; the retry resends the
  whole event (idempotent: upsert/update with the same values).
- Classify a non-2xx answer: `401` → `session_expired` (invalidate the cached token, re-sign once,
  retry once); `503` → `unavailable`; `429` → `rate_limited`; `403 REQUEST_LIMIT_EXCEEDED` →
  `request_limit`; other `4xx` → `rejected`; unparseable `2xx` → `malformed_response`. All but
  `rejected` and `malformed_response` are retryable.
- Parse `Retry-After` (delay-seconds or HTTP-date) when present and carry it on the error for
  logs and the Sync issues inbox; the pg-boss queue backoff (1 min → 6 h, ADR-0008) decides the
  actual retry time.
- Track `Sforce-Limit-Info` per org and refuse to send (retryable `throttled`) once usage reaches
  the configured share (default 25 %) of the daily limit.
- Call API version **67.0**; assert ≥ 46.0.
- Build the contract against a local fake that answers with the documented shapes above
  (`fixtures/documented/sobject-collections-responses.json`); never call Salesforce in CI.

## Confidence

High for the URI, method, body, 200-record limit, same-type rule, ordered results, `200` with
per-record failures, `allOrNone` semantics and API 46.0 (consistent across many versioned copies
of S1/S2). Medium for exact error bodies (shape from S4; codes from S3) and `403
REQUEST_LIMIT_EXCEEDED` vs `429` (S3/S5 primary, S9 secondary) — the classifier handles both.
Low for `Retry-After` on Platform REST (undocumented) — handled defensively, and the queue backoff
governs regardless.

## Follow-ups

- Scratch-org spike (human-authorised org): record and redact an upsert and an update response
  (success, partial failure), a `401`, and a `Sforce-Limit-Info` header into
  `packages/connectors/salesforce/fixtures/recorded/`; replace the documented fixture.
- Re-try `developer.salesforce.com` for the verbatim example bodies when the proxy allows it.
- Re-check API 68.0 after 2026-11-30 together with DL-0095.

**Affects:** `packages/connectors/salesforce/src/writeback/`, `apps/worker`, ADR-0036, design §5.4,
§5.6.
