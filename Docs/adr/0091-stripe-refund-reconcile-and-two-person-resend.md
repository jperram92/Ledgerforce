---
adr: 0091
title: "A stale or failed Stripe refund is reconciled with Stripe first; a resend needs a second person, a step-up and a new recorded key"
status: Accepted
date: 2026-11-17
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0091: A stale or failed Stripe refund is reconciled with Stripe first; a resend needs a second person, a step-up and a new recorded key

## Status
Accepted under the product owner's standing instruction DL-0691. The building agent decides open
security questions after research that compares standards and comparable systems. Here the
research is RQ-0173, and the decisions are DL-0773 to DL-0777. Category: security (money out,
segregation of duties). It also changes the data model (migration reserved as 0077), the public
API and the integration contract (design §10.6). It extends ADR-0083 and its addendum, and
ADR-0074. It supersedes neither.

## Context and problem statement
ADR-0083 sends an approved Stripe refund document once, with Idempotency-Key
`lf-refund-v2-<refund id>`. It never sends one automatically more than 23 hours after the
approval (`KEY_EXPIRED`), because Stripe may prune the key after 24 hours. Security review r8
left two residuals:

- **R2.** A commit can be lost after a successful send. Stripe then holds a refund that carries
  `lf_refund_id`, and LedgerForce has no `stripe_refund` row for it; the document may even be
  unapproved again.
- **R3.** A refund that was sent, or adopted, and that Stripe reports `failed` or `canceled`
  stops as `REFUND_FAILED`, with no way forward.

T-0189 asks for a safe path in both cases. The path must never refund the customer twice.

## Decision drivers
- Never a second refund (design §3.9); every create is preceded by a lookup (RQ-0164).
- Maker-checker for money out (design §6.5, ADR-0074); step-up for money-out actions (§6.2,
  ADR-0083).
- Record what happened at the date it happened (GP-006 Stripe variant, design §3).
- Forward-only, additive schema; tenant isolation (AGENTS.md §4).

## Considered options
1. **Lift the 23-hour rule and rely on the lookup alone.** Rejected. The lookup makes a duplicate
   unlikely, but an automatic resend days later is still a fresh money-out decision. Stripe's list
   is also not a transaction with our database.
2. **Resend under the old key.** Rejected. Within 24 hours Stripe replays the failed refund (R3).
   After pruning, the request cannot be told apart from a new refund.
3. **Reconcile first, then a two-person resend with a new key recorded before the call.** Chosen.
4. **Send a resend from the worker only.** Rejected for the same reason as ADR-0083 option 4: the
   person confirming would not see the result.

## Decision outcome
- **Live** means a Stripe refund in `pending`, `requires_action` or `succeeded`. A `failed` refund
  gave the money back to the balance, and a `canceled` one moved none, so neither counts as sent
  and neither is ever adopted. The lookup collects every refund that carries the document's
  `lf_refund_id` across the party's PaymentIntents. It adopts the single live one. If it finds
  two or more, it stops with `SENT_NOT_POSTED`, and nothing is recorded or sent.
- **Send past the window (AC-1).** The window is 23 hours from the approval, or from the latest
  confirmed resend. Past it, the send (and so a retry from Sync issues) looks up first. It adopts
  a live refund and posts it once: GP-006 Stripe variant, posting key `ar-refund:<id>`, journal
  attributed to the approver. With nothing live it refuses `KEY_EXPIRED`, and the message names
  both ways forward.
- **Adoption is dated at Stripe.** Every adopted refund is dated its Stripe `created` time, as a
  calendar date in the tenant's report time zone, and never before the document's date.
- **Check.** `POST /ar/refunds/:id/stripe-check` (`ar.refund.approve`, no step-up: no money
  moves) never creates. It answers `recorded` when the document is paid, or when it records a
  live refund for an approved document. It answers `held_unapproved` for R2 when the document is
  not approved; approving it then adopts and sends nothing. Otherwise it answers `not_at_stripe`,
  with the failed refund ids and `resendable`.
- **Resend (AC-2, R3).**
  `PUT /ar/refunds/:id/stripe-resends/:resendId` (`ar.refund.approve`, SoD step
  `refund_resend.request`, reason 1–500 characters) is allowed only for an approved, requested
  Stripe document whose normal send is blocked (past the window, or a failed or canceled refund
  at Stripe) and for which Stripe, asked now under the party lock, holds no live refund. The
  answers are 409 `AT_STRIPE`, 422 `NOT_BLOCKED`, and 422 when another resend is already
  waiting. The row records the key `lf-refund-v3-<resend id>` before any call.
  `POST …/:resendId/confirm` (`ar.refund.approve`, step-up 300 s, SoD `refund_resend.confirm`)
  is refused to the person who asked: rule `SOD_REFUND_RESEND_SELF_CONFIRM`, always, with no
  small-team exception. Then, as approval does, it writes an outbox event
  `ar.refund.stripe_approved` and sends in a savepoint with the resend's key. The lookup still
  comes first. A repeat by the same person replays without a Stripe call.
- **Database.** Table `app.customer_refund_stripe_resend` (migration reserved as 0077):
  - The key is fixed by a CHECK (`lf-refund-v3-` || id).
  - `confirmed_by <> requested_by` is a CHECK named `SOD_REFUND_RESEND_SELF_CONFIRM`, and the
    guard enforces it too.
  - An insert needs an approved, requested Stripe document.
  - The only update sets `confirmed_by` once; `confirmed_at` is stamped by the trigger.
  - At most one unconfirmed resend exists per document.
  - RLS is ENABLE + FORCE. lf_app has SELECT and INSERT, and UPDATE (`confirmed_by`) only.
  - The SoD mirror functions gain the two steps and the rule.

## Consequences
- A refund document can always reach an end: paid (sent, adopted or resent) or cancelled
  (T-0190).
- A small team of one cannot resend. It can cancel the document and refund by bank, which goes
  through the batch release controls.
- Refunds adopted on the inline path are now dated their Stripe date rather than the day of
  adoption. The two dates differ only when a commit was lost.
- The refund region does not yet offer the check or the resend. That is card T-0208, together
  with a nightly sweep that finds R2 strays across the company.

## Addendum (2026-11-22, security review r10): no cancel while a send may still land
Added by claude for findings M1, L1, L2, L3 and L4 of security review r10 (DL-0778, DL-0779). It
strengthens the decision above and T-0190's cancel (DL-0770); it does not change this ADR's
status.

- **Deadlines.** Every Stripe request is abandoned after 30 s. A send sets
  `idle_in_transaction_session_timeout` to 5 min, so the database never ends a sending transaction
  (and releases the party lock) while one of its requests is still waiting.
- **Cancel only a finished, quiet send.** An approved document is cancelled only when its window
  has passed, or the worker gave up (an open or ignored Sync issue, none being retried), and no
  send activity happened in the last 15 minutes. Otherwise the answer is 422 `SEND_NOT_FINISHED`.
  Unapproved documents are not cancelled here (T-0207).
- **Never create past a stray.** Before any create, the lookup also lists live refunds carrying a
  cancelled Stripe document of the same customer; one there refuses
  `CANCELLED_REFUND_AT_STRIPE`. `stripe-check` reports such refunds (`held_cancelled`,
  `cancelled_held_at_stripe`).
- **L2.** A live refund of another amount or currency is `SENT_NOT_POSTED`.
- **L3.** The confirm handler re-checks the verified step-up.
- **L4.** Posting dates follow the engine's resolved date (the lock-date policy).
- **I1.** A refund that fails after it was recorded paid is card T-0229 (renumbered from T-0217 at merge).

