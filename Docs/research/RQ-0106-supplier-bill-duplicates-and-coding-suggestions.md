---
id: RQ-0106
title: How are duplicate supplier bills detected, how is a bill coded by suggestion, and what does a bill post (and when)?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0050, T-0052]
linked_adrs: []
superseded_by:
---

# RQ-0106 — Supplier bill duplicates, coding suggestions and the GP-008 producer

## Question

- **Q1.** What is a "duplicate supplier invoice number" (UC-05 A3) — exact text, or a normalised
  key — and what does "warning, cannot post twice" mean for entry versus posting?
- **Q2.** "Suggested coding from past bills" (UC-05 step 2, SS-UC05-02): which past bills count,
  how is one (account, tax code) chosen when the history disagrees, and how does it combine with
  the posting-profile matrix (T-0039)? The result must be deterministic.
- **Q3.** Which journal does a bill produce, in which line order, and how do tax amounts and
  rounding come out of the tax engine (T-0034) for a purchase?
- **Q4.** UC-05 posts "on approval", but approval and SoD are T-0052. What does T-0050 post from?

## Sources

1. Design §3.8 row 6 (Supplier bill: Dr expense or asset (net), GST paid; Cr AP control (gross)),
   §3.9 (pipeline, preview), §3.3 (posted = immutable), §6.5 rule 3 (bills: entered-by ≠
   approved-by above $1,000), §4.4 (posting profiles, purchase direction).
2. `Docs/specs/UC-05.md` — main flow, A2 (AP lock), A3 (duplicate → warning, cannot post twice).
3. `Docs/accounting/postings.md` GP-008 (Approved, DL-0253) and F1 (RQ-0095: one tax line per
   tax code; CAP posts through GST_PAID).
4. RQ-0097 / DL-0260 — resolution order; differing tax-code defaults → TAX_CODE_CONFLICT, the line
   must carry an explicit tax code.
5. `packages/modules/tax/src/gst.engine.ts` and `tax-journal.ts` (T-0034) — calculateTax and the
   document-line grouping by (account, tax code); tax amounts are carried non-negative and the
   side gives the direction (posting-command.ts rejects a signed amount).
6. ATO, *Tax invoices* (GSTR 2013/1 and ato.gov.au "Tax invoices"): a supplier's tax invoice is
   identified by the supplier (ABN) and its own invoice number; the purchaser holds one tax
   invoice per acquisition. Duplicate claims of the same tax invoice overstate input tax credits.
7. Common practice in Xero / Business Central (design §2): duplicate-bill warnings compare the
   supplier and the supplier's reference ignoring case and punctuation ("INV-0045" = "inv 0045").

## Findings

- **F1 (Q1).** The identity of a supplier invoice is (company, supplier party, supplier
  reference). Comparison uses a normalised key: upper case, letters and digits only (spaces,
  dashes, slashes and dots dropped), so formatting variants collide. Entry never fails on a
  duplicate — the clerk may be keying a corrected copy — it returns the matching bills as a
  warning. Posting refuses a second posted bill with the same key (`DUPLICATE_SUPPLIER_REF`),
  checked in code and backed by a partial unique index over posted bills, so concurrent posts
  cannot both win. A voided bill (future reversal) leaves the index.
- **F2 (Q2).** Deterministic two-stage suggestion:
  1. *Supplier history*: lines of the supplier's **posted** bills (approved coding only — a draft
     may be wrong), taken from the most recent 5 bills ordered by bill date desc, bill number desc.
     When the new line names a product, only history lines with that product count; otherwise
     all. Among (account, tax code) pairs the most frequent wins; ties go to the most recently
     used pair (bill date, bill number, line number), then account id and tax code ascending.
  2. *Product profile*: when there is no history and the line names a product, the posting
     profile resolver (direction purchase, slot expense or asset) gives the account and the tax
     code. A TAX_CODE_CONFLICT (DL-0260) still suggests the account but no tax code — the clerk
     must choose one.
  3. Otherwise no suggestion. The suggestion is never applied silently: it is returned with its
     source and the clerk accepts it onto the line (`coding_source` records which).
- **F3 (Q3).** GP-008 line order is document lines, then one tax line per tax code (F1), then the
  AP control credit with the supplier and due date. The tax engine computes the amounts
  (`calculateTax`, company `tax_rounding`, bill `amounts_are`); `draftTaxedDocumentLines(side:
  purchase)` groups document lines by (account, tax code) and mirrors the sides; the bill
  producer reorders to GP-008's order and puts any per-document residue on ROUNDING immediately
  before AP control. Tax amounts stay non-negative because bill lines must be positive (a supplier
  credit is a separate document, not a negative bill line). Tax lines post to the tax code's
  GST_PAID account, carry the code and no tax amount.
- **F4 (Q4).** T-0050 keeps a `status` field with the full lifecycle (`draft`,
  `awaiting_approval`, `approved`, `posted`, `void`) and an `approved_by` column, and posts a bill
  that is `draft` or `approved`. T-0052 adds submit/approve with the §6.5 SoD rule and then
  narrows posting to `approved` only; nothing in T-0050 decides SoD.

## Conclusion

Build per F1–F4. Decisions: DL-0290 (bill model, duplicates), DL-0291 (suggestion algorithm),
DL-0292 (posting from draft until T-0052; journal line order), DL-0293 (local migration
placeholders for the reserved 0033–0037 numbers).
