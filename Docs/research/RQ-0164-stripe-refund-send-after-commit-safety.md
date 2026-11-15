---
id: RQ-0164
title: How does a Stripe refund send stay single when the posting or the commit fails after Stripe accepted it?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0172]
linked_adrs: [ADR-0083, ADR-0074, ADR-0008, ADR-0025]
superseded_by:
---

# RQ-0164 — Stripe refund send: posting and commit failures after Stripe said yes

## Question

Security review r8 of T-0172 (findings F1–F3, F5) found:

- Q1 (F1a). `sendStripeCustomerRefund` calls `POST /v1/refunds` and only then posts GP-006. A
  posting refusal after Stripe accepted the refund (period closed, account inactive) is classed
  as transient and retried until `KEY_EXPIRED`: money is out, the books do not show it and the
  Sync issue does not say Stripe already refunded. What can be checked before the call, and how
  is a post-send failure reported?
- Q2 (F1b). If the request transaction fails to commit after a successful send, the approval
  rolls back; a re-approval more than 24 hours later has a fresh `approved_at`, passes the
  23-hour check and Stripe may have pruned the key, so a second refund could be created. How is
  that made impossible?
- Q3 (F2). Can a method-level unconditional `@RequireStepUp` inherit a class-level condition?
- Q4 (F3). The step-up condition and the handler read the refund separately (READ COMMITTED);
  how does the handler know the step-up was enforced for this request?
- Q5 (F5). Can the worker's retried posting be attributed to the approver without a schema
  change?

## Why it matters

A duplicate Stripe refund or a refund missing from the books is irrecoverable without manual
work (design §3.9 idempotent commands, §5.6 Sync issues, §6.2 step-up, §6.5 maker-checker).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `npm pack stripe@23.1.0`, `esm/resources/Refunds.d.ts` (`RefundResource.list`, `RefundListParams`) and `esm/resources/Refunds.js` | 2026-11-15 | primary (official SDK, generated from Stripe's OpenAPI spec) | `list(params?: RefundListParams)` is `GET /v1/refunds` ("Returns a list of all refunds you created … most recent refunds appearing first"); `RefundListParams` has `payment_intent` ("Only return refunds for the PaymentIntent specified by this ID"), `charge`, `created`, and the pagination params. |
| S2 | same package, `esm/shared.d.ts` `PaginationParams`, `esm/lib.d.ts` `ApiList<T>` | 2026-11-15 | primary (SDK types) | `limit` "can range between 1 and 100, and the default is 10"; `starting_after` is the cursor (an object id); a list is `{ object: 'list', data: T[], has_more: boolean, url }`. |
| S3 | same package, `esm/StripeResource.js` line 61 | 2026-11-15 | primary (SDK source) | `dataInQuery = requestMethod === 'GET' \|\| requestMethod === 'DELETE'`: list parameters go in the query string, form-encoded like POST bodies. |
| S4 | same package, `esm/resources/Refunds.d.ts` `Refund.metadata: Metadata \| null` | 2026-11-15 | primary (SDK types) | A Refund object returns the metadata it was created with. |
| S5 | [RQ-0115](RQ-0115-stripe-invoice-payment-link.md) S5 (docs.stripe.com/api/idempotent_requests) | 2026-11-15 | primary (extract, via RQ) | Keys may be pruned after 24 hours; a reused key after pruning is a new request. |
| S6 | `packages/ledger/src/posting-engine.ts` `preview()` | 2026-11-15 | source code | "the journal post() would write for this command, built by the same steps, or the same typed error post() would throw. Reads only" — period (resolvePostingDate), accounts, roles, party, dimensions, users. |
| S7 | `packages/ledger/src/subledger.ts` `allocate()` | 2026-11-15 | source code | Refuses ACCOUNT_MISMATCH, PARTY_MISMATCH, CURRENCY_MISMATCH, SAME_SIDE, DATE_BEFORE_DOCUMENT, OVER_ALLOCATION, UNKNOWN_USER. |
| S8 | `packages/outbox/src/sync-issues.ts` `describeFailure`, `isPermanentFailure` | 2026-11-15 | source code | A Sync issue stores the thrown error's `errorCode` and message; `retryable === false` dead-letters at once. |
| S9 | `apps/api/src/authz/permission.decorator.ts`, `apps/api/src/tenancy/tenant.interceptor.ts` | 2026-11-15 | source code | Max age and condition are separate metadata keys, each falling back to the class independently; the interceptor skips the condition when the session is already fresh and passes nothing to the handler. |

## Findings

1. Everything that can refuse the posting is readable before the call: `preview()` runs the
   same validation as `post()` and throws the same typed error (S6); the allocation's own
   refusals (S7) can be checked against the open item and the previewed AR line (same account,
   party, currency, opposite sides, date not before the credit note, amount within both).
2. Stripe can be asked whether a refund already exists for this document: `GET /v1/refunds?
   payment_intent=…&limit=100`, paging with `starting_after` while `has_more` (S1–S3), and
   matching `metadata.lf_refund_id` (and `lf_company_id`), which every send sets (S4). Stripe has
   no search endpoint for refunds in the SDK's resources, so listing per PaymentIntent is the way.
3. With that lookup before every create, a lost commit or pruned key cannot cause a second
   refund: the second send adopts the first (inference from 2 and S5). The 23-hour `KEY_EXPIRED`
   rule stays as a second guard and keeps T-0189 for sends older than that.
4. After Stripe accepted (or an existing refund was adopted), a failure to post is not transient
   in any useful sense: retrying hides that money is out. It must be permanent
   (`retryable: false`) with its own code so the Sync issue says so (S8).
5. Sending only from the worker after commit (ADR-0083 option 4) would also avoid (b), but not
   (a), and the approver would not see the result; with the lookup the inline send is as safe.
6. F2: storing `{ maxAge, when }` under one metadata key makes the handler's declaration replace
   the class's as a whole (S9).
7. F3: the interceptor knows whether the session met the route's max age; recording that in the
   request scope lets the handler refuse a Stripe refund it was not verified for, whatever the
   condition saw.
8. F5: the refund view already carries `approvedBy` (from `customer_refund_approval`), a user of
   the tenant; using it as `createdBy` when the caller passes none needs no schema change.

## Conclusion / decision

- Before any Stripe call: local checks, then look up an existing Stripe refund with
  `lf_refund_id` = the refund id on every candidate PaymentIntent of the party (its posted credit
  notes' Stripe payments), then pre-check the posting (`preview()`) and the allocation. A refusal
  with no existing Stripe refund is `NOT_POSTABLE` ("not sent to Stripe"); with one it is
  `SENT_NOT_POSTED`.
- If a matching refund exists, adopt it (no create); otherwise create as before.
- Any failure after Stripe accepted or was adopted is `SENT_NOT_POSTED`, `retryable: false`,
  with the Stripe refund id in the message and in the API's `stripe` view (`code`), and a
  distinct sentence in the refund region. A later retry (Sync issues) adopts and posts once.
- Keep the inline send; do not move it to the worker only.
- F2: one metadata value `{ maxAge, when }`. F3: the interceptor records the verified step-up
  max age in the request scope; the approve handler refuses a Stripe refund without it (401
  `step_up_required`). F5: default `createdBy` to the approver.

## Confidence

`medium-high`: Stripe facts from the official SDK's generated types and source (no live key or
network, as RQ-0104/RQ-0115/RQ-0163); the database and framework facts are from source code and
proved by tests.

## Follow-ups

- T-0189 still covers a send older than 23 hours (manual check, then record or resend).
- Replace the documented fixture with a redacted test-mode recording when a key is available.

**Affects:** packages/connectors/stripe, apps/api (refunds, authz, tenancy), apps/web (refund
region), ADR-0083 (addendum).
