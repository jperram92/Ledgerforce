---
id: RQ-0130
title: How does a bad-debt write-off document work — Div 21 eligibility, the GST decreasing adjustment, the ECL allowance path, and what stays out of scope?
status: answered
opened: 2026-11-09
resolved: 2026-11-09
opened_by: claude
linked_tasks: [T-0048, T-0175, T-0176, T-0177]
linked_adrs: []
superseded_by:
---

# RQ-0130 — Bad-debt write-off (T-0048)

## Question

- **Q1.** When may a write-off carry the Div 21 decreasing adjustment (ADJ-BD), and what does the
  document check (eligibility)?
- **Q2.** How is the GST adjustment of a **partial** write-off computed, and of an invoice that is
  not wholly taxable?
- **Q3.** Accruals versus cash basis: does the ledger entry differ?
- **Q4.** ECL allowance path (GP-007-A A2/A3): which balance limits the charge to the allowance,
  and how is the leftover allowance (A4) released?
- **Q5.** Where do `setting:ar.bad_debt_account` and `setting:ar.ecl_allowance_account` live?
- **Q6.** Does the subledger close the invoice, and how do statements, ageing and BAS see it?
- **Q7.** What is out of scope (recovery, automated ECL provision, maker-checker)?

## Why it matters

A write-off removes a receivable and reduces GST payable. If the adjustment is claimed when it is
not available, or an allowance is over-used, BAS and the balance sheet are wrong (s 21-5; AASB 9).

## Sources

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `Docs/accounting/postings.md` GP-007 (Approved, DL-0253) and GP-007-A (Approved, DL-0282 / DL-0387) | 2026-11-09 | golden (human-owned) | GP-007 lines, ADJ-BD, partial write-off = amount × 1/11 half-up, cash basis same entry no BAS; GP-007-A A1–A4 and the *Allowance rule* (ex-GST charge, default the lesser of the ex-GST amount and the allowance credit balance, never a debit balance, excess to bad debts, residue by A4). |
| S2 | RQ-0095 S2 (ATO "Types of adjustments") and S4 (GST Act Div 21, s 21-5, s 21-15) | 2026-11-08 (extracts; primary hosts return proxy 403) | primary (regulator / legislation) | Non-cash basis: decreasing adjustment if a taxable supply was made, the GST was attributed, and the debt is **written off as bad or overdue 12 months or more**; claimed in the period of write-off; recovery = increasing adjustment. Forgiven or set-off debts do not qualify. |
| S3 | `.agent/evidence/T-0124/accounting-rereview-20261109.md` (persona, DL-0386) RC-1, m1, m2, Q13, Q14 | 2026-11-09 | review | The user states the allowance charge with a default and a cap; A1 is a `manual_journal`; A4 is a remeasurement manual journal; 1B at the write-off date is conservative. |
| S4 | `packages/modules/tax/templates/au-tax-codes.json` (T-0035) | 2026-11-09 | code/data | ADJ-BD: 10 %, collected role GST_COLLECTED; BAS row `any → 1B, tax, debit, accruals`. Cash basis has no row, so the report shows nothing. |
| S5 | `packages/modules/tax/src/bas-report.ts`, `bas-report.db.test.ts` "bad debt: GP-007" | 2026-11-09 | code | The cash-basis report attributes only settlements (receipts, refunds) to a document; an `ar_write_off` allocation is not consideration. |
| S6 | `packages/modules/gl/templates/au-services-smb.v2.json` suggestedSettings | 2026-11-09 | data | `bad_debts_account` 6500, `ecl_allowance_account` 1290 (asset, receivable, credit normal, not control). |
| S7 | Migration 0037 `app.ar_invoice_settings`, 0021 `app.sod_settings` | 2026-11-09 | code | Company settings are insert-only history tables, latest row wins. |

## Findings

1. **Eligibility (Q1).** The write-off document *is* the act of writing off as bad (s 21-5(1),
   ground "written off"), so a posted write-off always meets the write-off ground. The document
   also records whether the debt was overdue 12 months or more on the write-off date (the second
   ground; GP-007-A m2). Further checks: the invoice is posted, it belongs to the party, the
   write-off date is not before the invoice date and is **after the due date** (the card scopes
   "an overdue invoice"), the amount is ≤ the invoice's AR open amount (a paid or forgiven part
   cannot be written off), and the invoice is in the company's base currency (FX write-offs are a
   follow-up; the engine posts base-currency lines here).
2. **GST of a partial or mixed write-off (Q2).** GST = written-off amount × invoice tax total ÷
   invoice total, half-up to cents. For a wholly taxable 10 % invoice this is the GP-007 rule
   (amount × 1/11), up to the invoice's own line rounding; a GST-free part carries no adjustment;
   a full write-off of an unpaid invoice returns exactly the GST raised (1,375.00 → 125.00). When
   the GST is 0.00 the journal has no ADJ-BD line and no GST line.
3. **Basis (Q3).** Same ledger lines on both bases (GP-007, RQ-0095 Q3). The BAS map makes the
   difference: accruals → 1B, cash → none. The document stores the company's GST basis at
   write-off time for display only.
4. **Allowance (Q4).** The *available* allowance is the allowance account's credit balance, the
   lesser of the balance at the write-off date and the latest balance (so a later-dated debit
   cannot be over-drawn either), under a per-company advisory lock so two write-offs cannot both
   spend it. The charge is ex-GST: default = min(ex-GST amount, available); a user-stated charge
   must be ≤ both. The ADJ-BD tax of the allowance line = GST × charge ÷ ex-GST, half-up; the
   bad-debt line takes the rest (A3: 100.00 + 25.00). The leftover (A2: 125.00) is released by an
   adjusting **manual journal** (A4, Dr allowance / Cr bad debts) through the manual-journal
   workflow (submit → approve → post); the module offers `allowanceReleaseLines` to draft it,
   capped at the available balance. A1 stays a `manual_journal` (Q13).
5. **Settings (Q5).** New insert-only history table `app.ar_write_off_settings` (latest row wins):
   `bad_debt_account_id` (expense) and optional `ecl_allowance_account_id` (asset, not a control
   account). Method `auto` (default) uses the allowance when the setting is present and the
   available balance is > 0, else direct; `direct` and `allowance` are explicit user choices.
6. **Subledger (Q6).** The AR credit line opens a write-off credit item that is allocated to the
   invoice in the same savepoint: invoice open 0.00, status *written off* (GP-007 Subledger). The
   statement shows the line as kind `write_off`; ageing reads open items, so nothing remains.
7. **Out of scope (Q7).** Recovery (increasing adjustment at 1A, s 21-15) → T-0176. Automated ECL
   provision (`ar.ecl_provision`, stored matrix inputs) → T-0175. Maker-checker approval (SoD) and
   the write-off screen → T-0177; until then the write-off records `created_by` and is an API/module
   action only. FX write-offs are refused (`FOREIGN_CURRENCY`) and listed on T-0177.

## Conclusion

Build the write-off as an insert-only document posted on creation through the engine (source type
`ar_write_off`, key `ar_write_off:<id>`), with the checks of finding 1, the GST of finding 2, the
allowance rule of finding 4, the settings of finding 5 and the allocation of finding 6. Prove it
with GP-007 and GP-007-A A2/A3 produced by the code, A1/A4 through the manual-journal path, and the
BAS report (1B 125.00 accruals, nothing on cash).

## Confidence

High for the ledger lines (Approved goldens). Medium for the "after due date" check (a scope
choice; s 21-5 itself only needs the write-off). Primary legislation text is unverified here
(proxy 403), as in RQ-0095.
