---
id: RQ-0047
title: Sync issues inbox screens — where they live, what the API offers, which actions apply in which status, and the error in plain words
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0092]
linked_adrs: [ADR-0040, ADR-0034]
superseded_by:
---

# RQ-0047 — Sync issues inbox screens (T-0092)

## Question

T-0092 builds the Sync issues inbox in `apps/web` (design §5.6 rule 2: "a Sync issues inbox
with the error, payload and a one-click retry"; principle P9). The API exists (T-0071,
ADR-0040). Before writing the screens:

- Q1 Where does the inbox live in the app? The IA puts it at `/salesforce/issues` in a
  "Salesforce sync" area, but the shell's navigation (T-0081) has no such section.
- Q2 What exactly do `GET /sync-issues`, `GET /sync-issues/:id`, `POST …/retry` and
  `POST …/ignore` accept and answer: filters, paging, payload, refusals?
- Q3 In which status may an issue be retried or ignored, and what does a repeat do?
- Q4 Who may read and who may act, so that actions are hidden or disabled with a reason (P6)?
- Q5 What errors can an issue carry, and how can each be said in plain words (P6, P9: "inbox
  translating `ENTITY_IS_LOCKED` into an action")?
- Q6 Is the payload safe to show?

## Why it matters

The inbox is where a person decides to send a failed write-back again or park it. A screen that
offers Retry where the API answers 409, hides the reason a control is disabled, or shows a raw
`rejected` instead of what to do, breaks P6 and P9 and teaches people to ignore the inbox.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `apps/api/src/sync/sync-issues.controller.ts` (base 14c53b0) | 2026-10-26 | source code | `GET /sync-issues?status&after&limit`: status ∈ open, retried, resolved, ignored (else 400 `invalid_status`); `after` a UUID (else 400 `invalid_after`); `limit` 1–200, default 50 (else 400 `invalid_limit`); answers `{ issues, next_after }`, `next_after` non-null only when a further row exists. `GET /sync-issues/:id` adds `payload`; a non-UUID or unknown id is 404 `not_found`. `POST :id/retry` 200 with the issue, 409 `sync_issue_not_retryable`, 503 `queue_not_configured`. `POST :id/ignore` with optional `{ note }` (string ≤ 500, else 400 `invalid_note`), 200 or 409 `sync_issue_not_ignorable`. Read needs `sync.issues.read`, act `sync.issues.manage`. Both actions audited. |
| S2 | `packages/outbox/src/sync-issues.ts` `retrySyncIssue`, `ignoreSyncIssue`, `describeFailure`, `resolveRetriedIssues` | 2026-10-26 | source code | Retry: `retried` answers as is (no second job); `open` and `ignored` are retried; `resolved` refused. Ignore: `ignored` answers as is; only `open` is ignored; others refused. A successful delivery resolves the event's retried issues. `describeFailure` keeps name, kind, `errorCode`, HTTP status, `retryable` and the message (≤ 1,000 characters); an abandoned job has kind `abandoned`. |
| S3 | RQ-0044 Conclusion; SS-PLAT-91 | 2026-10-26 | project research | A new dead letter re-opens the issue with the new error and the summed attempts. Retries run 1 min to 6 h apart before an issue opens; permanent failures (`retryable: false`) open at once. |
| S4 | `packages/connectors/salesforce/src/writeback/collections.ts` (`SalesforceApiErrorKind`), `writeback.ts` (`WriteBackRecordError`) | 2026-10-26 | source code | Kinds: `session_expired` (401), `rate_limited` (429), `request_limit` (403 REQUEST_LIMIT_EXCEEDED), `unavailable` (5xx or network), `throttled` (LedgerForce's own API-share gate), `rejected` (other 4xx), `malformed_response`. Only `rejected` and `malformed_response` are not retryable. Per-record refusals in a 200 answer throw `WriteBackRecordError` (no kind, retryable) whose message names the first record's status code. |
| S5 | RQ-0040 S3, S5 (Salesforce REST API "Status Codes and Error Responses"; limits cheat sheet) | 2026-10-26 | primary (via RQ-0040) | 401 = session expired or invalid; 403 `REQUEST_LIMIT_EXCEEDED` = the org's API request limit is exceeded (daily, or too many concurrent long requests); 503 = maintenance or overload. |
| S6 | Salesforce SOAP API Developer Guide, "Core Data Types → StatusCode" (`ENTITY_IS_LOCKED`, `UNABLE_TO_LOCK_ROW`, `FIELD_CUSTOM_VALIDATION_EXCEPTION`, `INVALID_FIELD`, `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`) — https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm | 2026-10-26 | secondary (author's knowledge of the published list; not re-fetched in this session) | `ENTITY_IS_LOCKED`: the record is locked (typically by an approval process). `UNABLE_TO_LOCK_ROW`: another operation held the row; retrying usually succeeds. `FIELD_CUSTOM_VALIDATION_EXCEPTION`: a validation rule refused the change. `INVALID_FIELD`: a field named in the request does not exist or is not accessible. `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`: the running user cannot see or edit a related record. |
| S7 | `packages/shared/src/rbac/catalogue.ts`, `rbac.matrix.test.ts` (T-0071, DL-0215) | 2026-10-26 | source code | `sync.issues.read`: Owner, Finance Admin, Accountant, Auditor. `sync.issues.manage`: Owner, Finance Admin, Accountant. |
| S8 | `Docs/ui/information-architecture.md` §2, §3, S17; `Docs/ui/principles.md` P2, P6, P9, P12, P14; mockup 09 | 2026-10-26 | primary (design) | Inbox at `/salesforce/issues` in a "Salesforce sync" area (Accountant ◐ view + retry, Auditor ◐). Status is a word plus a colour. A disabled action has visible text explaining it. Navigation order is a contract (P14): new areas need a release note. Mockup 09 says "Your books are not affected" and groups items needing a person. |
| S9 | `apps/web/src/sections.ts`, `apps/web/src/App.test.tsx` (`SECTIONS` order), `tests/e2e/web/shell.spec.ts` | 2026-10-26 | source code (tests) | The shell's six sections are asserted in order by existing tests; Settings' gloss already names "the Salesforce connection". |
| S10 | `packages/outbox/src/outbox.ts` (`OutboxEventInput.payload`), `packages/connectors/salesforce/src/writeback/mapping.ts` | 2026-10-26 | source code | The payload is the business snapshot the writer recorded (invoice, payment, account, opportunity fields; no credentials). The connector never stores tokens in events; `describeFailure` is secret-free. No bank account fields are mapped for write-back. |

## Findings

1. **Place (Q1).** Adding a "Salesforce sync" section would change the navigation that P14 and
   the existing shell tests fix, which is a release-note change, not a screen task. Settings
   already promises "the Salesforce connection", and the IA's Settings area lists integrations.
   The inbox therefore goes under Settings — `/settings/sync-issues` and
   `/settings/sync-issues/:issueId` — listed on the Settings page, so Settings is the current
   section. When a Salesforce sync area is added, the route moves with a redirect (follow-up).
2. **Contract (Q2).** Keyset paging only forward (`after` = last id of the page); "first page"
   drops the cursor. The screen asks for 20 per page (well inside 1–200) to keep each page short
   on a phone. The status filter is in the address (`?status=`), so a view can be shared; the
   default is `open` ("Needs a person"), and `all` sends no status. Unknown filters and cursors
   in the address are dropped rather than sent (the API would answer 400).
3. **Actions (Q3).** Retry is offered for `open` and `ignored`; for `retried` the screen says a
   retry is already on its way; for `resolved`, that nothing is left to do. Ignore is offered for
   `open` only. Both stay safe when repeated (S2), and a 409 from a race (the issue changed in
   another tab) is shown in plain words and the issue is reloaded.
4. **Permissions (Q4).** The list and the detail need `sync.issues.read`; a caller without it
   sees a forbidden state naming the Owner, a Finance Admin, an Accountant or an Auditor. Retry
   and Ignore need `sync.issues.manage`; for an Auditor they are shown **disabled** with
   `aria-describedby` text naming who can act (P6, IA "◐"). The API remains the authority.
5. **Plain words (Q5).** Each kind in S4, plus `abandoned`, a record refusal
   (`WriteBackRecordError`) and an unknown failure, maps to a heading and a next step. Known
   Salesforce codes from S6 (found in `error.code` or the message) add a specific next step,
   e.g. `ENTITY_IS_LOCKED` → "unlock it in Salesforce, then retry". The raw code, HTTP status and
   message stay visible for the accountant. A non-retryable failure says that retrying will not
   help until the cause is fixed. Every screen repeats mockup 09's reassurance that the books are
   not affected (design §5.6 rule 4).
6. **Payload (Q6).** The payload is business data that every reader of the inbox can already
   see elsewhere (S7: Owner, Finance Admin, Accountant, Auditor); it holds no credentials (S10).
   It is shown on demand (`<details>`) as formatted JSON, never parsed for arithmetic.

## Conclusion

Build two screens under Settings with a client of their own in `apps/web/src/sync/` (reusing
the admin screens' access, state and step-up routing): a filtered, keyset-paged list and a detail
page with the error in plain words, the payload reference, attempts and history, and Retry /
Ignore with an inline confirmation, offered by status and permission as above. No API, schema or
dependency change is needed (no migration, no ADR).

## Confidence

High for Q1–Q4 and Q6 (read from the pinned source and its db tests). Medium for the Salesforce
code meanings in S6 (secondary; the advice is phrased so that a wrong guess still points the user
to Salesforce's own message, which is always shown).

## Follow-ups

- When a "Salesforce sync" area joins the navigation (release note, P14), move the inbox to the
  IA's `/salesforce/issues` and redirect the Settings path.
- The shell's always-visible sync indicator (P9, IA §1) is not part of T-0092.

**Affects:** `apps/web/src/sync/`, `apps/web/src/router.tsx`, `apps/web/src/sections.ts`.
