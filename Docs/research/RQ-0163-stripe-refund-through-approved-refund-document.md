---
id: RQ-0163
title: How does an approved refund document send a Stripe refund once, and how are failures retried without a second refund or posting?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0172]
linked_adrs: [ADR-0074, ADR-0083, ADR-0008, ADR-0048]
superseded_by:
---

# RQ-0163 — Stripe refund through the approved refund document

## Question

T-0172 lets `PUT /ar/refunds/:id` accept `method: stripe` and makes the approve step send the
refund to Stripe (ADR-0074, DL-0477 item 3, DL-0562). Before building:

- Q1. A refund document (`app.customer_refund`) belongs to a party, not to a credit note. Which
  Stripe payment is refunded, without a schema change (no migrations in this round, DL-0569)?
- Q2. Which idempotency key makes the send happen once, and for how long does Stripe honour it?
- Q3. How is a failed send retried safely (never a second refund, never a second journal)?
- Q4. Which Stripe refund statuses may be posted, and what date does the entry carry?
- Q5. DL-0562 asks for step-up on the approve route *for a Stripe refund*. Can `@RequireStepUp`
  apply to Stripe refunds only, without moving the check into the controller?

## Why it matters

A wrong answer moves money twice (a duplicate refund at Stripe) or posts GP-006 twice, both
irrecoverable without manual work. Design §3.9 (idempotent commands), §5.6 (retries, Sync
issues), §6.2 (step-up), §6.5 (maker-checker).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | [RQ-0104](RQ-0104-stripe-webhooks-receipt-refund.md) S6 (`stripe@23.1.0` `Refunds.d.ts`) | 2026-11-15 | primary (types, via RQ) | `POST /v1/refunds` with `payment_intent`, integer-cent `amount`, `reason`, `metadata`; refund `status` is a string (`pending`, `requires_action`, `succeeded`, `failed`, `canceled`). |
| S2 | [RQ-0115](RQ-0115-stripe-invoice-payment-link.md) S5 (docs.stripe.com/api/idempotent_requests) | 2026-11-15 | primary (extract, via RQ) | `Idempotency-Key` up to 255 characters; keys may be pruned after 24 hours (a reused key after pruning is a new request); the same key with different parameters is an error; no personal data in keys. |
| S3 | `packages/outbox/src/queue.ts`, `packages/outbox/src/backoff.ts` (source code) | 2026-11-15 | source code | Outbox queue: `retryLimit 10`, `retryDelay 60`, backoff, `retryDelayMax 21600`. Delay after attempt c is between `min(21600, 60·2^c)` and `min(21600, 120·2^c)` seconds. |
| S4 | `apps/worker/src/outbox-worker.ts`, `packages/outbox/src/deliver.ts`, `sync-issues.ts` (source code) | 2026-11-15 | source code | A handler's effect and its inbox row commit in one tenant transaction; a failure rolls both back; `retryable === false` dead-letters at once; dead letters become Sync issues (design §5.6). |
| S5 | `packages/db/migrations/0051_payments_stripe_webhook.sql`, `0055_ar_customer_refund.sql`, `0070_ar_customer_refund_approval.sql` | 2026-11-15 | source code | `stripe_webhook_event` stores the PaymentIntent per invoice; `stripe_refund` (insert-only) stores credit note, PaymentIntent, key and `entry_id`; `customer_refund` is paid only by its own posted `ar_refund` entry (source id = refund id), unique entry per refund; approval rows are append-only. |
| S6 | `apps/api/src/tenancy/tenant.interceptor.ts`, `apps/api/src/authz/permission.decorator.ts` (source code) | 2026-11-15 | source code | Step-up is read from route metadata and checked in the interceptor, inside the tenant transaction, after the permission and before SoD. |
| S7 | `Docs/accounting/postings.md` GP-006 (Approved) | 2026-11-15 | internal (golden) | Variant (Stripe refund): line 2 is `setting:stripe.clearing_account`; Dr AR control (party) 220.00 / Cr Stripe clearing 220.00. |
| S8 | Computation from S3 (`node -e` of the bounds, 10 retries) | 2026-11-15 | experiment | Upper bound of all ten retry delays: 120+240+480+960+1920+3840+7680+15360+21600+21600 = 73,800 s ≈ 20.5 h. |

## Findings

1. A Stripe refund can only go back to the payment it refunds (S1: `payment_intent`). The
   destination is fixed by the original card payment, so choosing the payment is not a
   fraud-sensitive choice the way a bank account is (inference).
2. Without a schema change, the payment is found from data already stored (S5): the party's
   posted credit notes with open credit whose invoice has a stored Stripe PaymentIntent with
   enough left to refund (payment amount less `stripe_refund` amounts on it). The send writes the
   chosen credit note into `stripe_refund.credit_note_id`, and `stripe_refund.entry_id` equals
   `customer_refund.entry_id`, so the refund document and the Stripe refund are linked by the
   journal entry (S5).
3. One key per refund document — `lf-refund-v2-<refund id>` — makes every retry of the same
   document the same Stripe request (S2). The parameters are recomputed on retry; if they
   changed, Stripe answers an error instead of a second refund (S2).
4. Keys may be pruned after 24 hours (S2). Pg-boss retries finish within about 20.5 hours (S3,
   S8). A retry later than 23 hours after the approval could create a second refund, so it must
   not be sent automatically (inference from S2).
5. The outbox gives at-least-once delivery with an exactly-once database effect (S4). With the
   Stripe key per document and the posting key `ar-refund:<refund id>` (the same key the bank
   path uses), a redelivery either finds the refund paid (no call) or repeats the same Stripe
   request and posts once (S4, S5).
6. `pending`, `requires_action` and `succeeded` are the statuses the existing T-0074 path posts;
   `failed` and `canceled` are not posted (S1, `refund.ts`).
7. The money leaves when the refund is sent, so the entry is dated the send date (the tenant's
   report time zone, as the daily jobs do). The refund document requires `paid_on ≥ refund_date`
   (S5), so a Stripe refund dated in the future cannot be sent yet.
8. The interceptor already runs the step-up check inside the tenant transaction (S6), so a
   route-level condition evaluated there can read the refund's method under RLS. The check stays
   central, not in the controller (apps/api AGENTS.md).

## Conclusion / decision

- Choose the Stripe payment at send time: the party's oldest posted credit note whose open
  credit and whose invoice's Stripe payment both cover the refund amount. If none, refuse
  (`NO_STRIPE_PAYMENT`) — at request time too, so a Stripe refund is never requested that cannot
  be sent. One refund document refunds one payment; split larger refunds.
- Stripe Idempotency-Key `lf-refund-v2-<refund id>`; posting key `ar-refund:<refund id>`;
  metadata `lf_tenant_id`, `lf_company_id`, `lf_refund_id`, `lf_refund_no`, `lf_credit_note_id`,
  `lf_credit_note_no`.
- On approval: record the approval and an outbox event `ar.refund.stripe_approved` in the same
  transaction, then try the send in a savepoint. Success posts GP-006 (Stripe variant), allocates
  the refund against the credit note, writes `stripe_refund` and marks the refund paid. Any
  failure rolls back only the savepoint; the approval and the event commit and the outbox handler
  `stripe.refund.send` retries (pg-boss backoff, permanent failures to Sync issues).
- Never send automatically more than 23 hours after the approval (`KEY_EXPIRED`, permanent);
  someone must check Stripe first (follow-up card T-0189).
- Post only `pending`, `requires_action`, `succeeded`.
- Entry date = the send date in the tenant's report time zone. Approving a Stripe refund dated
  after today is refused (`NOT_DUE`).
- `@RequireStepUp(300, stripeRefundOnly)`: an optional condition evaluated by the interceptor in
  the tenant transaction. Bank refunds keep their current rules (step-up happens at batch
  release).

## Confidence

`medium-high`: the Stripe facts come from SDK types and an extract of the official docs (no live
key or network, as in RQ-0104/RQ-0115); the retry and database facts come from source code and
are proved by the T-0172 tests.

## Follow-ups

- T-0189: reconcile a Stripe refund whose send is older than 23 hours (list the PaymentIntent's
  refunds, match `lf_refund_id`, then record or resend).
- T-0190: a way to cancel an approved Stripe refund that Stripe refused permanently, so its
  amount stops counting as requested.
- Replace the documented fixture with a redacted test-mode recording when a key is available
  (RQ-0104 follow-up).

**Affects:** packages/connectors/stripe, packages/modules/ar, apps/api (refunds, step-up),
apps/worker, apps/web (refund region), ADR-0074, ADR-0083.
