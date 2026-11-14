---
adr: 0074
title: "Customer refunds: maker-checker approval before payment, and the refund routes"
status: Accepted
date: 2026-11-14
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0074: Customer refunds: maker-checker approval before payment, and the refund routes

## Status
Accepted under the product owner's delegation of 2026-11-13 (DL-0477 item 3: "Yes you are
authorised to make all these decisions based off best practices"). Category: security (it
changes who can make money leave the business) and public API (design §10.6). Recorded in
DL-0580.

## Context and problem statement
T-0055 built the refund document (`app.customer_refund`, migration 0055) with no approval:
every requested bank refund went into the next payment batch. ADR-0072 added the permissions
`ar.refund.create` (Owner, Finance Admin, AR Clerk) and `ar.refund.approve` (Owner, Finance
Admin, Approver). DL-0477 item 3 requires that the creator of a refund may not approve it, that a
bank refund is paid only through the AP payment batch and its existing release rules, and that a
Stripe refund is sent only after approval. T-0152 exposes refunds over HTTP and on a screen.

## Decision drivers
- Maker-checker for money leaving the business (COSO control activities; design §6.5, the same
  as supplier payments). OWASP ASVS V4 (access control enforced on the server, least privilege).
- Defence in depth: the database must refuse to pay an unapproved refund even if a code path
  forgets the check (the same approach as the payment-batch and confirmation guards, 0047–0055).
- No second payment path (card T-0152 open question 2).
- Forward-only, additive schema (AGENTS.md §0.6). The status CHECK on `customer_refund` cannot
  be widened (the runner refuses DROP CONSTRAINT).

## Considered options
1. **A new status `approved` on `customer_refund`.** Rejected: needs DROP CONSTRAINT on the
   status CHECK and a replaced guard function.
2. **Columns `approved_by` / `approved_at` on `customer_refund`.** Rejected: the 0055 guard
   allows only status, entry_id, paid_on and updated_at to change; replacing it widens a
   security trigger.
3. **An append-only approval record `app.customer_refund_approval`** (one row per refund), plus
   additive guards. Chosen.

## Decision outcome
Chosen option 3.

**Approval record (migration 0070).** `app.customer_refund_approval (tenant_id, company_id,
refund_id, approved_by, approved_at)`, unique per refund, tenant-owned (RLS ENABLE + FORCE,
`tenant_isolation`), `lf_app` SELECT and INSERT only: an approval is evidence and is never
changed (like `payment_batch_refund`). An insert trigger refuses approving a refund that is not
`requested`. Two additive guards:
- a refund can be marked `paid` only if it has an approval row;
- a refund can be put in a payment batch as a payable line (`payment_batch_refund` with no
  exclusion) only if it has an approval row.

**Segregation of duties.** SoD steps `refund.create` and `refund.approve` and the rule
`SOD_REFUND_SELF_APPROVAL` (approve conflicts with create; condition always; small-team mode
may allow it as a recorded exception that the Owner acknowledges weekly, exactly as
`SOD_BATCH_SELF_APPROVAL` for supplier payments). The steps and the rule are added by the lead's
shared migration 0069 and `packages/shared/src/sod/rules.ts`. Both refund routes declare `@SoD`
so the creator is recorded in `app.sod_action` and checked in the guard, never in the controller.

**Payment.**
- `bank_batch`: `createPaymentBatch` takes only approved, requested bank refunds. The batch's
  create / approve / release rules (two releasers above the threshold, step-up) and the bank
  confirmation (GP-006 per refund) are unchanged. `payCustomerRefund` refuses an unapproved
  refund (`NOT_APPROVED`) before the database guard would.
- `stripe`: the API still refuses the method (`METHOD_NOT_AVAILABLE`). When it is offered, the
  Stripe call is made by the approve step, never by create (follow-up card T-0172).

**Routes (public API).** Money is a decimal string; ids are client-chosen uuids.

| Route | Permission | SoD step | Notes |
|---|---|---|---|
| `PUT /ar/refunds/:id` | `ar.refund.create` | `refund.create` | Body `company_id, party_id, refund_date, amount, method, reason?`. 201 new, 200 replay (same id). 404 for a party not in the caller's company/tenant. 422 `REFUND_EXCEEDS_CREDIT`, `METHOD_NOT_AVAILABLE`, `INVALID_REFUND`. |
| `POST /ar/refunds/:id/approve?company_id=` | `ar.refund.approve` | `refund.approve` | 200; a repeat returns the approval with `replayed: true`. 403 `sod_violation` / `SOD_REFUND_SELF_APPROVAL` for the creator. 404 for another tenant's refund. 422 `NOT_APPROVABLE` if not requested. |
| `GET /ar/refunds/:id?company_id=` | `ar.read` | — | The refund with `approval` (`pending` / `approved`), `approved_by`, `approved_at`. |
| `GET /ar/refunds/:id/journal?company_id=[&account_id=]` | `ar.read` | — | Engine `preview()` of GP-006, writes nothing. |
| `GET /ar/parties/:id/credit?company_id=` | `ar.read` | — | `balance`, `requested`, `available`. |

**Which bank account the preview shows.** GP-006 credits the bank account the batch pays from,
which is chosen when the batch is created. The preview uses, in order: the `account_id` query
parameter (a GL account of the company); else the GL account of the live batch that pays the
refund; else the GL account of the company's only active bank account (`app.bank_account`).
With none or several and no choice, it refuses with 422 `BANK_ACCOUNT_REQUIRED`. The preview is
dated the refund date and says so; the real entry is dated the bank confirmation date.

## Consequences
- Refunds requested before migration 0070 need an approval before a batch pays them. This is
  intended: they never had a checker.
- The RBAC matrix (ADR-0072) already lists the holders; the api-db tests prove 403 for each
  permission, the SoD refusal, replay and tenant isolation; the DB tests prove both guards.
- Stripe refunds over HTTP remain unavailable until T-0172.
