# Accounting review — golden postings GP-001…GP-020, RQ-0090/0094/0095/0096/0097, AU tax-code, chart and posting-profile templates, DL-0244/0250/0253–0257/0260 — 2026-11-08

> **Honesty statement.** This is an AI persona modelled on the knowledge and professional standards
> of an Australian Chartered Accountant / CPA who is also a registered tax agent. It is **not** a
> registered practitioner, holds no TPB registration, carries no professional indemnity insurance
> and cannot sign or lodge anything. The product owner chose this persona instead of paid external
> review (DL-0248). Its findings are the best available technical review, not professional advice.

Reviewer: accountant-reviewer (claude persona) · Branch `claude/incomplete-features-build-wivsco`
· reviewed at 4f5bdb4, plus T-0039 merge b9a56dc for the tax-code precedence item (lead request).
Read-only on code and `Docs/accounting/postings.md`. Nothing in the golden file was changed.

**Independence note.** GP-001…GP-020 were drafted, answered (RQ-0095) and approved (DL-0253) by the
same provider (claude). This review is the first check by a different role. It does not replace
the owner's gate.

## Overall: **PASS WITH MAJORS** (0 BLOCKER · 6 MAJOR · 19 MINOR · 20 CONFIRMED)

Every journal balances. Accounts, sides and BAS labels are right for the scenarios as written. No
entry misstates the statements or the BAS for its stated facts. The MAJORs fall into two groups:
- **Incomplete treatments.** These are GST attribution for a single (non-Div 156) supply with a
  part payment, and the AASB 9 allowance path for bad debts.
- **Template data that would misstate BAS labels or the balance sheet when used as shipped.** These
  are: the fixed-asset default tax code, HARDWARE.asset mapped to PP&E, no separate export code for
  G2 versus G3, and the OVERSEAS_CUSTOMER → FRE default applied with no s 38-190 / s 38-185 test.

### Method

For each GP I worked out the journal from the scenario before reading the drafted lines, then
compared. The drafted lines matched my derivation in all 20 entries (22 journals counting 18a/18b
and 20a/20b). Debits equal credits in every table. I also checked the arithmetic: GST at 1/10 or
1/11 half-up, Stripe 23.68/11 = 2.1527 → 2.15, GP-018 3.35/11 = 0.3045 → 0.30 and 10.05/11 =
0.9136 → 0.91, and the Payday Super business-day counts.

### Source confirmation (2026-11-08)

Direct retrieval failed for every primary host. `curl` returned `CONNECT tunnel failed, response
403` and WebFetch returned `ENOTFOUND` for `www.ato.gov.au`, `www.legislation.gov.au`,
`www.austlii.edu.au`, `docs.stripe.com`, `support.stripe.com` and `www.aasb.gov.au`. **These hosts
must be allowed in the session's network settings to finish primary verification.** I re-ran
WebSearch to get independent extracts. A source is "corroborated by extract" when a second, fresh
search extract matches the RQ's claim. It is **not** a primary-page confirmation.

| Source / claim | Status |
|---|---|
| ATO "How to make adjustments": increasing adjustments at 1A, decreasing at 1B (accounts method); G7/G18 on the worksheet method | Corroborated by extract (ATO URL, two page versions). Not opened. |
| ATO "Adjustment notes": a note is needed for a decreasing adjustment unless the GST is $75 or less | Corroborated by extract. Not opened. |
| ATO / GSTR 2000/35 via edited private ruling 1011792288728: a Div 99 deposit is attributed when forfeited or applied; a genuine deposit is not a part payment; Div 156 components are separate supplies | Corroborated by extract. GSTR 2000/35 itself not read; paragraph refs (¶12, ¶115, ¶118) **unverified**. |
| ATO "Progressive or periodic sales and purchases": each component is accounted for as a separate sale | Corroborated by extract. |
| Payday Super: law passed, Royal Assent 6 Nov 2025, starts 1 July 2026, SG due within 7 business days of each payday (QE day), first-year ATO PCG | Corroborated by extract (ATO media release, plus GT, A&M and PwC). Legislation text not read. |
| s 38-190 item 2/3: services GST-free if used or enjoyed outside Australia, or supplied to a non-resident not in Australia; s 38-190(3) limitation; GSTR 2025/1 on supplies provided to another entity in Australia | Corroborated by extract (ATO "Exports and GST", vatupdate). Section wording **unverified**. |
| AASB Interpretation 1031: receivables and payables stated GST-inclusive; net GST recoverable or payable included in receivables or payables | Corroborated by extract (AASB PDF and standards.aasb.gov.au). Operative-date window should be re-checked. |
| Stripe AU standard pricing (1.7% + A$0.30 domestic) is GST-inclusive; custom pricing may show GST separately | Secondary only (Aspire, Lilach Bullock, Xero). Stripe's own page **unverified**. Consistent with GP-003's split. |
| GST Act s 29-5(1)/(2), s 29-10(1)/(3), s 29-20, s 21-5, Div 99, Div 156 operative wording | **Unverified.** A search for the section text returned only Indian GST material. Relied on prior knowledge, which agrees with RQ-0095. |
| Stripe balance transaction `fee_details[].type` enum (`tax` etc.) and the monthly AU tax invoice | **Unverified** in this session. The T-0074/T-0075 test-mode spike remains the confirmation. |
| AASB 15 ¶105–108, AASB 9 ¶5.4.4 / ¶5.5.15, AASB 101 ¶32, AASB 119, AASB 102 | **Unverified** (aasb.gov.au blocked). Cited from prior knowledge of the standards. |
| ATO BAS G2 = exports of goods only; GST-free exported services reported at G3 | **Unverified** (prior knowledge). Re-check the ATO "G2 Export sales" instruction. |
| ATO rounding rules (taxable-supply and total-invoice; half cent rounds up), RQ-0094 S1 | **Unverified** in this session (RQ-0095 S9 extract only). |

---

## Findings

| Item | Verdict | Severity | Standard / law | Finding | Proposed change |
|---|---|---|---|---|---|
| GP-001 | Confirmed | CONFIRMED | AASB 15 ¶31/¶38 (point-in-time on invoice for billed services), s 9-70, s 29-5(1)(b) | Dr AR 1,375 / Cr revenue 1,000 + 250 / Cr GST 125. Accruals G1 1,375, 1A 125 at invoice. Cash basis nothing until paid. Correct. | — |
| GP-001 (invoice) | Note | MINOR | s 29-70, GSTR 2013/1 | At $1,375 (≥ $1,000) the tax invoice must also show the buyer's identity or ABN. That is an invoice-template requirement, not a journal one. | Add to the invoice-format acceptance tests (T-0040/T-0047). |
| GP-002 | Confirmed | CONFIRMED | s 29-5(2) | Dr bank / Cr AR. Cash-basis G1/1A in the receipt period, proportional. Undeposited-funds variant right. | — |
| GP-003 | Confirmed | CONFIRMED | s 29-10(1),(3); AASB 15 (receipt); conceptual framework (expense when incurred) | Fee and fee GST at charge give the right cut-off, because Stripe deducts the fee at charge. Accruals G11 23.68 (GST-inclusive), 1B 2.15. Claim held back until the monthly Stripe tax invoice is held. Correct. | — |
| GP-003 (fee figures) | Note | MINOR | — | 23.68 split 21.53 + 2.15 assumes standard AU pricing is GST-inclusive. Secondary sources agree; Stripe's own page is unverified. The golden says the split is read from `fee_details` and not computed, which is correct. | Keep. T-0074/T-0075 spike must confirm a `tax` fee_detail on AU accounts. |
| GP-003/004 (clearing) | Note | MINOR | AASB 107 ¶6–¶8 | Stripe clearing (chart 1210) is a claim on Stripe, not a bank deposit. Classify it as a receivable or other current asset, not as cash and cash equivalents, unless the entity adopts and discloses a policy. | Cash-flow report (later phase): exclude `setting:stripe.clearing_account` from cash unless configured. |
| GP-004 | Confirmed | CONFIRMED | — | Net moves from clearing to bank. Clearing nets to 0. Correct. | — |
| GP-005 | Confirmed | CONFIRMED | Div 19; s 29-20; ATO "How to make adjustments" (extract); s 29-75 | Same period: G1 −220 / 1A −20. Later period: 1B +20 with G1 unchanged, matching ATO accounts-method wording. Always issuing an adjustment note is conservative and right. | — |
| GP-005 (presentation) | Note | MINOR | AASB 101 ¶32 | Acme's AR becomes a −220 credit balance. Statements must not offset customer credit balances against debit balances in "Trade debtors". | Balance-sheet report: reclassify net customer credit balances to a liability line at the reporting date. |
| GP-006 | Confirmed | CONFIRMED | — | Dr AR / Cr bank, no GST. The DL-0254 controls are appropriate (refund fraud vector). | — |
| GP-007 (GST/BAS) | Confirmed | CONFIRMED | s 21-5, s 21-10; ATO "Types of adjustments" (extract) | Accruals: 1B 125 in the write-off period, and recovery goes to 1A. Cash basis: no adjustment, same ledger entry (it clears GST that was never attributed). Debiting GST collected is acceptable: the BAS label comes from tax code `ADJ-BD`, and net payable is the same. | — |
| GP-007 (AASB 9) | Incomplete | **MAJOR** | AASB 9 ¶5.5.15 (simplified ECL for trade receivables), ¶5.4.4 (write-off); AASB 1060 | The golden only covers direct write-off to expense. An entity applying AASB 9 holds an ECL allowance; the write-off then debits the allowance, and only any excess goes to expense. The chart has no allowance (contra-receivable) account and there is no setting for one. Direct write-off is fine where no allowance exists (many non-reporting SMBs). It is not fine as the only path. | Add the allowance variant below (GP-007-A) as a new Draft. Add chart account "Allowance for expected credit losses" (asset, contra, normal credit) and `setting:ar.ecl_allowance_account`. |
| GP-007 (scenario) | Note | MINOR | s 21-5(1)(b) | INV-000140's invoice date is not stated, so the "overdue 12 months" condition cannot be checked from the golden. | State the invoice date in a superseding Draft (e.g. 2026-11-05, due 2026-11-19). |
| GP-008 | Confirmed | CONFIRMED | s 11-5, s 29-10; BAS G10/G11 GST-inclusive | G10 2,200, G11 550, 1B 250. One tax line per code is right. Capitalising a $2,000 laptop is consistent with AASB 116 (capitalisation threshold is a policy). | — |
| GP-008 (reference) | Note | MINOR | — | "Computer equipment 1510" does not exist in the T-0018 chart, where 1510 is **Accumulated depreciation** and 1500 is Office equipment. The runner resolves by name through golden-world, so tests are unaffected. A human reading "Ref" would post to a contra account. | See the reference-chart MINOR. |
| GP-009 | Confirmed | CONFIRMED | — | One entry per batch, one AP line per bill, one bank line. A returned item is a new entry. Cash-basis G10/G11/1B in the payment period. Correct. | — |
| GP-010 | Confirmed | CONFIRMED | TAA 1953 Sch 1 (PAYGW); SGAA 1992; AASB 119 ¶11 | Gross to expense, PAYGW and SG to liabilities, net to wages payable. W1 10,000, W2 2,000. SG is not in W1. Correct. | — |
| GP-010/011/020 (dates) | Note | MINOR | Payday Super (from 1 July 2026, 7 business days after payday) | The scenario uses "pay run ending 2027-07-14" (Wed). GP-011 pays net on 2027-07-15 (Thu); GP-020 debits on 07-14. Payday is the date wages are paid. For GP-010/011 that is 07-15, so the SG deadline is **2027-07-26** (Mon), not 07-23. The stated date is earlier, so it is safe, but wrong. W1/W2 belong to the period in which wages are **paid**. | In a superseding Draft, state the payday explicitly (GP-010/011: 2027-07-15 → SG due 2027-07-26; GP-020: 2027-07-14 → 2027-07-23). |
| GP-010/020 (tax codes) | Note | MINOR | — | `BAS-W1` / `BAS-W2` (like `ADJ-BD`) are not in `au-tax-codes.json`. They exist only in `packages/ledger/src/testing/golden-world.ts`. W1 is driven by an expense-line code, so an accrued but unpaid wage could reach W1. | Phase-1 payroll bridge: derive W1/W2 from `payroll.pay_run` lines by pay date, or add W-codes to the template with that rule (same pattern as DL-0257). |
| GP-011 | Confirmed | CONFIRMED | — | Correct. | — |
| GP-012 / GP-014 (attribution) | Defensible, incomplete | **MAJOR** | s 29-5(1); Div 156 (s 156-5); Div 99; GSTR 2000/35 (unverified paras) | Option B (1/11 of the amount received) and the deposit invoice (GST on the deposit only) are right **only where Div 156 applies**, i.e. a progressive or periodic supply with progressive consideration, or the deposit is a separate component. For a single (non-progressive) supply on the accruals basis, s 29-5(1) attributes the **whole** GST (1,000) to the period of the first payment or invoice. The golden notes the risk, but the software has no way to record which case applies. It silently treats every deposit as a Div 156 component, which can understate 1A by 700 in November. Cash basis is unaffected (s 29-5(2)). | (1) Add a contract/opportunity classification `gst_supply_pattern = progressive_div156 (default for milestone/period services) \| single_supply \| security_deposit_div99`, stored on the deposit invoice or receipt, with help text. (2) For `single_supply` on accruals, post the whole GST at first payment or invoice: GP-012-B / GP-015-B below. (3) Show the chosen pattern on the BAS-prep report. GP-012/013/014/015 stay valid for `progressive_div156`. |
| GP-013 | Confirmed | CONFIRMED | s 29-5(1), Div 156 | Final invoice nets the prepayment. Project 1A totals 1,000 and G1 totals 11,000 across periods. Correct under Div 156. | — |
| GP-014 (AASB 15) | Note | MINOR | AASB 15 ¶105, ¶108 | Dr AR / Cr contract liability at invoice is right when the right to the deposit is unconditional (non-cancellable, due). If the contract is cancellable without penalty before payment, AASB 15 recognises nothing until paid. Grossing up AR and the liability then overstates both. | Note only: tenant policy, or recognise on payment for cancellable deposits. GST still attributes at invoice issue (s 29-5(1)(b)). |
| GP-014 (account) | Confirmed | CONFIRMED | AASB 15 ¶106 | Contract liability, not revenue. Correct. | — |
| GP-015 | Confirmed | CONFIRMED | — | Same shape as GP-013. Unsigned tax on the debit side is correct. | — |
| GP-016 | Confirmed | CONFIRMED | s 29-5(1)(b); AASB 15 ¶106 | GST on the whole annual invoice at issue; revenue deferred. Current liability. Correct. (Same ¶108 note as GP-014 if the subscription is cancellable and not yet due.) | — |
| GP-017 | Confirmed | CONFIRMED | AASB 15 ¶35(a), ¶39–¶41 (time-elapsed output method) | Straight-line monthly release; residue to the last release. Correct. | — |
| GP-018a | Confirmed | CONFIRMED | ATO rounding (taxable-supply rule) | 0.30 × 3 = 0.90, nets 9.15. No residue. Correct. | — |
| GP-018b | Confirmed | CONFIRMED | ATO rounding (total-invoice rule) | GST 0.91 is reported as shown on the invoice. Correct for tax. | — |
| GP-018b (revenue) | Note | MINOR | AASB 15 ¶47 | The transaction price ex GST is 10.05 − 0.91 = 9.14. The golden shows revenue 9.15 and a 0.01 ROUNDING expense (chart 6900, type expense). Net profit is right, but gross revenue is overstated by 0.01. This is immaterial and the treatment was chosen (DL-0244/0255). | Optional: classify sales-document rounding as a revenue adjustment in reports, or give ROUNDING an "other income/expense" subtype. No golden change needed. |
| GP-019 | Confirmed | CONFIRMED | AASB 108 (correction by reversal); Div 19; s 29-75 | Void only in the same BAS period with no allocations; otherwise a credit/adjustment note. Pure side swap. Correct and conservative. | — |
| GP-020 | Confirmed | CONFIRMED | §3.2 control account | Provider-debit mode through PAYROLL_CLEARING is the standard practice. Clearing nets to 0. Correct. | — |
| GP-020 (code note) | Note | MINOR | — | "reference code 2330 for payroll clearing … new" is wrong: the T-0018 chart already has PAYROLL_CLEARING at **2350**, and 2330 is **SUPER_PAYABLE**. Following the note would create a code collision. | Fix in a superseding Draft or a header erratum. |
| postings.md reference chart | Inconsistent | MINOR | — | The "illustrative" codes collide with different accounts in the real AU template: 1100 (bank vs Undeposited funds), 1510 (equipment vs Accumulated depreciation), 2200/2210 (GST vs —; real 2310/1820), 2320/2330 (wages/super vs PAYG/super), 6200 (Merchant fees vs **Rent**), 6300 (Bad debts vs —; real 6500), 8900 vs 6900 ROUNDING, 4000/4100 vs 4110/4120. Tests resolve by role, slot and name, so there is no ledger effect. Humans will be misled. | Replace the reference table with the T-0018 codes in a superseding header Draft (no GP line changes). |
| Chart 1500 Office equipment | Wrong default | **MAJOR** | BAS G10 vs G11 | `defaultTaxCode: "GST"` on a fixed-asset account. Purchases coded to it default to G11 (non-capital) instead of G10. Net GST is correct, but full-BAS G10/G11 are misreported. GP-008 itself correctly uses CAP. | Superseding chart template version (additive): 1500 `defaultTaxCode: "CAP"`. Apply the same rule to every `fixed_asset` debit-normal account. Add a template test: fixed-asset accounts default to CAP. |
| Chart (allowance) | Missing | (part of GP-007 MAJOR) | AASB 9 | No contra-receivable account for the ECL allowance. | Add "1290 Allowance for expected credit losses" (asset, receivable/contra, normal credit, not control). |
| Chart (completeness) | Incomplete | MINOR | AASB 119 ¶13–¶16 (annual leave), AASB 137, AASB 102, AASB 112 (flag only) | Missing accounts: employee leave provisions (annual leave and LSL, current/non-current), accrued expenses, inventory and COGS (see HARDWARE), ATO integrated client account / BAS clearing, PAYG instalments, income tax payable/expense (out of MVP scope, flag only), and accumulated depreciation pairs for any further asset classes. Tenants can add these, but a services SMB with staff will need leave provisions at year end. | Add to the template in a later version, or have the wizard prompt for them. |
| Chart (bank fees INP) | Note | MINOR | Div 40 (financial supplies); BAS G11/G14 vs G13 | INP on purchases (6110 bank fees) is right for "no GST credit". T-0035 must map purchase-side INP to G11 (+G14 on the calculation sheet), **not** G13. G13 is purchases used to make input-taxed sales. Sales-side INP (4900 interest) maps to G4. | T-0035 mapping test for both directions of INP. |
| Chart (GST accounts) | Note | MINOR | AASB Interpretation 1031; AASB 101 ¶32 | Separate GST collected (2310) and GST paid (1820) accounts are fine. Reports should present the net amount within payables or receivables (Int 1031 permits this). | Reporting layer. |
| Profiles: HARDWARE | Misstates | **MAJOR** | AASB 102 vs AASB 116; AASB 15 ¶114 (disaggregation, Tier 1) | `HARDWARE.asset → 1500 Office equipment` sends hardware bought **for resale** into PP&E, overstating PP&E and understating inventory and COGS. It conflates the own-use laptop of GP-008 (correctly chosen on the bill line) with resold hardware. Mapping HARDWARE revenue to 4190 "Recoverable costs income" also mislabels a product sale as a cost recovery. The empty COGS slot is intentional and acceptable (gap step), but a filled wrong slot is worse than an empty one. | Superseding profile template: leave `HARDWARE.asset` **empty** (gap step asks the tenant: inventory or expensed-on-purchase); keep the cogs gap. Either add "4140 Hardware sales" or keep 4190 with the name changed to "Hardware and recoverable costs". If an own-use equipment profile is wanted, add a separate `EQUIPMENT` profile with `asset: 1500` and purchase tax CAP. |
| Profiles: REIMBURSABLE_EXPENSE | Note | MINOR | AASB 15 B34–B38 (principal vs agent); GST on on-charged costs | 4190 revenue suits on-charged costs where the entity is principal (taxable as part of the supply). True disbursements as agent are neither revenue nor a supply by the entity. | Note in the wizard: an agent-type disbursement posts to a clearing/receivable account, not revenue. |
| Profiles: FREIGHT | Note | MINOR | — | 4190 is acceptable. Freight charged is revenue and takes the GST status of the main supply (GST-free if it is part of an export of goods). | — |
| Profiles: OVERSEAS_CUSTOMER default FRE | Unsafe default | **MAJOR** | s 38-190 (items 2–3, subs (3)); s 38-185 (goods exported within 60 days); s 9-25 | With the T-0039 rule "only one default set → use it", any product without its own tax code sold to an OVERSEAS_CUSTOMER is silently FRE. Examples: services enjoyed in Australia, goods delivered in Australia, or work on Australian real property. That under-collects GST (1A). A party profile alone cannot establish GST-free status. | See the tax-code ruling below. Interim fix: remove `defaultTaxCode` from OVERSEAS_CUSTOMER (template v2), which makes the resolver return NO_TAX_CODE so a person codes the line. |
| Tax template | Missing code | **MAJOR** | BAS G2 (export of goods) vs G3 (other GST-free) — prior knowledge, unverified | A single `FRE` code cannot separate exports of goods (G2) from other GST-free sales, including exported services (G3). Full-BAS reporters would misreport G2/G3. Simpler BAS reporters are unaffected. | Add codes `EXP` (GST-free export of goods, s 38-185, sales → G1+G2) and keep `FRE` (G1+G3). Optional `EXS` (export of services, s 38-190, → G3) for audit clarity. Effective-dated rows, additive. |
| Tax template (`ADJ-BD`, W-codes) | Tracked | MINOR | — | Not in the template. ADJ-BD is tracked by DL-0257 (T-0035/T-0048). BAS-W1/W2 are untracked. | Track W-codes as in the GP-010 note. |
| Tax-code precedence (T-0039, RQ-0097, DL-0260) — lead request | Ruling | (counted in the OVERSEAS_CUSTOMER MAJOR) | s 9-5, Div 38 (s 38-185, s 38-190), Div 40, Div 84, Div 99 | Keeping the TAX_CODE_CONFLICT refusal is **safe**, because it never guesses. It is **not sufficient**: (a) the single-default fallback lets party-only FRE through; (b) it forces manual coding on every overseas sale. GST status depends on both what is supplied and who/where the recipient is, plus conditions only a person can confirm. | Adopt a tax-determination matrix with confirmations: see *Tax-code ruling and data design* below. |
| RQ-0090 | Confirmed with note | — | — | Findings consistent with RQ-0095. It is still marked `answered-pending-human`; RQ-0095 superseded its open points. | Status housekeeping only. |
| RQ-0094 | Confirmed | — | ATO rounding | Both rules accepted; half-up; residue analysis correct (spike S6). | — |
| RQ-0095 | Confirmed with the GP-012/014 MAJOR | — | — | Q1–Q6 and Q8–Q11 answers agree with my independent derivation. For Q7, the Option A rejection is right; the "treat as progressive components" default needs the classification in the GP-012 MAJOR. | — |
| RQ-0096 | Confirmed with the HARDWARE MAJOR | — | — | Slot model sound. The template mapping is covered in the HARDWARE MAJOR. | — |
| DL-0244 / DL-0255 | Confirmed | — | — | Residue to ROUNDING is acceptable (see GP-018b MINOR). | — |
| DL-0250 | Confirmed with the HARDWARE MAJOR | — | — | Data model sound. HARDWARE.asset seed must change. | — |
| DL-0253 | Process note | MINOR | APES 110 (objectivity) | Self-approval by the drafting provider under delegation. Acceptable only because this independent review follows. The gate-4 golden diff-guard FAIL must still be accepted by the owner at merge. | Owner to note at merge. |
| DL-0254 | Confirmed | — | — | Appropriate control. | — |
| DL-0256 | Confirmed | — | — | PENDING with a reason is honest; no tests weakened. | — |
| DL-0257 | Confirmed | — | — | Correct to add ADJ-BD with its BAS mapping. Extend the same rule to BAS-W1/W2. | — |

---

## Proposed superseding entries (for the ledger-engineer to write as new `Draft` entries — do not edit Approved ones)

### GP-007-A — Bad debt write-off against an ECL allowance (proposes to add a variant to GP-007; GP-007 stays valid for direct write-off)

Scenario: as GP-007 (INV-000140, $1,375.00 incl. GST 125.00, accruals). The entity applies AASB 9
simplified ECL and had already provided 1,250.00 (the loss net of the recoverable GST adjustment)
in an earlier period.

**A1 — ECL allowance recognised (earlier period, e.g. 2027-06-30), source `ar.ecl_provision` (new, journal class)**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.bad_debt_account (impairment expense) | 6500 | 1,250.00 | | — | — |
| 2 | setting:ar.ecl_allowance_account | 1290 | | 1,250.00 | — | — |
| | **Total** | | **1,250.00** | **1,250.00** | | |

BAS: none (no GST event).

**A2 — Write-off 2027-12-01, source `ar.write_off`**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.ecl_allowance_account | 1290 | 1,250.00 | | ADJ-BD (tax 125.00) | Acme |
| 2 | tax:GST.collected | 2310 | 125.00 | | ADJ-BD | — |
| 3 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |

Accruals: 1B +125.00 in the write-off period. Cash basis: same entry, no BAS effect. If the
allowance is smaller than the amount written off, the difference debits
`setting:ar.bad_debt_account` on an extra line with the same ADJ-BD tax split.

### GP-012-B — Uninvoiced part payment, **single (non-Div 156) supply**, accruals basis (proposes a variant beside GP-012)

Scenario: as GP-012 ($3,300 received 2026-11-10 on an $11,000 GST-inclusive project), classified
`gst_supply_pattern = single_supply`. s 29-5(1) attributes the whole GST (1,000.00) to November.
The 700.00 of GST reported ahead of billing is a GST-timing asset recovered from the customer at
final billing. It is recorded gross: AASB 101 ¶32 does not allow netting it into the contract
liability. **Needs a new system role** `GST_ATTRIBUTED_UNBILLED` (asset, not control) — a design
decision for T-0047.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1010 | 3,300.00 | | — | — |
| 2 | system:GST_ATTRIBUTED_UNBILLED (proposed) | new | 700.00 | | GST (tax 700.00, attribution only) | Acme |
| 3 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,000.00 | GST (tax 300.00) | Acme |
| 4 | tax:GST.collected | 2310 | | 1,000.00 | GST | — |
| | **Total** | | **4,000.00** | **4,000.00** | | |

BAS (accruals) 2026-11: G1 +11,000.00, 1A +1,000.00. Cash basis: use GP-012 unchanged (1A 300.00).
The tax-line representation of line 2 (base 7,000.00 not yet invoiced) needs a BAS-query rule.
Until it exists this variant stays PENDING.

### GP-015-B — Final invoice after GP-012-B / single-supply deposit (2026-12-15)

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 7,700.00 | | — | Acme |
| 2 | system:CUSTOMER_PREPAYMENTS | 2400 | 3,000.00 | | — | Acme |
| 3 | product:PROFESSIONAL_SERVICES.revenue | 4110 | | 10,000.00 | — (GST already attributed) | Acme |
| 4 | system:GST_ATTRIBUTED_UNBILLED (proposed) | new | | 700.00 | — | Acme |
| | **Total** | | **10,700.00** | **10,700.00** | | |

BAS 2026-12: G1 0, 1A 0. Project totals are G1 11,000.00 and 1A 1,000.00, all in November. The
tax invoice still shows the total GST of 1,000.00 and the 300.00 already invoiced or received.
The same pattern applies to a GP-014 deposit invoice classified `single_supply` (invoice issue
attributes the whole GST).

*(The chart, profile and tax-template changes are data proposals, not journals. They are listed in
the findings table and the design below.)*

---

## Tax-code ruling and data design (lead request — T-0039 / RQ-0097 / DL-0260)

**Ruling.** Neither "party wins" nor "product wins" is GST-correct, and a two-key lookup without
confirmations is not enough either. A supply's GST status turns on:
- what is supplied: Div 38 inherently GST-free items such as basic food, health and education;
  Div 40 input-taxed items such as financial supplies and residential rent; goods vs services vs
  Australian real property;
- who the recipient is and where they are: s 38-190 item 2 (non-resident not in Australia when
  the supply is done, not connected with Australian land or goods), item 3 (used or enjoyed
  outside Australia), and the s 38-190(3) limit where the supply is provided to another entity in
  Australia (GSTR 2025/1);
- a fact about the transaction: s 38-185 goods exported within 60 days, with evidence.

Keep the refusal as the **fallback**. Put a determination matrix in front of it, add confirmation
flags, and remove the unsafe single-default shortcut for party-only GST-free codes.

**Recommended data design (additive migrations only; nothing dropped):**

1. `app.party_posting_profile.tax_class` (new column). Customer classes: `DOMESTIC`,
   `NON_RESIDENT_OFFSHORE`. Supplier classes: `DOMESTIC_REGISTERED`, `DOMESTIC_UNREGISTERED`,
   `OVERSEAS`. Optionally `RELATED_PARTY` (no GST effect; a reporting tag). Mark the existing
   `default_tax_code` deprecated in a comment and ADR. Keep it readable for one version.
2. `app.product_posting_profile.tax_class` (and an optional override on `app.product`):
   `TAXABLE_SERVICE`, `TAXABLE_GOODS`, `TAXABLE_DIGITAL`, `AU_REAL_PROPERTY`, `GST_FREE_INHERENT`
   (Div 38 food/health/education/etc.), `INPUT_TAXED` (Div 40), `CAPITAL_EQUIPMENT` (purchase
   side), `BAS_EXCLUDED`.
3. `app.tax_determination` (tenant-owned, RLS): `(company_id, direction sale|purchase,
   party_tax_class, product_tax_class, valid_from, valid_to)` → `outcome` ∈ {`code`, `confirm`,
   `manual`}, `tax_code`, `alt_tax_code`, `confirmation_key`.
   - `code`: use this code.
   - `confirm`: propose `tax_code`, but require the user to confirm a named condition. The
     condition is stored on the document line (`tax_confirmation_key`, `confirmed_by`,
     `confirmed_at`, free-text evidence ref). If it is not confirmed, use `alt_tax_code`. This
     gives a record-keeping trail for the 5-year retention requirement.
   - `manual`: the line must carry an explicit code.
4. **Precedence:**
   1. Explicit line code. If it differs from the determination result, store an override reason
      (audit).
   2. Product-inherent classes win regardless of party: `GST_FREE_INHERENT` → FRE,
      `INPUT_TAXED` → INP, `BAS_EXCLUDED` → N-T.
   3. The `tax_determination` cell.
   4. No cell → refuse `NO_TAX_RULE`. This replaces TAX_CODE_CONFLICT, reusing the T-0039 refusal
      plumbing.

   A party default alone never makes a supply GST-free.
5. **AU template seed (sales):**
   - `DOMESTIC` × `TAXABLE_*` → `code GST`.
   - `NON_RESIDENT_OFFSHORE` × `TAXABLE_SERVICE` / `TAXABLE_DIGITAL` → `confirm` FRE/EXS
     (`s38-190: recipient not in Australia when the supply is done, not provided to an entity in
     Australia, not connected with AU real property`), alt GST.
   - `NON_RESIDENT_OFFSHORE` × `TAXABLE_GOODS` → `confirm` EXP (`s38-185: exported within 60 days,
     evidence held`), alt GST.
   - any × `AU_REAL_PROPERTY` → `code GST`.

   **Purchases:**
   - `DOMESTIC_REGISTERED` × `TAXABLE_*` → GST; × `CAPITAL_EQUIPMENT` → CAP.
   - `DOMESTIC_UNREGISTERED` × any → FRE (no GST in price; no credit).
   - `OVERSEAS` × `TAXABLE_SERVICE` / `TAXABLE_DIGITAL` → `manual`. A GST-registered business
     recipient is not charged GST, and the Div 84 reverse charge applies only to recipients who
     are not fully creditable; this is out of MVP scope, so flag it.
6. **Tax codes needed:** add `EXP` (G2) and optionally `EXS` (G3). FRE stays G3. These are
   effective-dated rows.
7. **Tests (TDD, T-0039 follow-up card):**
   - property: no resolution yields a GST-free/export code without either a product-inherent
     class or a stored confirmation;
   - table tests for every template cell;
   - the existing TAX_CODE_CONFLICT tests become NO_TAX_RULE tests; the T-0039 behaviour is
     superseded, not deleted.
8. This changes a tax treatment and the data model, so it needs an **accounting ADR** (human gate)
   before the build.

---

## Items to re-check when primary sources are reachable

Allow `www.ato.gov.au`, `law.ato.gov.au`, `www.legislation.gov.au`, `www.austlii.edu.au`,
`docs.stripe.com`, `support.stripe.com`, `stripe.com` and `www.aasb.gov.au` in the session network
settings, then check:

1. GST Act s 29-5(1)/(2), s 29-10(3), s 29-20, s 29-70, s 29-75, s 21-5, s 21-10, Div 99, s 156-5,
   s 38-185, s 38-190 — operative wording.
2. GSTR 2000/35 (Div 156 and deposits; ¶12, ¶115, ¶118 as cited by the private ruling), GSTR
   2000/19 (adjustments), GSTR 2000/2 (bad debts — RQ-0090 says it was not read), GSTR 2013/1
   (tax invoices), GSTR 2025/1 (s 38-190(3)).
3. ATO BAS instructions: whether G1 is adjusted for later-period sales adjustments under the
   accounts method; G2 = goods exports only; G13 vs G11/G14 for input-taxed purchases.
4. ATO Payday Super page and the enacted text: "qualifying earnings", the 7-business-day rule, and
   whether the due date counts from payday or from the QE day.
5. Stripe: AU pricing page (GST-inclusive?), the monthly tax invoice support article, and the
   `balance_transaction.fee_details` `tax` type — via the T-0074/T-0075 test-mode spike.
6. AASB 15 ¶105–108, AASB 9 ¶5.4.4/¶5.5.15, AASB 101 ¶32, AASB Interpretation 1031 operative
   window (an extract suggests "before 1 January 2027": check whether it has been reissued).
7. ATO rounding guidance (RQ-0094 S1) — the two rules and half-cent-up.

## Sources used in this review (search extracts, 2026-11-08)

- [ATO — How to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments)
- [ATO — Adjustment notes](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/adjustment-notes)
- [ATO — Edited private ruling citing GSTR 2000/35](https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg)
- [ATO — Progressive or periodic sales and purchases](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/agent-consignment-and-progressive-transactions/gst-agent-consignment-and-progressive-transactions/progressive-or-periodic-sales-and-purchases)
- [ATO — Media release: employers prepare for Payday Super](https://www.ato.gov.au/media-centre/ato-calls-on-employers-to-prepare-for-payday-super)
- [Grant Thornton — Payday Super becomes law](https://www.grantthornton.com.au/insights/client-alerts/payday-super-becomes-law/)
- [PwC — Explaining Payday Super](https://www.pwc.com.au/workforce/employment-taxes/whats-trending-explaining-payday-super-a-new-compliance-regime.html)
- [ATO — Exports and GST](https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/australians-doing-business-overseas/exports-and-gst)
- [vatupdate — GSTR 2025/1 supplies to non-residents provided to another entity in Australia](https://www.vatupdate.com/2025/07/23/gst-ruling-on-supplies-to-non-residents-provided-to-another-entity-in-australia)
- [AASB — Interpretation 1031](https://aasb.gov.au/admin/file/content105/c9/INT1031_07-04.pdf)
- [Aspire — Stripe fees in Australia](https://aspireapp.com/en-au/blog/stripe-fees-australia) (secondary)
- [Xero AU — Pricing and fees for Stripe](https://www.xero.com/au/pricing-plans/pricing-and-fees-for-stripe/) (secondary)
