# Golden postings — LedgerForce

> **Status: APPROVED 2026-11-01** — the product owner delegated approval to the building agent (DL-0256):
> entries are approved on the basis of the AASB/GST research (RQ-0095, RQ-0096); errors surface in the golden tests.
> Superseded entries are kept with a forward link. Approved entries are changed only by superseding.
>
> Drafted by: claude (scribe) · Date: 2026-10-24 · Task: T-0007 · Research: [RQ-0090](../research/RQ-0090-golden-posting-tax-treatments.md)
> Approval: 2026-11-01 — the product owner approved all entries by instruction, delegating the review to the building agent (DL-0256); each entry records its basis (RQ-0095, RQ-0096).
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
| GP-001 | Sales invoice (§3.8) | MVP | UC-01, UC-02 | Approved |
| GP-002 | Customer receipt — bank transfer (§3.8) | MVP | UC-03 | Approved |
| GP-003 | Card receipt via Stripe — payment into clearing (§3.8) | MVP | UC-03 | Approved |
| GP-004 | Stripe payout — net settlement (§3.8) | MVP | UC-03, UC-08 | Superseded by GP-027 |
| GP-005 | Customer credit note — partial, on a paid invoice (§3.8) | MVP | UC-11 | Approved |
| GP-006 | Customer refund — bank / payment batch (§3.8, UC-11) | MVP | UC-11 | Approved |
| GP-007 | Bad debt write-off incl. GST decreasing adjustment (§3.8) | MVP | — | Superseded by GP-024 |
| GP-008 | Supplier bill (§3.8) | MVP | UC-05 | Approved |
| GP-009 | Supplier payment (§3.8) | MVP | UC-06 | Approved |
| GP-010 | Payroll journal from payroll provider (§3.8) | Phase 1 | UC-07 | Approved |
| GP-011 | Net pay batch (§3.8) | Phase 1 | UC-07 | Approved |
| GP-012 | Customer prepayment received (§3.8) | MVP | — | Superseded by GP-020 |
| GP-013 | Prepayment applied to the final invoice (§3.8, §4.3) | MVP | — | Superseded by GP-022 |
| GP-014 | Deposit invoice — §4.5 rule `deposit-on-closed-won` | MVP (format) / Phase 1 (rule) | UC-09 | Approved |
| GP-015 | Final invoice net of deposit (§4.3) | MVP | UC-09 | Approved |
| GP-016 | Annual subscription invoiced to deferred revenue (§3.8) | Phase 2 | — | Approved |
| GP-017 | Deferred revenue release (§3.8) | Phase 2 | — | Approved |
| GP-018 | Rounding — per-line vs per-document GST (§3.4) | MVP | UC-01 | Superseded by GP-023 |
| GP-019 | Reversal (void) of a posted sales invoice (§3.3, principle 2) | MVP | UC-10 | Approved |
| GP-020 | Prepayment, progressive/periodic or total unknown — GST at receipt (proposes to supersede GP-012) | MVP | — | Approved |
| GP-021 | Single supply: full tax invoice at first part-payment | MVP | — | Approved |
| GP-022 | Prepayment applied after GP-020 (proposes to supersede GP-013) | MVP | — | Approved |
| GP-023 | Rounding: total invoice rule default, per-line opt-in (proposes to supersede GP-018) | MVP | UC-01 | Approved |
| GP-024 | Bad-debt write-off via ECL allowance (proposes to supersede GP-007) | MVP | — | Approved |
| GP-025 | Period-end ECL allowance adjustment | MVP / Phase 1 | — | Approved |
| GP-026 | Bad-debt recovery | MVP | — | Approved |
| GP-027 | Stripe payout, fee GST pending tax invoice (proposes to supersede GP-004) | MVP | UC-03 | Approved |
| GP-028 | Monthly Stripe tax-invoice reconciliation | MVP | UC-03 | Approved |
| GP-029 | Credit note in a later BAS period, both presentations, reason code (varies GP-005, GP-019) | MVP | UC-11 | Approved |
| GP-030 | Monthly depreciation | MVP | — | Approved |
| GP-031 | Accrued expense with auto-reversal | MVP | UC-10 | Approved |
| GP-032 | Prepaid expense with monthly release | MVP | — | Approved |
| GP-033 | Super payment under Payday Super | Phase 1 | UC-07 | Approved |
| GP-034 | Super guarantee charge assessment | Phase 1 | UC-07 | Approved |
| GP-035 | Prior-period adjustment (AASB 108) | Phase 1 | — | Approved |

---

## GP-001 — Sales invoice, two lines, GST exclusive

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01, UC-02 · Design: §3.8 row 1, §3.4
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ar.receipt` · Use cases: UC-03, UC-08 · Design: §3.8 row 2
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `payments.stripe.charge` · Use cases: UC-03 · Design: §3.8 row 3, §5.7
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

- **Status: Superseded by GP-027** (DL-0256, 2026-11-01) · Phase: MVP · Source type: `payments.stripe.payout` · Use cases: UC-03, UC-08 · Design: §3.8 row 3
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ar.credit_note` · Use cases: UC-11 · Design: §3.8 row 4
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ar.refund` · Use cases: UC-11 · Design: §3.8 (refund follows "Supplier payment" mechanics), UC-11
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

- **Status: Superseded by GP-024** (DL-0256, 2026-11-01) · Phase: MVP · Source type: `ar.write_off` · Use cases: — (AR) · Design: §3.8 row 5
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ap.bill` · Use cases: UC-05 · Design: §3.8 row 6
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ap.payment` · Use cases: UC-06 · Design: §3.8 row 7
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: Phase 1 · Source type: `payroll.pay_run` · Use cases: UC-07 · Design: §3.8 row 8
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: Phase 1 · Source type: `payroll.net_pay_batch` · Use cases: UC-07 · Design: §3.8 row 9
- **Scenario:** the GP-010 net pay ($8,000.00) is paid by ABA batch, released by a second user, confirmed 2027-07-15.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:WAGES_PAYABLE | 2300 | 8,000.00 | | — | — |
| 2 | bank:OPERATING | 1100 | | 8,000.00 | — | — |
| | **Total** | | **8,000.00** | **8,000.00** | | |

- **Check:** 8,000.00 = 8,000.00 ✓
- **Tax/BAS:** none.

## GP-012 — Customer prepayment received (no tax invoice yet)

- **Status: Superseded by GP-020** (DL-0256, 2026-11-01) · Phase: MVP · Source type: `ar.prepayment` · Use cases: — · Design: §3.8 row 10
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

- **Status: Superseded by GP-022** (DL-0256, 2026-11-01) · Phase: MVP · Source type: `ar.invoice` + `ar.prepayment_application` · Use cases: — · Design: §3.8 row 10, §4.3 "Deposit / prepayment … applied to the final invoice"
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP (deposit billing format §4.3); Phase 1 when produced by Rules Studio (UC-09) · Source type: `rule:deposit-on-closed-won@3` · Use cases: UC-09 · Design: §4.5
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-09 · Design: §4.3
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: Phase 2 · Source type: `ar.invoice` (product profile SUBSCRIPTION with deferral schedule) · Design: §3.8 row 11, §8.1 Revenue Recognition
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: Phase 2 · Source type: `revrec.release` · Design: §3.8 row 11
- **Scenario:** 2027-01-31 month-end release of 1/12 of GP-016 ($1,000.00). Remaining deferred 11,000.00.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:DEFERRED_REVENUE | 2410 | 1,000.00 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 1,000.00 | — | Acme |
| | **Total** | | **1,000.00** | **1,000.00** | | |

- **Check:** 1,000.00 = 1,000.00 ✓ · 12 releases sum to 12,000.00; any rounding residue goes to the last release, not ROUNDING.
- **Tax/BAS:** none.

## GP-018 — Rounding: per-line (default) vs per-document GST on a tax-inclusive invoice

- **Status: Superseded by GP-023** (DL-0256, 2026-11-01) · Phase: MVP · Source type: `ar.invoice` · Use cases: UC-01 · Design: §3.4 ("difference to the document total posts to ROUNDING")
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

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** · Phase: MVP · Source type: `ledger.reversal` (reversal_of_id = GP-001 entry) · Use cases: UC-10 · Design: §3.3, principle 2
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

## Proposed entries from the AASB/GST review (T-0115, RQ-0095/RQ-0096)

The owner approved the change list on 2026-11-01 and delegated approval of the worked entries to the
building agent (DL-0256). The entries below implement it and are Approved; superseded entries above carry a
forward link. Amounts are worked examples
for the accountant to check; sources are in [AASB decisions confirmed by law](../research/reports/AASB%20decisions%20confirmed%20by%20law.md).
Items marked **(unverified)** could not be checked against primary text.

## GP-020 — Customer prepayment, progressive/periodic supply or total unknown (GST at receipt)

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.prepayment` · **Proposes to supersede GP-012** · Q7
- **Scenario:** as GP-012 — 2026-11-10 Acme pays $3,300.00 before any invoice, for staged work invoiced by milestone
  (progressive supply, GST Act Div 156) or where the total is not yet known. GST is attributable on receipt (s 29-5).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 3,300.00 | | — | — |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,000.00 | GST (tax 300.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 300.00 | GST | — |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 3,300.00 = 3,000.00 + 300.00 ✓
- **Tax/BAS (accruals):** G1 +3,300.00; 1A +300.00 at 2026-11-10. Cash basis: same period (payment received).
- **Untaxed variant (GP-012 shape) only for:** GST-free or input-taxed supplies, receipts flagged as a genuine Div 99 security deposit (GST when forfeited or applied), and unidentified receipts.
- **Fields:** receipt carries `supply_type` (progressive_periodic | single | unknown_total | gst_free | security_deposit); the engine records GST attributed to date per supply so the final invoice never repeats it.

## GP-021 — First part-payment on a single (non-progressive) supply: full tax invoice at receipt

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.invoice` (advance) + `ar.receipt` · Q7
- **Scenario:** 2026-11-10 Acme pays $3,300.00 towards a single $11,000.00 (GST-inclusive) project with a known
  price. The first payment attributes GST on the whole supply, so LedgerForce issues the full tax invoice INV-000170
  at receipt. Work is not yet performed, so the invoice credits a contract liability, not revenue (AASB 15; the
  contract must be non-cancellable — otherwise use a payment request and GP-020's untaxed path is not available, see Q13).

**21a — advance tax invoice**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 11,000.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 1,000.00 | GST | — |
| | **Total** | | **11,000.00** | **11,000.00** | | |

**21b — receipt applied**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 3,300.00 | | — | — |
| 2 | system:AR_CONTROL | 1200 | | 3,300.00 | — | Acme |
| | **Total** | | **3,300.00** | **3,300.00** | | |

**21c — on completion (2026-12-15), revenue recognised**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:CUSTOMER_PREPAYMENTS | 2400 | 10,000.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | — | Acme |
| | **Total** | | **10,000.00** | **10,000.00** | | |

- **Check:** 21a 11,000.00 = 10,000.00 + 1,000.00 ✓ · 21b 3,300.00 = 3,300.00 ✓ · 21c 10,000.00 = 10,000.00 ✓ · INV-000170 open 7,700.00.
- **Tax/BAS (accruals):** G1 +11,000.00, 1A +1,000.00 at 2026-11-10. No GST at completion.
- Note: the review's sketch used the GP-001 (revenue) shape; this draft uses the GP-014 (liability) shape because revenue is not earned at receipt.

## GP-022 — Prepayment applied to the final invoice (after GP-020)

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.invoice` + `ar.prepayment_application` · **Proposes to supersede GP-013** · Q7
- **Scenario:** 2026-12-15 final invoice INV-000150, $10,000.00 ex GST, GST 1,000.00, total $11,000.00; the GP-020
  prepayment (3,000.00 + GST 300.00 already reported) is applied.

**22a — final invoice**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 11,000.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 10,000.00 | GST (tax 1,000.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 1,000.00 | GST | — |
| | **Total** | | **11,000.00** | **11,000.00** | | |

**22b — application of prepayment (removes GST already attributed)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,000.00 | | GST (tax −300.00) | Acme |
| 2 | tax:GST.collected | 2200 | 300.00 | | GST | — |
| 3 | system:AR_CONTROL | 1200 | | 3,300.00 | — | Acme |
| | **Total** | | **3,300.00** | **3,300.00** | | |

- **Check:** 22a 11,000.00 = 10,000.00 + 1,000.00 ✓ · 22b 3,000.00 + 300.00 = 3,300.00 ✓ · GST on the project 300.00 + 1,000.00 − 300.00 = 1,000.00 ✓
- **Subledger:** INV-000150 open 7,700.00; prepayment unapplied 0.00.
- **Tax/BAS (accruals):** final period G1 +7,700.00, 1A +700.00 (net of the 300.00 reported at GP-020).

## GP-023 — GST rounding: total invoice rule (AU default) and per-line 2 dp (opt-in)

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.invoice` · **Proposes to supersede GP-018** · Q8 · Design §3.4 (accounting ADR)
- **Scenario:** as GP-018 — INV-000160, three lines each $3.35 GST-inclusive, document total $10.05.

**23a — default `tax_rounding = total_invoice`:** GST = 10.05 / 11 = 0.91363… → 0.91; net 9.14. Line nets round to
3.05 each (9.15); the −0.01 residual goes to the largest line (ties: the last line), giving 3.05 / 3.05 / 3.04. The
printed invoice shows these same line nets. No ROUNDING line.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 9.14 | GST-INC (tax 0.91 doc-level) | Acme |
| 3 | tax:GST.collected | 2200 | | 0.91 | GST-INC | — |
| | **Total** | | **10.05** | **10.05** | | |

**23b — opt-in `tax_rounding = per_line_2dp` (taxable supply rule, matches Xero/QuickBooks):** line GST 0.30 each.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 10.05 | | — | Acme |
| 2 | product:SUBSCRIPTION.revenue | 4100 | | 9.15 | GST-INC (tax 0.90) | Acme |
| 3 | tax:GST.collected | 2200 | | 0.90 | GST-INC | — |
| | **Total** | | **10.05** | **10.05** | | |

- **Check:** 23a 10.05 = 9.14 + 0.91 ✓ · 23b 10.05 = 9.15 + 0.90 ✓
- **Tax/BAS:** 23a G1 +10.05, 1A +0.91 · 23b G1 +10.05, 1A +0.90. Expect 1-cent differences against invoices issued by per-line systems.

## GP-024 — Bad-debt write-off through the expected-credit-loss allowance

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.write_off` · **Proposes to supersede GP-007** · Q3, Q12 · AASB 9
- **Scenario:** as GP-007 — INV-000140 ($1,375.00 = 1,250.00 + GST 125.00) written off 2027-12-01; the allowance
  (AR_ECL_ALLOWANCE, contra-AR, measured ex GST) already holds 1,250.00 for it from period-end GP-025 journals.
  The write-off is a journal with a written write-off record, not a credit note.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_ECL_ALLOWANCE | 1210 | 1,250.00 | | — | Acme |
| 2 | tax:GST.collected | 2200 | 125.00 | | GST-ADJ | — |
| 3 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,250.00 + 125.00 = 1,375.00 ✓
- **Variant — allowance short:** if the allowance holds only 1,000.00: Dr AR_ECL_ALLOWANCE 1,000.00 / Dr 6300 Impairment of receivables 250.00 / Dr GST collected 125.00 / Cr AR 1,375.00 ✓.
- **Tax/BAS:** accruals 1B +125.00 (decreasing adjustment, on write-off or when 12 months overdue); cash basis no BAS effect (GST never reported). No adjustment note; the write-off record is required.
- **Direct write-off (GP-007 shape)** remains available only as a tenant's documented materiality election.
- **New roles/accounts:** `system:AR_ECL_ALLOWANCE` (1210, contra-asset); 6300 renamed "Impairment of receivables".

## GP-025 — Period-end expected-credit-loss allowance adjustment

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP (manual amount) / Phase 1 (provision matrix) · Source type: `ar.ecl_adjustment` · Q12 · AASB 9 simplified approach
- **Scenario:** 2027-11-30 the ageing × loss-rate calculation requires an allowance of 1,800.00 (ex GST); the balance is 1,250.00. Approved by Finance Admin.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.bad_debt_account (Impairment of receivables) | 6300 | 550.00 | | — | — |
| 2 | system:AR_ECL_ALLOWANCE | 1210 | | 550.00 | — | — |
| | **Total** | | **550.00** | **550.00** | | |

- **Check:** 550.00 = 550.00 ✓ · A decrease posts the reverse. No GST, no subledger effect.

## GP-026 — Bad-debt recovery after write-off

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.recovery` · Q3
- **Scenario:** 2028-03-01 Acme pays the $1,375.00 written off in GP-024.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 1,375.00 | | — | — |
| 2 | setting:ar.bad_debt_account (Impairment of receivables) | 6300 | | 1,250.00 | GST-ADJ (tax 125.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 125.00 | GST-ADJ | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** 1,375.00 = 1,250.00 + 125.00 ✓
- **Tax/BAS:** accruals — increasing adjustment 1A +125.00. Cash basis — GST attributable on receipt: 1A +125.00, G1 +1,375.00 **(unverified)**.

## GP-027 — Stripe payout with fee GST pending the monthly tax invoice

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `payments.stripe.payout` · **Proposes to supersede GP-004** · Q2
- **Journal:** identical to GP-004 (Dr bank 1,351.32 / Dr fee 21.53 / Dr GST paid 2.15 / Cr Stripe clearing 1,375.00).
- **Difference:** the 2.15 GST line carries evidence status `pending_tax_invoice`; the BAS includes it at 1B (and G11)
  only once Stripe's monthly tax invoice for that **UTC** month is attached. Confirm the 23.68 fee and its GST split
  against a real AU payout before approval (Stripe states GST is charged on top of its fees).

## GP-028 — Monthly Stripe tax-invoice reconciliation

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `payments.stripe.tax_invoice` · Q2
- **Scenario:** the November (UTC) tax invoice shows fee GST 2.16 against 2.15 posted from payouts (fee total unchanged). The invoice wins.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | tax:GST.paid | 2210 | 0.01 | | GST | — |
| 2 | setting:stripe.fee_account | 6200 | | 0.01 | GST | Stripe |
| | **Total** | | **0.01** | **0.01** | | |

- **Check:** 0.01 = 0.01 ✓ · Marks every payout GST line in the month `tax_invoice_held`; 1B for the month = 2.16.

## GP-029 — Credit note in a later BAS period (both BAS presentations), with reason code

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ar.credit_note` · Varies GP-005 and GP-019 · Q4
- **Scenario:** as GP-005 but INV-000123 was reported in the Oct–Dec 2026 BAS and CN-000007 ($200.00 + GST 20.00) is
  issued 2027-01-20 with `reason_code = scope_reduction`. Journal identical to GP-005 (Dr revenue 200.00 / Dr GST collected 20.00 / Cr AR 220.00).
- **Tax/BAS — default `credit_note_bas = net`:** G1 −220.00, 1A −20.00 in the Jan–Mar 2027 BAS (as Xero/QuickBooks).
- **Tax/BAS — setting `credit_note_bas = ato_adjustment`:** 1B +20.00 (worksheet G18) in Jan–Mar 2027; G1 unchanged.
- **Same BAS period** as the invoice: G1/1A net under both settings.
- **Reason codes:** price_concession, return, scope_reduction, billing_error, goodwill → reduce revenue. `credit_loss` is not allowed on a credit note; it routes to GP-024. A GP-019 void in a later period follows the same BAS setting.
- **Document:** the credit note is titled an adjustment note and references INV-000123.

## GP-030 — Monthly depreciation (recurring journal)

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ledger.recurring.depreciation` · Q14 · AASB 116
- **Scenario:** the GP-008 laptop ($2,000.00, capitalised because it exceeds the company's capitalisation threshold setting,
  which is a business policy, not the tax write-off limit), straight-line over 36 months from 2026-11-03.
  Monthly charge 2,000.00 / 36 = 55.555… → 55.56; the final month takes 55.40 so the total is exactly 2,000.00 (35 × 55.56 = 1,944.60).

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:DEPRECIATION_EXPENSE | 6500 | 55.56 | | — | — |
| 2 | system:ACCUM_DEPRECIATION | 1519 | | 55.56 | — | — |
| | **Total** | | **55.56** | **55.56** | | |

- **Check:** 55.56 = 55.56 ✓ · No GST. Tax depreciation (instant asset write-off, small business pool) stays off the ledger.

## GP-031 — Accrued expense with automatic reversal

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ledger.accrual` · Q14
- **Scenario:** 2026-11-30 November electricity estimated at $400.00 ex GST, bill not yet received. Accrued ex GST (no input tax credit without a tax invoice); auto-reverses 2026-12-01; the bill later posts as GP-008 shape.

**31a — accrual (2026-11-30)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | expense: Electricity | 6150 | 400.00 | | — | — |
| 2 | system:ACCRUED_EXPENSES | 2150 | | 400.00 | — | — |
| | **Total** | | **400.00** | **400.00** | | |

**31b — automatic reversal (2026-12-01)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:ACCRUED_EXPENSES | 2150 | 400.00 | | — | — |
| 2 | expense: Electricity | 6150 | | 400.00 | — | — |
| | **Total** | | **400.00** | **400.00** | | |

- **Check:** 31a 400.00 = 400.00 ✓ · 31b 400.00 = 400.00 ✓ · Recurring journals may also auto-reverse; editing an accrual reposts it and regenerates its reversal.

## GP-032 — Prepaid expense with monthly release

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: MVP · Source type: `ap.bill` + `ledger.prepayment_release` · Q14
- **Scenario:** 2026-11-01 annual insurance bill $1,320.00 ($1,200.00 + GST 120.00) covering 12 months; released monthly.

**32a — bill to prepayments**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:PREPAYMENTS | 1400 | 1,200.00 | | GST (tax 120.00) | Supplier |
| 2 | tax:GST.paid | 2210 | 120.00 | | GST | — |
| 3 | system:AP_CONTROL | 2100 | | 1,320.00 | — | Supplier |
| | **Total** | | **1,320.00** | **1,320.00** | | |

**32b — monthly release (2026-11-30)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | expense: Insurance | 6160 | 100.00 | | — | — |
| 2 | system:PREPAYMENTS | 1400 | | 100.00 | — | — |
| | **Total** | | **100.00** | **100.00** | | |

- **Check:** 32a 1,200.00 + 120.00 = 1,320.00 ✓ · 32b 100.00 = 100.00 ✓ · Tax/BAS: G11 +1,320.00, 1B +120.00 at the bill (accruals).

## GP-033 — Super payment under Payday Super

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: Phase 1 · Source type: `payroll.super_payment` · Q15
- **Scenario:** the GP-010 pay run's super $1,200.00 (amount from the payroll provider, on qualifying earnings), payday
  2027-07-15; due to be **received by the fund** by 2027-07-26 (7 business days; 20 business days for a new
  employee's first payday or a new fund choice). Paid by clearing-house batch 2027-07-20.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:SUPER_PAYABLE | 2320 | 1,200.00 | | — | — |
| 2 | bank:OPERATING | 1100 | | 1,200.00 | — | — |
| | **Total** | | **1,200.00** | **1,200.00** | | |

- **Check:** 1,200.00 = 1,200.00 ✓ · Variant: Cr `system:PAYROLL_CLEARING` when the provider pays super (Q5).
- **Controls:** SUPER_PAYABLE lines carry the per-pay-run due date; alert ahead of it allowing clearing-house transit time. Business-day counting and public holidays **(unverified)**.

## GP-034 — Superannuation guarantee charge (late super) assessment

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: Phase 1 · Source type: `payroll.sgc_assessment` · Q15
- **Scenario (illustrative amounts — component rates unverified):** the GP-033 super was not received on time; the
  employer lodges/receives an SGC assessment of $1,950.00 = shortfall 1,200.00 + notional earnings 30.00 + administrative uplift 720.00.
  The unpaid SG liability moves into the charge.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:SUPER_PAYABLE | 2320 | 1,200.00 | | — | — |
| 2 | setting:payroll.sgc_expense | 6420 | 750.00 | | — | — |
| 3 | system:SGC_PAYABLE | 2330 | | 1,950.00 | — | ATO |
| | **Total** | | **1,950.00** | **1,950.00** | | |

- **Check:** 1,200.00 + 750.00 = 1,950.00 ✓ · Later general interest charge on an unpaid assessment posts to a separate non-deductible account. Confirm component rates and deductibility before approval.

## GP-035 — Prior-period adjustment (AASB 108)

- **Status: Approved (claude under the product owner's delegation, DL-0256, 2026-11-01; basis RQ-0095/RQ-0096)** — implements the owner-approved change list (DL-0255) · Phase: Phase 1 (with an accounting ADR) · Source type: `ledger.prior_period_adjustment` · Q11
- **Scenario:** 2027-09-10, after FY2027 (to 30 June 2027) is hard-locked and reported, an unrecorded June 2027 office
  bill of $550.00 ($500.00 + GST 50.00) is found; material. Posted in the current open period, tagged
  `corrects_period = FY2027`, `original_account = 6100`, with reason and approver.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:PRIOR_PERIOD_ADJUSTMENTS | 3150 | 500.00 | | GST (tax 50.00) | Supplier |
| 2 | tax:GST.paid | 2210 | 50.00 | | GST | — |
| 3 | system:AP_CONTROL | 2100 | | 550.00 | — | Supplier |
| | **Total** | | **550.00** | **550.00** | | |

- **Check:** 500.00 + 50.00 = 550.00 ✓ · Current-year profit unchanged; the restated report mode shows 500.00 as FY2027 office expense; "as originally reported" stays available.
- **Tax/BAS:** input tax credit claimed in the current BAS (within the 4-year limit **(unverified)**). Immaterial errors are ordinary current-period corrections.

### Proposed reference-chart additions

| Code | Account | Binding |
|---|---|---|
| 1210 | Allowance for expected credit losses (contra-AR) | `system:AR_ECL_ALLOWANCE` |
| 1400 | Prepayments | `system:PREPAYMENTS` |
| 1519 | Accumulated depreciation — computer equipment | `system:ACCUM_DEPRECIATION` |
| 2150 | Accrued expenses | `system:ACCRUED_EXPENSES` |
| 2330 | Super guarantee charge payable | `system:SGC_PAYABLE` |
| 3150 | Prior-period adjustments (equity) | `system:PRIOR_PERIOD_ADJUSTMENTS` |
| 6150 / 6160 | Electricity / Insurance | chosen on line |
| 6300 | Impairment of receivables (renamed from Bad debts) | `setting:ar.bad_debt_account` |
| 6420 | Super guarantee charge expense | `setting:payroll.sgc_expense` |
| 6500 | Depreciation | `system:DEPRECIATION_EXPENSE` |

Flag-only changes (no new journal): GP-014 and GP-016 gain `contract_non_cancellable` / `deposit_non_refundable` and a
due date (report-layer netting when cancellable, after MVP); GP-008 records the capitalisation-threshold test; GP-010
notes that SG comes from the provider. Leave-provision and lease entries follow once their Phase 1–2 scope is decided.

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

### Research update 2026-11-01 (T-0115) — for the accountant, not decisions

An AASB/ATO review of every draft entry and question is in
[AASB alignment of LedgerForce postings](../research/reports/AASB%20alignment%20of%20LedgerForce%20postings.md)
(RQ-0095; primary sites were unreachable, so items marked unverified there need checking). Its suggestions, for
your decision only: Q7 — reject Option A (GST is attributable on receipt, GST Act s 29-5); Q8 — make per-document
rounding the AU default with the residual on the largest revenue line; Q4 — net into G1/1A only in the same BAS
period, otherwise 1B; Q3, Q6, Q10, Q11 — draft answers supported; Q1, Q2, Q5 — supported with refinements. New
questions raised: Q12 AASB 9 expected-credit-loss allowance (affects GP-007); Q13 deposit/subscription invoices
before performance only for non-cancellable contracts (GP-014, GP-016); Q14 depreciation, accruals and prepayment
postings needed in the MVP (GP-008); Q15 super payment posting under Payday Super from 1 July 2026 (GP-010/011).
No entry above has been changed.

**Follow-up 2026-11-01 (RQ-0096):** each suggestion was checked against legislation, ATO rulings and how
Xero/MYOB/QuickBooks work — see
[AASB decisions confirmed by law](../research/reports/AASB%20decisions%20confirmed%20by%20law.md). Changes to the
suggestions above: Q7 — GST at receipt, but a single non-progressive supply attributes GST on the whole supply at the
first payment (supply type becomes a required input); Q4 — default reversed to netting the note into G1/1A in its own
period (as Xero/QuickBooks do), with the strict 1B form as a setting; Q8 — per-document default kept, per-line 2 dp
added as an opt-in. The report ends with the exact list of entries to supersede (GP-007, GP-012, GP-018), re-draft
(GP-013) or vary (GP-004, GP-005, GP-019), and new proposed entries GP-020…GP-029, for your approval. Still no entry
above has been changed.

### Resolutions (2026-11-01, DL-0256)

| # | Resolution | Entries |
|---|---|---|
| Q1 | Receipt at charge, fee at payout (accrue material unpaid fees at month end) | GP-003, GP-027 |
| Q2 | Fee GST per payout, 1B only once Stripe's monthly tax invoice (UTC month) is held; clearing and fee accounts are connector settings | GP-027, GP-028 |
| Q3 | Ledger debit to GST collected; BAS 1B via GST-ADJ (accruals only); write-off record, no adjustment note; via ECL allowance | GP-024, GP-026 |
| Q4 | Default nets credit notes into G1/1A in their own period; `credit_note_bas = ato_adjustment` setting for 1B | GP-005, GP-029 |
| Q5 | PAYROLL_CLEARING used when the provider pays net pay or super | GP-033 |
| Q6 | One entry per batch, one AP line per bill, one bank line per batch | GP-009 |
| Q7 | GST at receipt; supply type decides per-receipt (Div 156/unknown total) vs whole supply (single supply → advance tax invoice) | GP-020, GP-021, GP-022 |
| Q8 | Total invoice rule default, residual on the largest revenue line; per-line 2 dp opt-in | GP-023 |
| Q9 | Yes — customer refunds use the supplier bank-detail verification and cooling-off | GP-006 |
| Q10 | Liability (contract liability), with non-cancellable / non-refundable flags | GP-014, GP-015 |
| Q11 | Void only when unallocated; otherwise credit note; material errors in reported periods via prior-period adjustment | GP-019, GP-035 |
| Q12 | Expected-credit-loss allowance on by default; direct write-off only as a documented materiality election | GP-024, GP-025 |
| Q13 | Advance invoices before performance only for non-cancellable contracts; ledger gross, report-layer netting | GP-014, GP-016, GP-021 |
| Q14 | Depreciation, accruals and prepayments in the MVP | GP-030, GP-031, GP-032 |
| Q15 | Payday Super: per-pay-run due date, super payment, SGC accounts | GP-033, GP-034 |

## Change history

| Date | By | Change |
|---|---|---|
| 2026-10-24 | claude (T-0007) | Initial DRAFT, GP-001 … GP-019, Q1–Q11. |
| 2026-11-01 | claude (T-0115) | Added research-update note under Open questions (Q12–Q15 raised); no entry changed. |
| 2026-11-01 | claude (T-0115) | Follow-up note linking RQ-0096 decision confirmations; no entry changed. |
| 2026-11-01 | claude (T-0115) | Owner approved the RQ-0096 change list; added Draft entries GP-020…GP-035 and chart additions implementing it. Superseded entries left unchanged for the owner to mark. |
| 2026-11-01 | claude (T-0115) | Owner delegated approval (DL-0256): entries Approved, GP-004/007/012/013/018 superseded, Q1–Q15 resolved. |
