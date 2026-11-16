# T-0168 independent accounting review: single-supply GST attribution (RQ-0171, ADR-0089, GP-040 to GP-042)

> This is an AI accounting review, not a registered practitioner. It holds no TPB registration
> or professional indemnity insurance and cannot sign or lodge anything. It provides technical
> findings, not professional certification. The owner chose this approach instead of paid
> external review in the preserved source lineage (872c4fa, source DL-0248).

- Scope: RQ-0171, ADR-0089, GP-040/041/042 (Docs/accounting/postings.md lines 997-1100),
  packages/modules/tax/src/single-supply-attribution.db.test.ts (SS-PLAT-135),
  .agent/evidence/T-0168/accounting-self-review.md. Supporting reads: bas.ts (sale/purchase sign
  rules, cash fraction logic), system-roles.ts, GP-020/021/022/029.
- Reviewer: Claude (accountant-reviewer role), a separate sub-agent instance from the builder. This is
  NOT cross-provider review. The builder was also Claude, so this report does not meet the Codex
  cross-review gate.
- Reviewed: branch feat/T-0168-gst-attribution, HEAD 8d97b77 (content commit e40fadb), worktree
  agent-a30730efacaa1de6b. Date 2026-11-16. Read-only; nothing in the worktree was edited.

## Overall: PASS WITH MAJORS (no BLOCKER)

The central legal call (whole GST attributed at the first part-payment on accruals) is sound.
The journal device (coded whole-supply line + uncoded contra + unbilled-GST asset) is also sound.
Every table balances, and the BAS figures follow from bas.ts as written. The majors cover:
- the timing and classification of the cancellation/refund split;
- how variations are timed;
- negative G1 under the default netted presentation;
- unsupported paths that must be refused.

Unverified: legislation.gov.au and ato.gov.au did not resolve from this sandbox (ENOTFOUND). Every
legal statement below comes from web-search extracts of ATO pages, not primary text I read directly.
The text of AASB Interpretation 1031 was not retrieved.

## Re-derivation (independent)

Facts: net price 10,000.00, GST 10% = 1,000.00 (total invoice rule), two receipts of 3,300.00.

- **40a:** Dr bank 3,300 + Dr unbilled 700 + Dr 2400 contra 7,000 = 11,000 = Cr 2400 coded 10,000 + Cr GST 1,000. Balanced.
  - Net 2400 = Cr 3,000, which equals the GST-exclusive cash.
  - Identity: received = prepay balance + whole GST - unbilled (3,300 = 3,000 + 1,000 - 700). Holds.
- **40b:** 3,300 = 3,000 + 300. Balanced.
- **41a:** AR 4,400 + prepay 6,000 = revenue 10,000 + unbilled 400. Balanced.
  - AR = net - prepayBal + unbilledBal holds algebraically for any rounding pattern, provided R6 clears the actual balances.
- **41b and 41c:** Both balance.
  - 41b: 4,950 + 6,000 = 10,000 + 500 + 400 + 50.
  - 41c: 3,850 + 6,000 + 500 + 50 = 10,000 + 400.
  - Total GST is 1,050 / 950, which is 10% of the final price. Correct.
- **42a and 42b:** 42a: 7,700 = 7,700. 42b: 3,300 = 3,300. The net effect of 40a+42a+42b is zero.
- **bas.ts:** A coded line on a liability is treated as a sale. Net = credit - debit, and the tax is signed with net.
  - 40a gives G1 11,000 / 1A 1,000.
  - 42a gives G1 -7,700 / 1A -700.
  - Confirmed against the code (bas.ts lines 164-171, 186-190).
- **Rounding stress (my example):** Balances.
  - Net 9,999.99 gives GST 1,000.00 (999.999 rounded half-up).
  - A receipt of 1,000.00 gives GST part 90.91, unbilled 909.09 and contra 9,090.90.
  - Dr 10,999.99 = Cr 10,999.99.
  - When receipts reach the full price, the per-receipt 1/11 rounding can drive unbilled to -0.01 (see MINOR-2).

## Findings table

| # | Item | Verdict | Severity | Source | Reasoning | Proposed action |
|---|---|---|---|---|---|---|
| 1 | Whole GST attributed at first part-payment, accruals (s 29-5(1)) | PASS | CONFIRMED | s 29-5(1) as recorded in RQ-0134 (primary, read 2026-11-10 by builder); search extracts describing s 29-5 ("tax period in which any of the consideration is received, or earlier invoice") | s 29-5(1) attributes "the GST payable on the supply", not a proportion. A part-payment that is not a Div 99 security deposit is consideration. Div 156 needs both progressive supply and progressive consideration. | None. Keep the `unknown_total` refusal: the Commissioner's not-known-total determination (F2017L00425 family, extract only) attributes only to the extent the consideration is ascertainable. |
| 2 | G1 = 11,000 in the first-receipt period | PASS | CONFIRMED | ATO "Step 1 sales" extract; s 29-5 | On accruals, G1 reports the whole consideration of supplies whose GST is attributable to the period. | None. |
| 3 | Journal device: coded whole-supply line + uncoded contra on 2400, unbilled asset 1230 | PASS | MINOR | bas.ts code read | The BAS ties to coded ledger lines without a new tax code. The contract liability equals net cash. GST payable (1,000) is not netted with the 700. | Add auditability aids (MINOR-1, MINOR-3). |
| 4 | Classification of 1230 (other current asset, outside ECL) | PASS | CONFIRMED (inference) | AASB 101 para 32 (no offset unless required or permitted; prior knowledge, not re-read); AASB 15 paras 105-108 (search extract: receivable = unconditional right) | The 700 is not a receivable: the right to bill depends on performance and the contract is cancellable. It is not recoverable from the ATO unless an adjustment event occurs. It is not a contractual right to cash, so it is not a financial asset and falls outside AASB 9 ECL. It cannot be offset against the ATO GST liability because the counterparty differs. | Note in the disclosure policy that 1230 is assessed for recoverability like a prepayment. |
| 5 | Contract liability measured ex GST (3,000) | PASS | CONFIRMED (inference) | AASB 15 para 106 (extract); consistent with canonical GP-020 | The GST has been accounted to the ATO, so income in advance is carried net. That matches canonical practice. Interpretation 1031 (receivables/payables stated gross) was not retrieved. | None. |
| 6 | 41a: final invoice repeats no GST | PASS | CONFIRMED | s 29-5 (attribution once); ATO "when to make adjustments" extract | The GST was already attributed, and the tax invoice shows the fixed 1,000. | None. |
| 7 | 41b/41c: price change as a Div 19 adjustment, amount 50 | PASS (amount) / UNCLEAR (timing) | MAJOR | ATO "when to make adjustments" extract: on accruals you report an adjustment in the period you become aware of it (s 29-20(1)) | The amounts are right. The timing is not secure. The golden places the adjustment on the final-invoice date. If the variation was agreed in an earlier period, the adjustment belongs to that earlier period. ADR R2 has no variation event. R5 refuses receipts above the original total, which blocks any receipt above it after an agreed increase. | Add a contract-variation document dated at agreement that posts the delta adjustment lines on that date. Until it is built, refuse a final price that differs from the contract unless the variation date equals the invoice date. Allow R5 to use the varied total. |
| 8 | 41c: adjustment-note particulars | PASS | MINOR | ATO adjustment-notes page (extract): note required before a decreasing adjustment unless the GST is $75 or less (s 29-80); s 29-20(3) | Here 50 is under $75, so a note is not required. Issuing one anyway is harmless. | None. |
| 9 | 42a/42b split: cancellation removes only the unbilled 700; refund removes 300 later | FAIL (general rule) / PASS (golden's own dates) | MAJOR | ATO "when to make adjustments" extract (report when aware); ATO concert example (decreasing adjustment of 1/11 of the refund, in the cancellation period) | The scenario says the parties cancel and agree the refund on 2026-12-05. From that date the corrected consideration is nil, so the decreasing adjustment is 1,000 in that period, not 700 then 300 at payment. With both dates in December the BAS total is right. SS-PLAT-135 posts 42a in March and 42b in April and asserts a March net of 1A = 300, which bakes in a deferral of 300. That overpays GST in March and conflicts with the timing rule. After cancellation, the 3,000 left on 2400 is no longer a contract liability, because no performance obligation remains. It is a refund obligation, a payable of 3,300 including GST, which matters if a balance date falls between cancellation and refund. | Supersede GP-042 with GP-043 (journals below). Keep the 700/300 split only for a cancellation where the refund is disputed or undecided. In that case the cash portion stays an open liability, and forfeiture is refused, as R7 already says. |
| 10 | 42b adjustment note | FAIL | MAJOR | s 29-20(3)/s 29-80 extract | The 300 decrease is over $75, so the supplier must hold an adjustment note before claiming it. GP-042 records particulars only on 42a. | Under GP-043 a single adjustment note covers the 1,000. If the split is kept for disputed cases, the refund document needs adjustment-note particulars too. |
| 11 | Negative G1 under default `credit_note_bas = net` | UNCLEAR | MAJOR | ATO BAS instructions (extract): do not report negative figures; decreasing adjustments go to worksheet G18 / 1B | GP-042 can make a month's G1 negative; SS-PLAT-135 asserts April G1 = -3,300. This is pre-existing GP-029 behaviour, but cancellations make it routine. | In T-0204 BAS-prep, present any excess as G18/1B when a netted G1 or 1A would be negative, or refuse and require the `ato_adjustment` setting. Add a golden and a test. |
| 12 | Same-period reversal | PASS | CONFIRMED | ATO extract: no adjustment is needed if the sale is not yet reported | The reversal nets the period to zero. | Reversing 40a in a later period corrects an error ("correcting GST errors"), not a Div 19 adjustment. BAS-prep should label it that way (MINOR-4). |
| 13 | Cash basis uses GP-020/022 | PASS | CONFIRMED | s 29-5(2) (RQ-0134 primary); ATO extract: cash-basis adjustments go in the period of payment | Correct. A cash-basis query over a GP-040a entry counts the entry in full, because it has no subledger item and its fraction is 1 (bas.ts lines 114-121). Agrees with self-review MAJOR-1. | T-0204 basis guard (already carried). |
| 14 | Recipient request for a tax invoice while the contract is open | FAIL (gap) | MAJOR | s 29-70: supplier must issue a tax invoice within 28 days of a request (prior knowledge, not re-read) | R9 refuses the deposit invoice. GP-021 recognises a receivable that AASB 15 does not allow for a cancellable contract. So a registered customer who asks for a tax invoice after paying 3,300 cannot get one. | Allow a tax-invoice document on an open contract that posts nothing when the GST is already attributed. If it is issued before any receipt, post the attribution with no cash (journal J3 below). This also closes R9 / self-review MAJOR-2. |
| 15 | Final price below cash received | FAIL (gap) | MAJOR | inference | 41c with a final price under 6,000 net makes AR negative. No path or refusal is defined. | Refuse until a golden exists (credit/refund path), with a named error in T-0204. |
| 16 | Rounding: GST fixed once by total invoice rule; GP-023a line distribution | PASS | MINOR | ATO tax-invoice rounding (repo extract; not re-verified) | Fixing the GST once removes the residual. RQ-0171 correctly does not rely on GSTR 2000/34. | See MINOR-2. |
| 17 | GP-041 subledger shape vs GP-022 | PASS | MINOR | canonical GP-022 | GP-041 creates an AR item of 4,400 against a tax invoice of 11,000. GP-022 instead posts AR 11,000 and allocates the prepayment. As drafted, the invoice register and the AR original amount differ, and receipts do not show in the AR allocation history. | Prefer a GP-022-consistent shape: Dr AR 11,000 / Cr revenue 10,000 / Cr 1230 400 / Dr 2400 6,000 / Cr AR 6,600 (allocated to the invoice); Dr 17,000 = Cr 17,000. Alternatively, document the difference on the customer statement. |
| 18 | Mixed/composite (GSTR 2001/8), supply concept | UNCLEAR | MINOR | not retrieved | The refusal is conservative. Per search extracts, the brief's "GSTR 2019/1" covers supplies of things other than goods or real property connected with the indirect tax zone (s 9-25(5)). It does not cover single vs progressive supply. | Do not cite GSTR 2019/1 for this point. Use GSTR 2001/8, plus GSTR 2006/9 on supplies (its current status is unverified). |
| 19 | SS-PLAT-135 coverage | PASS | MINOR | test read | 41b/41c are posted alone, with no assertion that the 1230/2400 balances clear. The account is plain, not role-bound (disclosed). The 42a/42b cross-period assertion encodes finding 9. | Assert the clearing balances for 41b/41c. Update the 42 test to the superseding golden. |

### MINOR details

- MINOR-1: A journal shows a gross line and a contra on 2400. Put the contract id on both lines (memo or dimension) and list them in BAS-prep.
- MINOR-2: Per-receipt 1/11 rounding can leave 1230 at -0.01 (a credit) after the last receipt. Rule: the receipt that completes the contract takes the remaining 1230 balance as its GST part. R6 must accept a clearing amount that is either a debit or a credit.
- MINOR-3: R11's per-contract invariant needs a contract key on the 1230/2400 lines. A party key alone fails when one customer has two contracts.
- MINOR-4: BAS-prep should label a reversal across periods as an error correction.

## Proposed superseding journals

### GP-043a: supersedes GP-042a when the refund is agreed at cancellation (2026-12-05, after 40a only)

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:CUSTOMER_PREPAYMENTS (supply cancelled) | 2400 | 10,000.00 | | GST (tax -1,000.00) | Acme |
| 2 | tax:GST.collected | 2200 | 1,000.00 | | GST | - |
| 3 | system:CUSTOMER_PREPAYMENTS (consideration never to be received) | 2400 | | 7,000.00 | - | Acme |
| 4 | system:GST_ATTRIBUTED_UNBILLED | 1230 | | 700.00 | - | Acme |
| 5 | system:AR_CONTROL (customer credit: refund owed, GST-incl.) | 1200 | | 3,300.00 | - | Acme |
| | Total | | 11,000.00 | 11,000.00 | | |

- Balances: 2400 moves Dr 3,000 and clears. 1230 clears. GST collected nets to 0.
- AR subledger: an open credit of 3,300 for Acme.
- Adjustment note: one note for 1,000 (s 29-20(3)).
- BAS (accruals, December): G1 -11,000 / 1A -1,000 when netted, or 1B +1,000 under `ato_adjustment` (subject to finding 11).

### GP-043b: refund on 2026-12-12

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL (refund allocated to the credit) | 1200 | 3,300.00 | | - | Acme |
| 2 | bank:OPERATING | 1100 | | 3,300.00 | - | - |
| | Total | | 3,300.00 | 3,300.00 | | |

There is no BAS effect on accruals. On the cash basis, use the existing GP-020 refund shape.

### J3: tax invoice on an open contract before any receipt (finding 14)

Dr 1230 1,000.00 / Dr 2400 uncoded 10,000.00 / Cr 2400 coded GST 10,000.00 (tax 1,000.00) / Cr GST.collected 1,000.00.
- Totals: Dr 11,000 = Cr 11,000.
- BAS: G1 11,000 / 1A 1,000 (s 29-5(1)(b)).
- Later receipts follow GP-040b exactly. If the invoice is issued after 40a, no journal is posted.

## Sources (retrieved 2026-11-16 as web-search extracts; primary hosts blocked)

- ATO, adjustment notes: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/adjustment-notes
- ATO, when to make adjustments: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/when-to-make-adjustments
- ATO, how to make adjustments (G7/G18, no negative figures): https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments
- ATO, step 1 sales: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/completing-your-bas-for-gst/complete-your-bas/step-1-sales
- ATO, adjustment because of a rebate (aware period, note before claim): https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/gst-and-rebates/making-an-adjustment-because-of-a-rebate
- ATO, esli2026/034 (s 29-20(3) summary): https://www.ato.gov.au/law/view/pdf/esg/esli2026-034.pdf
- ATO, progressive or periodic sales: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/agent-consignment-and-progressive-transactions/gst-agent-consignment-and-progressive-transactions/progressive-or-periodic-sales-and-purchases
- ATO edited private ruling (first instalment / Div 99): https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg
- AASB 15 defined terms and paras 105-108 (extracts): https://standards.aasb.gov.au/node/126 ; https://ifrscommunity.com/knowledge-base/ifrs-15-contract-assets-and-contract-liabilities/
- GSTR 2019/1 subject (extract): https://www.ato.gov.au/law/view/pdf/pbr/gstr2019-cp001.pdf

## Unavailable sources and follow-up

- legislation.gov.au and ato.gov.au returned ENOTFOUND from this sandbox. Read s 29-5, 29-20, 29-70, 29-75, 29-80, 19-10, 19-45 and GSTR 2000/29 directly before T-0204 closes.
- AASB Interpretation 1031 and AASB 101 para 32 were not retrieved.
- Whether the ATO accepts a netted negative G1 in electronic lodgement: confirm in the current BAS instructions.
