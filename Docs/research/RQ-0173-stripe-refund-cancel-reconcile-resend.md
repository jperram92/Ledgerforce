---
id: RQ-0173
title: How is a Stripe refund document that Stripe refused, or whose send is older than 23 hours, cancelled, reconciled with Stripe or resent without ever refunding twice?
status: resolved
opened: 2026-11-16
resolved: 2026-11-16
opened_by: claude
linked_tasks: [T-0190, T-0189]
linked_adrs: [ADR-0083, ADR-0074, ADR-0091]
superseded_by:
---

# RQ-0173 — Cancel, reconcile and resend a Stripe refund document

## Question

T-0172 (ADR-0083 and its addendum, RQ-0163, RQ-0164) sends an approved Stripe refund document
once. Three cases are left open. In each one the document stays `requested` and keeps blocking the
customer's credit:

- **Q1 (T-0190).** Stripe refuses permanently, for example with `charge_disputed`. When may the
  document be cancelled? Who may cancel it? How do we know that no money left?
- **Q2 (T-0189 AC-1, review r8 R2).** The send is older than 23 hours (`KEY_EXPIRED`), or a commit
  was lost after Stripe accepted the refund and nobody approved the document again. How is the
  Stripe refund found and recorded once? Which date does the journal carry?
- **Q3 (T-0189 AC-2, review r8 R3).** Stripe holds no live refund for the document: it holds none,
  or only a `failed` or `canceled` one. What makes a resend safe? Which key does it use? Who must
  confirm it?
- **Q4.** How do comparable systems handle a refund that failed at the gateway?

## Why it matters

These are money-out paths (design §3.9 idempotent commands, §5.6 Sync issues, §6.2 step-up, §6.5
maker-checker). A second refund cannot be recovered without a manual chargeback to the customer. A
refund document that can be neither paid nor cancelled locks the customer's credit for good, and
`customerCredit.requested` overstates what is owed.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `npm pack stripe@23.1.0`, `package/esm/resources/Refunds.d.ts` (`Refund.status`, lines 126–133) | 2026-11-16 | primary (official SDK generated from Stripe's OpenAPI spec) | "Status of the refund. This can be `pending`, `requires_action`, `succeeded`, `failed`, or `canceled`." |
| S2 | same file, `Refund.failure_reason` and `failure_balance_transaction` (lines 88–95) | 2026-11-16 | primary | "After the refund fails, this balance transaction describes the adjustment made on your account balance that reverses the initial balance transaction." A failed refund gives the money back to the merchant's balance, so nothing reached the customer. |
| S3 | same file, `RefundResource.cancel` (lines 39–44) | 2026-11-16 | primary | "Cancels a refund with a status of requires_action. You can't cancel refunds in other states." A `canceled` refund moved no money. |
| S4 | same file, `Refund.created` (lines 67–70) | 2026-11-16 | primary | "Time at which the object was created. Measured in seconds since the Unix epoch." |
| S5 | RQ-0164 S1–S5 (List Refunds by `payment_intent`, `starting_after` paging, metadata is returned, keys may be pruned after 24 h) | 2026-11-15 | primary (via RQ) | The lookup and its limits, which this record reuses. |
| S6 | Odoo 17.0 `addons/payment_stripe/models/payment_transaction.py` `_send_refund_request` (https://raw.githubusercontent.com/odoo/odoo/17.0/addons/payment_stripe/models/payment_transaction.py) | 2026-11-16 | comparable OSS | Each refund is its own `payment.transaction` (operation `refund`) that calls `POST /v1/refunds`. A Stripe failure puts that transaction in state `error` or `cancel`; any new attempt is a new transaction with a new reference. No Idempotency-Key is sent for refunds. |
| S7 | Odoo 17.0 `addons/payment/models/payment_transaction.py` (`state` selection with `cancel` and `error`; `_compute_reference` adds a `-n` suffix to repeated references) | 2026-11-16 | comparable OSS | A retried operation gets a new reference, never the old one. |
| S8 | ERPNext develop `erpnext/accounts/doctype/payment_request/payment_request.py` (`on_cancel`, status `Cancelled`) | 2026-11-16 | comparable OSS | A payment request that was never paid is cancelled as a document; the status stays as history and nothing is deleted. |
| S9 | `packages/db/migrations/0055_ar_customer_refund.sql` (`customer_refund_guard`), `0070_ar_customer_refund_approval.sql` | 2026-11-16 | source code | Only `requested → paid / cancelled`; `cancelled` is refused while a live payment batch pays the refund; `paid` needs an approval row. `customerCredit.requested` counts `status = 'requested'` only. |
| S10 | `packages/connectors/stripe/src/refund.ts` (T-0172) | 2026-11-16 | source code | Every send holds the party's advisory lock for its whole transaction. Before each create it looks for a refund carrying this document's `lf_refund_id` and adopts the first match, in any state (a `failed` match ends as `REFUND_FAILED`). A cancelled document makes the outbox handler throw `NOT_PAYABLE`. |
| S11 | `packages/shared/src/sod/rules.ts`, `apps/api/src/sod/sod.decorator.ts`, migrations 0069 and 0071 | 2026-11-16 | source code | SoD rules are data that the API guard evaluates, and a migration mirrors their names. `smallTeamException` is set per rule. 0071 enforces "requester ≠ approver" in the database as well. |
| S12 | Design §6.5 (maker-checker for money out), §6.2 (step-up for money-out actions), §5.6 (Sync issues) | 2026-11-16 | design | A money-out action needs a second person and a fresh authentication. Connector failures surface in Sync issues. |

## Findings

1. **What "money is out" means at Stripe.** A refund in `pending`, `requires_action` or `succeeded`
   is live: money has left or may still leave (S1). A `failed` refund gives the money back to the
   merchant's balance (S2). A `canceled` one never moved money (S3). Only live refunds therefore
   count as "already sent" for this document. A failed or canceled one does not block a cancel or
   a resend, and it must never be adopted and posted. Today the lookup adopts the first match in
   any state (S10). That is safe, because a failed match ends as `REFUND_FAILED`, but it hides a
   live refund listed after a failed one. The lookup must collect every match and adopt the single
   live one. If it finds more than one live refund, it must stop and say so.
2. **Cancel (Q1).** A requested document has no recorded Stripe refund, because only a paid
   document has a `stripe_refund` row (S10). Stripe can still hold one: a commit lost after the
   send is review r8 R2, and it can leave the document unapproved. A cancel must therefore run the
   same lookup at Stripe. It must hold the party lock, so that no send of the same party runs at
   the same time (S10). It must refuse while Stripe holds a live refund. It must fail closed when
   Stripe cannot be asked. After the cancel, the database guard (S9) keeps the document cancelled
   for good. `customerCredit` stops counting it. The outbox handler must treat it as done; today it
   throws `NOT_PAYABLE`, which would reopen a Sync issue on every retry. Comparable systems cancel
   the unpaid document and keep it as history (S6, S8).
3. **Who cancels.** A cancel moves no money and frees credit, and spending that credit again needs
   a new approved document. It is the maker withdrawing a request (S12), so it needs neither a
   checker nor a step-up. The API names one permission per route (`RequirePermission`). Accepting
   "create or approve" would change the authorisation framework, which is a security change outside
   this card. The roles with `ar.refund.create` are Owner, Finance Admin and AR Clerk; Owner and
   Finance Admin also approve. Requiring `ar.refund.create` lets the people who own the request
   withdraw it. The Approver role, which only checks, does not cancel.
4. **Reconcile (Q2).** For a document older than 23 hours, the lookup is the reconciliation. A live
   refund carrying `lf_refund_id` is adopted and posted once through the existing path (GP-006
   Stripe variant, posting key `ar-refund:<id>`). The journal carries the date the money left,
   which is the refund's `created` time (S4) as a calendar date in the tenant's report time zone,
   as for the daily jobs. Adopting moves no money, so a retry from Sync issues (the outbox handler)
   may do it automatically. Only a create is limited by the 23-hour window. An unapproved document
   with a live refund at Stripe (R2) cannot be recorded, because 0070 needs an approval row
   before paid. A check must say so ("approve it to record it"); the approval then adopts and never
   creates. Finding such strays across the whole company needs a scheduled sweep (follow-up card).
5. **Resend (Q3).** A resend must never reuse `lf-refund-v2-<id>`. Within 24 hours Stripe would
   replay the failed refund; after pruning, the request would be new but indistinguishable (S5).
   It needs a new key that is recorded before the call, so a retry of the resend repeats the same
   request: `lf-refund-v3-<resend id>`. A new attempt gets a new reference, as in Odoo (S6, S7).
   It is allowed only when the normal send is blocked (older than 23 hours, or Stripe holds only
   failed or canceled refunds for the document) and Stripe holds no live refund. One person asks
   and another person confirms (S12). The rule allows no small-team exception, because this is the
   riskiest money-out step and a sole user can still cancel and refund by bank. The database
   enforces the same rule, as 0071 does (S11). Confirming sends money, so it needs a step-up no
   older than 300 s (ADR-0083). The send's own 23-hour window then runs from the confirmation.
6. **Comparable systems (Q4).** Odoo records a gateway failure on the refund transaction and lets a
   user start a new one, with no lookup and no second person (S6, S7). ERPNext cancels unpaid
   payment requests (S8). LedgerForce stays stricter than both: it looks up before every create,
   uses a recorded new key, and requires two people for a resend.

## Conclusion / decision

- **Live** means `pending`, `requires_action` or `succeeded`. The lookup collects every refund
  carrying the document's `lf_refund_id` across the party's PaymentIntents. It adopts the single
  live one. If there are two or more live ones, it stops with `SENT_NOT_POSTED`.
- **T-0190:** `POST /ar/refunds/:id/cancel` (`ar.refund.create`, no SoD step, no step-up, audited).
  It cancels a requested Stripe refund document (approved or not) only after the lookup, under the
  party lock, finds no live refund at Stripe. Otherwise it answers 409 `AT_STRIPE` with the Stripe
  refund id. It answers 503 when no Stripe client is configured, and 422 `NOT_CANCELLABLE` when
  the document is paid or is a bank refund (bank cancel is follow-up card T-0207). A repeat
  replays. The outbox handler does nothing for a cancelled document. The refund view shows a
  failed send from its open Sync issue, so the region can offer Cancel after a reload.
- **T-0189:** a send older than its window does the lookup first. It adopts a live refund dated at
  Stripe, or refuses `KEY_EXPIRED` when there is nothing to adopt. Every adoption is dated by the
  Stripe refund's `created` time. `POST /ar/refunds/:id/stripe-check` (`ar.refund.approve`) records
  a live refund of an approved document, or reports what Stripe holds; it never creates. A resend is
  `PUT /ar/refunds/:id/stripe-resends/:resendId` (ask, `ar.refund.approve`), then
  `POST …/:resendId/confirm` (`ar.refund.approve`, step-up 300 s, SoD
  `SOD_REFUND_RESEND_SELF_CONFIRM` with no small-team exception, database-enforced). Each resend
  gets a recorded key `lf-refund-v3-<resend id>`. Recorded in ADR-0091 (migration 0076).

## Confidence

`medium-high`. The Stripe facts come from the official SDK's generated types (no live key or
network to docs.stripe.com was available from this sandbox; the proxy refused the tunnel). The
behaviour of comparable systems comes from their source. The database facts come from migrations
and are proved by tests.

## Follow-ups

- T-0207: cancel a requested bank refund that no live batch pays.
- T-0208: refund region for the Stripe check and the resend (ask and confirm), and a nightly sweep
  that lists requested Stripe documents with a live refund at Stripe (review r8 R2 at scale).
- Replace the documented fixtures with a redacted test-mode recording when a key is available
  (RQ-0104 follow-up).

**Affects:** packages/connectors/stripe, packages/modules/ar, packages/db (migration 0076),
packages/shared (SoD rule), apps/api (refund routes), apps/web (refund region).
