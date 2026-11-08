# Golden postings — LedgerForce

> **Status: APPROVED (owner-delegated to claude per DL-0253, 2026-11-08) — human gate `golden_postings`.
> Agents may not change after Approved.**
>
> **Accounting treatments approved by Claude under product-owner delegation; independent review by the
> accountant-reviewer AI persona (DL-0248) is required before production use; the persona is not a TPB-registered
> practitioner (see RQ-0095 confidence levels).**
>
> Drafted by: claude (scribe) · Date: 2026-10-24 · Task: T-0007 · Research: [RQ-0090](../research/RQ-0090-golden-posting-tax-treatments.md), [RQ-0095](../research/RQ-0095-golden-posting-open-questions.md)
> Approval: GP-001 … GP-020 `Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)`. The product owner
> delegated the `golden_postings` gate for T-0007 to claude on 2026-11-08 (owner's words quoted in DL-0253).
> Originally: _pending_ — the product owner changes each entry's `Status: Draft` to `Status: Approved (initials, date)`.
> After approval this file is human-owned (AGENTS.md §5): agents propose changes in a PR comment or a new
> `Draft` entry that supersedes the old one; they never edit an Approved entry.

## How to read this file

- Every entry is a **golden posting**: the exact journal the posting engine must produce for a standard
  event in design §3.8 (plus the §4.5 deposit rule and the §3.4 rounding rule). The golden-posting runner
  (backlog card "Golden-posting test runner") parses the tables below and asserts the engine output line-for-line.
- Accounts are named by **system role** (`system:AR_CONTROL`), **posting-profile slot**
  (`product:PROFESSIONAL_SERVICES.revenue`), **tax-code account** (`tax:GST.collected`), **bank account binding**
  (`bank:OPERATING`) or **connector/setting binding** (`setting:ar.bad_debt_account`). The engine resolves these;
  tests must never hard-code account codes. Reference codes come from the AU services SMB template (below) and are
  illustrative only.
- All amounts AUD, company base currency AUD, `NUMERIC(19,4)` stored, shown to cents. GST 10%,
  **per-line, half-up to cents** (AU default, design §3.4) unless the entry says otherwise.
- GST basis for BAS columns: **accruals** unless stated; the cash-basis effect is noted where it differs.
- The fixed fictional parties: customer **Acme Pty Ltd** (party profile `DOMESTIC_CUSTOMER`), supplier
  **Officeworks-like Supplies Pty Ltd** (`DOMESTIC_SUPPLIER`), employees of the tenant **Demo Co Pty Ltd**.
- Every table ends with a **Total** row; the self-check script verifies Σdebit = Σcredit for every journal.

### Reference chart (AU services SMB template — illustrative codes)

| Code | Account | Binding |
|---|---|---|
| 1100 | Bank — Operating | `bank:OPERATING` (bank account record → GL account) |
| 1110 | Undeposited funds | `system:UNDEPOSITED_FUNDS` |
| 1120 | Stripe clearing | `setting:stripe.clearing_account` (see Q2) |
| 1200 | Accounts receivable | `system:AR_CONTROL` (control account) |
| 1510 | Computer equipment (asset) | chosen on bill line / product `HARDWARE.asset` |
| 2100 | Accounts payable | `system:AP_CONTROL` (control account) |
| 2200 | GST collected | `system:GST_COLLECTED` = `tax:GST.collected` |
| 2210 | GST paid | `system:GST_PAID` = `tax:GST.paid` |
| 2300 | Wages payable | `system:WAGES_PAYABLE` |
| 2310 | PAYG withholding payable | `system:PAYG_WITHHOLDING` |
| 2320 | Superannuation payable | `system:SUPER_PAYABLE` |
| 2330 | Payroll clearing | `system:PAYROLL_CLEARING` (control account; GP-020) |
| 2400 | Customer prepayments (liability) | `system:CUSTOMER_PREPAYMENTS` |
| 2410 | Deferred revenue (liability) | `system:DEFERRED_REVENUE` |
| 4000 | Revenue — Professional services | `product:PROFESSIONAL_SERVICES.revenue` |
| 4100 | Revenue — Subscriptions | `product:SUBSCRIPTION.revenue` |
| 6100 | Office expenses | chosen on bill line |
| 6200 | Merchant fees | `setting:stripe.fee_account` (see Q2) |
| 6300 | Bad debts | `setting:ar.bad_debt_account` (see Q3) |
| 6400 | Wages and salaries | `setting:payroll.wages_expense` |
| 6410 | Superannuation expense | `setting:payroll.super_expense` |
| 8900 | Rounding | `system:ROUNDING` |

### BAS labels used

G1 total sales (GST-inclusive) · 1A GST on sales (and increasing adjustments) · G10 capital purchases ·
G11 non-capital purchases · 1B GST on purchases (and decreasing adjustments) · W1 total salary and wages ·
W2 amounts withheld. Businesses on Simpler BAS report only G1, 1A and 1B; G10/G11 are still captured on lines.

---

## Index

| Id | Event (design ref) | Phase | Use cases | Status |
|---|---|---|---|---|
| GP-001 | Sales invoice (§3.8) | MVP | UC-01, UC-02 | Approved |
| GP-002 | Customer receipt — bank transfer (§3.8) | MVP | UC-03 | Approved |
| GP-003 | Card receipt via Stripe — payment into clearing (§3.8) | MVP | UC-03 | Approved |
| GP-004 | Stripe payout — net settlement (§3.8) | MVP | UC-03, UC-08 | Approved |
| GP-005 | Customer credit note — partial, on a paid invoice (§3.8) | MVP | UC-11 | Approved |
| GP-006 | Customer refund — bank / payment batch (§3.8, UC-11) | MVP | UC-11 | Approved |
| GP-007 | Bad debt write-off incl. GST decreasing adjustment (§3.8) | MVP | — | Approved |
| GP-008 | Supplier bill (§3.8) | MVP | UC-05 | Approved |
| GP-009 | Supplier payment (§3.8) | MVP | UC-06 | Approved |
| GP-010 | Payroll journal from payroll provider (§3.8) | Phase 1 | UC-07 | Approved |
| GP-011 | Net pay batch (§3.8) | Phase 1 | UC-07 | Approved |
| GP-012 | Customer prepayment received (§3.8) | MVP | — | Approved |
| GP-013 | Prepayment applied to the final invoice (§3.8, §4.3) | MVP | — | Approved |
| GP-014 | Deposit invoice — §4.5 rule `deposit-on-closed-won` | MVP (format) / Phase 1 (rule) | UC-09 | Approved |
| GP-015 | Final invoice net of deposit (§4.3) | MVP | UC-09 | Approved |
| GP-016 | Annual subscription invoiced to deferred revenue (§3.8) | Phase 2 | — | Approved |
| GP-017 | Deferred revenue release (§3.8) | Phase 2 | — | Approved |
| GP-018 | Rounding — per-line vs per-document GST (§3.4) | MVP | UC-01 | Approved |
| GP-019 | Reversal (void) of a posted sales invoice (§3.3, principle 2) | MVP | UC-10 | Approved |
| GP-020 | Pay run settled by provider debit — PAYROLL_CLEARING (§3.2, §3.8; RQ-0095 Q5) | Phase 1 | UC-07 | Approved |

---

## GP-001 — Sales invoice, two lines, GST exclusive

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01, UC-02 · Design: §3.8 row 1, §3.4
- **Scenario:** INV-000123 to Acme Pty Ltd dated 2026-11-05, terms 14 days.
  Line 1 Professional services, $1,000.00 ex GST, tax code GST → GST 100.00.
  Line 2 Subscription, $250.00 ex GST, tax code GST → GST 25.00. Invoice total $1,375.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 1,375.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 1,000.00 | GST (tax 100.00) | Acme |
| 3 | product:SUBSCRIPTION.revenue | 4100 | | 250.00 | GST (tax 25.00) | Acme |
| 4 | tax:GST.collected | 2200 | | 125.00 | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** Σdebit 1,375.00 = Σcredit 1,000.00 + 250.00 + 125.00 = 1,375.00 ✓
- **Subledger:** AR open item INV-000123, original 1,375.00, open 1,375.00, due 2026-11-19.
- **Tax/BAS (accruals):** G1 +1,375.00; 1A +125.00 in the period of 2026-11-05. Cash basis: nothing until paid (see GP-002).
- **Salesforce:** LF_Invoice__c upserted (status Posted/Sent, total 1,375.00, amount due 1,375.00); Opportunity LF_Amount_Invoiced__c +1,375.00; Account LF_Balance_Due__c +1,375.00.

## GP-002 — Customer receipt by bank transfer (full)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.receipt` · Use cases: UC-03, UC-08 · Design: §3.8 row 2
- **Scenario:** 2026-11-15 Acme pays INV-000123 in full, $1,375.00, by EFT into the operating account; receipt allocated to INV-000123.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 1,375.00 | | — | — |
| 2 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,375.00 = 1,375.00 ✓
- **Variant:** if the receipt is recorded before banking (cheque/cash), line 1 is `system:UNDEPOSITED_FUNDS` (1110); the later deposit moves it to the bank account (Dr bank / Cr undeposited funds).
- **Subledger:** receipt open item −1,375.00; allocation receipt→INV-000123 1,375.00, fx_difference 0.00; both open amounts 0.00 → invoice status Paid.
- **Tax/BAS:** accruals none. Cash basis: G1 +1,375.00, 1A +125.00 in the period of 2026-11-15 (proportional to the amount received).
- **Salesforce:** LF_Invoice__c status Paid, amount due 0.00; LF_Payment__c created; Account LF_Balance_Due__c −1,375.00, LF_Last_Payment_Date__c 2026-11-15; Opportunity LF_Amount_Paid__c +1,375.00.

## GP-003 — Card payment via Stripe: payment received into Stripe clearing

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `payments.stripe.charge` · Use cases: UC-03 · Design: §3.8 row 3, §5.7
- **Scenario:** 2026-11-15 Acme pays INV-000123 ($1,375.00) through the invoice's Stripe payment link (webhook `payment_intent.succeeded` / `charge.succeeded`).
  The customer receipt **and** the Stripe fee with its GST are recognised at charge time from the charge's balance
  transaction (`fee`, `fee_details[]`, `net`), so Stripe clearing always equals the Stripe balance (Q1, RQ-0095).
  Stripe fee for the charge $23.68 in total (1.7% + $0.30 = 23.675 → 23.68), of which GST $2.15 and fee $21.53 —
  the split is taken from Stripe's fee breakdown, not recomputed (Q2). Net $1,351.32 stays in clearing until the payout (GP-004).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:stripe.clearing_account | 1120 | 1,351.32 | | — | — |
| 2 | setting:stripe.fee_account | 6200 | 21.53 | | GST (tax 2.15) | Stripe |
| 3 | tax:GST.paid | 2210 | 2.15 | | GST | — |
| 4 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,351.32 + 21.53 + 2.15 = 1,375.00 = 1,375.00 ✓
- **Subledger:** receipt −1,375.00 allocated to INV-000123 → Paid. Idempotency key = Stripe event id.
- **Tax/BAS (accruals):** G11 +23.68; 1B +2.15 in the charge period — claimable once Stripe's monthly tax invoice
  for the charge month is held (s 29-10(3)); BAS preparation checks Σ per-charge fee GST = the invoice's GST (Q2).
  Customer side as GP-002 (cash basis G1 +1,375.00, 1A +125.00 on this date). Refunds, disputes and Stripe fee
  adjustments post at their own balance-transaction dates.
- **Salesforce:** as GP-002.
- **Superseded draft (2026-10-24, retained):** receipt at charge, gross (Dr clearing 1,375.00 / Cr AR_CONTROL
  1,375.00), fee recognised at payout. Replaced by fee-at-charge per RQ-0095 Q1 (month-end cut-off; clearing =
  Stripe balance at every date).

## GP-004 — Stripe payout: net settlement (net moves from Stripe clearing to bank)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `payments.stripe.payout` · Use cases: UC-03, UC-08 · Design: §3.8 row 3
- **Scenario:** 2026-11-17 Stripe pays out the GP-003 charge. The fee and its GST were already recognised at
  charge (GP-003, Q1); the payout only moves the net $1,351.32 from Stripe clearing to the operating account.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 1,351.32 | | — | — |
| 2 | setting:stripe.clearing_account | 1120 | | 1,351.32 | — | — |
| | **Total** | | **1,351.32** | **1,351.32** | | |

- **Check:** 1,351.32 = 1,351.32 ✓ · Stripe clearing nets to 0.00 for this charge (GP-003 Dr 1,351.32, here Cr 1,351.32).
- **Subledger:** none (no AR/AP control line). The bank statement line 1,351.32 matches this entry in reconciliation (UC-08).
- **Tax/BAS:** none at payout. The fee GST (1B +2.15, GP-003) is claimable once Stripe's monthly tax invoice for the
  charge month is held (s 29-10(3)); BAS preparation checks Σ per-charge fee GST = the invoice's GST and posts any
  difference as a one-line adjustment on `setting:stripe.fee_account` with code GST, dated in that month (Q2, RQ-0095).
- **Bindings:** Stripe clearing and merchant fees are Stripe connector **settings**, not system roles (Q2); the
  clearing account is flagged as a reconciliation account (manual journals to it need approval).
- **Superseded draft (2026-10-24, retained):** net settlement at payout — Dr bank 1,351.32 / Dr fees 21.53 (GST,
  tax 2.15) / Dr GST paid 2.15 / Cr clearing 1,375.00. Replaced per RQ-0095 Q1 (fee at charge).

## GP-005 — Customer credit note, partial, on a paid invoice

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.credit_note` · Use cases: UC-11 · Design: §3.8 row 4
- **Scenario:** 2026-11-20 CN-000007 against paid INV-000123: credit $200.00 ex GST of the Professional services
  line (scope reduced). GST 20.00; credit note total $220.00. Because INV-000123 is fully paid, the credit is
  held as customer credit (to be refunded in GP-006).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | product:PROFESSIONAL_SERVICES.revenue | 4000 | 200.00 | | GST (tax 20.00) | Acme |
| 2 | tax:GST.collected | 2200 | 20.00 | | GST | — |
| 3 | system:AR_CONTROL | 1200 | | 220.00 | — | Acme |
| | **Total** | | **220.00** | **220.00** | | |

- **Check:** 200.00 + 20.00 = 220.00 = 220.00 ✓
- **Subledger:** credit-note open item −220.00 (customer credit). Not allocatable to INV-000123 (already open 0.00); Acme's AR balance is −220.00 (credit).
- **Tax/BAS (accruals):** same BAS period as INV-000123 → G1 −220.00, 1A −20.00. If the credit note fell in a
  later BAS period: **1B +20.00**, G1 unchanged (decreasing adjustment, Div 19); company option
  `sales_adjustment_presentation = adjustment_1B (default) | net_G1_1A` (T-0035). The document is always issued as an
  **adjustment note** referencing the original invoice number and date (Q4, RQ-0095).
- **Salesforce:** LF_Invoice__c for INV-000123 shows credited 220.00; Opportunity LF_Amount_Paid__c becomes net 1,155.00 after the refund (GP-006); Account LF_Balance_Due__c −220.00 until refunded.

## GP-006 — Customer refund paid from the bank (payment batch)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.refund` · Use cases: UC-11 · Design: §3.8 (refund follows "Supplier payment" mechanics), UC-11
- **Scenario:** 2026-11-24 the $220.00 credit on CN-000007 is refunded to Acme's verified bank account in the next payment batch (posts on bank confirmation).
  Bank details verified (requester ≠ verifier, cooling-off elapsed — design §6.5 rule 2 extended to customer refunds, Q9); batch creator ≠ releaser.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 220.00 | | — | Acme |
| 2 | bank:OPERATING | 1100 | | 220.00 | — | — |
| | **Total** | | **220.00** | **220.00** | | |

- **Check:** 220.00 = 220.00 ✓
- **Variant (Stripe refund):** line 2 is `setting:stripe.clearing_account` (1120); the refund is netted in the next payout.
- **Subledger:** refund open item +220.00 allocated to CN-000007 → both 0.00. Acme AR balance 0.00. Refund ≤ the
  customer's open credit at release (Q9). Where the original receipt came through Stripe the default is a Stripe
  refund to the original card (variant above); overriding it needs a reason.
- **Tax/BAS:** none (GST already adjusted by GP-005).
- **Salesforce:** Opportunity LF_Amount_Paid__c = 1,375.00 − 220.00 = **1,155.00** (net paid); Account LF_Balance_Due__c 0.00.

## GP-007 — Bad debt write-off including GST decreasing adjustment

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.write_off` · Use cases: — (AR) · Design: §3.8 row 5
- **Scenario:** a different invoice, INV-000140 to Acme for $1,375.00 (1,250.00 + GST 125.00, same lines as GP-001 but
  unpaid), is written off in full on 2027-12-01 after being overdue more than 12 months. Company GST basis: accruals.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.bad_debt_account | 6300 | 1,250.00 | | ADJ-BD (tax 125.00) | Acme |
| 2 | tax:GST.collected | 2200 | 125.00 | | ADJ-BD | — |
| 3 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,250.00 + 125.00 = 1,375.00 = 1,375.00 ✓
- **Subledger:** write-off document −1,375.00 allocated to INV-000140 → open 0.00, status Written off.
- **Tax/BAS (accruals):** decreasing adjustment **1B +125.00** in the period of write-off (ATO: decreasing adjustments at 1B, RQ-0090). A later recovery is an increasing adjustment at 1A. **Cash basis:** the GST was never reported, so no BAS adjustment; the ledger entry is the same (clears the 125.00 never-remitted liability). See Q3.
- **Partial write-off:** GST adjustment = written-off amount × 1/11, half-up to cents.
- **Tax code `ADJ-BD`** (RQ-0095 Q3): bad-debt decreasing adjustment, rate 10%, posted against GST collected (the
  liability is cleared where it was raised); BAS map accruals → 1B, cash → none. It joins the AU template together
  with its BAS mapping (T-0035/T-0048). No adjustment note is required (Div 21); a later recovery is an increasing
  adjustment at 1A via the reversing code. The bad debts account stays a **setting** (`setting:ar.bad_debt_account`),
  not a system role. (Draft 2026-10-24 named the code `GST-ADJ`, which is not a template code — superseded.)

## GP-008 — Supplier bill (expense + capital asset)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ap.bill` · Use cases: UC-05 · Design: §3.8 row 6
- **Scenario:** BILL-000045 from Officeworks-like Supplies dated 2026-11-03, due 2026-11-30.
  Line 1 stationery and consumables $500.00 ex GST (tax code GST, non-capital) → GST 50.00.
  Line 2 laptop $2,000.00 ex GST (tax code CAP, capital acquisition) → GST 200.00. Total $2,750.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | expense: Office expenses | 6100 | 500.00 | | GST (tax 50.00) | Supplier |
| 2 | asset: Computer equipment | 1510 | 2,000.00 | | CAP (tax 200.00) | Supplier |
| 3 | tax:GST.paid | 2210 | 50.00 | | GST | — |
| 4 | tax:CAP.paid | 2210 | 200.00 | | CAP | — |
| 5 | system:AP_CONTROL | 2100 | | 2,750.00 | — | Supplier |
| | **Total** | | **2,750.00** | **2,750.00** | | |

- **Check:** 500.00 + 2,000.00 + 50.00 + 200.00 = 2,750.00 = 2,750.00 ✓
- **Tax lines (F1, RQ-0095):** one tax line per tax code. `tax:CAP.paid` resolves to GST paid (2210) through the CAP
  code's GST_PAID role, as `tax:GST.paid` does. (Draft 2026-10-24 had a single line 3 "250.00, GST / GST-CAP" —
  superseded: a journal line carries one tax code and `GST-CAP` is not a template code; line 1 is non-capital, so
  the bill is not collapsed to CAP.)
- **Subledger:** AP open item BILL-000045, original 2,750.00, open 2,750.00, due 2026-11-30.
- **Tax/BAS (accruals):** G10 +2,200.00; G11 +550.00; 1B +250.00. Cash basis: on payment (GP-009).

## GP-009 — Supplier payment (payment batch, posted on bank confirmation)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ap.payment` · Use cases: UC-06 · Design: §3.8 row 7
- **Scenario:** payment batch PB-000012 released 2026-11-27, ABA file uploaded, bank confirms 2026-11-28; BILL-000045 paid $2,750.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AP_CONTROL | 2100 | 2,750.00 | | — | Supplier |
| 2 | bank:OPERATING | 1100 | | 2,750.00 | — | — |
| | **Total** | | **2,750.00** | **2,750.00** | | |

- **Check:** 2,750.00 = 2,750.00 ✓
- **Subledger:** payment −2,750.00 allocated to BILL-000045 → 0.00, status Paid. Nothing posts at release; only on confirmation.
- **Tax/BAS:** accruals none. Cash basis: G10 +2,200.00, G11 +550.00, 1B +250.00 in the payment period.
- **Batch detail (Q6, RQ-0095):** **one journal per confirmed batch, one AP_CONTROL line per bill (with party), one
  bank credit for the batch total.** The single bank line matches the single balancing debit on the bank statement
  (ABA self-balanced file); the per-bill lines give exact allocations and remittance detail. A rejected/returned
  item is a separate later entry (Dr bank / Cr AP_CONTROL for that bill, reopening it), never an edit. (Draft
  2026-10-24 called a per-supplier AP line "equally valid" — superseded.)

## GP-010 — Payroll journal from payroll provider (Phase 1)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: Phase 1 · Source type: `payroll.pay_run` · Use cases: UC-07 · Design: §3.8 row 8
- **Scenario:** fortnightly pay run ending 2027-07-14, finalised in the payroll provider and imported: gross wages $10,000.00;
  PAYG withheld $2,000.00; superannuation guarantee 12% = $1,200.00; net pay $8,000.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:payroll.wages_expense | 6400 | 10,000.00 | | BAS-W1 | — |
| 2 | setting:payroll.super_expense | 6410 | 1,200.00 | | — | — |
| 3 | system:PAYG_WITHHOLDING | 2310 | | 2,000.00 | BAS-W2 | — |
| 4 | system:SUPER_PAYABLE | 2320 | | 1,200.00 | — | — |
| 5 | system:WAGES_PAYABLE | 2300 | | 8,000.00 | — | — |
| | **Total** | | **11,200.00** | **11,200.00** | | |

- **Check:** 10,000.00 + 1,200.00 = 11,200.00 = 2,000.00 + 1,200.00 + 8,000.00 = 11,200.00 ✓
- **Subledger:** per-employee lines are not posted to the GL (summary only); the pay-run id is the idempotency key. See Q5 on PAYROLL_CLEARING.
- **Tax/BAS:** W1 +10,000.00, W2 +2,000.00 for the period containing the pay date. No GST.
- **Super:** SG is 12% of qualifying earnings; Payday Super (from 2026-07-01) requires SUPER_PAYABLE for this run to
  reach the fund within 7 business days of payday (by 2027-07-23).
- **Settlement mode (Q5, RQ-0095):** this golden is `net_pay_settlement = ledgerforce_batch` (default): LedgerForce
  pays net pay by its own ABA batch (GP-011), so net pay is credited to WAGES_PAYABLE. When the provider settles
  (`provider_debit`) see GP-020 (PAYROLL_CLEARING).

## GP-011 — Net pay batch (Phase 1)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: Phase 1 · Source type: `payroll.net_pay_batch` · Use cases: UC-07 · Design: §3.8 row 9
- **Scenario:** the GP-010 net pay ($8,000.00) is paid by ABA batch, released by a second user, confirmed 2027-07-15.
  One WAGES_PAYABLE line for the batch total (wages payable has no party subledger) and one bank line (Q6).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:WAGES_PAYABLE | 2300 | 8,000.00 | | — | — |
| 2 | bank:OPERATING | 1100 | | 8,000.00 | — | — |
| | **Total** | | **8,000.00** | **8,000.00** | | |

- **Check:** 8,000.00 = 8,000.00 ✓
- **Tax/BAS:** none.

## GP-012 — Customer prepayment received (no tax invoice yet)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.prepayment` · Use cases: — · Design: §3.8 row 10
- **Scenario:** 2026-11-10 Acme pays a $3,300.00 prepayment (30% of an $11,000.00 GST-inclusive project) by EFT before any invoice is issued.
  **Option B (golden, RQ-0095 Q7):** GST is attributed on receipt at 1/11 of the amount (accruals: earlier of payment
  and invoice, s 29-5(1); cash: to the extent received), tax code GST; the user is prompted to issue the
  deposit/tax invoice, and the final invoice nets the GST already reported (GP-013). The default path for a known
  taxable supply is still the deposit tax invoice (GP-014); this entry covers an uninvoiced (unsolicited) prepayment.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 3,300.00 | | — | — |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,000.00 | GST (tax 300.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 300.00 | GST | — |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 3,300.00 = 3,000.00 + 300.00 ✓
- **Subledger:** unapplied prepayment −3,000.00 net (−3,300.00 gross received) on Acme (customer credit, not an
  AR_CONTROL line).
- **Tax/BAS (accruals and cash):** G1 +3,300.00; 1A +300.00 in the period of 2026-11-10.
- **Security-deposit variant (Div 99), no GST:** only when the user classifies the money as a genuine security
  deposit (Div 99) or as relating to a GST-free / input-taxed / not-yet-known supply — classification stored on the
  receipt — the whole receipt goes to the liability: Dr bank 3,300.00 / Cr CUSTOMER_PREPAYMENTS 3,300.00, no BAS
  effect until applied or forfeited. This is the former Option A.
- **Residual risk (accountant, not decidable in software):** where a contract is not a Div 156 progressive supply,
  s 29-5 may attribute the **whole** contract GST to the first payment period; LedgerForce documents this on the
  deposit format and treats deposit + final invoice as progressive components (RQ-0095 Q7 point 4).

> **Superseded draft (2026-10-24, retained for history — not a golden):** *Option A (as design §3.8):* whole receipt
> to the liability, no GST at receipt — Dr `bank:OPERATING` 3,300.00 / Cr `system:CUSTOMER_PREPAYMENTS` 3,300.00
> (party Acme); subledger unapplied prepayment −3,300.00. Rejected for taxable part payments by RQ-0095 Q7 (not
> compliant on the accruals basis, s 29-5(1)); retained only as the Div 99 security-deposit variant above.

## GP-013 — Prepayment applied to the final invoice

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.invoice` · Use cases: — · Design: §3.8 row 10, §4.3 "Deposit / prepayment … applied to the final invoice"
- **Scenario:** 2026-12-15 final invoice INV-000150 for the project: Professional services $10,000.00 ex GST, less the
  GP-012 prepayment (Option B, $3,000.00 ex GST, GST 300.00 already reported) applied on the invoice. GST on the net
  = 700.00. Amount due $7,700.00. One journal — the same shape as GP-015 (RQ-0095 Q7).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 7,700.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,000.00 | | GST (tax 300.00) | Acme |
| 3 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 4 | tax:GST.collected | 2200 | | 700.00 | GST | — |
| | **Total** | | **10,700.00** | **10,700.00** | | |

- **Check:** 7,700.00 + 3,000.00 = 10,700.00 = 10,000.00 + 700.00 ✓ · Customer prepayments for the project nets to
  0.00 (3,000.00 Cr in GP-012, 3,000.00 Dr here).
- **Subledger:** INV-000150 opens at 7,700.00; the GP-012 prepayment is applied on the invoice → unapplied 0.00. No
  separate application journal is needed.
- **Tax/BAS (accruals):** G1 +7,700.00, 1A +700.00 at 2026-12-15 — project total 1A 300.00 (GP-012) + 700.00 =
  1,000.00 ✓; the GST already reported at GP-012 is not reported again.
- **Salesforce:** LF_Invoice__c amount due 7,700.00; Opportunity LF_Amount_Paid__c 3,300.00.

> **Superseded draft (2026-10-24, retained for history — not a golden):** two journals under Option A.
> *Journal 13a — final invoice:* Dr `system:AR_CONTROL` 11,000.00 (Acme) / Cr `product:PROFESSIONAL_SERVICES.revenue`
> 10,000.00 (GST, tax 1,000.00) / Cr `tax:GST.collected` 1,000.00; Σ 11,000.00. *Journal 13b — application of
> prepayment* (source type `ar.prepayment_application`): Dr `system:CUSTOMER_PREPAYMENTS` 3,300.00 (Acme) / Cr
> `system:AR_CONTROL` 3,300.00 (Acme); Σ 3,300.00. Subledger: INV-000150 original 11,000.00, allocation 3,300.00 →
> open 7,700.00. BAS G1 +11,000.00, 1A +1,000.00. Superseded by RQ-0095 Q7: with Option B at GP-012 the liability
> (3,000.00 net) is cleared on the final invoice and journal 13b is no longer needed.

## GP-014 — Deposit invoice from rule `deposit-on-closed-won` (design §4.5)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP (deposit billing format §4.3); Phase 1 when produced by Rules Studio (UC-09) · Source type: `ar.invoice` · Use cases: UC-09 · Design: §4.5
- **Scenario:** Opportunity "Acme website rebuild" Closed Won 2026-11-02, Amount $10,000.00 (ex GST), Deposit_Percent__c 30.
  `base = 10,000.00 × 30 / 100 = 3,000.00`; `tax(base, GST) = 300.00`; `gross = 3,300.00`. Approval not required (≤ 10,000).
  Entry tagged `rule_id=deposit-on-closed-won, rule_version=3`, dimension `sales_team` from Opportunity.Owner.Team__c.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 3,300.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,000.00 | GST (tax 300.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 300.00 | GST | — |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 3,300.00 = 3,000.00 + 300.00 ✓
- **Subledger:** AR open item DEP-000004 3,300.00 (a tax invoice). Receipt then follows GP-002 (Dr bank 3,300.00 / Cr AR 3,300.00).
- **Tax/BAS (accruals):** G1 +3,300.00; 1A +300.00 at 2026-11-02.
- **Control-account note:** the rule writes AR_CONTROL only because it carries `party:` — the engine creates the subledger entry; a rule line on a control account without a party is refused (SS-PLAT-07).
- **Source type and provenance (F2, RQ-0095):** the deposit invoice is a tax invoice in the AR series (billing format
  "Deposit / prepayment", §4.3), so its source type is `ar.invoice` (period class `ar`). The rule is **provenance,
  not a source type**: the entry records `rule_id=deposit-on-closed-won, rule_version=3` (design §4.5); storing it
  on `journal_entry` (additive columns) is a Rules Studio follow-up. (Draft 2026-10-24 used source type
  `rule:deposit-on-closed-won@3`, which is not in the period matrix and cannot be stored — superseded.)
- **Account (Q10, RQ-0095):** credit **CUSTOMER_PREPAYMENTS** (contract liability, AASB 15 ¶106), not revenue; revenue
  is recognised by the final invoice (GP-015). The deposit invoice must be marked *Tax invoice*; its GST is reported
  at issue (accruals) — see Q7.

## GP-015 — Final invoice net of deposit

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-09 · Design: §4.3
- **Scenario:** 2026-12-15 final invoice INV-000151 for the GP-014 project (deposit DEP-000004 already paid): Professional services $10,000.00 ex GST, less deposit applied $3,000.00 ex GST. GST on the net = 700.00. Amount due $7,700.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 7,700.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,000.00 | | GST (tax 300.00) | Acme |
| 3 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 4 | tax:GST.collected | 2200 | | 700.00 | GST | — |
| | **Total** | | **10,700.00** | **10,700.00** | | |

- **Check:** 7,700.00 + 3,000.00 = 10,700.00 = 10,000.00 + 700.00 ✓ · Customer prepayments for the project nets to 0.00 (3,000.00 Cr in GP-014, 3,000.00 Dr here).
- **Tax amounts are unsigned (F4, RQ-0095):** the debit side of line 2 expresses the reduction, exactly as GP-005; the
  tax amount is 300.00, never negative. (Draft 2026-10-24 wrote `GST (tax −300.00)`, which the engine refuses —
  superseded.)
- **Subledger:** INV-000151 open 7,700.00.
- **Tax/BAS:** G1 +7,700.00; 1A +700.00 — total GST on the project 300.00 + 700.00 = 1,000.00 ✓.

## GP-016 — Annual subscription invoiced in advance to deferred revenue (Phase 2)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: Phase 2 · Source type: `ar.invoice` (product profile SUBSCRIPTION with deferral schedule) · Design: §3.8 row 11, §8.1 Revenue Recognition
- **Scenario:** 2027-01-01 INV-000200 annual subscription 12 months $12,000.00 ex GST, GST 1,200.00, total 13,200.00, recognised monthly.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 13,200.00 | | — | Acme |
| 2 | system:DEFERRED_REVENUE | 2410 | | 12,000.00 | GST (tax 1,200.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 1,200.00 | GST | — |
| | **Total** | | **13,200.00** | **13,200.00** | | |

- **Check:** 13,200.00 = 12,000.00 + 1,200.00 ✓
- **Tax/BAS (accruals):** G1 +13,200.00; 1A +1,200.00 at invoice date (GST follows the invoice, not the revenue schedule).

## GP-017 — Deferred revenue release (Phase 2)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: Phase 2 · Source type: `revrec.release` · Design: §3.8 row 11
- **Scenario:** 2027-01-31 month-end release of 1/12 of GP-016 ($1,000.00). Remaining deferred 11,000.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:DEFERRED_REVENUE | 2410 | 1,000.00 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 1,000.00 | — | Acme |
| | **Total** | | **1,000.00** | **1,000.00** | | |

- **Check:** 1,000.00 = 1,000.00 ✓ · 12 releases sum to 12,000.00; any rounding residue goes to the last release, not ROUNDING.
- **Tax/BAS:** none.
- **Source type (F3, RQ-0095):** `revrec.release` stays. It is added to the period matrix (stored `revrec_release`,
  class `journal`: allowed under AR/AP lock, override under soft close, deny under hard lock) **and** to the SQL
  mirror `app.source_type_class` by a forward-only migration in the Phase-2 revenue-recognition task, with the
  period-control parity test. Until then the runner reports this entry PENDING (out of phase).

## GP-018 — Rounding: per-line (default) vs per-document GST on a tax-inclusive invoice

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01 · Design: §3.4 ("difference to the document total posts to ROUNDING")
- **Scenario:** INV-000160, three Subscription add-on lines each **$3.35 GST-inclusive** (document total $10.05).
  Line net = 3.35 / 1.1 = 3.04545… → 3.05 (half-up). Tax code **GST** with the document's price mode
  **tax-inclusive** (`amountsAre = inclusive`, DL-0245): inclusive pricing is a property of the document, not of the
  code. (Draft 2026-10-24 labelled the code `GST-INC`, which is not a template code — superseded, RQ-0095 Q8.)

**18a — company setting `tax_rounding = per_line` (AU default):** line GST = 3.35 / 11 = 0.30454… → 0.30; each line nets 3.05 + 0.30 = 3.35. No rounding line.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 9.15 | GST (tax 0.90) | Acme |
| 3 | tax:GST.collected | 2200 | | 0.90 | GST | — |
| | **Total** | | **10.05** | **10.05** | | |

**18b — company setting `tax_rounding = per_document`:** document GST = 10.05 / 11 = 0.91363… → 0.91; line nets stay 3.05 × 3 = 9.15; 9.15 + 0.91 = 10.06 vs document total 10.05 → difference 0.01 debited to ROUNDING.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | system:ROUNDING | 8900 | 0.01 | | — | — |
| 3 | product:SUBSCRIPTION.revenue | 4100 | | 9.15 | GST (tax 0.91 doc-level) | Acme |
| 4 | tax:GST.collected | 2200 | | 0.91 | GST | — |
| | **Total** | | **10.06** | **10.06** | | |

- **Check:** 18a 10.05 = 9.15 + 0.90 ✓ · 18b 10.05 + 0.01 = 10.06 = 9.15 + 0.91 ✓
- **Tax/BAS:** 18a G1 +10.05, 1A +0.90 · 18b G1 +10.05, 1A +0.91 (GST equals the GST shown on the tax invoice in both cases).
- **Residue (Q8, RQ-0095):** the per-document difference posts to **ROUNDING** (design §3.4), never into a revenue
  line, so every revenue line equals the line net on the invoice and one account is reviewed at BAS time. Both ATO
  rounding rules (taxable-supply and total-invoice) are acceptable; `per_document` is offered only as an
  **advanced** company setting — the default `per_line` never produces a residue at 10%.

## GP-019 — Reversal (void) of a posted sales invoice

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: MVP · Source type: `ledger.reversal` (reversal_of_id = GP-001 entry) · Use cases: UC-10 · Design: §3.3, principle 2
- **Scenario:** INV-000123 (GP-001) was posted in error and is voided on 2026-11-06 before any receipt. The reversal is a new entry with every line of GP-001 swapped debit↔credit, same accounts, tax codes, parties and dimension sets; the original stays posted with status `reversed`.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | 1,000.00 | | GST (tax 100.00) | Acme |
| 3 | product:SUBSCRIPTION.revenue | 4100 | 250.00 | | GST (tax 25.00) | Acme |
| 4 | tax:GST.collected | 2200 | 125.00 | | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,000.00 + 250.00 + 125.00 = 1,375.00 = 1,375.00 ✓ · GP-001 + GP-019 restore every account_balance to its prior value (invariant suite).
- **Tax amounts are unsigned (F5, RQ-0095):** a reversal is a pure side swap; tax amounts are copied unchanged
  (100.00, 25.00) and the debit side carries the direction. (Draft 2026-10-24 wrote `tax −100.00` / `tax −25.00`,
  which the engine refuses — superseded.) Posting needs the reversal path (T-0032); until it exists the runner
  reports this entry PENDING.
- **Subledger:** reversal item −1,375.00 allocated to INV-000123 → open 0.00, status Void.
- **Tax/BAS:** voided in the same BAS period → G1 and 1A net to 0. **A void is allowed only in the same BAS period as
  the invoice and with no allocations** (open = original) and the period not hard-locked; a later-period
  cancellation is a credit note (GP-005 mechanics, adjustment note, 1B decreasing adjustment). A void of an invoice
  already sent still emits a cancellation notice referencing its number and date (Q11, RQ-0095). (Draft 2026-10-24
  allowed a later-period void with G1 −1,375.00 / 1A −125.00 in the reversal period — superseded.)
- **Period rule:** the reversal is dated in the first period open for `ar` (never back-dated into a locked period).

## GP-020 — Pay run settled by provider debit (PAYROLL_CLEARING)

- **Status: Approved (owner-delegated to claude per DL-0253, 2026-11-08)** · Phase: Phase 1 · Source type: `payroll.pay_run` + `payroll.provider_debit` · Use cases: UC-07 · Design: §3.2 (PAYROLL_CLEARING control account), §3.8 row 8; RQ-0095 Q5
- **Scenario:** the GP-010 pay run (ending 2027-07-14: gross $10,000.00, PAYG withheld $2,000.00, SG 12% $1,200.00,
  net $8,000.00) for a company with payroll-integration setting `net_pay_settlement = provider_debit`: the payroll
  provider pays the employees and debits the employer's operating account $8,000.00 on 2027-07-14. The employer
  still remits PAYG withholding and super itself, so those stay on PAYG_WITHHOLDING / SUPER_PAYABLE. Two journals.

**Journal 20a — pay run**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:payroll.wages_expense | 6400 | 10,000.00 | | BAS-W1 | — |
| 2 | setting:payroll.super_expense | 6410 | 1,200.00 | | — | — |
| 3 | system:PAYG_WITHHOLDING | 2310 | | 2,000.00 | BAS-W2 | — |
| 4 | system:SUPER_PAYABLE | 2320 | | 1,200.00 | — | — |
| 5 | system:PAYROLL_CLEARING | 2330 | | 8,000.00 | — | — |
| | **Total** | | **11,200.00** | **11,200.00** | | |

**Journal 20b — provider debit (matched in bank reconciliation)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:PAYROLL_CLEARING | 2330 | 8,000.00 | | — | — |
| 2 | bank:OPERATING | 1100 | | 8,000.00 | — | — |
| | **Total** | | **8,000.00** | **8,000.00** | | |

- **Check:** 20a 10,000.00 + 1,200.00 = 11,200.00 = 2,000.00 + 1,200.00 + 8,000.00 ✓ · 20b 8,000.00 = 8,000.00 ✓ ·
  PAYROLL_CLEARING nets to 0.00 once the provider debit is matched.
- **Control account:** PAYROLL_CLEARING is a control account (§3.2): both journals come from the payroll bridge
  (subledger), never from a manual journal. If the provider also remits super and/or PAYG, those amounts are
  credited to PAYROLL_CLEARING instead and the provider debit grows by the same amount.
- **Tax/BAS:** W1 +10,000.00, W2 +2,000.00 for the period containing the pay date (as GP-010). No GST.
- **Source types:** `payroll.provider_debit` (and the reference code 2330 for payroll clearing) are new; they are added
  to the period matrix + SQL mirror and the AU template by the Phase-1 payroll-bridge task. Until then the runner
  reports this entry PENDING (out of phase).

---

## Open questions for accountant

These were deliberately **not** decided by agents. Each blocked approval of the listed entries.

**2026-11-08 — all eleven answered** under product-owner delegation in
[RQ-0095](../research/RQ-0095-golden-posting-open-questions.md) (sources and per-question confidence there); the
answers are applied to the entries above and recorded in the *Answer* column. The questions are kept as asked.
New doubts go below as Q12 onwards.

| # | Question | Affects | Draft assumption | Answer (2026-11-08) |
|---|---|---|---|---|
| Q1 | Stripe timing: recognise the customer receipt at charge (GP-003) and the fee at payout (GP-004), or the fee at charge too (Stripe knows it at charge time)? Fee at payout means clearing carries the gross until payout. | GP-003, GP-004 | Receipt at charge, fee at payout. | **Answered (RQ-0095 Q1, confidence medium):** receipt **and** fee + fee GST at charge, from the charge's balance transaction; the payout only moves the net from clearing to bank. GP-003/GP-004 rewritten. |
| Q2 | Stripe fee GST: Stripe says GST applies to its AU fees and issues a **monthly tax invoice**. Is it acceptable to claim 1B per payout from the per-transaction fee breakdown, or only from the monthly tax invoice (one monthly fee journal)? Is "Stripe clearing" a new **system role** (and "Merchant fees" a setting) — they are not in the §3.2 role list. | GP-004, GP-003, GP-006 | Per payout from Stripe's breakdown; clearing and fee accounts are Stripe connector settings, not system roles. | **Answered (RQ-0095 Q2, medium-high):** 1B per charge from Stripe `fee_details`; the monthly Stripe tax invoice must be held before the BAS is lodged (s 29-10(3)) and BAS prep ties Σ fee GST to it. Clearing and fee accounts stay connector settings, not system roles. GP-004 note. |
| Q3 | Bad debt GST: design §3.8 debits **GST collected** for the adjustment, but the BAS reports a decreasing adjustment at **1B** (ATO). Keep the ledger line on GST collected (2200) or use GST paid (2210)? On the **cash** basis no adjustment arises — confirm the same ledger entry (clearing the never-remitted 125.00) is right. Bad debts account: setting or system role? | GP-007 | Ledger debit to GST collected; BAS 1B via tax code GST-ADJ; cash basis no BAS effect. | **Answered (RQ-0095 Q3, high for BAS / medium for the account):** keep Dr GST collected (2200); BAS 1B via decreasing-adjustment tax code `ADJ-BD` (accruals → 1B, cash → none); cash basis same entry, no BAS effect; bad-debt account is a setting. GP-007 code renamed. |
| Q4 | Credit-note BAS presentation: net the adjustment note into G1/1A of the credit-note period (as drafted), or report as a decreasing adjustment at 1B? | GP-005 | Net into G1/1A. | **Answered (RQ-0095 Q4, medium):** same BAS period → net G1/1A; later period → 1B decreasing adjustment, G1 unchanged (option `sales_adjustment_presentation`, default `adjustment_1B`); always an adjustment note. GP-005 note. |
| Q5 | Payroll: §3.8 credits WAGES_PAYABLE, yet §3.2 also has PAYROLL_CLEARING. When is PAYROLL_CLEARING used (e.g. provider pays net pay and we only post a clearing)? | GP-010, GP-011 | Not used in these goldens. | **Answered (RQ-0095 Q5, medium):** PAYROLL_CLEARING only when the provider settles (`net_pay_settlement = provider_debit`); default batch mode uses WAGES_PAYABLE. New GP-020; GP-010 Payday Super note. |
| Q6 | Payment batch journal granularity: one entry per batch with one AP line per bill (drafted), per supplier, or one entry per bill? Affects bank reconciliation (bank shows one batch debit). | GP-009, GP-011 | One entry per batch, one AP line per bill, one bank line per batch. | **Answered (RQ-0095 Q6, high / medium):** one entry per batch, one AP line per bill, one bank line per batch; a returned item is a new entry. GP-009 note. |
| Q7 | **GST on prepayments received before an invoice (accruals):** Option A (design table, no GST until invoice) vs Option B (GST attributed on receipt). Or should LedgerForce always issue a deposit tax invoice (GP-014) and disallow untaxed prepayments for taxable supplies? | GP-012, GP-013 | Option A drafted, flagged as risky. | **Answered (RQ-0095 Q7, high that Option A is non-compliant / medium for the whole-supply caveat):** Option A rejected for taxable part payments; deposit tax invoice by default (GP-014); Option B for uninvoiced receipts (GP-012 golden); Option A only as the Div 99 security-deposit variant. GP-013 restructured to the net-of-prepayment shape; old 13a/13b retained as superseded. |
| Q8 | Rounding: with per-document GST, post the residual to ROUNDING (design §3.4, drafted) or adjust the largest revenue line so ROUNDING stays zero? Is per-document rounding acceptable for AU tax invoices at all, or should it be hidden behind an "advanced" setting? | GP-018 | ROUNDING per design. | **Answered (RQ-0095 Q8, high for ATO / medium for policy):** keep ROUNDING (design §3.4); `per_document` only as an advanced setting. `GST-INC` → `GST` + inclusive price mode. Resolves DL-0244 (DL-0255). |
| Q9 | Customer refunds: should refunds of credit balances be allowed in AP payment batches (ABA) with the customer's bank details verified by the same workflow as suppliers (§6.5 rule 2)? | GP-006 | Yes — same verification and cooling-off. | **Answered (RQ-0095 Q9, medium):** yes, with supplier-grade bank-detail verification (§6.5 rule 2 extended to customer refunds, DL-0254); refund ≤ open credit; Stripe refund to the original card preferred. GP-006 notes. |
| Q10 | Deposit invoice account: the §4.5 rule credits CUSTOMER_PREPAYMENTS (liability) on a tax invoice — confirm vs crediting revenue on the deposit invoice. | GP-014, GP-015 | Liability, cleared by the final invoice. | **Answered (RQ-0095 Q10, high):** liability (contract liability, AASB 15 ¶106) confirmed. GP-014 note; GP-014 source type `ar.invoice` (F2). |
| Q11 | Reversal of an invoice in a later period: should the void be blocked once a receipt/credit is allocated (require credit note instead)? | GP-019 | Void allowed only when open = original (no allocations); otherwise credit note. | **Answered (RQ-0095 Q11, medium):** void only with no allocations **and** in the same BAS period (period not hard-locked); otherwise a credit note. GP-019 note. |

## Change history

| Date | By | Change |
|---|---|---|
| 2026-10-24 | claude (T-0007) | Initial DRAFT, GP-001 … GP-019, Q1–Q11. |
| 2026-11-08 | claude (T-0007) | Applied RQ-0095 (still Draft): Q1 GP-003 fee at charge, GP-004 net only; Q2 GP-004 evidence note; Q3 GP-007 code `GST-ADJ` → `ADJ-BD`; Q4 GP-005 note; Q5 new GP-020 (Phase 1) + GP-010 notes; Q6 GP-009/011 notes; Q7 GP-012 → Option B, GP-013 → one net-of-prepayment journal (old 13a/13b kept as superseded); Q8 GP-018 `GST-INC` → `GST` + inclusive price mode; Q9 GP-006 notes; Q10 GP-014 note; Q11 GP-019 note; runner fixes F1 GP-008 tax line split by code + `CAP`, F2 GP-014 source type `ar.invoice` + provenance, F3 GP-017 note, F4 GP-015 and F5 GP-019 unsigned tax amounts. Q1–Q11 answered in place. Superseded draft text retained in each entry. |
| 2026-11-08 | claude (T-0007, owner-delegated, DL-0253) | Validated with the golden runner (DL-0256): 14 MVP entries reproduced line for line by the posting engine; GP-019 PENDING (requires T-0032); GP-010/011/020 (Phase 1) and GP-016/017 (Phase 2) PENDING out of phase. All entries GP-001 … GP-020 and the file header set to **Approved (owner-delegated to claude per DL-0253, 2026-11-08)**. Accountant-reviewer persona review (DL-0248) required before production use. From here the file is human-owned. |
