---
id: RQ-0189
title: When may a requested bank refund be cancelled, and an unapproved refund request (either method) be withdrawn, without money leaving for a cancelled document?
status: resolved
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0207]
linked_adrs: [ADR-0107, ADR-0074, ADR-0083, ADR-0091]
superseded_by:
---

# RQ-0189 — Cancel a bank refund; withdraw an unapproved refund request

## Question

T-0190 (DL-0770) lets `POST /ar/refunds/:id/cancel` cancel only a requested **Stripe** refund
whose send failed or expired. Security review r10 (DL-0778) then also refused an *unapproved*
Stripe document and left "withdraw an unapproved request, by either method" to T-0207. Open points:

- **Q1.** May a requested `bank_batch` refund be cancelled, approved or not? What stops a cancel
  while a payment batch pays it?
- **Q2.** A refund in a **draft** (or partially released) batch: cancel it (and drop it from the
  batch), or refuse until the batch itself is cancelled? Released and confirmed batches are
  refused (the money is leaving or has left).
- **Q3.** Is there a race between building a batch and cancelling a refund?
- **Q4.** May an *unapproved* Stripe request be withdrawn without asking Stripe?
- **Q5.** Which permission, which SoD step, step-up, Idempotency-Key and audit?
- **Q6.** How do comparable systems handle this?

## Why it matters

A requested refund counts in `customerCredit.requested`, so a refund the customer no longer wants
locks its credit until it is paid. Cancelling one the bank is paying, or one Stripe already
refunded, would refund twice (design §3.9, §6.5).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/db/migrations/0055_ar_customer_refund.sql` (`customer_refund_guard`) | 2026-11-23 | source code | Only `requested → paid / cancelled`; `cancelled` is refused while a non-excluded line of a batch whose status is not `cancelled` pays the refund. `payment_batch_refund` is append-only. |
| S2 | `packages/db/migrations/0047_ap_payment_batch.sql` | 2026-11-23 | source code | Batch status `draft → partially_released → released`, or `→ cancelled` before release; "Only `status` and `updated_at` ever change; the total is frozen." |
| S3 | `packages/modules/ap/src/payment-batches.ts` `createPaymentBatch` | 2026-11-23 | source code | Takes the company's `ap-payment-batch:<company>` lock (not the refund party lock), reads requested approved bank refunds no live batch pays, then inserts the lines. No module function or route cancels a batch today. |
| S4 | `packages/db/migrations/0070_ar_customer_refund_approval.sql` | 2026-11-23 | source code | A payable batch line needs an approval (`payment_batch_refund_needs_approval`, BEFORE INSERT); it never checks the refund's status. |
| S5 | `packages/connectors/stripe/src/refund.ts` (`cancelStripeCustomerRefund`, `sendNotFinished`, `refundsAtStripe`) and `stripe-refund-followups.contract.db.test.ts` "a commit lost after the send" | 2026-11-23 | source code / test | The approve transaction sends to Stripe; if its commit is lost, Stripe holds a refund for a document that is unapproved again (security review r8 R2). `held_unapproved` is a real state. |
| S6 | PostgreSQL 17 docs, "Explicit Locking — Row-Level Locks" (https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) | 2026-11-23 | primary | `FOR SHARE` conflicts with `FOR NO KEY UPDATE` (taken by an UPDATE of non-key columns); `FOR KEY SHARE` (what a foreign-key check takes) does not. |
| S7 | PostgreSQL 17 docs, "Transaction Isolation — Read Committed" (https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED) | 2026-11-23 | primary | A `SELECT … FOR SHARE` that waited for a concurrent updater re-reads the newest committed version of the row; each statement sees what was committed before it began. |
| S8 | ERPNext `erpnext/accounts/doctype/payment_order/payment_order.py` (https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/payment_order/payment_order.py) | 2026-11-23 | comparable OSS | Submitting a Payment Order marks its requests "Payment Ordered"; a reference already in another order is refused; only cancelling the order resets the requests' status. |
| S9 | ERPNext `payment_request.py` `on_cancel` / `check_if_payment_entry_exists` (https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/payment_request/payment_request.py) | 2026-11-23 | comparable OSS | A payment request is cancelled as a document (status kept as history); cancel is refused once a payment entry exists ("Payment Entry already exists"). It does not check Payment Orders (a gap we do not copy). |
| S10 | Odoo 17 `addons/account/models/account_payment.py` (`action_cancel` "draft -> cancelled", `mark_as_sent`) (https://raw.githubusercontent.com/odoo/odoo/17.0/addons/account/models/account_payment.py) | 2026-11-23 | comparable OSS | Only a draft payment is cancelled; a posted one is first reset to draft. Sent payments are flagged, not deleted. |
| S11 | RQ-0173 (findings 1–4), ADR-0074, ADR-0083, ADR-0091 | 2026-11-23 | prior research | Live Stripe refund = `pending`, `requires_action`, `succeeded`; cancel is `ar.refund.create`, no SoD step, no step-up (no money moves); Stripe is asked under the party lock, fail closed. |
| S12 | Design §3.9 (idempotent commands), §6.5 (maker-checker for money out), `apps/api/AGENTS.md` (every mutating endpoint requires an idempotency key), DL-0642 / ADR-0097 (Idempotency-Key "not stored" for state-idempotent routes) | 2026-11-23 | design / repo rules | Mutations carry an Idempotency-Key; a route that is idempotent by state may require the header without storing it. |

## Findings

1. **Bank refund, no live batch (Q1).** Nothing has been sent: a bank refund leaves only in a
   released batch's bank file (S2, S3). Cancelling it moves no money, so approved or not makes no
   difference; the database (S1) already permits `requested → cancelled` when no live batch pays it.
2. **Draft batch (Q2).** A batch's lines are append-only and its total frozen at build (S1, S2), and
   releasers approve that frozen total (design §6.5). Dropping a line from a draft batch would mean
   changing what releasers approve, or a bank file whose total no longer matches the batch. ERPNext
   (S8) likewise frees a document held by a payment order only by cancelling the order; Odoo (S10)
   cancels only drafts of the *payment itself*. The consistent rule here: a refund in any live
   batch (draft, partially released, released, confirmed) is refused; the customer's credit is
   freed by cancelling the unreleased batch first. No batch-cancel exists yet (S3), so that becomes
   follow-up card **T-0241** (the database already allows `draft/partially_released → cancelled`).
3. **Race (Q3).** `createPaymentBatch` and the cancel take different advisory locks (S3), and the
   0070 insert trigger never reads the refund's status (S4). A batch build that read the refund as
   requested could insert its line after a cancel committed: a bank file paying a cancelled
   document. The 0055 guard only covers the opposite order, and only for lines already committed.
   A BEFORE INSERT trigger on `payment_batch_refund` that reads the refund `FOR SHARE` closes both
   orders: `FOR SHARE` conflicts with the cancel's row lock (S6) and re-reads the committed status
   (S7); a waiting cancel's guard then sees the committed line (S1, S7). A payable line for a refund
   that is not `requested` is refused. Excluded lines (no payment) stay allowed.
4. **Unapproved Stripe request (Q4).** Normally an unapproved document was never sent, because the
   approval and the send commit together. But a lost commit leaves Stripe holding a refund for a
   document that reads unapproved (S5). So a withdrawal still asks Stripe first, under the party
   lock, fail closed (503 when no client), and refuses `AT_STRIPE` when Stripe holds a live refund.
   The "send has finished" quiet window (r10 M1(b)) needs an approval and applies only to approved
   documents; for an unapproved one there is no committed send activity to wait on. The residual
   case (a send still in flight from a transaction that already rolled back, bounded by the 30 s
   Stripe deadline) is the same one r10 M1(c)/(d) already detect afterwards (a later create is
   refused and `stripe-check` lists `held_cancelled`).
5. **Who and how (Q5).** Withdrawing or cancelling reduces money out; it needs no checker and no
   step-up (S11, ADR-0074 drivers). The maker role is `ar.refund.create` (Owner, Finance Admin, AR
   Clerk): the person who can ask for a refund can take the request back. An Approver alone cannot
   cancel (they approve, they do not originate). The route requires an Idempotency-Key (S12),
   not stored: a cancel is idempotent by state (a repeat replays the cancelled refund, 200). Each
   first cancel is audited with before/after.

## Conclusion / decision

- `cancelCustomerRefund` cancels a requested refund by either method, approved or not:
  - **bank_batch:** refused `NOT_CANCELLABLE` while a live batch pays it (the message names the
    batch and its status); otherwise cancelled, no external call. The 0055 guard stays the backstop.
  - **stripe:** Stripe is asked first under the party lock (fail closed, `METHOD_NOT_AVAILABLE`
    without the connector; the API answers 503). An approved document also keeps the r10
    `SEND_NOT_FINISHED` guard. A live refund at Stripe is `AT_STRIPE`.
  - paid → `NOT_CANCELLABLE`; cancelled → replay.
- New migration (reserved 0086; local 0082): `payment_batch_refund_requested_only` BEFORE INSERT
  trigger refusing a payable line for a refund that is not `requested` (`FOR SHARE`).
- The refund view carries `payment_batch` (`{ id, batch_no, status }` with status `draft`,
  `partially_released`, `released` or `confirmed`) for a bank refund a live batch pays, so the
  refund region shows it and offers Cancel only when allowed.
- Route: `POST /ar/refunds/:id/cancel`, `ar.refund.create`, Idempotency-Key required (not stored),
  audited, no SoD step, no step-up; another tenant's refund 404. Recorded in ADR-0107.

## Confidence

High for Q1, Q3, Q5 (source code and PostgreSQL documentation). Medium-high for Q2 (a product rule;
comparable systems differ, ours follows the frozen-batch design). Q4's residual window is accepted
and already detected by r10 M1(c)/(d).

## Follow-ups

- T-0241 — AP: cancel an unreleased (draft or partially released) payment batch, so its bills and
  refunds can be re-batched or cancelled.
