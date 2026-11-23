---
adr: 0107
title: "Cancel a requested customer refund by either method: bank refunds outside a live batch, unapproved requests after a Stripe lookup"
status: Accepted
date: 2026-11-23
author: claude
category: security
human_gate: yes (accepted under the owner's delegation DL-0691, with research RQ-0189)
supersedes: none
superseded_by: none
---

# ADR-0107: Cancel a requested customer refund by either method

## Status

Accepted on 2026-11-23 by claude under the product owner's standing instruction DL-0691 (the
building agent decides open security choices after research), backed by RQ-0189. It changes who
may stop a refund document and when (security model), adds a database guard (data model) and
changes a route and a response shape (public API), so design §10.6 requires this record. The
independent security review and the cross-provider review of T-0207 still apply to the code.
Decision log: DL-0950..DL-0955. Task: T-0207. It extends ADR-0074 (refund routes) and the T-0190
cancel recorded in RQ-0173; neither is edited.

## Context and problem statement

`POST /ar/refunds/:id/cancel` (T-0190) cancelled only an approved Stripe refund whose send failed
or expired; security review r10 L1 (DL-0778) also refused an unapproved Stripe document and left
"withdraw an unapproved request, by either method" and the bank refund cancel to T-0207. A
requested bank refund counts in `customerCredit.requested` until a payment batch pays it, so a
refund the customer no longer wants locks the credit. RQ-0189 found:

- a bank refund leaves only in a released batch's bank file; batch lines are append-only and the
  batch total is frozen at build (migrations 0047, 0055), and no batch cancel exists yet;
- the batch build and the refund cancel take different advisory locks, so without a new guard a
  batch could insert a payable line for a refund cancelled a moment earlier;
- an unapproved Stripe document can still be held at Stripe after a lost commit (review r8 R2).

## Decision drivers

- No refund may leave twice, and none may leave for a cancelled document (design §3.9, §6.5).
- Releasers approve a batch's frozen total; its contents must not change under them (§6.5).
- Fail closed when an external system cannot be asked (ADR-0083, RQ-0173).
- The person who asks for a refund can take the request back (maker-checker only gates money out).
- Every mutating route carries an Idempotency-Key and is audited (`apps/api/AGENTS.md`).

## Considered options

1. **Refuse while any live batch pays the refund; DB guard on new batch lines** (chosen).
2. **Allow cancelling a refund in a draft batch and skip its line at release and confirmation.**
3. **Keep bank refunds uncancellable; tell users to wait for the batch.**

### Option 1 — Refuse in any live batch, guard new lines

- Good, because it matches the existing 0055 guard exactly (one definition of "live").
- Good, because the batch total releasers approve never changes.
- Good, because the 0082 trigger closes the race in both orders inside the database.
- Bad, because a refund caught in a draft batch stays until that batch can be cancelled
  (follow-up T-0241).

### Option 2 — Cancel out of a draft batch

- Good, because the customer's credit is freed at once.
- Bad, because it changes an approved frozen total, needs the 0055 guard replaced, and every
  consumer (ABA export, confirmation, GP-006 posting) must learn to skip cancelled lines.

### Option 3 — No bank cancel

- Bad, because the credit stays locked by a document nobody wants (the T-0207 problem).

## Decision outcome

Chosen option: **Option 1**, because it keeps one rule for "live batch", keeps the released
contents fixed and puts the race guard in the database.

Rules:

1. `cancelCustomerRefund` cancels a **requested** refund, approved or not, under the party lock.
   Paid → 422 `NOT_CANCELLABLE`; cancelled → replay (200, `replayed: true`).
2. **bank_batch:** refused 422 `NOT_CANCELLABLE` while a payable line of a batch whose status is
   not `cancelled` pays it (draft, partially released, released, confirmed); the message names the
   batch and its state. No external call. The 0055 guard remains the backstop.
3. **stripe:** Stripe is asked first (read-only lookup by `lf_refund_id`); without the Stripe
   connector the module refuses `METHOD_NOT_AVAILABLE` and the API answers 503. A live refund at
   Stripe is 409 `AT_STRIPE`. An approved document also keeps r10's `SEND_NOT_FINISHED`
   (send finished and 15 minutes quiet). An unapproved document has no committed send activity to
   wait on; the lookup alone decides.
4. Migration 0082 (reserved 0086): `payment_batch_refund_requested_only`, BEFORE INSERT on
   `app.payment_batch_refund`, reads the refund `FOR SHARE` and refuses a payable line for a
   refund that is not `requested`. Excluded lines are unaffected.
5. Route `POST /ar/refunds/:id/cancel?company_id=`: permission `ar.refund.create` (Owner, Finance
   Admin, AR Clerk); no SoD step and no step-up (no money moves; it only lowers what can leave);
   `Idempotency-Key` header required (400 `idempotency_key_required`; not stored — the route is
   idempotent by state, as ADR-0097); audited with before/after on the first cancel; another
   tenant's refund 404; a malformed id 400.
6. The refund view of a bank refund carries `payment_batch: { id, batch_no, status } | null`
   (`status` is `draft`, `partially_released`, `released` or `confirmed`). The refund region
   offers Cancel for a requested bank refund with no `payment_batch`, for an unapproved request
   of either method, and (T-0190) for a Stripe refund whose send failed or expired.

## Consequences

### Good

- A customer's credit is no longer locked by a bank refund nobody wants.
- A cancelled refund can never be paid by a batch, whatever the timing.

### Bad / accepted trade-offs

- A refund in an unreleased batch waits for T-0241 (batch cancel).
- RQ-0189 finding 4: a Stripe send still in flight from a transaction that already rolled back
  (bounded by the 30 s client deadline) could land after a withdrawal; r10 M1(c)/(d) detect that
  case afterwards (a later create is refused; `stripe-check` lists `held_cancelled`).

### Follow-ups

- T-0241 — cancel an unreleased payment batch.

## Compliance and verification

| Rule | Enforced by |
|---|---|
| 1, 2 | `packages/modules/ap/src/customer-refund-cancel.db.test.ts` (SS-UC11-18, SS-UC11-19) |
| 3 | `packages/connectors/stripe/src/stripe-refund-followups.contract.db.test.ts` (SS-UC11-20, AT_STRIPE for unapproved held documents) |
| 4 | `customer-refund-cancel.db.test.ts` (raw insert refused; two-transaction race refused) |
| 5 | `apps/api/src/ar/refunds.db.test.ts`, `apps/api/src/ar/refunds-stripe.db.test.ts` |
| 6 | `tests/e2e/web/refunds.spec.ts` (T-0207 block) |
