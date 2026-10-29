---
id: RQ-0010
title: Stripe (payment links, payouts, fee/GST breakdown in AU) and Peppol PINT A-NZ status
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0010 — Stripe for MVP; Peppol PINT A-NZ status

## Question

Q1. Best Stripe primitive to collect payment for an invoice issued by LedgerForce (Payment Links
vs Checkout Session vs Stripe Invoicing).
Q2. How to reconcile payouts: balance transactions per payout, fee breakdown, GST on Stripe fees
for Australian accounts.
Q3. Current status of Peppol PINT A-NZ (Phase 2 only).

## Why it matters

UC-03 (payment received and synced), design §3.8 "Card receipt via Stripe, net settlement" and
§5.7; RQ-0090 left the Stripe fee-GST question open for the golden posting.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `stripe` npm package 23.0.1, `cjs/resources/BalanceTransactions.d.ts` | 2026-10-24 | primary (SDK types) | `fee_details: Array<{amount (cents), application, currency, description, type}>`; type ∈ `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, **`tax`**, `withheld_tax`. List params include `payout`, `source`, `type`, `created`. Balance transaction types include `charge`, `payment`, `refund`, `stripe_fee`, `tax_fee`, `payout`, `adjustment`, … |
| S2 | https://docs.stripe.com/payouts/reconciliation (via WebSearch) | 2026-10-24 | primary (extract) | List balance transactions with `payout=po_…` (automatic payouts only), paginate (default 10), `expand[]=data.source`; retrieve on `payout.paid` / `payout.reconciliation_completed` webhooks. |
| S3 | https://support.stripe.com/questions/taxes-on-stripe-fees-for-australia-based-businesses (via WebSearch) | 2026-10-24 | primary (extract) | GST applies to all Stripe fees for AU accounts at the standard rate, "applied in addition to the product and service fees, unless there is agreement on GST-inclusive pricing"; monthly tax invoice for the GST (by ~10th of next month). |
| S4 | https://stripe.com/au/pricing (via WebSearch) | 2026-10-24 | primary (extract, possibly stale) | Card rates shown as including GST — conflicts with S3. |
| S5 | https://docs.stripe.com/reports/balance-transaction-types ; https://docs.stripe.com/reports/all-fees (via WebSearch) | 2026-10-24 | primary (extract) | `tax_fee`: taxes Stripe collects, typically tax on Stripe fees; Fees report rows have separate `amount` and `tax`. |
| S6 | https://docs.stripe.com/api/checkout/sessions ; https://docs.stripe.com/api/payment-link (via WebSearch) | 2026-10-24 | primary (extract) | Checkout Session per payment with `client_reference_id` (≤ 200 chars) and `metadata`; Payment Links are reusable, metadata copied to sessions. |
| S7 | https://invopop.com/coverage/australia ; https://ecosio.com/en/blog/e-invoicing-in-australia-rules-formats-and-timelines/ ; https://edicomgroup.com/blog/australia-approves-b2b-einvoicing (via WebSearch) | 2026-10-24 | secondary | PINT A-NZ is the A-NZ format on Peppol; BIS 3.0 A-NZ retired (sources cite 15 May 2025 / 31 Mar 2026); ATO is the Peppol Authority; B2B e-invoicing remains voluntary; a single source cites PINT A-NZ 1.1.2 mandatory from 9 Mar 2026 (unverified). |

## Findings

1. **Collect per invoice with a Checkout Session** (S6): created via API when the invoice is
   posted, `client_reference_id = <LF invoice id>`, `metadata.lf_invoice_id`, amount = amount
   due, idempotency key = invoice id + amount due. Payment Links are reusable and less precise for
   amount-due changes; Stripe Invoicing would create a second invoice of record (conflicts with
   D1: LedgerForce owns invoices).
2. **Payout reconciliation (S1, S2):** for each `payout.paid`, list balance transactions with
   `payout=<id>`; each `charge`/`payment` row has `amount` (gross), `fee`, `net` and `fee_details`.
   GST on the Stripe fee appears as a `fee_details` entry of `type: "tax"` when Stripe charges GST
   on top; refunds, disputes and `stripe_fee`/`tax_fee` rows (Stripe product fees billed
   separately) also land in payouts.
3. **GST on Stripe fees in AU is account-dependent (S3 vs S4):** default is GST *on top*
   (separate `tax` component) unless GST-inclusive pricing was agreed. The GST credit is
   evidenced by Stripe's monthly tax invoice, not by the payout.
4. **Peppol (Phase 2):** PINT A-NZ is current; BIS 3.0 no longer accepted; version detail
   (1.1.x) unverified — re-check at Phase 2 start against the ATO/OpenPeppol pages.

## Conclusion / decision

- Payment collection: Checkout Session per posted invoice (Payment Link URL stored on the
  invoice mirror LF_Invoice__c). On `checkout.session.completed`: post receipt
  **Dr Stripe clearing / Cr AR control** (allocation to the invoice) — the receipt leg that
  design §3.8 leaves implicit.
- On `payout.paid`: post settlement **Dr Bank (payout amount), Dr Merchant fees (Σ
  `stripe_fee` + `application_fee` components), Dr GST paid (Σ `tax` components) / Cr Stripe
  clearing (Σ gross)**; if an account has no `tax` component (GST-inclusive pricing), split the
  fee as GST = fee/11 only when the tenant setting says so — otherwise no GST credit.
  Include refunds / disputes / `stripe_fee` / `tax_fee` rows as their own lines. This answers
  RQ-0090 Q2 for golden posting GP Stripe (human still approves the posting).
- Stripe SDK `stripe` (runtime dependency ⇒ ADR) behind a `PaymentProvider` port; webhooks
  signature-verified and idempotent on event id.
- Peppol: no MVP work; keep party field "delivery preference: Peppol (ABN)".

## Confidence

High for API shapes (SDK types). Medium for AU fee-GST presentation (Stripe's own pages
conflict) — hedged by handling both shapes and a tenant setting; verify with a test-mode AU
account during the Stripe task.

## Follow-ups

- Stripe task: capture a real test-mode AU payout's balance transactions as a contract fixture.
- Phase 2 gate: re-research PINT A-NZ version and access-point accreditation.

**Affects:** `packages/connectors/stripe`, Payments module, AR receipts, Bank reconciliation,
golden postings (RQ-0090), design §3.8, §5.7, UC-03, UC-11.
