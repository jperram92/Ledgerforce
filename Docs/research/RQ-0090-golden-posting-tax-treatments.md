---
id: RQ-0090
title: AU GST treatments needed to draft the golden postings (bad debts, Stripe fees, deposits, BAS labels)
status: answered-pending-human   # open | answered | answered-pending-human | superseded
opened: 2026-10-24
opened_by: claude
task: T-0007
---
# RQ-0090 — AU GST treatments behind the DRAFT golden postings

## Question

Drafting `Docs/accounting/postings.md` (T-0007) needs, for each standard event in design §3.8:
1. Where does a GST bad-debt adjustment go on the BAS, and when is it allowed?
2. Are Stripe processing fees subject to GST for an Australian account, and how are they evidenced?
3. Is GST attributable when a customer prepayment / deposit is received before any tax invoice (accruals basis)?
4. Current superannuation guarantee rate for the payroll example.

## Findings (with sources)

1. **Bad debts.** On the non-cash (accruals) basis a supplier may claim a *decreasing adjustment* for the GST
   on a taxable sale when the consideration has not been received and the debt is written off as bad or has
   been overdue 12 months or more; it is made in the period of write-off (or of becoming aware of the 12-month
   overdue). Decreasing adjustments are reported at **label 1B**, increasing adjustments (e.g. later recovery)
   at **1A**. Sources: ATO "Types of adjustments"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/types-of-adjustments>,
   ATO "How to make adjustments"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments>.
   Cash-basis taxpayers never reported the GST, so no adjustment arises. Further authority: GSTR 2000/2 (not yet read).
2. **Stripe fees.** Stripe states GST applies to its fees for Australia-based accounts at the standard rate and
   issues a monthly tax invoice for the GST on fees. Sources: Stripe support "Taxes on Stripe fees for
   Australia-based businesses" <https://support.stripe.com/questions/taxes-on-stripe-fees-for-australia-based-businesses>.
   Whether the GST is inside the per-transaction fee reported on the balance transaction (vs only on the monthly
   invoice) was **not confirmed** — the Stripe API reference for `balance_transaction.fee_details` must be checked
   in the Stripe payout task (T-0075) before its golden test is finalised.
3. **Deposits.** On the accruals basis GST is attributable to the earliest period in which any consideration is
   received or an invoice is issued (ATO "Identify your accounting basis"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/identify-your-accounting-basis>).
   A *security* deposit (Div 99 GST Act) is different — not consideration until applied/forfeited. So a prepayment
   that is part-payment for a taxable supply likely carries GST on receipt; design §3.8's "Dr Bank / Cr Customer
   prepayments" does not split GST. → human decision (golden posting GP-012 offers options A/B).
4. **Super guarantee** is 12% of ordinary time earnings from 1 July 2025 (legislated end of the SG rate step-up).
   Used only as an illustrative number in GP-010.

## Conclusion

The golden postings are drafted with these treatments and every uncertain point is listed in
`Docs/accounting/postings.md` → *Open questions for accountant*. Status stays
`answered-pending-human` until the product owner (an accountant) approves the golden postings
(human gate `golden_postings`).
