---
id: RQ-0122
title: How are customer statements and aged receivables built from the AR subledger, as at a date, and how do they reconcile to the AR control account?
status: answered
opened: 2026-11-09
resolved: 2026-11-09
opened_by: claude
linked_tasks: [T-0049, T-0110, T-0125, T-0041, T-0042]
linked_adrs: [ADR-0035]
superseded_by:
---

# RQ-0122 — Customer statements and aged receivables (T-0049)

## Question

- **Q1.** Ageing basis and buckets: by due date or document date, and which buckets?
- **Q2.** How are unallocated credits (unapplied receipts / over-payments, unallocated credit
  notes) shown, and do they enter the buckets?
- **Q3.** How are open amounts reconstructed *as at* a past date, when `subledger_entry` only stores
  the current open amount?
- **Q4.** In which currency do ageing and statements run, and how do they reconcile to the AR
  control account (base currency) when allocations carry FX differences?
- **Q5.** What does a statement contain, and how does it "equal the AR subledger for the party"?
- **Q6.** Scope boundaries with T-0125 (balance-sheet credit balances), T-0041/T-0042 (PDF, email)
  and T-0110 (Salesforce write-back of balance due / overdue).
- **Q7.** Is a migration needed?

## Why it matters

Ageing and statements are what a customer and the collections process see. If they do not tie to
the subledger and the control account, a customer is chased for money it has paid, or the balance
sheet and the ageing disagree (RQ-0039 "Why it matters").

## Sources

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | Design §3.3 table `subledger_entry` ("AR/AP open items for ageing and allocation"), §8.1 module catalog (AR: "statements, ageing"; Reporting MVP: "ageing"), §9 MVP ("aged AR/AP") | 2026-11-09 | design | Ageing and statements read the AR open items; ageing is an MVP report. No bucket definition beyond the card. |
| S2 | `.agent/backlog/T-0049.md` AC-1 | 2026-11-09 | card | "Aged AR buckets (current, 1–30, 31–60, 61–90, 90+) sum to AR control balance at date"; goal "aged AR query by due date". |
| S3 | RQ-0039, migration 0028, `packages/ledger/src/subledger.ts` (`subledgerReconciliation`, `subledgerDrift`) | 2026-11-09 | code / record | Items are signed like the GL (invoice +, receipt / credit note −), per line on an AR_CONTROL account, in transaction and base currency. Allocations are append-only and dated; reversals are negated rows. `subledgerReconciliation(asOf)` already reconstructs the base subledger as at a date: items dated ≤ asOf less the base released by allocations dated ≤ asOf, and compares with control + Σ fx_difference (realised FX not yet posted, DL-0187). |
| S4 | UC-12, SS-UC12-05; `packages/connectors/salesforce/src/writeback/mapping.ts` (`balanceDue`, `overdueAmount` on Account) | 2026-11-09 | spec / code | Salesforce shows balance due and overdue amount per Account; they must equal the aged-AR totals for the party. The write-back producer is T-0110. |
| S5 | T-0125 card, DL-0280, DL-0283 | 2026-11-09 | card / decision | AASB 101 ¶32: net customer credit balances are reclassified to a liability on the balance sheet, per party, as presentation in `packages/modules/reporting`. Statements and ageing are not in its scope. |
| S6 | T-0041 / T-0042 cards | 2026-11-09 | card | PDF rendering (headless Chromium) and SMTP delivery of statements belong there. |
| S7 | Common SMB practice for aged receivables (Xero "Aged Receivables" and MYOB "Ageing" reports; prior knowledge — vendor help sites are not reachable from this sandbox, proxy 403) | 2026-11-09 | secondary (prior knowledge) | Ageing defaults to due date; "Current" = not yet due; columns of 30 days, the last "older"; unapplied credits and prepayments are listed with the customer and reduce its total; the report total ties to the receivables account. |

## Findings

1. **Q1.** Age by **due date** (S2 goal, S7). Days overdue = asOf − due date (calendar days).
   Buckets: `current` (≤ 0, not yet due), `1–30`, `31–60`, `61–90`, `90+` (> 90). An invoice
   without an explicit due date has due date = entry date (migration 0028), so it is "current" on its
   own date.
2. **Q2.** Open **debit** items are aged into the buckets. Open **credit** items as at the date
   (unallocated receipts, i.e. over-payments and unapplied cash, and unallocated credit notes) are
   **not** aged: they are listed per party and totalled in a separate `unallocatedCredits` column
   (negative). Per party and in total: `net = Σ buckets + unallocatedCredits`. A party whose net is
   negative is flagged `inCredit` (the T-0125 balance-sheet case) but stays on the ageing.
   The fast-check property therefore states: Σ buckets + unallocated credits = AR control balance
   as at the date (S2 + the requirement that credits are shown separately).
3. **Q3.** Same reconstruction as S3, per item: `open(asOf) = original − sign(original) × Σ amount`
   over allocations touching the item dated ≤ asOf (reversals are negative, so they add back), and
   the same for base with `from_base_amount` / `to_base_amount`. Items dated after asOf are
   excluded. This lives in `packages/ledger` (the owner of ledger tables) as a read API,
   `openItemsAsOf`, next to `subledgerReconciliation`.
4. **Q4.** Ageing runs in **base currency** (`base open amount`), with the transaction currency and
   amount kept per item, because it must reconcile to the control account. The reconciliation block
   reports control balance, unposted FX (Σ fx_difference as at the date) and the difference, using
   `subledgerReconciliation(asOf)`; with one currency (the MVP AU case) unposted FX is zero and
   Σ ageing = control exactly. A **statement** runs in the customer's **transaction currency**, one
   section per currency the party has items in (a customer is billed in its own currency).
5. **Q5.** Statement for a party and range [from, to]: opening balance = Σ original amounts of the
   party's AR items dated before `from`; one line per item dated in the range (invoice, credit note,
   receipt, other) with reference, due date, debit / credit and running balance; allocations dated in
   the range listed for information (they move nothing between the party's balance — both sides
   belong to the party); closing = opening + Σ lines. Because allocations net to zero within a
   party and currency, closing = Σ open amounts of the party's items as at `to` — the AR subledger for
   the party. The statement also carries the party's ageing as at `to` and its unallocated credits.
   The document model is data only (no HTML/PDF).
6. **Q6.** T-0049 does not reclassify anything on the balance sheet (T-0125), does not render or
   email (T-0041/T-0042), and does not emit write-back events (T-0110). It provides
   `customerReceivableTotals` (balance due = net, overdue = Σ buckets 1–30…90+) that T-0110's
   producer will send; SS-UC12-05's aged-AR side is proved here, the write-back side in T-0110.
7. **Q7.** **No migration.** Every figure is a read of `subledger_entry`, `allocation`,
   `journal_*` and the AR document tables, which all exist (0028, 0037, 0039, 0040).

## Conclusion

Build `openItemsAsOf` / `allocationsAsOf` reads in `packages/ledger/src/subledger.ts`, pure ageing
and statement shaping in `packages/modules/ar/src/ageing.ts` and `customer-statement.ts`, and the
DB queries `agedReceivables`, `customerReceivableTotals` and `customerStatement` in
`packages/modules/ar/src/aged-receivables.ts`. No migration 0043. Decisions DL-0360…DL-0363.

**Confidence:** high for Q3–Q7 (code, design and cards); medium-high for Q1/Q2 (card + common
practice from prior knowledge, vendor pages not re-read today).
