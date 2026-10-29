---
id: RQ-0009
title: Australian GST / BAS facts for the MVP tax engine
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0009 — Australian GST and BAS for the MVP

## Question

GST rate and tax categories; meaning of BAS labels G1, G2, G3, G10, G11, 1A, 1B; GST rounding on
tax invoices (per line vs total); tax invoice requirements (≥ $1,000 needs buyer identity/ABN);
cash vs accrual eligibility.

## Why it matters

Design §3.4 (rounding), §3.6 (tax engine, BAS box mapping), UC-01/UC-05 invoice and bill
content, risk "Tax rule errors" §11.1.

## Sources consulted

ato.gov.au was not directly fetchable (proxy 403); content was obtained via WebSearch restricted
to `ato.gov.au`, whose extracts quote the pages. See also RQ-0090 (golden-posting tax treatments).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices | 2026-10-24 | primary (extract) | < $1,000: intended as tax invoice, seller identity, seller ABN, date, description/quantity/price, GST amount (or "total includes GST" when GST is exactly 1/11). ≥ $1,000: also **buyer's identity or ABN**. Rounding: single sale → nearest cent, 0.5 up; multiple sales → *total invoice rule* or *taxable sale rule* (below); supplier and customer may use different rules. |
| S2 | https://www.ato.gov.au/law/view/document?docid=GST/GSTR20131/NAT/ATO/00001 (GSTR 2013/1) | 2026-10-24 | primary (extract) | Buyer identity **or** ABN satisfies the ≥ $1,000 requirement. |
| S3 | https://www.ato.gov.au/law/view/print?DocID=NEM/EM200027/NAT/ATO/00008 (EM, Indirect Tax Legislation Amendment Act 2000) | 2026-10-24 | primary (extract) | s9-90 rounding methods; worked total-invoice example. |
| S4 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/quarterly-gst-reporting | 2026-10-24 | primary (extract) | GST turnover < $10m: *Simpler BAS* — report only **G1, 1A, 1B**. ≥ $10m (full reporting): G1, G2, G3, G10, G11, 1A, 1B. Annual GST return: G1, 1A, 1B. |
| S5 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/complete-your-bas/step-3-purchases | 2026-10-24 | primary (extract) | G10 capital purchases (machinery, computers, furniture, cars) vs G11 non-capital (trading stock, running costs, leases); imports: (customs duty + GST) × 11 at G10/G11. |
| S6 | https://ato.gov.au/deferredGSTscheme | 2026-10-24 | primary (extract) | Deferred GST on imports: label **7A** pre-filled by ATO, credit claimed at 1B; monthly reporters only. |
| S7 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method | 2026-10-24 | primary (extract) | Cash basis allowed for small business entities (aggregated turnover **< $10 million**) or if accounting for income tax on a cash basis; otherwise ATO permission. Non-business enterprises: GST turnover ≤ $2m. |
| S8 | https://www.ato.gov.au/law/view/document?docid=GST/GSTR20002/NAT/ATO/00001 (GSTR 2000/2) | 2026-10-24 | primary (extract) | Bad-debt decreasing adjustment: accruals basis only; written off or ≥ 12 months overdue; 1/11 of amount for wholly taxable supply; recovery → increasing adjustment. |

## Findings

1. **Rate:** 10% (GST-inclusive price → GST = 1/11).
2. **Categories (engine tax codes):** taxable (GST 10%), GST-free (e.g. exports, basic food,
   some health/education), input taxed (financial supplies, residential rent — no GST charged,
   no credits), BAS excluded / out of scope (wages, super, ATO payments, private), GST on
   imports (GST paid to ABF or deferred via 7A), capital acquisitions (purchases at G10).
3. **BAS labels:** G1 total sales *including GST*; G2 export sales; G3 other GST-free sales;
   G10 capital purchases (incl. GST); G11 non-capital purchases (incl. GST); 1A GST on sales
   (+ increasing adjustments); 1B GST on purchases (+ decreasing adjustments, e.g. bad debts —
   see RQ-0090). 7A deferred GST on imports. Businesses < $10m GST turnover lodge Simpler BAS
   (G1, 1A, 1B only).
4. **Rounding (S1, S3)** — two lawful methods for an invoice with several taxable lines:
   - *Total invoice rule*: sum the line GST amounts (unrounded) and round the total to the nearest
     cent, half-up; if every line is 1/11-taxable, may instead compute GST on the summed
     GST-exclusive total and round once.
   - *Taxable sale rule*: compute GST for each line, keeping as many decimals as the system
     records, add them, and round the total to the nearest cent, half-up.
   Neither rule rounds **each line to whole cents and then sums**. A single-line invoice rounds
   to the nearest cent, 0.5 up.
5. **Tax invoice ≥ $1,000** (GST-inclusive price) must also show buyer identity **or** ABN;
   every tax invoice shows seller identity + ABN, date, items, GST (S1, S2). Tax invoices are
   required to claim credits on purchases > $82.50 incl. GST (well-known ATO threshold;
   not re-verified today — low impact, used only as an AP warning).
6. **Cash vs accrual (S7):** cash basis is available below $10m aggregated turnover; the engine
   must support both (design §3.6 already does). Bad-debt adjustments apply to accruals only (S8).

## Conclusion / decision

- Tax codes (AU template): `GST` 10%, `FRE` GST-free, `EXP` export (G2), `INP` input taxed,
  `N-T` BAS excluded, `CAP` capital acquisition (G10), `GST-IMP` GST on imports, `DGST`
  deferred GST (7A/1B). Each maps to report boxes as data (design §3.6).
- BAS report: produce the full label set; tenants on Simpler BAS see only G1/1A/1B.
- Rounding default for AU: **total invoice rule** — line GST stored at 4 dp (NUMERIC(19,4)),
  invoice GST = round-half-up(sum) to cents, difference between that and the sum of displayed
  line GST posted to ROUNDING. This **differs from design §3.4** ("AU default: per line, half-up
  to cents") ⇒ accounting decision for the human (human gate).
- Invoice validation: block approval of an invoice ≥ $1,000 incl. GST when the customer party has
  neither a legal name nor an ABN; print "Tax invoice", seller ABN, date, GST per line or total.
- Tax engine test pack must include: 1-cent rounding edge cases (e.g. 3 × $0.05 lines),
  mixed taxable/GST-free invoices, inclusive vs exclusive pricing, cash vs accrual BAS for the
  same period.

## Confidence

High for rate, labels, invoice requirements and cash-basis threshold (multiple ATO pages agree).
Medium-high for rounding interpretation (ATO page extract + EM) — the human accountant should
confirm the chosen default.

## Follow-ups

- Human decision: AU rounding default (design §3.4 vs total-invoice rule).
- Re-check the $1,000 / $82.50 thresholds when the BAS module (Phase 1) starts.

**Affects:** `packages/modules/tax`, AR invoice validation/PDF, AP bill capture, BAS report
(Phase 1), golden postings (RQ-0090), design §3.4, §3.6.
