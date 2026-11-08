---
id: RQ-0102
title: BAS label mapping per tax code, and how a ledger-only query attributes GST on the cash basis
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0035]
linked_adrs: []
superseded_by:
---

# RQ-0102 — BAS label mapping per tax code; cash-basis attribution from the ledger

## Question

T-0035 builds "each tax code maps to report boxes … the BAS report is a query" (design §3.6) for
both GST bases. Before writing code:

- **Q1.** Which BAS labels does each AU template tax code feed (G1, G2, G3, G10, G11, 1A, 1B, W1,
  W2), and with which amount (GST-inclusive value, GST, or the plain amount)?
- **Q2.** The AU template has one `GST` code used on both sales and purchases. How does a query
  over journal lines tell a sale (G1/1A) from a purchase (G10/G11/1B)?
- **Q3.** On the cash basis, GST is attributable to the extent consideration is received. How does
  a query that reads only journal lines and subledger allocations know how much of a document was
  paid in a period — and what counts as "paid" (a credit note or a bad-debt write-off allocated
  to an invoice is not consideration)?
- **Q4.** The card's open question (RQ-0090; postings Q3/Q4): adjustment labels for bad debts and
  credit notes.
- **Q5.** What does Simpler BAS report?

## Why it matters

A wrong box mapping mis-states the BAS the company lodges; a wrong cash-basis rule reports GST in
the wrong period (or reports GST on a written-off debt that was never received).

## Sources consulted

Network note (2026-11-08): `curl https://www.ato.gov.au/…` from this session fails with
`CONNECT tunnel failed, response 403`, as in RQ-0094/RQ-0095. ATO pages are therefore cited from
RQ-0095's search-engine extracts (marked *via RQ-0095*) or from prior knowledge (marked so).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | ATO, "How to make adjustments" (RQ-0095 S1) | via RQ-0095 | primary | Accounts method: increasing adjustments at 1A, decreasing at 1B. |
| S2 | ATO, "Types of adjustments" (RQ-0095 S2) | via RQ-0095 | primary | Bad-debt decreasing adjustment on the non-cash basis in the write-off period; recovery is an increasing adjustment. |
| S3 | GST Act s 29-5(1)/(2) (RQ-0095 S4) | via RQ-0095 | primary | Accruals: earlier of invoice or any consideration; cash basis: to the extent consideration is received. |
| S4 | ATO, "Choosing an accounting method" (RQ-0095 S8) | via RQ-0095 | primary | Cash basis: GST reported when payment is received; accruals: earlier of invoice or payment. |
| S5 | ATO, "PAYG withholding — how to complete your activity statement labels" (RQ-0095 S16) | via RQ-0095 | primary | W1 total gross payments (salary, wages …); W2 amounts withheld from W1 payments. |
| S6 | ATO, "Completing your BAS for GST" — label instructions G1 (total sales incl. GST), G2 (export sales), G3 (other GST-free sales), G10 (capital purchases incl. GST), G11 (non-capital purchases incl. GST), 1A (GST on sales), 1B (GST on purchases); purchases of imported goods include the value at G10/G11 and the GST paid to Home Affairs is claimed at 1B | prior knowledge (not re-read 2026-11-08) | primary | Label definitions as quoted. |
| S7 | ATO, "Simpler BAS" | prior knowledge | primary | Small businesses (GST turnover < $10M) report only G1, 1A and 1B; G2/G3/G10/G11 are no longer reported (businesses still record them). Matches postings.md "BAS labels used". |
| S8 | `Docs/accounting/postings.md` Approved GP-001, -002, -005, -006, -007, -008, -010, -012, -013 Tax/BAS bullets; "BAS labels used" section | 2026-11-08 | project (Approved goldens) | Expected labels per event: GP-001 G1 1,375.00 / 1A 125.00; GP-002 cash G1/1A at receipt "proportional to the amount received"; GP-005 same period G1 −220.00 / 1A −20.00; GP-007 accruals 1B 125.00, cash none; GP-008 G10 2,200.00 / G11 550.00 / 1B 250.00; GP-010 W1 10,000.00 / W2 2,000.00; GP-012 G1 3,300.00 / 1A 300.00 accruals and cash; GP-013 G1 7,700.00 / 1A 700.00. |
| S9 | RQ-0095 Q3, Q4, Q7 | 2026-11-08 | project research | ADJ-BD: kind adjustment_decreasing, 10 %, GST_COLLECTED, accruals → 1B, cash → none. Credit note same BAS period → net G1/1A; later period → 1B (option `sales_adjustment_presentation`). Prepayment Option B → G1/1A at receipt on both bases. |
| S10 | Repository: migrations 0007, 0028 (`journal_line`, `subledger_entry`, `allocation`), 0031 (`tax_code`), `packages/ledger/src/period-matrix.ts` (`SOURCE_TYPES`), `packages/db/src/migrate.ts` (policy) | 2026-11-08 | source code | Lines carry `tax_code_id` and an unsigned `tax_amount` (side gives direction). Allocations pair a + and a − item with `allocation_date` and base released per item; reversals are negative rows. `SOURCE_TYPES` is a closed list of 15 codes. The migration runner refuses any `DROP` (incl. `DROP CONSTRAINT`), so 0031's `kind` CHECK cannot be widened in place. |

## Findings

1. **Mapping (Q1).** From S6/S8: sales at the taxable code → G1 (net + GST) and 1A (GST);
   GST-free sales → G1 and G3 (exports G1 and G2); input-taxed sales → G1 (G4 is out of scope);
   taxable non-capital purchases → G11 (net + GST) and 1B (GST); capital (CAP) → G10 and 1B;
   GST-free or input-taxed purchases → G11 (G13/G14 out of scope); imports (IMP) → G11 and 1B
   (the template's IMP is a non-capital import; a capital import uses CAP); BAS excluded (N-T)
   → nothing. Bad-debt adjustment ADJ-BD → 1B (GST amount) on accruals only (S2, S9).
   W1 = the gross wages line amount, W2 = the withheld amount (S5, GP-010).
2. **Sale vs purchase (Q2).** Every Approved golden that carries a two-sided code puts sales on
   revenue or liability accounts (revenue, customer prepayments, deferred revenue — GP-001, 005,
   012–016, 019) and purchases on expense or asset accounts (GP-003 fee, GP-008). The account
   type is stored and immutable in meaning; the source type is not enough (manual journals).
   Rule: a line's flow is **sales** when its account type is revenue or liability, **purchases**
   when asset, expense or equity. Codes that are one-flow by nature (ADJ-BD, BAS-W1, BAS-W2)
   map with flow `any` and an explicit positive side. Known limit: the proceeds of a fixed-asset
   sale must be posted to a revenue (other income) account to report at G1 — documented, as
   Xero/MYOB require a disposal account too (prior knowledge).
3. **Cash basis (Q3).** s 29-5(2) (S3/S4) attributes to the extent consideration is received.
   The ledger has exactly what is needed: a document's AR/AP item and the allocations that
   release it, each dated. Classify source types (closed list, S10):
   - *document* — the tax is attributed through settlement of its open item: `ar_invoice`,
     `ar_credit_note`, `ar_write_off`, `ap_bill`;
   - *settlement* — consideration paid/received: `ar_receipt`, `ar_refund`,
     `payments_stripe_charge`, `ap_payment`, `ar_prepayment_application`;
   - *immediate* — cash at entry date: `ar_prepayment` (GP-012 Option B), `payments_stripe_payout`,
     `payroll_pay_run`, `payroll_net_pay_batch`, `manual_journal`, and the GST lines of a
     settlement entry (GP-003 fee GST).
   - `ledger_reversal` takes the class of the entry it reverses.
   For a document, the share reported in a period = Σ base released from its items by
   allocations dated in the period **whose counter item belongs to a settlement entry** ÷ Σ |base
   original| of its items. A credit note or write-off allocated to an invoice therefore releases
   nothing (no consideration) — which also yields GP-007's "cash: nothing". Allocation reversals
   are negative rows and reduce the share. Each document × label share is rounded half-up to
   cents.
4. **Adjustments (Q4).** Bad debt: ADJ-BD → 1B on accruals, none on cash (S2, S9). Credit note in
   the same period nets into G1/1A by the signed sum (S9; GP-005). The later-period presentation
   (1B, option `sales_adjustment_presentation`) needs the credit note → original invoice link,
   which the ledger does not store today (journal_entry has only `source_id`); until then the
   report presents every credit note netted (the `net_G1_1A` presentation RQ-0095 Q4 allows).
   Follow-up card.
5. **Simpler BAS (Q5).** G1, 1A, 1B only (S7, postings.md).
6. **Schema (S10).** A forward-only migration cannot widen 0031's `kind` CHECK. A new nullable
   `subkind` column refines `kind` for the two new kinds: `adjustment_decreasing` (stored kind
   `taxable`: 10 %, GST_COLLECTED — every 0031 check still holds) and `payg_withholding` (stored
   kind `bas_excluded`: rate 0, no roles — not a GST code). The effective kind is
   `coalesce(subkind, kind)`.

## Conclusion / decision

- Data table `app.bas_label_map` (effective-dated, per company): tax code, flow
  (sales/purchases/any), label, amount (gross/net/tax), positive side, basis
  (both/accruals/cash). The AU template ships the rows of finding 1; codes `ADJ-BD`, `EXP`,
  `BAS-W1`, `BAS-W2` join the template.
- Read API in `packages/ledger` (the only package that touches ledger tables) returns taxed lines
  and settlement releases; `packages/modules/tax` maps and sums with decimal.js. No writes.
- Company setting `gst_basis` (accruals default); the report takes a basis and a format
  (full | simpler).

## Confidence

High for G1/1A/1B/G10/G11 on the golden events (Approved goldens, S1–S4); medium for G2/G3/IMP/
INP purchases (prior knowledge, not re-read); medium for the sale/purchase-by-account-type rule
(design choice consistent with every golden). The accountant-reviewer persona (DL-0248) should
review finding 1 before production.

## Follow-ups

- Credit-note later-period presentation (`sales_adjustment_presentation`) once credit notes record
  their original invoice (follow-up card).
- Increasing adjustment for a bad-debt recovery at 1A (T-0048 owns the posting rule).
- Stripe monthly tax-invoice tie-out before lodgement (RQ-0095 Q2; T-0075).
- Whole-dollar rounding of labels on the lodged form (BAS UI, Phase 1).
- Re-read S6/S7 directly when the proxy allows.
