---
id: RQ-0095
title: Answers to the golden-posting accountant questions Q1–Q11 and the five runner findings (DL-0246)
status: answered        # open | answered | answered-pending-human | superseded (values as RQ-0090/RQ-0094)
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0007, T-0031, T-0032, T-0034, T-0035, T-0047, T-0048, T-0055, T-0074, T-0075]
linked_adrs: []
superseded_by:
---

# RQ-0095 — Golden-posting open questions Q1–Q11 and the five unpostable drafts

## Question

The product owner delegated to claude the job of answering the questions in
`Docs/accounting/postings.md` → *Open questions for accountant* (Q1–Q11) so that the golden postings
can be finalised. For **each** question: what does the source material (ATO, GST Act, Stripe,
AASB, bank formats) say, what is the answer, and what must the golden journal look like?

Also: the golden runner (DL-0246, T-0031) found five Draft entries that the engine cannot post as
written (F1 GP-008, F2 GP-014, F3 GP-017, F4 GP-015, F5 GP-019). For each, what is the minimal
correction that matches the engine model in `packages/ledger` — or must the engine change?

## Why it matters

T-0007 is `blocked` on the golden-postings gate, and every posting task (T-0040 onwards) needs an
Approved golden first (`AGENTS.md` §0.2, `Docs/accounting/AGENTS.md`). Guessing wrong mis-states
GST (BAS 1A/1B), revenue timing or the bank reconciliation for every tenant. Design refs:
`solution-design.md` §3.2 (system roles), §3.3 (journal line), §3.4 (rounding), §3.5 (period matrix),
§3.6 (tax engine, BAS as a query), §3.8 (standard postings), §4.3 (billing formats), §4.5 (rules),
§6.5 (SoD). Prior research: RQ-0090 (tax treatments), RQ-0094 (GST rounding).

**Scope boundary.** This record answers the questions and proposes exact golden changes. It does not
edit `postings.md` (human-owned file; the scribe/lead applies changes as Draft entries via the
`golden-posting` skill and the `golden_postings` label).

## Sources consulted

**Network note (2026-11-08).** From this session `curl` to `www.ato.gov.au`, `law.ato.gov.au`,
`www.legislation.gov.au`, `www.austlii.edu.au`, `docs.stripe.com` and `support.stripe.com` fails
(`CONNECT tunnel failed, response 403`), and WebFetch cannot resolve `www.ato.gov.au`. The regulator
and vendor pages below were therefore read through the **WebSearch tool's extracts of the live
pages** (titles, URLs and quoted sentences as returned), not by opening the full page. Each row says
so. Where a fact rests on the researcher's prior knowledge rather than an extract, the row says
"prior knowledge". Re-verify rows marked *extract* by opening the page when the proxy allows.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | ATO, "How to make adjustments", https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments | 2026-11-08 (extract) | primary (regulator) | Accounts method: report "increasing adjustments at Label 1A, decreasing amounts at Label 1B". Calculation-worksheet method: overall increasing adjustment at G7, overall decreasing at G18. |
| S2 | ATO, "Types of adjustments", https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/types-of-adjustments | 2026-11-08 (extract) | primary (regulator) | Non-cash (accruals) basis: a decreasing adjustment for a bad debt is available if you made a taxable sale and paid the GST, and the debt is written off as bad or has been overdue 12 months or more; claimed in the period of write-off; a later recovery is an increasing adjustment in the period of recovery. Forgiven or set-off debts do not qualify. |
| S3 | ATO, "Adjustment notes", https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/adjustment-notes | 2026-11-08 (extract) | primary (regulator) | "You need a valid adjustment note before you can make a decreasing adjustment, unless the adjustment is for GST of $75 or less." If the note is not held at lodgement, report the adjustment in the first BAS lodged after receiving it. |
| S4 | A New Tax System (Goods and Services Tax) Act 1999, Div 19 (adjustment events), Div 21 (s 21-5 writing off bad debts, s 21-10 recovery), s 29-5 (attribution of GST), s 29-10(3) (input tax credit not attributable until a tax invoice is held), Div 99 (deposits as security), Div 156 (progressive/periodic supplies), https://www.legislation.gov.au/Details/C2004A00446 | 2026-11-08 (table of contents and section headings via extract; operative wording prior knowledge) | primary (legislation) | s 29-5(1): GST on a taxable supply is attributable to the period in which any of the consideration is received or, if earlier, an invoice is issued. s 29-5(2): cash basis — attributable to the extent consideration is received. s 29-10(3): a credit is not attributable until the recipient holds a tax invoice. Div 99: a deposit held as security is not consideration until forfeited or applied. |
| S5 | ATO edited private ruling quoting s 29-5 and GSTR 2000/35, https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg | 2026-11-08 (extract) | primary (regulator, non-binding for others) | "Division 99 … modif[ies] the normal attribution rules contained in section 29-5 where a payment is a deposit"; the deposit "must be a genuine deposit and not a part payment"; "the first instalment paid will trigger attribution for the total consideration (excluding the deposit amount) under section 29-5". |
| S6 | Commissioner of Taxation v Qantas Airways Ltd (FCAFC), https://au.vlex.com/vid/commissioner-of-taxation-v-793810169 | 2026-11-08 (extract) | primary (case law, summary) | GST on an executory contract is payable once, in the period of the first payment or invoice, not in each period of performance. |
| S7 | Goods and Services Tax: Particular Attribution Rules Where Total Consideration Not Known Determination 2017 (F2017L00425) and explanatory statement, https://www.legislation.gov.au/F2017L00425/asmade | 2026-11-08 (extract) | primary (legislative instrument) | Applies only where the total consideration is not known because it depends on future events outside the parties' control; then GST is attributed as consideration is received. Sunsets/repealed from 1 October 2027 (2023 amendment). |
| S8 | ATO, "Choosing an accounting method", https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method | 2026-11-08 (extract) | primary (regulator) | Accruals: "You account for the GST payable on the sales you make in the reporting period in which you issue a tax invoice or receive full or part payment, whichever happens first"; if payment arrives before the invoice "you must include the GST amount in the reporting period in which the payment happened". Cash basis: GST when payment received. |
| S9 | ATO, "Tax invoices" (rounding of GST), https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices | 2026-11-08 (extract) | primary (regulator) | Two accepted rounding rules for multi-supply invoices — **total invoice rule** (add unrounded GST, round once) and **taxable supply rule** (per supply) — nearest cent, 0.5 cent rounds up; supplier and customer need not use the same rule. (Consistent with RQ-0094 S1.) |
| S10 | Stripe Support, "Taxes on Stripe fees for Australia-based businesses", https://support.stripe.com/questions/taxes-on-stripe-fees-for-australia-based-businesses | 2026-11-08 (extract) | primary (vendor) | GST applies to all Stripe fees for AU accounts at the standard rate; it is applied in addition to the fees unless GST-inclusive pricing is agreed; Stripe issues a **monthly tax invoice** for the GST on fees (email "A new tax invoice is now available to view", also in the Dashboard). |
| S11 | Stripe API, "The Balance Transaction object", https://docs.stripe.com/api/balance_transactions/object | 2026-11-08 (extract) | primary (vendor API) | `fee` and `fee_details[]` on each balance transaction; `fee_details.type` ∈ `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax`, `withheld_tax`; `net` = amount − fee; `available_on` = date funds become available. |
| S12 | Stripe Docs, "Payout reconciliation report", https://docs.stripe.com/reports/report-types/payout-reconciliation | 2026-11-08 (extract) | primary (vendor) | Optimised for users on automatic payouts "who model their Stripe balance as a temporary clearing account"; itemises every payment, refund, dispute and fee in each payout. |
| S13 | Stripe AU pricing summaries (Aspire, Wise, Xero AU Stripe pricing pages), e.g. https://www.xero.com/au/pricing-plans/pricing-and-fees-for-stripe/ | 2026-11-08 (extract) | secondary | Standard AU card pricing (1.7% + A$0.30 domestic) is described as GST-inclusive; conflicts with S10's "in addition" wording for non-standard pricing. Used only to show the fee/GST split must be read from Stripe data, not computed. |
| S14 | NAB, "Direct Link — Australian Direct Entry payments and dishonour report" (ABA/Cemtex spec), https://www.nab.com.au/content/dam/nab/documents/guides/banking/nab-direct-link-australian-direct-entry-payments-and-dishonour-report.pdf | 2026-11-08 (extract) | primary (bank spec) | For a self-balanced file "the last line of the detail section must be a balancing entry" (one debit to the funding account for the total of the credits); one type 7 file-total record per file. |
| S15 | Employment Hero, "Chart of Accounts (AU, Xero)", https://help.employmenthero.com/hc/en-au/articles/11373441448847-Chart-of-Accounts-AU-Xero | 2026-11-08 (extract) | secondary (payroll-provider vendor doc) | A pay run may be posted "using a journal entry … you'll need to create a payroll clearing account where the data can be posted. This payroll clearing account can then be used to reconcile against the bank account transactions"; deductions paid directly to a bank account are not a liability and go through payroll clearing. |
| S16 | ATO, "PAYG withholding — how to complete your activity statement labels", https://ato.gov.au/Business/Business-activity-statements-(BAS)/In-detail/Instructions/PAYG-withholding---how-to-complete-your-activity-statement-labels | 2026-11-08 (extract) | primary (regulator) | W1 = total gross payments from which you are usually required to withhold (salary, wages …), reported even if nothing withheld; W2 = amounts withheld from W1 payments. STP reporters may have W1/W2 pre-filled. |
| S17 | ATO, "How Payday Super works", https://www.ato.gov.au/businesses-and-organisations/super-for-employers/payday-super/about-payday-super | 2026-11-08 (extract) | primary (regulator) | From 1 July 2026 SG (12% of qualifying earnings) must reach the fund within 7 business days after each payday. |
| S18 | AASB 15 ¶106–108 and Appendix A, https://standards.aasb.gov.au/node/94 | 2026-11-08 (extract) | primary (accounting standard) | If the customer pays, or an amount is due (unconditional right = receivable), before the entity transfers goods/services, present a **contract liability** when payment is made or due, whichever is earlier. |
| S19 | ATO Community answer on cancelled/incorrect invoices, https://community.ato.gov.au/s/question/a0JMo000004SOI1MAO/p00417032; ATO "Incorrectly charged GST", https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/correcting-gst-errors/incorrectly-charged-gst | 2026-11-08 (extract) | secondary (ATO moderator) / primary | A cancelled, varied or incorrectly stated supply is adjusted by a credit/adjustment note that identifies the original tax invoice number and date; an error (rather than a cancellation) may be corrected on a later BAS or by revising the earlier one, subject to conditions. |
| S20 | Repository: `packages/ledger/src/posting-command.ts` (`amount()`, `checkLine`), `packages/ledger/src/period-matrix.ts` (`SOURCE_TYPES`, `PERIOD_MATRIX`, `storedSourceType`), `packages/db/migrations/0007_ledger_journal.sql` (journal_line), `packages/ledger/src/golden/command.ts` (GoldenMappingError for two tax codes) | 2026-11-08 | source code | `taxAmount` goes through the same `amount()` validator as debit/credit: "plain **non-negative** decimal string" — negatives are refused (INVALID_AMOUNT). A line has exactly one side > 0. `SOURCE_TYPES` is a closed list (15 codes); unknown types → `deny`; stored code must match `^[a-z][a-z0-9_]*$` (dots → underscores). The matrix is mirrored in SQL (migration 0018 `app.source_type_class`). `journal_line.tax_amount numeric(19,4)` has no sign CHECK in SQL; the sign rule lives in the command validator. |
| S21 | Repository: `packages/modules/tax/src/tax-journal.ts`, `packages/modules/tax/templates/au-tax-codes.json` | 2026-11-08 | source code | Tax journal builder emits **one tax line per tax code** (`tax:<code>.collected` / `.paid`), and a document-line `taxAmount` that is "document-signed" (may be negative for a negative line). AU template codes are `GST`, `FRE`, `INP`, `N-T`, `IMP`, `CAP` — there is **no** `GST-CAP`, `GST-ADJ` or `GST-INC` code. |
| S22 | `Docs/solution-design/solution-design.md` §3.2, §3.4, §3.5, §3.6, §3.8, §4.3, §4.5, §6.5 | 2026-11-08 | primary (project design) | §3.2 closed system-role list incl. PAYROLL_CLEARING (a control account); §3.6 "each tax code maps to report boxes … BAS report is a query"; "engine records both [bases] and the report picks one"; §3.8 rows; §4.3 deposit format "posts to customer prepayments; applied to the final invoice"; §4.5 "every posted entry records the rule id and version"; §6.5 rule 2 covers supplier and employee bank details. |
| S23 | RQ-0090, RQ-0094 (this repo) | 2026-11-08 | prior research | RQ-0090: bad-debt adjustments at 1B; Stripe monthly tax invoice; deposit attribution risk. RQ-0094: both rounding rules acceptable; ROUNDING residue implemented as drafted; Q8 left to accountant. |

## Findings — per question

### Q1 — Stripe timing: fee at charge or at payout?

**Question.** Recognise the customer receipt at charge (GP-003) and the Stripe fee at payout (GP-004),
or the fee at charge too?

**Findings.**
- Stripe creates the balance transaction for a charge at charge time, with `fee`, `fee_details[]`
  and `net` already populated; the payout only moves the accumulated net balance (S11). Stripe's own
  reconciliation guidance assumes the Stripe balance is modelled as a **clearing account** (S12).
- If the fee is booked at payout, the clearing account carries the gross until payout, so at any
  month-end the clearing balance ≠ the Stripe balance and fees for charges on the last days of the
  month land in the next month (inference from S11/S12; a cut-off error for both P&L and 1B).
- On accruals the input tax credit is attributable to the period in which consideration is provided
  or an invoice is issued (s 29-10, S4); Stripe takes the fee out of the charge immediately (S11), so
  the fee's consideration is provided at charge.

**Answer.** Recognise **both** the receipt and the fee (with its GST) **at charge**, from the charge's
balance transaction (`fee_details`, S11). The payout entry then only moves the net from clearing to
bank. This keeps clearing equal to the Stripe balance at every date and gives correct month-end
cut-off. Refunds, disputes and Stripe fee adjustments post at their own balance-transaction dates.

**Recommended golden change.**
- GP-003 becomes (2026-11-15):
  | # | Account | Debit | Credit | Tax code | Party |
  |---|---|---:|---:|---|---|
  | 1 | setting:stripe.clearing_account | 1,351.32 | | — | — |
  | 2 | setting:stripe.fee_account | 21.53 | | GST (tax 2.15) | Stripe |
  | 3 | tax:GST.paid | 2.15 | | GST | — |
  | 4 | system:AR_CONTROL | | 1,375.00 | — | Acme |
  | | **Total** | **1,375.00** | **1,375.00** | | |
  BAS: G11 +23.68, 1B +2.15 (accruals) in the charge period; the customer side as GP-002 (cash basis
  G1 +1,375.00, 1A +125.00).
- GP-004 becomes Dr `bank:OPERATING` 1,351.32 / Cr `setting:stripe.clearing_account` 1,351.32, no tax.
- Keep the scenario text "split taken from Stripe's fee breakdown, not recomputed".

**Confidence:** medium (vendor docs primary; the cut-off argument is accounting judgement; the AU
`fee_details` split must be confirmed by a test-mode spike in T-0074/T-0075).

### Q2 — Stripe fee GST evidence; system role vs setting

**Question.** Claim 1B per transaction/payout from Stripe's fee breakdown, or only from the monthly tax
invoice? Are "Stripe clearing" and "Merchant fees" system roles?

**Findings.**
- GST applies to Stripe's AU fees; Stripe issues a **monthly** tax invoice for that GST (S10).
- s 29-10(3): a credit is not attributable until the recipient **holds** a tax invoice (S4); if the
  note/invoice arrives late the claim moves to the first BAS lodged after it is held (same principle as
  S3).
- Stripe's monthly tax invoice for month M is issued early in M+1, i.e. before the BAS for any period
  ending in M is due (monthly BAS 21st of M+1; quarterly 28th of the following month) (inference from
  S10 + BAS due dates; prior knowledge).
- Standard AU pricing is reported as GST-inclusive, but S10 says GST is "in addition" for other price
  arrangements (S13 vs S10) — so the split must be **read from Stripe**, never computed.
- Design §3.2's system-role list is closed and contains neither (S22); §3.2 control accounts are
  AR, AP and payroll clearing only.

**Answer.** Recognise the fee GST **per charge** from Stripe's `fee_details` (Q1), and treat the
monthly Stripe tax invoice as the evidence that must be **held before the BAS is lodged**. Add a
BAS-preparation check (T-0035/T-0075): for every month in the BAS period, a Stripe tax invoice is
recorded and its GST equals Σ per-charge fee GST for that month; any difference is posted as a
one-line adjustment on `setting:stripe.fee_account` with code GST, dated in that month. Stripe
clearing and merchant fees stay **connector settings** (`setting:stripe.clearing_account`,
`setting:stripe.fee_account`), not system roles; the clearing account should be flagged
"reconciliation account" so manual journals to it need approval (§6.5 rule 4 spirit).

**Recommended golden change.** No line change beyond Q1. Replace GP-004's note "requires Stripe's tax
invoice — monthly — as evidence" with "1B claimable once Stripe's monthly tax invoice for the charge
month is held (s 29-10(3)); BAS prep checks Σ fee GST = invoice GST". Keep bindings as settings.

**Confidence:** medium-high (S4/S10 primary; per-charge AU `fee_details` content still to spike).

### Q3 — Bad debt: which GST ledger account; cash basis; bad-debts account binding

**Question.** Design §3.8 debits GST collected; the BAS reports the decreasing adjustment at 1B. Keep
2200 or use 2210? Is the cash-basis ledger entry the same? Bad debts account: setting or system role?

**Findings.**
- Accruals: decreasing adjustment for GST on a written-off (or ≥ 12 months overdue) taxable sale, in
  the period of write-off; reported at **1B**; recovery → increasing adjustment at 1A (S1, S2, S4
  Div 21). No adjustment note is needed for Div 21 (the adjustment is not an adjustment *event* under
  Div 19) — prior knowledge, consistent with S2 not requiring one.
- Cash basis: GST is attributable only to the extent consideration is received (s 29-5(2), S4), so the
  unpaid GST was never reported and no bad-debt adjustment arises (S2 states the rule for non-cash
  basis only).
- Design §3.6: the BAS is a query over tax codes mapped to boxes; the engine records both bases and the
  report picks one (S22). So the BAS label comes from the **tax code**, not from which GST account is
  debited. The ledger records GST collected at invoice date on both bases, so the 125.00 sits in 2200
  on both bases and must be cleared from 2200.

**Answer.** Keep the design: **Dr GST collected (2200)**. Clearing the liability where it was raised
is correct on both bases and keeps 2200 equal to "GST on sales not yet reversed". BAS 1B comes from a
dedicated adjustment tax code mapped to 1B (accruals report) and to nothing (cash report). Cash basis:
same ledger entry, no BAS effect — confirmed. Bad debts account stays a **setting**
(`setting:ar.bad_debt_account`); no new system role.

**Recommended golden change.** GP-007 lines unchanged. Rename tax code `GST-ADJ` to a code that exists
in the AU template: add a template code (proposed `ADJ-BD`, kind `adjustment_decreasing`, rate 0.10,
`collectedRole: GST_COLLECTED`, BAS map accruals → 1B, cash → none) in T-0035/T-0048 and use it on
lines 1–2. Add to Tax/BAS: "no adjustment note required (Div 21); recovery → increasing adjustment 1A
via the reversing code". Keep the partial write-off rule (amount × 1/11, half-up).

**Confidence:** high for the BAS treatment and cash basis (S1, S2, S4); medium for the ledger-account
choice (accounting convention; either account gives the same net BAS amount).

### Q4 — Credit note BAS presentation

**Question.** Net the adjustment note into G1/1A of the credit-note period, or report a decreasing
adjustment at 1B?

**Findings.**
- A credit note for a reduced price/cancelled part is a Div 19 adjustment event (S4, S19).
- An *adjustment* arises only where GST already attributed to an earlier period is now wrong (Div 19,
  S4); when the event occurs in the **same** tax period as the original attribution, the period's GST
  is simply the corrected amount (prior knowledge of Div 19 / GSTR 2000/19; consistent with S1's
  framing).
- For a later period, the ATO accounts-method instruction is: decreasing adjustments at **1B**, G1 is
  not adjusted (S1); third-party sources that say "reduce 1A" conflict with S1 — S1 is trusted.
- A decreasing adjustment needs a valid adjustment note unless the GST is $75 or less (S3).
- Net GST payable is identical either way; only label presentation differs.

**Answer.** Same BAS period as the invoice → net into G1/1A (as drafted). Later BAS period →
decreasing adjustment at **1B** (G1 unchanged), ATO-literal. Implement in the BAS report (T-0035) via
the credit-note tax code's adjustment mapping keyed on "original invoice's BAS period ≠ credit note's
BAS period", with a company option `sales_adjustment_presentation = adjustment_1B (default) |
net_G1_1A` for accountants who prefer netting. Every credit note must be issued as an **adjustment
note** (title "Adjustment note", references original invoice number and date) regardless of the $75
threshold.

**Recommended golden change.** GP-005 lines unchanged (20.00 is the same-period case: invoice
2026-11-05, credit 2026-11-20). Change Tax/BAS to: "Same BAS period as INV-000123 → G1 −220.00, 1A
−20.00. If the credit note fell in a later BAS period: 1B +20.00, G1 unchanged (decreasing adjustment,
Div 19; document is an adjustment note)."

**Confidence:** medium (S1/S3 primary for the labels; the same-period netting rests on prior
knowledge of Div 19 and could not be re-read today).

### Q5 — When is PAYROLL_CLEARING used?

**Question.** §3.8 credits WAGES_PAYABLE yet §3.2 also has PAYROLL_CLEARING. When is it used?

**Findings.**
- Payroll providers that post journals to the ledger use a payroll clearing account to reconcile the
  bank debits they cause (e.g. the provider debits the employer for net pay, or deductions are paid
  directly) (S15).
- §3.2 makes payroll clearing a **control account** (subledger-only postings, S22).
- W1 = gross wages, W2 = PAYG withheld (S16); SG 12% of qualifying earnings, paid within 7 business
  days of payday from 1 July 2026 (S17) — the GP-010 pay date 2027-07-14 is after that date.

**Answer.** Two settlement modes, a payroll-integration setting `net_pay_settlement`:
1. `ledgerforce_batch` (default; GP-010/GP-011): LedgerForce pays net pay by its own ABA batch →
   credit **WAGES_PAYABLE**, cleared by the net-pay batch.
2. `provider_debit`: the provider (or its clearing house) pays employees/funds/ATO and debits the
   employer's bank → the pay-run journal credits **PAYROLL_CLEARING** for every amount the provider
   settles (net pay, and super/PAYG if the provider remits them), and the bank debit, matched in
   reconciliation, posts Dr PAYROLL_CLEARING / Cr bank. Amounts the employer remits itself stay on
   PAYG_WITHHOLDING / SUPER_PAYABLE.

**Recommended golden change.** GP-010 and GP-011 unchanged. Add a Phase-1 Draft **GP-020
"Pay run settled by provider debit"**: Dr wages 10,000.00 (W1) / Dr super expense 1,200.00 /
Cr PAYG_WITHHOLDING 2,000.00 (W2) / Cr SUPER_PAYABLE 1,200.00 / Cr PAYROLL_CLEARING 8,000.00; then
Dr PAYROLL_CLEARING 8,000.00 / Cr bank 8,000.00 on the provider debit date. Note on GP-010: "SG is 12%
of qualifying earnings; Payday Super requires SUPER_PAYABLE for this run to be paid within 7 business
days (by 2027-07-23)".

**Confidence:** medium (provider practice is secondary; design defines the role but not its use).

### Q6 — Payment batch journal granularity

**Question.** One entry per batch with one AP line per bill, per supplier, or one entry per bill?

**Findings.**
- An ABA batch is settled by the bank as one balancing debit for the total of the credits
  (self-balanced file's last detail record; one file total record) (S14), so the bank statement shows
  one debit per batch (for most banks; some list items individually).
- The subledger needs one allocation per bill (design §3.3 allocation table, S22); a control line with
  a party creates the subledger entry (GP-014 note, engine behaviour).

**Answer.** Keep as drafted: **one journal per confirmed batch, one AP_CONTROL line per bill (with
party), one bank credit for the batch total**. The single bank line matches the single statement
debit; per-bill AP lines give exact allocations and remittance detail. A rejected/returned item is a
separate later entry (Dr bank / Cr AP_CONTROL for that bill, reopening it), never an edit.

**Recommended golden change.** No line change to GP-009/GP-011. GP-009 "Batch detail" note: drop
"per supplier … equally valid" and state the rule plus the returned-item treatment. GP-011: one
WAGES_PAYABLE line for the batch total (wages payable has no party subledger) — unchanged.

**Confidence:** high for the bank-statement shape (S14) and medium for the design choice.

### Q7 — GST on prepayments received before an invoice (accruals)

**Question.** Option A (no GST until invoice), Option B (GST on receipt), or always require a deposit
tax invoice and disallow untaxed prepayments for taxable supplies?

**Findings.**
- Accruals: GST is attributable to the period in which any consideration is received or an invoice is
  issued, whichever is first (s 29-5(1), S4, S8). ATO: if payment arrives before the invoice, include
  the GST in the period of the payment (S8).
- Strictly, s 29-5(1) attributes the GST **on the whole supply** to the first payment period, not just
  1/11 of the part paid (S5, S6) — unless (a) the payment is a genuine Div 99 security deposit (S5),
  (b) the supply is a Div 156 progressive/periodic supply whose components are separately paid (S4),
  or (c) the total consideration is not known (F2017L00425, S7, until 1 Oct 2027).
- Cash basis: GST attributable to the extent received (s 29-5(2)) → exactly Option B (S4).
- Option A is therefore **not compliant** on accruals for a part payment of a taxable supply.

**Answer.** Reject Option A for taxable supplies. LedgerForce rules:
1. A prepayment for a known taxable supply is **always invoiced** — the deposit tax invoice path
   (GP-014) — and the receipt then follows GP-002. This is the default and the only path offered in
   the deposit billing format.
2. A receipt that arrives with no invoice (unsolicited prepayment) is posted as Option B: GST
   attributed on receipt at 1/11 of the amount, tax code GST, and the user is prompted to issue the
   deposit/tax invoice; the final invoice nets the GST already reported.
3. Option A (whole amount to liability, no GST) is permitted only when the user classifies the money
   as a **security deposit** (Div 99) or as relating to a GST-free / input-taxed / not-yet-known
   supply, with that classification stored on the receipt.
4. Residual risk for the accountant (cannot be decided in software): where the contract is not a
   Div 156 progressive supply, s 29-5 may attribute the **whole** contract GST to the first payment
   period. LedgerForce documents this on the deposit format and treats deposit + final invoice as
   progressive components (the common practice for milestone billing).

**Recommended golden change.** GP-012: replace Option A with Option B as the golden — Dr bank
3,300.00 / Cr CUSTOMER_PREPAYMENTS 3,000.00 (tax code GST, tax 300.00) / Cr tax:GST.collected 300.00;
BAS accruals and cash G1 +3,300.00, 1A +300.00 at 2026-11-10. Keep Option A text as a labelled
"security deposit (Div 99) variant, no GST". GP-013: journal 13a becomes the GP-015 shape (final
invoice net of prepayment: Dr AR 7,700.00 / Dr CUSTOMER_PREPAYMENTS 3,000.00 (GST, tax 300.00) /
Cr revenue 10,000.00 (GST, tax 1,000.00) / Cr GST collected 700.00; Σ 10,700.00 = 10,700.00).
With Option B the prepayment liability (3,000.00 net) is cleared by 13a's debit and the GST already
reported is not reported again, so **journal 13b is no longer needed** (keep it in the file as
superseded) and INV-000150 opens at 7,700.00. BAS: G1 +7,700.00, 1A +700.00 at 2026-12-15 (project
total 1A 300.00 + 700.00 = 1,000.00).

**Confidence:** high that Option A is non-compliant for part payments (S4, S8); medium for the
whole-supply attribution caveat (S5/S6 extracts, GSTR 2000/35 not read).

### Q8 — Rounding residue with per-document GST

**Question.** Post the per-document residue to ROUNDING or adjust the largest revenue line? Should
per-document rounding be offered for AU tax invoices?

**Findings.**
- Both the total-invoice and taxable-supply rules are accepted by the ATO; half a cent rounds up (S9,
  RQ-0094).
- The GST that must be reported is the GST shown on the tax invoice; both options satisfy that; the
  choice affects only which P&L line carries ≤ a few cents (RQ-0094 finding 4).
- T-0034 already implements the residue → ROUNDING as design §3.4 states (S21, RQ-0094).

**Answer.** Keep **ROUNDING** (design §3.4): it is transparent, auditable (one account to review),
already built, and leaves every revenue line equal to the line net shown/derived on the invoice.
Offer `per_document` only as an **advanced** company setting with the explanation that the default
`per_line` never produces a residue at 10%; ROUNDING should be reviewed at BAS time.

**Recommended golden change.** None to GP-018a/18b lines. Rename tax code `GST-INC` to `GST` with the
document's price mode "tax-inclusive" (the template has no `GST-INC` code, S21): lines read
`GST (tax 0.90)` / `GST (tax 0.91 doc-level)`; add "price mode: inclusive" to the scenario.

**Confidence:** high for ATO acceptability (S9); medium for the policy choice.

### Q9 — Customer refunds in AP payment batches

**Question.** Allow refunds of customer credit balances in ABA payment batches with the customer's
bank details verified like suppliers' (§6.5 rule 2)?

**Findings.**
- ABA direct-entry credits can pay any BSB/account; the bank does not validate account name against
  number (S14; prior knowledge), so a changed bank detail is a classic fraud vector — the reason §6.5
  rule 2 exists for suppliers and employees (S22).
- No regulation prescribes the control; this is an internal-control choice.

**Answer.** Yes — allow them, with these controls: (1) the customer's bank details go through the
same requester ≠ verifier, 24-hour cooling-off and notice-to-previous-contact workflow as suppliers
(extend §6.5 rule 2 to "supplier, employee **and customer refund**" bank details); (2) the batch
creator ≠ releaser rule applies unchanged; (3) amount ≤ the customer's open credit at release;
(4) where the original receipt came through Stripe, default to a Stripe refund to the original card
(GP-006 variant) and require a reason to override.

**Recommended golden change.** None to GP-006 lines. Add to the scenario "bank details verified
(requester ≠ verifier, cooling-off elapsed)" and to Subledger "refund ≤ open credit". Record the §6.5
extension as a decision-log entry (and an ADR-light note for the security reviewer).

**Confidence:** medium (control design; no primary source mandates it).

### Q10 — Deposit invoice account

**Question.** The §4.5 rule credits CUSTOMER_PREPAYMENTS (liability) on a tax invoice — confirm vs
crediting revenue.

**Findings.**
- AASB 15 ¶106: consideration received or due (unconditional) before the goods/services are
  transferred → **contract liability**, presented when payment is made or due (S18).
- Design §4.3: "Deposit / prepayment — posts to customer prepayments; applied to the final invoice"
  (S22).
- GST follows the tax invoice, independent of revenue recognition (S4, S8; as GP-016).

**Answer.** Confirmed: credit **CUSTOMER_PREPAYMENTS** (contract liability), not revenue. Revenue is
recognised by the final invoice (or the revenue schedule), which debits the liability back (GP-015).

**Recommended golden change.** None to GP-014 lines (see F2 for its source type). Add a note: "The
deposit invoice must be marked *Tax invoice*; its GST is reported at issue (accruals) — see Q7".

**Confidence:** high (S18, S22).

### Q11 — Void of an invoice in a later period

**Question.** Should a void be blocked once a receipt/credit is allocated (require a credit note)?

**Findings.**
- A cancelled or incorrectly stated supply that has been invoiced is adjusted by a credit/adjustment
  note that identifies the original tax invoice (S19, S3); a later-period decreasing adjustment needs
  that note (S3).
- A reversal (void) restores balances exactly and is posted in the first open AR period (design §3.3,
  §3.5; `ledger.reversal` class `reversal`, S20).

**Answer.** Allow a void only when **all** hold: (1) open amount = original (no allocations of
receipts, credits or prepayments); (2) the reversal date falls in the **same BAS period** as the
invoice (its GST not yet reported) — otherwise use a credit note, which produces an adjustment note
and the 1B treatment of Q4; (3) the period is not hard-locked. If the invoice was already sent to the
customer, the void still emits a cancellation notice referencing the invoice number and date.

**Recommended golden change.** GP-019 Tax/BAS: replace "if in a later period, G1 −1,375.00 and 1A
−125.00 in the reversal period" with "Void is allowed only in the same BAS period and with no
allocations; a later-period cancellation is a credit note (GP-005 mechanics, 1B decreasing
adjustment)". Plus fix F5 below.

**Confidence:** medium (S19 is an ATO moderator answer; the rule is conservative by design).

## Findings — the five runner fixes (DL-0246)

How the engine models tax (S20, S21):
- `PostingLineInput.taxAmount` is validated by the same `amount()` as debit/credit: a **non-negative**
  plain decimal; a negative value is refused (`INVALID_AMOUNT`). The direction of every line —
  including its tax — is carried by the **side** (exactly one of debit/credit > 0).
- GP-005 (credit note) already follows this: Dr revenue 200.00 with `GST (tax 20.00)` positive.
- A reversal (T-0032) is "every line swapped debit↔credit, same tax codes" — with unsigned tax amounts
  that is a pure side swap; signed tax amounts would require negating them too.
- The BAS query (T-0035) derives the sign from side relative to the tax code's normal side
  (sales code: credit = +, debit = −; purchase code: debit = +, credit = −).
- Mismatch to fix in code (not in the engine): `tax-journal.ts` (T-0034) emits a "document-signed"
  `taxAmount` that can be negative for a negative document line. Its adapter to `PostingLineInput`
  must pass `abs(taxAmount)` with the side already flipped by `line()`. **The engine does not need to
  change.**
- The source-type list is closed and mirrored in SQL (migration 0018); stored codes must match
  `^[a-z][a-z0-9_]*$` (S20).

| # | Entry | Problem | Minimal correction | Engine change? |
|---|---|---|---|---|
| F1 | GP-008 line 3 | One tax line carries two codes "GST / GST-CAP"; the runner refuses a line needing two codes, and the tax builder emits one tax line **per code** (S21). Also `GST-CAP` is not a template code (template: `CAP`). | **Split line 3** into: 3a `tax:GST.paid` (2210) Dr 50.00, code `GST`; 3b `tax:CAP.paid` (2210) Dr 200.00, code `CAP`. Rename line 2's code `GST-CAP` → `CAP (tax 200.00)`. Renumber AP_CONTROL to line 5. Totals unchanged (2,750.00). BAS unchanged: G10 +2,200.00, G11 +550.00, 1B +250.00. Do **not** collapse to CAP only — line 1 is non-capital (G11). | No |
| F2 | GP-014 | Source type `rule:deposit-on-closed-won@3` is not in `SOURCE_TYPES` and cannot be stored (`:`/`@`/`-` fail the regex). Rule provenance is not a source type. | Source type **`ar.invoice`** (the deposit invoice is a tax invoice in the AR series, billing format "Deposit / prepayment", §4.3; period class `ar` is right — it debits AR_CONTROL). Keep `rule_id=deposit-on-closed-won, rule_version=3` as entry provenance (design §4.5). | No for the golden. Follow-up (Rules Studio task, Phase 1): store rule provenance on `journal_entry` (additive columns `rule_id`, `rule_version`) — not a source type. |
| F3 | GP-017 | `revrec.release` not in `SOURCE_TYPES`. | Keep the golden's source type `revrec.release`; **add it to the matrix** as stored `revrec_release`, class **`journal`** (a period-end, non-control adjustment: allowed under AR/AP lock, override under soft close, deny under hard lock), in `period-matrix.ts` **and** a new forward-only migration that replaces `app.source_type_class` — in the Phase-2 revenue-recognition task, with the period-control parity test. | Yes, data-only (matrix row + mirrored SQL function), Phase 2. Not needed for MVP. |
| F4 | GP-015 line 2 | `GST (tax −300.00)` — negative tax refused. | Write **`GST (tax 300.00)`** on the **debit** line (Dr CUSTOMER_PREPAYMENTS 3,000.00). The debit side expresses the reduction, exactly as GP-005. Totals unchanged; BAS net G1 +7,700.00, 1A +700.00 unchanged. | No (adapter in tax-journal → abs value) |
| F5 | GP-019 lines 2–3 | `GST (tax −100.00)`, `GST (tax −25.00)` — negative tax refused. | Write **`GST (tax 100.00)`** and **`GST (tax 25.00)`** on the debit revenue lines (reversal = side swap, tax amounts copied unchanged). Source type `ledger.reversal` already exists (class `reversal`). Still needs the reversal path (T-0032) to run. | No (T-0032 must copy tax amounts unsigned) |

Related naming fixes found while checking F1 (same class of runner failure, latent): GP-007 `GST-ADJ`
and GP-018 `GST-INC` are not template codes (S21) — see Q3 and Q8 recommendations.

## Summary table

| Q | Answer | Golden change | Confidence |
|---|---|---|---|
| Q1 | Receipt **and** fee + fee GST at charge (from the balance transaction); payout moves net only | GP-003 → Dr clearing 1,351.32 / Dr fees 21.53 (GST 2.15) / Dr GST paid 2.15 / Cr AR 1,375.00; GP-004 → Dr bank 1,351.32 / Cr clearing 1,351.32 | medium |
| Q2 | 1B per charge from Stripe `fee_details`; monthly tax invoice must be held before lodgement (s 29-10(3)) + BAS-prep tie-out; clearing/fee accounts are connector settings | GP-004 note text only | medium-high |
| Q3 | Keep Dr GST collected (2200); BAS 1B via a decreasing-adjustment tax code; cash basis: same entry, no BAS effect; bad-debt account = setting | GP-007: code `GST-ADJ` → template code (proposed `ADJ-BD`, accruals 1B); notes | high (BAS) / medium (account) |
| Q4 | Same BAS period → net G1/1A; later period → 1B decreasing adjustment, G1 unchanged; document is an adjustment note | GP-005 Tax/BAS note (lines unchanged) | medium |
| Q5 | PAYROLL_CLEARING only when the provider settles (provider debit); default batch mode uses WAGES_PAYABLE | GP-010/011 unchanged; new GP-020 (provider debit) + Payday Super note | medium |
| Q6 | One entry per batch, one AP line per bill, one bank line per batch; returned item = new entry | GP-009 note only | high / medium |
| Q7 | Option A non-compliant for taxable part payments; deposit tax invoice by default; Option B for uninvoiced receipts; A only for Div 99 security deposits | GP-012 → Option B golden; GP-013 13a → net-of-prepayment shape, 13b superseded | high (A rejected) / medium (whole-supply caveat) |
| Q8 | Keep ROUNDING; per-document only as advanced setting | GP-018 lines unchanged; `GST-INC` → `GST` + price mode inclusive | high (ATO) / medium (policy) |
| Q9 | Yes, with supplier-grade bank-detail verification; prefer Stripe refund to original card | GP-006 notes only; §6.5 rule 2 extended (DL) | medium |
| Q10 | Liability (contract liability, AASB 15 ¶106) confirmed | GP-014 note only | high |
| Q11 | Void only with no allocations **and** in the same BAS period; otherwise credit note | GP-019 Tax/BAS note | medium |

| Fix | Entry | Correction | Engine change |
|---|---|---|---|
| F1 | GP-008 | Split tax line: `tax:GST.paid` 50.00 (GST) + `tax:CAP.paid` 200.00 (CAP); line 2 code `CAP` | No |
| F2 | GP-014 | Source type `ar.invoice`; rule id/version as provenance | No (provenance columns later) |
| F3 | GP-017 | Add `revrec.release` → class `journal` to matrix + SQL mirror (Phase 2) | Yes, data-only |
| F4 | GP-015 | Line 2 `GST (tax 300.00)` on the debit | No (tax adapter: abs) |
| F5 | GP-019 | Lines 2–3 `GST (tax 100.00)` / `GST (tax 25.00)` on the debits | No (T-0032 copies unsigned) |

## Conclusion / decision

1. Answers: Q1 fee at charge; Q2 per-charge 1B from Stripe data + monthly tax invoice held before
   lodgement, settings not roles; Q3 keep Dr GST collected, 1B via an adjustment tax code, cash basis
   no BAS effect, bad-debt account a setting; Q4 same period net G1/1A, later period 1B; Q5
   PAYROLL_CLEARING only for provider-settled pay runs (new GP-020); Q6 keep one entry per batch, one
   AP line per bill; Q7 Option A rejected for taxable supplies — deposit tax invoice by default,
   Option B for uninvoiced receipts, Option A only for Div 99 security deposits; Q8 keep ROUNDING,
   per-document advanced; Q9 yes with supplier-grade verification; Q10 liability confirmed; Q11 void
   only same BAS period and no allocations, else credit note.
2. Runner fixes: F1 split the GP-008 tax line by code (and use `CAP`); F2 GP-014 source type
   `ar.invoice` with rule provenance separate; F3 add `revrec.release` (class `journal`) to the matrix
   + SQL mirror in the Phase-2 task; F4/F5 positive tax amounts on the debit lines. The engine's
   unsigned-tax + side model is correct and stays; the T-0034 tax-journal adapter must pass absolute
   tax amounts.
3. The scribe applies these as **new Draft entries / Draft revisions** in `postings.md` under the
   `golden-posting` skill (file is human-owned; nothing is Approved by this RQ), and appends the Q&A
   answers inline in the *Open questions* table with a link to RQ-0095.
4. Proposed decision-log entry: "DL-NNNN — Golden-posting questions Q1–Q11 answered under product-owner
   delegation (RQ-0095); runner fixes F1–F5; tax amounts are unsigned, direction by side."

## Confidence

Overall **medium**: primary sources (ATO pages, GST Act headings, Stripe API/support, AASB 15, NAB
ABA spec) were read through search-engine extracts because the proxy blocked direct fetches; the
code findings (F1–F5) are **high** (read in the repository). Per-question confidence is stated
above. Hedges built in: Q4 and Q5 are settings, Q1/Q2 require a Stripe test-mode spike in T-0074/
T-0075 confirming AU `fee_details` contains a `tax` component equal to the GST on the fee.

## Follow-ups

- Re-open S1–S10, S16–S19 directly and record retrieval when `ato.gov.au`, `legislation.gov.au` and
  `stripe.com` are reachable; read GSTR 2000/35, GSTR 2000/19, GSTR 2000/2, GSTR 2006/2 ¶94ff for the
  Q7 whole-supply caveat and Q4 same-period rule.
- T-0034: tax-journal → PostingLineInput adapter passes `abs(taxAmount)`; test with a negative line.
- T-0035: tax codes `ADJ-BD` (bad debt, 1B), credit-note adjustment mapping by BAS period, option
  `sales_adjustment_presentation`; BAS-prep check for Stripe monthly tax invoices.
- T-0047: deposit format and Option B prepayment receipt; Div 99 classification flag.
- T-0055 / T-0015: extend bank-detail verification to customer refunds (§6.5 rule 2).
- Phase 1 payroll bridge: GP-020 and `net_pay_settlement` setting.
- Phase 2 rev-rec: `revrec.release` source type + migration mirror.
- Rules Studio: `rule_id` / `rule_version` provenance columns.

**Affects:** Docs/accounting/postings.md (GP-003, -004, -005, -007, -008, -009, -012, -013, -014, -015,
-017, -018, -019, new GP-020), packages/ledger period matrix, packages/modules/tax, design §3.8 notes,
§6.5 rule 2.
