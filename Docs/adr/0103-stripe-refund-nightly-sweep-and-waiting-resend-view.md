---
adr: 0103
title: "A nightly read-only sweep reports Stripe refunds no document records as Sync issues; the refund view shows the waiting resend"
status: Proposed
date: 2026-11-23
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0103: A nightly read-only sweep reports Stripe refunds no document records as Sync issues; the refund view shows the waiting resend

## Status
Proposed by claude for T-0208; accepted when CI is green and the cross-provider reviewer approves
(category integration: a new outbox topic and handler, a scheduled job, and an additive field of
the public refund view, design §10.6). It implements what ADR-0091 (Accepted, security) and its
r10 addendum left to T-0208 and does not change their money-out rules. Research: RQ-0185.
Decisions DL-0910 to DL-0915. No migration, no new permission, no runtime dependency.

## Context and problem statement
A stray — a live Stripe refund carrying a document's `lf_refund_id` while the document is not
approved, approved but not recorded, or cancelled, or two live refunds for one document — is found
today only when a person runs `POST /ar/refunds/:id/stripe-check` on that document (review r8 R2,
r10 M1(c)). The refund region does not offer that check or the two-person resend, and the refund
view does not say that a resend is waiting.

## Decision drivers
- Never move money and never record without a person (design §6.5, ADR-0091).
- Report through the existing Sync issues inbox (design §5.6) rather than a new surface.
- Tenant isolation and idempotency of scheduled work (ADR-0062).

## Considered options
1. **Sweep that records** (call `checkStripeCustomerRefund` nightly). Rejected: an unattended
   journal for money out; for an unapproved document it is not even allowed.
2. **New "strays" table and screen.** Rejected: needs a migration, a permission and a screen for
   what Sync issues already does (status, retry, ignore, audit).
3. **Read-only sweep + outbox event + read-only handler whose dead letter is the Sync issue.**
   Chosen.
4. **Stripe `refund.created` webhooks only.** Not now: webhooks can be missed, so a periodic
   reconciliation is still needed (RQ-0185 S8); a webhook path can be added later.

## Decision
- **Schedule.** The scheduler (lf_migrator) installs `stripe.refunds.sweep.fanout` at 15:35 UTC
  and sends one `stripe.refunds.sweep` job per active tenant and UTC day (job id derived from
  queue, tenant and day; the job data is `{ tenantId }` only). The worker consumes it only when
  Stripe is configured.
- **Candidates.** Each company's Stripe refund documents that are `requested`, or `cancelled` with
  a change in the last 30 days.
- **Per document**, in its own lf_app tenant transaction: the party lock, a re-read (a paid
  document is skipped), then the read-only lookup across the party's PaymentIntents. Findings:
  `held_unapproved`, `held_unrecorded`, `held_cancelled`, `several_live`.
- **Report.** One outbox event `ar.refund.stripe_unrecorded` (aggregate the document; payload
  refund id and number, finding, Stripe refund ids) per stray document, never while an earlier one
  for the document has not been delivered successfully. Its handler
  `stripe.refund.unrecorded_check` repeats the read-only look and throws `HELD_AT_STRIPE`
  (`retryable: false`) with a plain message while the stray is there, so the dead letter becomes
  one open Sync issue (connector `stripe`). A retry succeeds, and the issue resolves, once the
  document is recorded (a person's "Check with Stripe", or approving an R2 document) or the stray
  is gone.
- **Never.** The sweep and the handler call no Stripe create, write no journal, no
  `stripe_refund` row and no document status.
- **Refund view.** Every stored Stripe view (`GET /ar/refunds/:id` and the other routes that
  return it) carries `stripe.resend`: the unconfirmed resend `{ id, requested_by,
  requested_by_name, requested_at, reason }` or null. Right after a send it is null.
- **Refund region.** "Check with Stripe" for `ar.refund.approve` on an approved, requested Stripe
  document whose send failed or expired (not `SENT_NOT_POSTED`) and no resend waits; the outcome
  in words; "Ask to send again" with a required reason when `resendable`; the waiting resend shown
  to every reader; "Confirm and send again" only to someone with the permission who did not ask,
  behind the step-up prompt. The API's SoD rule and the database CHECK remain the authority.

## Consequences
- Strays across the company surface each night in Sync issues with what to do.
- A document whose report is ignored is not reported again until that report is delivered
  successfully (retry); this keeps one issue per document.
- Sweep cost is one list call per PaymentIntent of each candidate's party each night.
- Without Stripe configured, fan-out jobs are queued but not consumed (and expire), as for the
  other Stripe handlers.

## Links
RQ-0185, RQ-0173, ADR-0091 (and addendum), ADR-0062, ADR-0008, T-0208, DL-0910–DL-0915.
