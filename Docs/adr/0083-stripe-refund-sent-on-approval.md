---
adr: 0083
title: "A Stripe refund is sent by the approve step, once, with step-up; failures retry through the outbox"
status: Accepted
date: 2026-11-15
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0083: A Stripe refund is sent by the approve step, once, with step-up; failures retry through the outbox

## Status
Accepted under the product owner's delegation: DL-0562 (step-up on approving a Stripe refund,
decided 2026-11-14 under DL-0477) and DL-0477 item 3 ("a Stripe refund is sent only after
approval"). Category: security (money out, authentication strength) and public API / integration
contract (design §10.6). Research: RQ-0163. Recorded in DL-0660. Extends ADR-0074; it does not
supersede it.

## Context and problem statement
ADR-0074 made refunds maker-checker but left `method: stripe` refused (`METHOD_NOT_AVAILABLE`),
because T-0074's `refundCreditViaStripe` refunds a credit note straight to Stripe with no
approval. T-0172 lets the refund document carry Stripe refunds. Approving one moves money at
once — there is no later release step as there is for a payment batch — so the approval needs the
same fresh authentication as releasing a batch (DL-0562), and the Stripe call must happen once
even when the network or the worker fails.

## Decision drivers
- Maker-checker and no second payment path (ADR-0074, design §6.5, COSO control activities).
- Fresh authentication for money-out actions (design §6.2, ADR-0025, OWASP ASVS V2/V4).
- Exactly-once effect: never two Stripe refunds, never two journals (design §3.9, §5.6).
- No schema change in this round (DL-0569); forward-only migrations otherwise.

## Considered options
1. Step-up on every refund approval (bank too). Rejected: bank refunds already pass step-up when
   the batch is released; doubling it adds friction without a control gain, and DL-0562 is
   scoped to Stripe refunds.
2. Check the method and demand step-up in the controller. Rejected: authorisation stays in the
   interceptor, never ad hoc in controllers (apps/api AGENTS.md).
3. **`@RequireStepUp(300, stripeRefundOnly)`**: the decorator takes an optional condition that
   the interceptor evaluates inside the tenant transaction, after the permission check and before
   SoD. Chosen.
4. Send only from the worker (asynchronous). Rejected as the only path: the approver would not
   see the result. Kept as the retry path.

## Decision outcome
- **Request.** `PUT /ar/refunds/:id` accepts `method: stripe` when the party has a posted credit
  note with open credit whose invoice was paid through Stripe with enough left to refund
  (RQ-0163); otherwise 422 `NO_STRIPE_PAYMENT`. One refund document refunds one payment.
- **Approve.** `POST /ar/refunds/:id/approve` keeps `ar.refund.approve` and SoD
  `refund.approve` (`SOD_REFUND_SELF_APPROVAL`). For a Stripe refund it also needs a step-up no
  older than 300 s (401 `step_up_required`, `max_age: 300`); a bank refund does not. Another
  tenant's refund is 404 (the condition sees nothing under RLS and the handler answers 404). A
  Stripe refund dated after today (tenant report time zone) is refused, 422 `NOT_DUE`. The
  route answers 503 `stripe_refunds_unavailable` when the deployment has no Stripe client or
  outbox.
- **Send once.** In the approval's transaction: the approval row, then an outbox event
  `ar.refund.stripe_approved` (aggregate `customer_refund`), then — in a savepoint — the send:
  `POST /v1/refunds` with Idempotency-Key `lf-refund-v2-<refund id>`, then GP-006 Stripe variant
  (Dr AR control (party) / Cr `setting:stripe.clearing_account`, source `ar_refund`, source id =
  the refund id, posting key `ar-refund:<refund id>`, dated the send date), allocation against the
  credit note, a `stripe_refund` row with the same `entry_id`, and the refund marked paid. The
  response carries `stripe: { status: sent | pending | failed, stripe_refund_id, message }`.
- **Retry.** A failure rolls back the savepoint only. The outbox handler `stripe.refund.send`
  repeats the send; a paid refund is a no-op. Pg-boss backoff retries a transient failure; a
  permanent one (Stripe 4xx, `NO_STRIPE_PAYMENT`, `KEY_EXPIRED`) goes to Sync issues at once.
  No automatic send happens more than 23 hours after the approval (Stripe prunes keys after
  24 hours), `KEY_EXPIRED`; reconciliation with Stripe is card T-0189.
- **Direct path closed.** `refundCreditViaStripe` now needs the id of an approved Stripe refund
  document and goes through the same send; without one it refuses `NOT_APPROVED`.

## Consequences
- Approvers of Stripe refunds need an MFA session refreshed within five minutes; the screen shows
  the existing step-up prompt.
- A refund Stripe refuses permanently stays approved and requested until T-0190 adds a cancel.
- `stripe_refund.entry_id = customer_refund.entry_id` links the two records without a migration.
