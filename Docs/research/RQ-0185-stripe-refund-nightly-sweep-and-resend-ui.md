---
id: RQ-0185
title: How does a nightly sweep find Stripe refunds that no refund document records, without ever creating or recording one, and how does the refund region present the check and the two-person resend?
status: resolved
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0208]
linked_adrs: [ADR-0091, ADR-0103]
superseded_by:
---

# RQ-0185 — Nightly sweep for unrecorded Stripe refunds, and the check / resend screens

## Question

T-0189 (ADR-0091 and its r10 addendum, RQ-0173) gave the API a read-only Stripe check, a resend
request and a second-person confirmation. Strays — a live Stripe refund carrying a document's
`lf_refund_id` while that document is unapproved, approved but unrecorded, or cancelled (review r8
R2, r10 M1(c)) — are found only when someone checks that one document.

- **Q1.** Which documents does a nightly sweep look at, and how does it look without moving money,
  recording a journal or racing a send that is in flight?
- **Q2.** How does it report a stray so a person acts on it, once per document, tenant-isolated?
- **Q3.** What does a retry of that report do?
- **Q4.** How should the refund region show the check outcome and the two-person resend so the
  requester and the confirmer are clearly different people?
- **Q5.** How do comparable systems reconcile gateway refunds?

## Why it matters

Money out that the books do not show is a misstatement of AR and Stripe clearing (design §3, §5.6)
and, for a cancelled document, a risk of refunding the same credit twice by bank (ADR-0091
addendum). A sweep that recorded or created anything would itself be a money-out path without
maker-checker (design §6.5).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | RQ-0164 S1–S5, RQ-0173 S1–S3 (List Refunds by `payment_intent`; `Refund.status` pending, requires_action, succeeded, failed, canceled) | 2026-11-23 | primary (via RQ) | The lookup and the meaning of "live" the sweep reuses unchanged. |
| S2 | `packages/connectors/stripe/src/refund.ts` (`refundsAtStripe`, `checkStripeCustomerRefund`, `sendOrRecord`) | 2026-11-23 | source code | `checkStripeCustomerRefund` *records* a live refund for an approved document (posts GP-006 Stripe variant). The lookup alone (`refundsAtStripe`) is read-only and throws `SENT_NOT_POSTED` on two live refunds. Every send holds the party's advisory lock for its whole transaction, and the addendum keeps that transaction open while a Stripe request may still land (30 s deadline, 5 min idle timeout). |
| S3 | `packages/outbox/src/sync-issues.ts`, migration 0030, `apps/worker/src/sync-issue-worker.ts` | 2026-11-23 | source code | A Sync issue exists only as the dead letter of an outbox event delivered to a handler (`UNIQUE (tenant_id, event_id, handler)`); `retrySyncIssue` re-queues the event; a later successful delivery resolves it. A handler error with `retryable: false` dead-letters at once. |
| S4 | `apps/worker/src/daily-jobs.ts`, `security-notices.ts`, `inbox-poll-jobs.ts` (ADR-0062) | 2026-11-23 | source code | Scheduled work: an owner-side cron fan-out (lf_migrator, `app.active_tenant_ids()`), one job per active tenant and period with an id derived from queue, tenant and period, and the job runs as lf_app inside `withTenant` (RLS). |
| S5 | Design §5 (connectors: "the nightly reconciliation replays what was missed"), §5.6 (Sync issues inbox), §6.5 (maker-checker) | 2026-11-23 | design | Connector gaps are found by a nightly reconciliation and surfaced in Sync issues; money out needs two people. |
| S6 | Odoo 17.0 `addons/payment/data/payment_cron.xml` and `payment_transaction.py` `_cron_post_process` | 2026-11-23 | comparable OSS | A scheduled job revisits transactions whose post-processing did not finish; it never sends a new refund, it finishes the bookkeeping of what the provider already confirmed. |
| S7 | ERPNext develop `hooks.py` `scheduler_events` and Payment Reconciliation tool | 2026-11-23 | comparable OSS | Gateway/bank differences are found by scheduled or on-demand reconciliation and shown to a user for a decision; matching is a user action, not automatic posting. |
| S8 | Stripe docs, "Reconciliation" / Balance transactions and the `refund.created` / `charge.refund.updated` webhooks (stripe@23.1.0 type definitions, `Event.type`) | 2026-11-23 | primary | Stripe recommends reconciling your records against Stripe's objects periodically, and also emits refund events; webhooks can be missed, so periodic reconciliation is still advised. |
| S9 | `apps/web/src/purchases/StepUpPrompt.tsx`, `apps/web/src/sales/RefundRegion.tsx`, `Docs/ui/principles.md` | 2026-11-23 | source code / design | The existing step-up prompt (says why, nothing retried by itself); the region's state line and refusal patterns; P6 states and plain words. |

## Findings

1. **Candidates (Q1).** Every Stripe refund document that is `requested` (approved or not), and every
   `cancelled` one changed in the last 30 days. A paid document is recorded by definition. A stray on
   a cancelled document can only appear while a request was in flight at cancel time; the r10
   cooling-off (15 min) and the 30 s deadline mean it is at Stripe within minutes, so 30 days of
   nightly sweeps is ample margin and bounds the Stripe calls (S2).
2. **Read-only look (Q1).** Per document, in its own tenant transaction: take the party lock (so an
   in-flight send in another transaction has finished and committed or rolled back, S2), re-read
   the document, skip it if it is paid, then run the read-only lookup. Never call
   `checkStripeCustomerRefund` (it records) or any create. Two live refunds is itself a finding.
   Findings: `held_unapproved` (R2), `held_unrecorded` (approved, requested, not recorded),
   `held_cancelled` (r10 M1(c)), `several_live`.
3. **Report (Q2).** The only report surface with status, retry and audit is Sync issues, which needs
   an outbox event and a handler (S3). The sweep publishes one event
   `ar.refund.stripe_unrecorded` per stray document; the handler `stripe.refund.unrecorded_check`
   repeats the read-only look and throws a permanent `HELD_AT_STRIPE` error while the stray is still
   there, so the dead letter becomes the Sync issue with a plain message (what Stripe holds and what
   to do). Once per document: the sweep publishes nothing for a document that already has such an
   event that is not finished (no successful delivery of the handler and no resolved issue).
   Tenant isolation comes from `withTenant` per job (S4) and RLS on every table read.
4. **Retry (Q3).** Retrying the issue re-runs the read-only look: it succeeds (the issue resolves)
   once the document is paid (someone ran "Check with Stripe", or approved the R2 document, which
   adopts) or the stray is gone; otherwise it dead-letters again with the current facts. A retry
   never records or creates (the same rule as the sweep).
5. **Screens (Q4).** Show "Check with Stripe" to people with `ar.refund.approve` on an approved,
   requested Stripe document whose send failed or expired (not `SENT_NOT_POSTED`, whose retry is in
   Sync issues), and on an unapproved one never (approval itself looks first). Outcomes in words:
   recorded; held for an unapproved document (approve to record it, nothing is sent); held for a
   cancelled one (deal with it in Stripe); nothing at Stripe with the failed refund ids. "Ask to send
   again" needs a reason (1–500 characters, the API's rule). A waiting resend shows who asked, when
   and why — the GET view must therefore carry it, with the requester's display name. The requester
   sees "another Approver must confirm" and no confirm button; anyone else with the permission sees
   "Confirm and send again", which asks for the step-up first (StepUpPrompt, nothing retried by
   itself). The API (SoD + database CHECK) remains the authority.
6. **Comparable systems (Q5).** Odoo and ERPNext reconcile on a schedule and finish only the
   bookkeeping of what the provider confirmed, or show differences for a person to decide (S6, S7).
   Stripe advises periodic reconciliation even with webhooks (S8). A report-only sweep plus a
   person-driven check is the more conservative of these and matches maker-checker (S5).

## Conclusion

Build a nightly, per-tenant, read-only sweep that publishes one `ar.refund.stripe_unrecorded` event
per stray Stripe refund document; a read-only handler turns it into a Sync issue and resolves it
only when the document is recorded or the stray is gone. The GET refund view gains the waiting
resend (who, display name, when, why). The refund region offers the check, the reasoned resend
request and the step-up-guarded confirmation by another person. Decisions DL-0910 to DL-0915,
ADR-0103.
