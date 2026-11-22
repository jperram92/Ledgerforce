---
id: RQ-0178
title: Single-supply final tax invoice - document record, multi-line split, adjustment-note particulars, slice scope and the AC-11 primary-law reading
status: answered
opened: 2026-11-22
resolved: 2026-11-22
opened_by: claude
linked_tasks: [T-0204, T-0217, T-0218]
linked_adrs: [ADR-0089]
superseded_by:
---

# RQ-0178 — Single-supply final tax invoice (GP-045) as built

## Question

T-0204 AC-1 asks that finalising a single-supply contract issues the tax invoice with the fixed
GST and posts GP-045a/b/c. GP-045, ADR-0089 R6 (addendum A) and RQ-0171 settle the journal. They
leave these build questions open:

- **Q1** Where is the final tax invoice recorded: in the existing invoice register
  (`app.sales_invoice` + lines) or in a contract-only table?
- **Q2** GP-045 has one revenue line. How does a final invoice with several lines (several
  revenue accounts) split the uncoded contract price and the coded price change?
- **Q3** How is the fixed GST shown on each printed line (AC-1: "GP-023a residual distribution")?
- **Q4** What adjustment-note particulars does a 45c decrease document carry (AC-10)?
- **Q5** Which parts of the card are built in this first slice, and which go to new cards?
- **Q6** AC-11: can the primary law be read from the build environment now?

## Sources

1. GP-045 (Approved, DL-0756), GP-044 (Approved, DL-0755), GP-022, GP-023, GP-029 —
   `Docs/accounting/postings.md`.
2. ADR-0089 R6, R8, R10, addendum A; RQ-0171 and addendum A.
3. Independent accounting review of T-0168, `.agent/evidence/T-0168/accounting-review-20261116.md`
   (findings 7, 8, 10, 11, 15, 17), which worked from ATO web extracts.
4. Existing code: `packages/modules/ar/src/invoices.ts` (register, numbering, line pricing),
   `prepayments.ts` (GP-022b allocation), `credit-notes.ts` (adjustment notes, GP-029),
   `packages/modules/tax/src/gst.ts` (`computeTax`, GP-023a residual rule).
5. How comparable systems present a final invoice after money received in advance (from their
   public help documentation as known to the builder; not re-fetched in this session because the
   environment's proxy blocks most outside hosts):
   - Xero: a prepayment is a separate transaction that is allocated to the later invoice; the
     invoice keeps its full total and shows "Less prepayment" with the amount due.
   - MYOB Business: a customer deposit is recorded on the sale and the invoice shows the total,
     the deposit paid and the balance due.
   - QuickBooks Online: an unapplied payment or credit is applied to the invoice; the invoice
     total is unchanged and the applied amount appears in its payment history.
   - Odoo: a down-payment invoice is deducted on the final invoice by a negative down-payment
     line; the tax is computed on the final lines.
6. Probe of primary sources on 2026-11-22: `.agent/evidence/T-0204/ac11-primary-source-probe.txt`.

## Findings

**Q1 — register.** GP-045 exists because GP-041 left "the invoice register and the AR original
amount" different (review finding 17). Every comparable system keeps the final document a normal
invoice with its full total, and shows the money received as an allocation (Xero, QuickBooks) or
a "deposit paid" line (MYOB). Only an `app.sales_invoice` row keeps the register, the invoice
number series (gapless, `ar_invoice_document`), the statements, the aged-receivables report and the
Salesforce write-back on one document. A contract-only table would need all of these again.

**Q2 — several lines.** The invoice lines carry the final price. The journal must post the
contract's known net uncoded (its GST was reported at attribution) and only the price change
coded with its own GST (GP-045b/c). A deterministic rule that reproduces GP-045 exactly for one
line: group the lines by revenue account in line order, post one uncoded revenue line per
account; take the price change out of the account that holds the largest line (ties: the last
line, the GP-023a tie rule) and post it as one coded line on that account. If that account's
uncoded amount would fall to zero or below, the request is refused (named error) rather than
posting a negative revenue line; a user can put the change on one line.

**Q3 — printed GST.** The document's GST is fixed: attributed GST plus the GST on the price
change. It is spread over the printed lines in proportion to their nets, each rounded half-up to
cents, the residual to the largest line (ties: the last) — the GP-023a total-invoice rule. The
line nets, taxes and grosses are stored on the invoice lines; their sums equal the invoice
totals.

**Q4 — adjustment-note particulars.** The review (finding 8) found a 45c note optional because
the GST decrease (50.00) is at or under $75 (s 29-80, ATO extract) and harmless to issue. AC-10:
the document still carries the particulars. From the ATO adjustment-note guidance as cited in the
review (not primary text — see Q6): a statement that the document is an adjustment note; the
supplier's identity and ABN (on the company); the date of issue; a brief explanation of the
reason; the amount of the adjustment and the GST in it; the earlier document it adjusts. The
final invoice is issued by the supplier with these as data: `price_change_net`,
`price_change_tax`, `variation_date`, `variation_reason`, and the reference of the earlier
attribution (the contract and its attribution entry). The invoice and the contract already hold
the supplier, recipient and date.

**Q5 — slice.** The card has eleven criteria across three posting families and a report; it is
several times the ~400-line split threshold. Slice 1 (this card): AC-1 for the accruals basis
(45a/b/c, default netted presentation), the AC-6 guard (a different final price only when the
variation is agreed on the invoice date), AC-8 (final price below the cash received refused),
AC-10 on the 45c document, and an AC-5 property over receipts and the final invoice. Not built
here, moved with full text:

- **T-0217** — cancellation and refund (AC-2, GP-044a–d incl. the ADR-0074 refund path), receipt
  reversal (AC-3, AC-9 labelling), AC-10 on 44a/44d, the AC-6 contract-variation document (needs
  candidate goldens GP-047+ approved with research), and the cash-basis final invoice (ADR-0089
  R8: GP-022 application, not built in slice 1 and refused by name meanwhile).
- **T-0218** — BAS preparation: basis guard and aged unbilled report (AC-4), never a negative
  G1/1A (AC-7, G18/1B), the company setting `credit_note_bas` (it does not exist in the schema yet;
  GP-029 and AC-1's GST-ADJ variant both depend on it), the lifecycle property over cancellation
  and refund (rest of AC-5), and the AC-11 primary-law reading.

A final invoice on an accruals contract that has no receipt (no attribution yet) has no golden;
it is refused by name until one exists (an ordinary invoice is the alternative, and the contract
stays open).

**Q6 — primary law.** On 2026-11-22 the build environment's proxy refused CONNECT to
legislation.gov.au, aasb.gov.au and austlii.edu.au (403) and ato.gov.au returned 403 for the home
page, GSTR 2000/29, GSTR 2001/8 and the BAS instructions. The primary text of s 29-5, 29-20,
29-70, 29-75, 29-80, 19-10, 19-45, GSTR 2000/29, GSTR 2001/8, the BAS instructions, AASB
Interpretation 1031 and AASB 101 para 32 is therefore **still unread**. AC-11 stays open and
moves to T-0218, which cannot close without it. Nothing in this slice relies on a reading that
the review's extracts did not already support.

## Conclusion

Q1 the final invoice is an `app.sales_invoice` row (kind `standard`) numbered from the invoice
series, posted as one GP-045 entry (source `ar_invoice`), its cash-received AR credit allocated to
its debit at once. Q2 per-account uncoded lines plus one coded change line on the largest line's
account; refused if that would make an uncoded line ≤ 0. Q3 GP-023a proportional distribution of
the fixed GST. Q4 particulars stored on a new immutable `app.single_supply_finalisation` row (one
per contract) and returned on the document view. Q5 slice as above; T-0217 and T-0218 carry the
rest. Q6 AC-11 open, recorded, not claimed.

Decisions: DL-0830 (document record), DL-0831 (multi-line split and printed GST), DL-0832
(particulars and the finalisation record), DL-0833 (slice and split), DL-0834 (AC-11 status).
