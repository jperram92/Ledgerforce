# Golden postings — LedgerForce

> **Status: DRAFT — awaiting product-owner approval (human gate: `golden_postings`).
> Agents may not change after Approved.**
>
> Drafted by: claude (scribe) · Date: 2026-10-24 · Task: T-0007 · Research: [RQ-0090](../research/RQ-0090-golden-posting-tax-treatments.md)
> Approval: _pending_ — the product owner changes each entry's `Status: Draft` to `Status: Approved (initials, date)`.
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
| GP-001 | Sales invoice (§3.8) | MVP | UC-01, UC-02 | Draft |
| GP-002 | Customer receipt — bank transfer (§3.8) | MVP | UC-03 | Draft |
| GP-003 | Card receipt via Stripe — payment into clearing (§3.8) | MVP | UC-03 | Draft |
| GP-004 | Stripe payout — net settlement (§3.8) | MVP | UC-03, UC-08 | Draft |
| GP-005 | Customer credit note — partial, on a paid invoice (§3.8) | MVP | UC-11 | Draft |
| GP-006 | Customer refund — bank / payment batch (§3.8, UC-11) | MVP | UC-11 | Draft |
| GP-007 | Bad debt write-off incl. GST decreasing adjustment (§3.8) | MVP | — | Draft |
| GP-008 | Supplier bill (§3.8) | MVP | UC-05 | Draft |
| GP-009 | Supplier payment (§3.8) | MVP | UC-06 | Draft |
| GP-010 | Payroll journal from payroll provider (§3.8) | Phase 1 | UC-07 | Draft |
| GP-011 | Net pay batch (§3.8) | Phase 1 | UC-07 | Draft |
| GP-012 | Customer prepayment received (§3.8) | MVP | — | Draft |
| GP-013 | Prepayment applied to the final invoice (§3.8, §4.3) | MVP | — | Draft |
| GP-014 | Deposit invoice — §4.5 rule `deposit-on-closed-won` | MVP (format) / Phase 1 (rule) | UC-09 | Draft |
| GP-015 | Final invoice net of deposit (§4.3) | MVP | UC-09 | Draft |
| GP-016 | Annual subscription invoiced to deferred revenue (§3.8) | Phase 2 | — | Draft |
| GP-017 | Deferred revenue release (§3.8) | Phase 2 | — | Draft |
| GP-018 | Rounding — per-line vs per-document GST (§3.4) | MVP | UC-01 | Draft |
| GP-019 | Reversal (void) of a posted sales invoice (§3.3, principle 2) | MVP | UC-10 | Draft |

---

## GP-001 — Sales invoice, two lines, GST exclusive

- **Status: Draft** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01, UC-02 · Design: §3.8 row 1, §3.4
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

- **Status: Draft** · Phase: MVP · Source type: `ar.receipt` · Use cases: UC-03, UC-08 · Design: §3.8 row 2
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

- **Status: Draft** · Phase: MVP · Source type: `payments.stripe.charge` · Use cases: UC-03 · Design: §3.8 row 3, §5.7
- **Scenario:** 2026-11-15 Acme pays INV-000123 ($1,375.00) through the invoice's Stripe payment link (webhook `payment_intent.succeeded` / `charge.succeeded`).
  The customer receipt is recognised at charge time, gross, into Stripe clearing; fees are recognised at payout (GP-004). See Q1 on timing.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:stripe.clearing_account | 1120 | 1,375.00 | | — | — |
| 2 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,375.00 = 1,375.00 ✓
- **Subledger:** receipt −1,375.00 allocated to INV-000123 → Paid. Idempotency key = Stripe event id.
- **Tax/BAS:** as GP-002 (cash basis recognises the sale on this date).
- **Salesforce:** as GP-002.

## GP-004 — Stripe payout: net settlement (bank net, fee, GST on fee)

- **Status: Draft** · Phase: MVP · Source type: `payments.stripe.payout` · Use cases: UC-03, UC-08 · Design: §3.8 row 3
- **Scenario:** 2026-11-17 Stripe pays out the GP-003 charge. Stripe fee for the charge $23.68 in total
  (1.7% + $0.30 = 23.675 → 23.68), of which GST $2.15 and fee $21.53 — the split is taken from Stripe's fee
  breakdown, not recomputed (see Q2). Net payout $1,351.32 lands in the operating account.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 1,351.32 | | — | — |
| 2 | setting:stripe.fee_account | 6200 | 21.53 | | GST (tax 2.15) | Stripe |
| 3 | tax:GST.paid | 2210 | 2.15 | | GST | — |
| 4 | setting:stripe.clearing_account | 1120 | | 1,375.00 | — | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,351.32 + 21.53 + 2.15 = 1,375.00 = 1,375.00 ✓ · Stripe clearing nets to 0.00 for this payout.
- **Subledger:** none (no AR/AP control line). The bank statement line 1,351.32 matches this entry in reconciliation (UC-08).
- **Tax/BAS:** G11 +23.68; 1B +2.15 (requires Stripe's tax invoice — monthly — as evidence).

## GP-005 — Customer credit note, partial, on a paid invoice

- **Status: Draft** · Phase: MVP · Source type: `ar.credit_note` · Use cases: UC-11 · Design: §3.8 row 4
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
- **Tax/BAS (accruals):** G1 −220.00; 1A −20.00 in the period of the credit note (adjustment note). See Q4.
- **Salesforce:** LF_Invoice__c for INV-000123 shows credited 220.00; Opportunity LF_Amount_Paid__c becomes net 1,155.00 after the refund (GP-006); Account LF_Balance_Due__c −220.00 until refunded.

## GP-006 — Customer refund paid from the bank (payment batch)

- **Status: Draft** · Phase: MVP · Source type: `ar.refund` · Use cases: UC-11 · Design: §3.8 (refund follows "Supplier payment" mechanics), UC-11
- **Scenario:** 2026-11-24 the $220.00 credit on CN-000007 is refunded to Acme's verified bank account in the next payment batch (posts on bank confirmation).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 220.00 | | — | Acme |
| 2 | bank:OPERATING | 1100 | | 220.00 | — | — |
| | **Total** | | **220.00** | **220.00** | | |

- **Check:** 220.00 = 220.00 ✓
- **Variant (Stripe refund):** line 2 is `setting:stripe.clearing_account` (1120); the refund is netted in the next payout.
- **Subledger:** refund open item +220.00 allocated to CN-000007 → both 0.00. Acme AR balance 0.00.
- **Tax/BAS:** none (GST already adjusted by GP-005).
- **Salesforce:** Opportunity LF_Amount_Paid__c = 1,375.00 − 220.00 = **1,155.00** (net paid); Account LF_Balance_Due__c 0.00.

## GP-007 — Bad debt write-off including GST decreasing adjustment

- **Status: Draft** · Phase: MVP · Source type: `ar.write_off` · Use cases: — (AR) · Design: §3.8 row 5
- **Scenario:** a different invoice, INV-000140 to Acme for $1,375.00 (1,250.00 + GST 125.00, same lines as GP-001 but
  unpaid), is written off in full on 2027-12-01 after being overdue more than 12 months. Company GST basis: accruals.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.bad_debt_account | 6300 | 1,250.00 | | GST-ADJ (tax 125.00) | Acme |
| 2 | tax:GST.collected | 2200 | 125.00 | | GST-ADJ | — |
| 3 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,250.00 + 125.00 = 1,375.00 = 1,375.00 ✓
- **Subledger:** write-off document −1,375.00 allocated to INV-000140 → open 0.00, status Written off.
- **Tax/BAS (accruals):** decreasing adjustment **1B +125.00** in the period of write-off (ATO: decreasing adjustments at 1B, RQ-0090). A later recovery is an increasing adjustment at 1A. **Cash basis:** the GST was never reported, so no BAS adjustment; the ledger entry is the same (clears the 125.00 never-remitted liability). See Q3.
- **Partial write-off:** GST adjustment = written-off amount × 1/11, half-up to cents.

## GP-008 — Supplier bill (expense + capital asset)

- **Status: Draft** · Phase: MVP · Source type: `ap.bill` · Use cases: UC-05 · Design: §3.8 row 6
- **Scenario:** BILL-000045 from Officeworks-like Supplies dated 2026-11-03, due 2026-11-30.
  Line 1 stationery and consumables $500.00 ex GST (tax code GST, non-capital) → GST 50.00.
  Line 2 laptop $2,000.00 ex GST (tax code GST-CAP, capital acquisition) → GST 200.00. Total $2,750.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | expense: Office expenses | 6100 | 500.00 | | GST (tax 50.00) | Supplier |
| 2 | asset: Computer equipment | 1510 | 2,000.00 | | GST-CAP (tax 200.00) | Supplier |
| 3 | tax:GST.paid | 2210 | 250.00 | | GST / GST-CAP | — |
| 4 | system:AP_CONTROL | 2100 | | 2,750.00 | — | Supplier |
| | **Total** | | **2,750.00** | **2,750.00** | | |

- **Check:** 500.00 + 2,000.00 + 250.00 = 2,750.00 = 2,750.00 ✓
- **Subledger:** AP open item BILL-000045, original 2,750.00, open 2,750.00, due 2026-11-30.
- **Tax/BAS (accruals):** G10 +2,200.00; G11 +550.00; 1B +250.00. Cash basis: on payment (GP-009).

## GP-009 — Supplier payment (payment batch, posted on bank confirmation)

- **Status: Draft** · Phase: MVP · Source type: `ap.payment` · Use cases: UC-06 · Design: §3.8 row 7
- **Scenario:** payment batch PB-000012 released 2026-11-27, ABA file uploaded, bank confirms 2026-11-28; BILL-000045 paid $2,750.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AP_CONTROL | 2100 | 2,750.00 | | — | Supplier |
| 2 | bank:OPERATING | 1100 | | 2,750.00 | — | — |
| | **Total** | | **2,750.00** | **2,750.00** | | |

- **Check:** 2,750.00 = 2,750.00 ✓
- **Subledger:** payment −2,750.00 allocated to BILL-000045 → 0.00, status Paid. Nothing posts at release; only on confirmation.
- **Tax/BAS:** accruals none. Cash basis: G10 +2,200.00, G11 +550.00, 1B +250.00 in the payment period.
- **Batch detail:** one journal per batch with one AP line per supplier (party) and one bank credit for the batch total is equally valid; this golden fixes **one entry per batch, one AP_CONTROL line per bill** (see Q6).

## GP-010 — Payroll journal from payroll provider (Phase 1)

- **Status: Draft** · Phase: Phase 1 · Source type: `payroll.pay_run` · Use cases: UC-07 · Design: §3.8 row 8
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

## GP-011 — Net pay batch (Phase 1)

- **Status: Draft** · Phase: Phase 1 · Source type: `payroll.net_pay_batch` · Use cases: UC-07 · Design: §3.8 row 9
- **Scenario:** the GP-010 net pay ($8,000.00) is paid by ABA batch, released by a second user, confirmed 2027-07-15.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:WAGES_PAYABLE | 2300 | 8,000.00 | | — | — |
| 2 | bank:OPERATING | 1100 | | 8,000.00 | — | — |
| | **Total** | | **8,000.00** | **8,000.00** | | |

- **Check:** 8,000.00 = 8,000.00 ✓
- **Tax/BAS:** none.

## GP-012 — Customer prepayment received (no tax invoice yet)

- **Status: Draft** · Phase: MVP · Source type: `ar.prepayment` · Use cases: — · Design: §3.8 row 10
- **Scenario:** 2026-11-10 Acme pays a $3,300.00 prepayment (30% of an $11,000.00 GST-inclusive project) by EFT before any invoice is issued.
  **Option A (as design §3.8 — drafted as the golden):** whole receipt to the liability.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 3,300.00 | | — | — |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,300.00 | — | Acme |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 3,300.00 = 3,300.00 ✓
- **Subledger:** unapplied prepayment −3,300.00 on Acme (customer credit, not an AR_CONTROL line).
- **Tax/BAS (Option A):** none at receipt. **Risk:** on the accruals basis GST is attributable to the earlier of payment received and invoice issued (RQ-0090), so a part-payment for a taxable supply probably needs GST now — **Option B** (alternative, not golden until chosen): Dr bank 3,300.00 / Cr CUSTOMER_PREPAYMENTS 3,000.00 / Cr GST collected 300.00; 1A +300.00, G1 +3,300.00. See Q7. The deposit-invoice path (GP-014) avoids the question by issuing a tax invoice.

## GP-013 — Prepayment applied to the final invoice

- **Status: Draft** · Phase: MVP · Source type: `ar.invoice` + `ar.prepayment_application` · Use cases: — · Design: §3.8 row 10, §4.3 "Deposit / prepayment … applied to the final invoice"
- **Scenario:** 2026-12-15 final invoice INV-000150 for the project: Professional services $10,000.00 ex GST, GST 1,000.00, total $11,000.00. The GP-012 prepayment (Option A) of $3,300.00 is applied. Two journals.

**Journal 13a — final invoice**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 11,000.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 1,000.00 | GST | — |
| | **Total** | | **11,000.00** | **11,000.00** | | |

**Journal 13b — application of prepayment**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,300.00 | | — | Acme |
| 2 | system:AR_CONTROL | 1200 | | 3,300.00 | — | Acme |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 13a 11,000.00 = 10,000.00 + 1,000.00 ✓ · 13b 3,300.00 = 3,300.00 ✓
- **Subledger:** INV-000150 original 11,000.00; allocation prepayment→INV-000150 3,300.00 → open 7,700.00; prepayment unapplied 0.00.
- **Tax/BAS (accruals, Option A):** G1 +11,000.00, 1A +1,000.00 at invoice date. (Under Option B the final invoice would credit GST 700.00 only, 300.00 having been reported at GP-012.)
- **Salesforce:** LF_Invoice__c amount due 7,700.00; Opportunity LF_Amount_Paid__c 3,300.00.

## GP-014 — Deposit invoice from rule `deposit-on-closed-won` (design §4.5)

- **Status: Draft** · Phase: MVP (deposit billing format §4.3); Phase 1 when produced by Rules Studio (UC-09) · Source type: `rule:deposit-on-closed-won@3` · Use cases: UC-09 · Design: §4.5
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

## GP-015 — Final invoice net of deposit

- **Status: Draft** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-09 · Design: §4.3
- **Scenario:** 2026-12-15 final invoice INV-000151 for the GP-014 project (deposit DEP-000004 already paid): Professional services $10,000.00 ex GST, less deposit applied $3,000.00 ex GST. GST on the net = 700.00. Amount due $7,700.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 7,700.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,000.00 | | GST (tax −300.00) | Acme |
| 3 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 4 | tax:GST.collected | 2200 | | 700.00 | GST | — |
| | **Total** | | **10,700.00** | **10,700.00** | | |

- **Check:** 7,700.00 + 3,000.00 = 10,700.00 = 10,000.00 + 700.00 ✓ · Customer prepayments for the project nets to 0.00 (3,000.00 Cr in GP-014, 3,000.00 Dr here).
- **Subledger:** INV-000151 open 7,700.00.
- **Tax/BAS:** G1 +7,700.00; 1A +700.00 — total GST on the project 300.00 + 700.00 = 1,000.00 ✓.

## GP-016 — Annual subscription invoiced in advance to deferred revenue (Phase 2)

- **Status: Draft** · Phase: Phase 2 · Source type: `ar.invoice` (product profile SUBSCRIPTION with deferral schedule) · Design: §3.8 row 11, §8.1 Revenue Recognition
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

- **Status: Draft** · Phase: Phase 2 · Source type: `revrec.release` · Design: §3.8 row 11
- **Scenario:** 2027-01-31 month-end release of 1/12 of GP-016 ($1,000.00). Remaining deferred 11,000.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:DEFERRED_REVENUE | 2410 | 1,000.00 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 1,000.00 | — | Acme |
| | **Total** | | **1,000.00** | **1,000.00** | | |

- **Check:** 1,000.00 = 1,000.00 ✓ · 12 releases sum to 12,000.00; any rounding residue goes to the last release, not ROUNDING.
- **Tax/BAS:** none.

## GP-018 — Rounding: per-line (default) vs per-document GST on a tax-inclusive invoice

- **Status: Draft** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01 · Design: §3.4 ("difference to the document total posts to ROUNDING")
- **Scenario:** INV-000160, three Subscription add-on lines each **$3.35 GST-inclusive** (document total $10.05).
  Line net = 3.35 / 1.1 = 3.04545… → 3.05 (half-up).

**18a — company setting `tax_rounding = per_line` (AU default):** line GST = 3.35 / 11 = 0.30454… → 0.30; each line nets 3.05 + 0.30 = 3.35. No rounding line.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 9.15 | GST-INC (tax 0.90) | Acme |
| 3 | tax:GST.collected | 2200 | | 0.90 | GST-INC | — |
| | **Total** | | **10.05** | **10.05** | | |

**18b — company setting `tax_rounding = per_document`:** document GST = 10.05 / 11 = 0.91363… → 0.91; line nets stay 3.05 × 3 = 9.15; 9.15 + 0.91 = 10.06 vs document total 10.05 → difference 0.01 debited to ROUNDING.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | system:ROUNDING | 8900 | 0.01 | | — | — |
| 3 | product:SUBSCRIPTION.revenue | 4100 | | 9.15 | GST-INC (tax 0.91 doc-level) | Acme |
| 4 | tax:GST.collected | 2200 | | 0.91 | GST-INC | — |
| | **Total** | | **10.06** | **10.06** | | |

- **Check:** 18a 10.05 = 9.15 + 0.90 ✓ · 18b 10.05 + 0.01 = 10.06 = 9.15 + 0.91 ✓
- **Tax/BAS:** 18a G1 +10.05, 1A +0.90 · 18b G1 +10.05, 1A +0.91 (GST equals the GST shown on the tax invoice in both cases).
- See Q8 (should the per-document difference adjust the last revenue line instead of ROUNDING?).

## GP-019 — Reversal (void) of a posted sales invoice

- **Status: Draft** · Phase: MVP · Source type: `ledger.reversal` (reversal_of_id = GP-001 entry) · Use cases: UC-10 · Design: §3.3, principle 2
- **Scenario:** INV-000123 (GP-001) was posted in error and is voided on 2026-11-06 before any receipt. The reversal is a new entry with every line of GP-001 swapped debit↔credit, same accounts, tax codes, parties and dimension sets; the original stays posted with status `reversed`.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | 1,000.00 | | GST (tax −100.00) | Acme |
| 3 | product:SUBSCRIPTION.revenue | 4100 | 250.00 | | GST (tax −25.00) | Acme |
| 4 | tax:GST.collected | 2200 | 125.00 | | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,000.00 + 250.00 + 125.00 = 1,375.00 = 1,375.00 ✓ · GP-001 + GP-019 restore every account_balance to its prior value (invariant suite).
- **Subledger:** reversal item −1,375.00 allocated to INV-000123 → open 0.00, status Void.
- **Tax/BAS:** if voided in the same period, G1 and 1A net to 0; if in a later period, G1 −1,375.00 and 1A −125.00 in the reversal period.
- **Period rule:** the reversal is dated in the first period open for `ar` (never back-dated into a locked period).

---

## Open questions for accountant

These are deliberately **not** decided by agents. Each blocks approval of the listed entries; answer inline or
in a PR comment and the scribe will update the drafts (as new Draft entries if any were already Approved).

| # | Question | Affects | Draft assumption |
|---|---|---|---|
| Q1 | Stripe timing: recognise the customer receipt at charge (GP-003) and the fee at payout (GP-004), or the fee at charge too (Stripe knows it at charge time)? Fee at payout means clearing carries the gross until payout. | GP-003, GP-004 | Receipt at charge, fee at payout. |
| Q2 | Stripe fee GST: Stripe says GST applies to its AU fees and issues a **monthly tax invoice**. Is it acceptable to claim 1B per payout from the per-transaction fee breakdown, or only from the monthly tax invoice (one monthly fee journal)? Is "Stripe clearing" a new **system role** (and "Merchant fees" a setting) — they are not in the §3.2 role list. | GP-004, GP-003, GP-006 | Per payout from Stripe's breakdown; clearing and fee accounts are Stripe connector settings, not system roles. |
| Q3 | Bad debt GST: design §3.8 debits **GST collected** for the adjustment, but the BAS reports a decreasing adjustment at **1B** (ATO). Keep the ledger line on GST collected (2200) or use GST paid (2210)? On the **cash** basis no adjustment arises — confirm the same ledger entry (clearing the never-remitted 125.00) is right. Bad debts account: setting or system role? | GP-007 | Ledger debit to GST collected; BAS 1B via tax code GST-ADJ; cash basis no BAS effect. |
| Q4 | Credit-note BAS presentation: net the adjustment note into G1/1A of the credit-note period (as drafted), or report as a decreasing adjustment at 1B? | GP-005 | Net into G1/1A. |
| Q5 | Payroll: §3.8 credits WAGES_PAYABLE, yet §3.2 also has PAYROLL_CLEARING. When is PAYROLL_CLEARING used (e.g. provider pays net pay and we only post a clearing)? | GP-010, GP-011 | Not used in these goldens. |
| Q6 | Payment batch journal granularity: one entry per batch with one AP line per bill (drafted), per supplier, or one entry per bill? Affects bank reconciliation (bank shows one batch debit). | GP-009, GP-011 | One entry per batch, one AP line per bill, one bank line per batch. |
| Q7 | **GST on prepayments received before an invoice (accruals):** Option A (design table, no GST until invoice) vs Option B (GST attributed on receipt). Or should LedgerForce always issue a deposit tax invoice (GP-014) and disallow untaxed prepayments for taxable supplies? | GP-012, GP-013 | Option A drafted, flagged as risky. |
| Q8 | Rounding: with per-document GST, post the residual to ROUNDING (design §3.4, drafted) or adjust the largest revenue line so ROUNDING stays zero? Is per-document rounding acceptable for AU tax invoices at all, or should it be hidden behind an "advanced" setting? | GP-018 | ROUNDING per design. |
| Q9 | Customer refunds: should refunds of credit balances be allowed in AP payment batches (ABA) with the customer's bank details verified by the same workflow as suppliers (§6.5 rule 2)? | GP-006 | Yes — same verification and cooling-off. |
| Q10 | Deposit invoice account: the §4.5 rule credits CUSTOMER_PREPAYMENTS (liability) on a tax invoice — confirm vs crediting revenue on the deposit invoice. | GP-014, GP-015 | Liability, cleared by the final invoice. |
| Q11 | Reversal of an invoice in a later period: should the void be blocked once a receipt/credit is allocated (require credit note instead)? | GP-019 | Void allowed only when open = original (no allocations); otherwise credit note. |

## Change history

| Date | By | Change |
|---|---|---|
| 2026-10-24 | claude (T-0007) | Initial DRAFT, GP-001 … GP-019, Q1–Q11. |
