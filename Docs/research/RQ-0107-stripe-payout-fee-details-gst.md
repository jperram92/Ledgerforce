---
id: RQ-0107
title: How a Stripe payout's fees and the GST on them are read for GP-027
status: answered
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0075, T-0130]
linked_adrs: []
superseded_by:
---

# RQ-0107 — Stripe payout fees and GST (closes RQ-0090 item 2)

## Question
Does a Stripe balance transaction's `fee_details` carry the GST on Stripe's fees as its own
entry, so the GP-027 payout journal can split fee 21.53 + GST 2.15 = 23.68 without guessing?

## Evidence
| Source | Date | Finding |
|---|---|---|
| Stripe Node SDK `stripe@23.1.0` (OpenAPI spec v2596), `esm/resources/BalanceTransactions.d.ts`, `interface FeeDetail` (downloaded with `npm pack` and read only) | 2026-11-13 | `fee_details[]` items have `amount` (cents), `application`, `currency`, `description` and `type`, documented as "one of: `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax`, or `withheld_tax`". The balance transaction `type` enum includes `charge`, `payment`, `refund`, `payout`, `stripe_fee` and others. |
| [Stripe support — Taxes on Stripe fees for Australia-based businesses](https://support.stripe.com/questions/goods-and-services-tax-(gst)-for-australia-based-businesses) | 2026-11-13 | GST applies to all Stripe fees at the standard rate, **in addition to** the fees unless GST-inclusive pricing is agreed, and Stripe issues a monthly tax invoice for the GST charged on its fees. |
| docs.stripe.com API reference | 2026-11-13 | Not reachable from this sandbox (host not allowed); the SDK types are generated from the same OpenAPI spec. |
| Docs/accounting/postings.md GP-027 / GP-028 (Approved, DL-0256) | 2026-11-13 | GP-027: Dr bank 1,351.32 / Dr fee 21.53 / Dr GST paid 2.15 / Cr Stripe clearing 1,375.00; the GST line is `pending_tax_invoice` until the monthly tax invoice. GP-028: the monthly tax invoice wins over posted GST. |

## Conclusion
- Fee = sum of `fee_details` amounts whose type is not `tax`/`withheld_tax`; GST on fees = sum of
  `tax` entries. Both come from the payout's balance transactions, never computed as 10 % (Stripe
  rounds per transaction; the tax invoice is authoritative, GP-028).
- `withheld_tax` is not GST on Stripe's fees (it is tax withheld from the merchant); a payout that
  carries one is refused with a typed error until a golden posting covers it (no guess).
- If a transaction has no `tax` entry, no GST line is posted for it; GP-028's monthly invoice
  reconciliation adds or corrects the GST (the invoice wins).
- The GST line's evidence status (`pending_tax_invoice`) is kept on the payout record, which
  GP-028 later reconciles; it is not a journal-line attribute today.
- Confirming the 23.68 split against a real AU payout remains a pilot-time check (GP-027 note);
  the contract fixture is built from the documented object shape, not a live recording.
