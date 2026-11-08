---
id: RQ-0114
title: How does a customer credit note become GP-005, link to the invoice line it adjusts, and when is it a later-period adjustment note?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0045, T-0035, T-0123]
linked_adrs: [ADR-0044]
superseded_by:
---

# RQ-0114 — Customer credit notes: journal, line link, creditable amount, adjustment note

## Question

- **Q1.** (card: "postings.md Q4") How is a credit note presented on the BAS, and how is the
  document labelled? (Answered in RQ-0095 Q4; restated here with what T-0045 must store.)
- **Q2.** How does a credit-note line "take the tax code of the invoice line it adjusts and is
  never re-resolved" (ADR-0044 W6/R5) when an invoice line usually has no stored tax code (it is
  resolved from the posting-profile matrix at posting time, T-0040)?
- **Q3.** What is "the creditable amount" (SS-UC11-07, UC-11 A1)?
- **Q4.** What is a "later BAS period"? The ledger stores no BAS frequency.
- **Q5.** Which approval rule applies (SS-UC11-06), and how does a credit note reach the invoice
  (allocation)?
- **Q6.** What order and signs do the GP-005 journal lines have?

## Why it matters

GP-005 is Approved (DL-0253) and must be produced by the credit-note code. T-0035 recorded that
the BAS report cannot present a later-period credit note at 1B because the ledger lacks the link
from a credit note to the original invoice (T-0035 card, "Open follow-ups" (1)).

## Sources

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | RQ-0095 Q4 and its sources S1, S3, S4, S19 (ATO "How to make adjustments", ATO "Adjustment notes", GST Act Div 19, ATO answer on cancelled invoices) | 2026-11-08 | primary via record | Same BAS period → net G1/1A; later period → decreasing adjustment at 1B, G1 unchanged; a decreasing adjustment needs an adjustment note (unless GST ≤ $75); every credit note is issued as an **adjustment note** that references the original invoice number and date, regardless of the $75 threshold (RQ-0095 answer). |
| S2 | `Docs/accounting/postings.md` GP-005 (Approved) | 2026-11-08 | golden (human-owned) | Lines: revenue Dr 200.00 (GST, tax 20.00, Acme); GST collected Dr 20.00 (GST); AR control Cr 220.00 (Acme). Subledger: credit open item −220.00. "The document is always issued as an adjustment note referencing the original invoice number and date (Q4, RQ-0095)." |
| S3 | ADR-0044 R5 (Accepted, W6) | 2026-11-08 | ADR | "A credit note, adjustment note or reversal never re-resolves: each of its lines takes the tax code, confirmation and trace of the line it adjusts. A posted line is never re-resolved." |
| S4 | Design §4.1 step 3 | 2026-11-08 | design | The setup wizard records "GST basis (cash or accrual), BAS frequency" — BAS frequency is a company setting in scope. |
| S5 | ATO, "Reporting and paying GST" / BAS lodgement periods (prior knowledge; ato.gov.au is not reachable from this sandbox, proxy 403) | 2026-11-08 | primary (prior knowledge) | GST is reported monthly, quarterly (quarters ending 30 Sep, 31 Dec, 31 Mar, 30 Jun) or annually (financial year 1 Jul – 30 Jun, for voluntary-registered / small entities). |
| S6 | ATO, "Adjustment notes" content requirements (prior knowledge, GSTR 2013/2 and the Tax invoice/adjustment note determinations; same reachability limit as S5) | 2026-11-08 | primary (prior knowledge) | An adjustment note shows that it is an adjustment note, the supplier's identity and ABN, the date of issue, the recipient's identity or ABN (needed for larger amounts, mirroring the $1,000 tax-invoice rule), a brief explanation of the adjustment, the difference in GST, and enough to identify the original supply (here: the original invoice number and date). |
| S7 | Code: `packages/modules/ar/src/sales-invoices.ts`, `invoice-journal.ts`, migration 0037, `packages/ledger/src/subledger.ts`, `packages/shared/src/sod/rules.ts`, migration 0021 | 2026-11-08 | code | Invoice lines store only an *optional explicit* tax code; the resolved account and tax-code version exist only in the posted journal, grouped by (account, code). `sales_invoice_line` is frozen once the invoice is approved. `allocate()` pairs a + and a − open item. SoD rule `SOD_CREDIT_NOTE_SELF_APPROVAL`: `credit_note.approve` conflicts with `credit_note.create` above `credit_note_self_approval` (default 1,000.00, `app.sod_settings`). |

## Findings

1. **Q1.** Unchanged from RQ-0095 Q4. T-0045 stores for each posted credit note whether it falls in
   a **later BAS period** than its invoice (`later_bas_period`) and the link from every credit-note
   line to the invoice line it adjusts, so the BAS report (follow-up card) can put later-period
   credit notes at 1B. The document title is **"Adjustment note"** for every credit note (S1, S2);
   the later-period flag says whether it is a Div 19 *adjustment* (1B) or a same-period correction
   (net G1/1A). The brief "labelled as an adjustment note when it is in a later period" is
   satisfied and the Approved golden's "always" wins for the same-period case (AGENTS.md: Approved
   goldens are human-owned).
2. **Q2.** The resolution of each invoice line must be captured **when the invoice posts** — it
   cannot be recovered later without re-resolving (forbidden, S3) and it is not recoverable from the
   grouped journal. New insert-only table `app.sales_invoice_line_posting` (one row per invoice
   line: revenue account, tax-code **version** id, code, rate, net, tax), written by the invoice post
   in the same savepoint. A credit-note line stores `invoice_line_id` (the W6 link) and copies the
   revenue account and tax-code version id from that row; a trigger proves they match. The tax-code
   version is the one valid on the **invoice** date (a rate change after the invoice does not
   change the credit). Invoices posted before migration 0040 have no snapshot row; crediting them is
   refused `NO_LINE_POSTING` (no production data exists yet).
3. **Q3.** Per invoice line: Σ net and Σ tax of the line's credit notes that are approved or posted,
   plus this note, ≤ the line's net and tax; and the note's total plus other credits ≤ the invoice
   total. Breach → `CREDIT_EXCEEDS_INVOICE`. Drafts reserve nothing. GST is proportional because each
   credit line is taxed at the invoice line's tax-code version with the company rounding.
4. **Q4.** Add `app.company.bas_frequency` (`monthly` | `quarterly` default | `annual`), like
   `gst_basis` (migration 0036). Period: calendar month; calendar quarter; Australian financial year
   (1 Jul – 30 Jun). The flag is computed at posting from the invoice and credit-note dates.
5. **Q5.** The module enforces `SOD_CREDIT_NOTE_SELF_APPROVAL` with the shared evaluator against the
   document's creator and the tenant's latest SoD settings (fails closed; the small-team exception
   path stays at the API, follow-up card). A posted credit note opens a credit open item (engine,
   AR control line); `allocateCreditNote` allocates it to the invoice's open item through the
   ledger's `allocate()`.
6. **Q6.** Revenue lines grouped by (account, tax-code version) in first-appearance order, debit,
   tax amount non-negative; one GST-collected debit per code with tax > 0; ROUNDING for a
   per-document residue (mirrored side); AR control credit last (party, due date = credit-note date).
   This is exactly GP-005's order.

## Conclusion

Build per findings 1–6 in migration 0040 and `packages/modules/ar/src/credit-notes.ts`. Follow-ups:
BAS 1B presentation using `creditNoteAdjustmentLines` and option `sales_adjustment_presentation`;
API routes with the small-team SoD exception; the adjustment-note PDF (T-0041 family).

**Confidence:** high for Q2/Q3/Q5/Q6 (code and golden); medium for Q1/Q4/S6 (regulator pages not
re-read today, prior knowledge consistent with RQ-0095).
