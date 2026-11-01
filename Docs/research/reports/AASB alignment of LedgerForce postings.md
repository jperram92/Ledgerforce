# Close five gaps before Approving golden postings

> Research report, 2026-11-01. Scope: Australian for-profit private-sector SMEs (the design's 1–50 staff
> target user), as at November 2026. Inputs: the four research notes in
> `Docs/research/research_notes/AASB alignment of LedgerForce postings/`, the solution design
> (`Docs/solution-design/solution-design.md`, §1, §3, §4.3–§4.5, §8, §9, §11) and the Draft golden postings
> GP-001…GP-019 with open questions Q1–Q11 (`Docs/accounting/postings.md`, Draft 2026-10-24).
> This report proposes; it changes no golden posting. Every recommendation that touches posting behaviour
> needs the product owner's decision (AGENTS.md §6 human gates `golden_postings` and accounting ADRs).

**Sourcing limitation (read first).** The primary sites (aasb.gov.au, standards.aasb.gov.au, ato.gov.au,
legislation.gov.au and asic.gov.au) could not be fetched from the research environment: the hosts did not
resolve and WebFetch returned `ENOTFOUND`. Several secondary hosts (ifrscommunity.com, bdo.com.au, kpmg.com,
pwc.com.au, fairwork.gov.au) also failed. Every finding therefore rests on **search-result text** (extracts of
the cited pages) and on secondary sources such as Big-4 guidance, IASB staff papers and Treasury guidance;
**no standard, ruling or Act was read in full**. AASB paragraph numbers are taken from the IFRS equivalents
on the AASB convention that Australian standards keep IFRS numbering and add only "Aus" paragraphs, which is
itself **unverified, from prior knowledge**. Claims marked **(unverified)** below had no retrieved source and
must be checked against the primary text before any golden posting is Approved. To verify, allow
`ato.gov.au`, `standards.aasb.gov.au`, `legislation.gov.au` and `asic.gov.au` in the session network settings.

The Draft golden postings are sound double-entry and already follow AASB Interpretation 1031 (revenue,
expenses and assets net of GST; receivables and payables gross), so **no posting is arithmetically wrong, but
five are not yet standards-compliant as drafted**. GP-007 writes bad debts off directly although AASB 9
requires a lifetime expected-credit-loss (ECL) allowance on trade receivables; GP-012 Option A defers GST on a
part-payment that the GST Act attributes on receipt; GP-018's "per line to cents" AU default matches neither
ATO rounding rule for a system that stores four decimals; GP-014 and GP-016 recognise a receivable before the
right to payment is necessarily unconditional; and GP-008 capitalises an asset in the MVP while depreciation
waits for Phase 2. Beyond the postings, the design lacks period-end mechanisms that AASB recognition and
measurement demand of anyone preparing Tier 2 statements: accruals with auto-reversal, prepaid expenses,
depreciation, annual-leave and long-service-leave provisions, and an AASB 108 prior-period-adjustment path.
Payday Super, in force for paydays from 1 July 2026, also breaks the assumption that super payable is
settled quarterly. Most target customers have no statutory duty to prepare AASB statements, but those that do
(shareholder- or ASIC-directed small companies, foreign-controlled subsidiaries, large proprietary companies)
get no size-based relief on recognition and measurement, so the ledger has to support full compliance
even when a tenant opts down. Eleven of the nineteen postings can be Approved essentially as drafted. The rest,
and eight of the eleven open questions, need a product-owner decision, mostly before the MVP pilot closes
its first month.

## Tier 2 trims disclosures, not recognition, so the ledger must do the full job

The framework question decides how strict the posting rules must be. ASIC's test makes a proprietary company
"large" if it meets two of three thresholds (consolidated revenue ≥ $50m, gross assets ≥ $25m, ≥ 100
employees), doubled for years beginning on or after 1 July 2019
([ASIC](https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/are-you-a-large-or-small-proprietary-company/);
[HLB](https://hlb.com.au/large-proprietary-company-thresholds-doubled)). Domestic small proprietary companies
prepare financial reports only when shareholders holding at least 5% of votes direct it (s293) or ASIC
requests it (s294), while foreign-controlled small companies must comply with Part 2M subject to ASIC relief
([ASIC](https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/small-proprietary-companies);
[RSM](https://www.rsm.global/australia/insights/ifrs-news/reporting-obligations-australian-proprietary-companies)).
So most LedgerForce tenants (sole traders, partnerships, trusts and small companies) produce tax-driven
accounts. The minority that must report cannot use self-assessed special purpose statements after AASB 2020-2.
From 1 July 2021 they prepare general purpose statements, at least Tier 2 under **AASB 1060**, and AASB 1060
**reduces disclosures only: recognition and measurement are identical to Tier 1**
([AASB 1060 explanatory statement](https://legislation.gov.au/F2020L00288/asmade/2020-03-23/es/original/word);
[KPMG](https://kpmg.com/au/en/insights/financial-reporting/farewell-spfs-welcome-simplified-disclosures.html)).
The exact AASB 2020-2 scope test (for example, constituting documents amended after 1 July 2020) is
**(unverified)**.

The design consequence is that LedgerForce cannot treat AASB measurement as an optional premium. A missing
ECL allowance, missing depreciation or a missing leave provision does not just reduce disclosure. It produces
statements an auditor would qualify. The pragmatic stance, which the product owner should confirm as a
policy, is that **compliant mechanisms are built in and on by default**. A tenant may record a documented
materiality election to simplify (for example, ECL rates at 0% with specific provisions only), but the
setting itself never claims compliance.

Presentation is also changing under the ledger's feet. **AASB 18** replaces AASB 101 for for-profit entities
for periods beginning on or after **1 January 2027** (1 January 2028 for not-for-profit and superannuation
entities) ([AASB](https://standards.aasb.gov.au/node/4590);
[AASB news](https://aasb.gov.au/news/new-standard-aasb-18-issued/)), so a 30 June filer's first AASB 18 year
starts 1 July 2027. It introduces operating, investing and financing categories with required subtotals
(operating profit; profit before financing and income taxes), management-defined performance measures
reconciled in one note, and stronger aggregation rules. Under the amended AASB 107 the indirect cash-flow
method starts from operating profit, and non-financial entities classify interest paid as financing and
interest and dividends received as investing. The notes attribute that point to AASB staff paper M213 and
secondary summaries but record no URL for it, so treat it as **(unverified)**.
Whether Tier 2 for-profit entities must switch in 2027 is **unresolved**: ED 341 proposes aligning AASB 1060
with AASB 18 only from 1 July 2030, and comments closed 24 August 2026
([AASB ED 341](https://aasb.gov.au/news/open-for-comment-ed-341-updating-aasb-1060-to-align-with-aasb-18-classification-and-presentation-requirements/)).
AASB 2026-4 (August 2026) gives relief to not-for-profit and superannuation entities; its content beyond
snippets is unknown ([BDO](https://www.bdo.com.au/en-au/blogs/corporate-reporting/aasb-18-relief-for-nfps-and-superannuation-entities)).
None of this changes postings. It changes **account metadata**: every account needs a current/non-current
attribute, a cash-flow category, an AASB 18 profit-or-loss category and, for expenses, a nature attribute,
with report layouts held as data-driven templates so the 2027–2030 ambiguity can be resolved without code.

Interpretation 1031 governs how GST appears in all of this. Receivables and payables "shall be stated with
the amount of GST included"; revenue, expenses and assets are net of GST unless the GST is not recoverable.
The **net** GST position sits within receivables or payables, and cash flows are gross, with the recoverable
GST on investing and financing flows classified as operating
([AASB Int 1031](https://standards.aasb.gov.au/node/329);
[Int 1031 compiled May 2019](https://www.aasb.gov.au/admin/file/content105/c9/INT1031_07-04_COMPmay19_01-20.pdf)).
The paragraph numbers (7–11) are **(unverified)**. Two LedgerForce consequences follow. The balance sheet
must **net GST collected (2200) and GST paid (2210) into one line** rather than show two control accounts.
And a non-recoverable-GST tax code must post the GST into the expense or asset line, not into 2210. One open
point: the current Int 1031 compilation is listed as operative only for periods beginning **before 1 January
2027**, which coincides with AASB 18. The researcher reads this as a consequential re-compilation rather than
a withdrawal, but **could not confirm what replaces or amends it**.

## Revenue mechanics pass AASB 15; receivable timing and credit losses do not

AASB 15 excludes amounts collected for third parties such as GST from the transaction price (para 47)
([Disclosure Hub](https://disclosurehub.org/2014/08/18/accounting-for-revenue-determining-the-transaction-price/)),
which GP-001, GP-005, GP-014 and GP-016 already respect. The friction is the receivable. Under para 108 a
receivable is an **unconditional** right, meaning only the passage of time remains before payment is due.
Under para 106, cash or a receivable that arrives before performance creates a contract liability
([IASB TRG ap7](https://www.ifrs.org/content/dam/ifrs/meetings/2014/october/trg-rev/rev-rec/ap7-presentation-contract.pdf)).
Illustrative Example 38 draws the line. For a **cancellable** contract invoiced before the cancellation right
lapses, recognise neither a receivable nor a contract liability. For a **non-cancellable** contract, recognise
both when payment falls due
([Deloitte DART 14.2](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-14-presentation/14-2-contract-liabilities)).
BDO puts it bluntly: the due date drives the timing, not the invoice date
([BDO UK](https://www.uk-tst2.bdo.global/en-gb/insights/business-edge/business-edge-2018/will-advance-billing-hurt-your-balance-sheet)).
GP-014 (deposit on Closed Won) and GP-016 (annual subscription in advance) are therefore compliant only for
non-cancellable terms. The practical fix the notes propose is an inference, not cited practice. Keep the
ledger gross, because GST is attributable when the tax invoice issues anyway, and let the **balance-sheet
report net** unpaid AR against the matching contract liability for invoices flagged cancellable. That keeps
the AR subledger, GST and AASB 15 presentation consistent without a second posting path.

The contract liability itself is measured **ex GST**, which is what GP-014 does (Cr CUSTOMER_PREPAYMENTS
3,000.00, GST 300.00 separately). Option B of GP-012 does the same; Option A overstates the liability by the
GST. AASB 15 permits labels such as "customer deposits" or "deferred revenue" (para 109, **unverified**), so
the 2400 and 2410 names can stay, provided both carry a `contract_liability` reporting class. **Crediting
revenue on a deposit invoice is not compliant**, which settles Q10. The mirror-image gap is the **contract
asset**: professional services are usually satisfied over time (para 35), so work performed but unbilled at
period end needs an unbilled-revenue mechanism. That belongs with milestone and progress billing (§4.3),
not the MVP, where invoicing in arrears for completed work keeps revenue and invoice aligned.

The larger AASB 9 gap is impairment. Paragraph 5.5.15 makes the **simplified, lifetime-ECL approach
mandatory** for trade receivables and contract assets without a significant financing component, and
B5.5.35 permits a **provision matrix** of ageing buckets × historical loss rates adjusted for current and
forward-looking conditions. Omitting the forward-looking adjustment is a common error under 5.5.17(c)
([PwC provision matrix guide](https://www.pwc.ch/en/publications/2020/IFRS%209%20-%20Impairment%20-%20Provision%20Matrix%20-%20Practical%20Guide.pdf);
[MNP](https://www.mnp.ca/-/media/files/mnp/pdf/service/assurance-and-accounting/financial-reporting-library/2019-07-ifrs-9-guide-impairment-of-trade-receivables.pdf)).
Separately, 5.4.4 says an entity **shall** write off a receivable when it has no reasonable expectation of
recovery ([IASB staff paper ap27c](https://cdn.ifrs.org/content/dam/ifrs/meetings/2024/april/iasb/ap27c-feedback-analysis-application-ifrs9-impairment-requirements.pdf)).
GP-007 has the write-off but no allowance, so it complies only where the difference is immaterial. The
minimal design is four pieces:

1. A contra-asset system role `AR_ECL_ALLOWANCE`.
2. The 6300 account renamed "Impairment of receivables (credit losses)". Impairment losses and gains form a
   separate line under AASB 101 para 82(ba)
   ([BDO India](https://www.bdo.in/getmedia/ef670680-3991-4b30-978d-ac0f4306ec00/BDO-India-Newsletter_March-2025.pdf)).
3. An approved period-end job that posts only the **delta** in the allowance (Dr impairment / Cr allowance,
   ex GST).
4. A write-off that debits the allowance rather than expense.

AASB 2024-2 (classification and measurement, from 1 January 2026) and AASB 2025-2 do not appear to touch the
trade-receivable model ([AASB news](https://aasb.gov.au/news/aasb-2024-2-amendments-to-australian-accounting-standards-classification-and-measurement-of-financial-instruments/)).
That conclusion is an inference **(unverified)**.

Two smaller AASB 15 points close the revenue picture. Credit notes mix two different economic events: price
concessions, returns and scope cuts reduce revenue as variable consideration, while a credit issued because
the customer cannot pay is a credit loss. The IASB itself concedes there is no bright line
([IASB PIR ap6a](https://www.ifrs.org/content/dam/ifrs/meetings/2024/april/iasb/ap6a-ifrs15-pir-applying-ifrs-15-with-ifrs-9.pdf);
[RevenueHub](https://www.revenuehub.org/price-concessions/)). So GP-005 needs a **reason code**, with "credit
loss" routed to the write-off posting. Second, the para 63 practical expedient (no financing adjustment when
payment and performance are at most 12 months apart) covers normal terms, annual prepaid subscriptions and
deposits ([BDO Australia](https://www.bdo.com.au/en-au/content/accounting-news/accounting-news-march-2019/contract-with-a-customer);
[Deloitte DART 6.4](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-6-step-3-determine-transaction/6-4-significant-financing-component)).
A preview warning for schedules longer than 12 months suffices. Stripe fees stay an operating expense with
revenue gross: Stripe is a supplier, and consideration payable reduces revenue only when paid to a customer
(para 70). No retrieved source states this directly, so it is **(unverified)**; the KPMG and Deloitte items only
frame the principal-versus-agent test
([KPMG Defining Issues 15-31](https://assets.kpmg.com/content/dam/kpmg/pdf/2015/07/Defining-Issues-O-1507-31.pdf)).
The Stripe clearing balance is a receivable from the processor (a financial asset) and belongs under
receivables, not cash.

## GST law decides four of the open questions outright

Prepayments (Q7) are the clearest case. On the accruals basis, GST is attributable to the **earlier** of the
period in which **any** consideration is received or an invoice is issued (s 29-5)
([legislation.gov.au ES F2017L00425](https://legislation.gov.au/F2017L00425/asmade/2017-04-01/es/original/pdf);
[GSTR 2000/29](https://www.ato.gov.au/law/view/document?DocID=GST%2FGSTR200029%2FNAT%2FATO%2F00001&PiT=99991231235958)).
GSTR 2006/2 states that a part payment under a contract attributes GST in the period it is paid
([GSTR 2006/2](https://www.ato.gov.au/law/view/pdf?DocId=GST%2FGSTR20062%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2006-002c2.pdf&PiT=20130701000001)).
Only a genuine Division 99 **security deposit** defers attribution until it is forfeited or applied
([GSTR 2000/29 extract](https://www.ato.gov.au/law/view/pdf?DocId=GST%2FGSTR200029%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-029c4.pdf&PiT=20151021000001)).
**GP-012 Option A is therefore not defensible** for an ordinary 30% project prepayment. Option B (Cr
CUSTOMER_PREPAYMENTS 3,000.00 / Cr GST 300.00; G1 +3,300.00, 1A +300.00) is the conservative proportional view
and matches the cash-basis result. It carries a sharper caveat: under strict s 29-5 the first receipt could
attribute GST on the **whole** $11,000 supply ($1,000). The only escapes are Division 156 progressive or
periodic supply treatment or the "consideration not ascertainable" regulation, and both are **(unverified)**.
An ATO edited private ruling says exactly that for a part payment: the first instalment triggers attribution
for the total consideration ([ATO EPR](https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg)). It is
persuasive only, not binding. The clean product rule is that **a prepayment against a taxable supply always
gets a GST document**, either a deposit tax invoice (GP-014) or an Option B receipt. The untaxed path stays
for GST-free or input-taxed supplies, flagged Div 99 security deposits, and unidentified customer money, the
last a product-owner call. GP-013 then credits only the remaining GST of 700.00.

Rounding (Q8) is the second case, and it contradicts design §3.4. For an invoice with several taxable sales the
ATO allows the **total invoice rule** (total the GST, round once to the cent, 0.5 up) or the **taxable supply
rule** (compute each line's GST, rounding only to the precision the system stores, then round the total), and
supplier and customer may use different rules ([ATO tax invoices](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices)).
eInvoices default to the total invoice rule ([ATO eInvoicing guide](https://www.ato.gov.au/api/public/content/23dcd77b380e47d4ba7e71d966c56502?v=ff6e9632)).
Applied to GP-018, the three lines of $3.35 GST-inclusive give **0.91** under the total invoice rule (10.05/11 =
0.9136). The taxable supply rule gives the same 0.91, because LedgerForce stores four decimals (0.3045 × 3 =
0.9136). GP-018a's per-line-to-cents result of **0.90 matches neither rule**; it fits the taxable supply wording
only if line GST were stored at two decimals. RQ-0009 had already concluded the AU default should be the total
invoice rule, and this research supports it. On the second half of Q8, posting the residual to ROUNDING (8900,
a P&L account) leaves revenue at 9.15 when Int 1031 says it should be the document total less GST, 9.14.
Adjusting the largest revenue line keeps revenue exact and ROUNDING at zero on sales documents. Either is
immaterial, but the line adjustment is cleaner and lets the tax invoice show the same line nets the ledger
posts.

Bad-debt GST (Q3) is settled by the ATO's adjustment guidance. On the non-cash basis the supplier makes a
**decreasing adjustment of 1/11 of the amount written off**. It falls in the period of write-off or, absent
write-off, when the debt becomes 12 months overdue, and is reported at **1B** (G18 on the worksheet). A recovery
is an **increasing adjustment at 1A**. A written record of the write-off decision is needed, and cash-basis
entities never reported the GST, so they have no adjustment
([ATO how to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments);
[GSTR 2000/2](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20002%2FNAT%2FATO%2F00001)).
The search tool reported the ATO page as updated September 2026; that date is not independently verified.
GP-007's "1B +125.00" is right. Because Int 1031 cares only about the net GST balance, the ledger debit can stay
on GST collected (2200) as §3.8 drafts, which also clears the never-remitted 125.00 for cash-basis tenants.
The BAS label must come from the tax code `GST-ADJ` (accruals → 1B; cash → nothing), not from the GL account.
The engine must also **not** emit a 1A recovery adjustment for a cash-basis tenant, whose later receipt is
simply G1/1A on receipt. Sources conflict on whether an adjustment note is required for bad debts. The better
reading, and prior knowledge, says it is not, because a write-off is not an adjustment event; this remains
**(unverified)**. The AASB 9 write-off date (5.4.4) and the GST trigger can diverge, so the GST adjustment
should become its **own tax-event posting**, decoupled from the accounting write-off. Recipient-side bad debts
(the buyer must make an increasing adjustment after 12 months unpaid) are **(unverified)** and have no golden.

Credit-note presentation (Q4) has two lawful answers. ATO worked examples treat a discount or refund on an
earlier sale as a decreasing adjustment at **1B** with G1 untouched
([ATO how to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments)).
Netting into G1 and 1A is consistent with the law when the reduction falls in the **same** tax period as the
original attribution, because no adjustment arises then **(unverified)**. Common practice nets adjustments in
G1, but the only source for that is non-ATO
([Accounts Unplugged](https://accountsunplugged.com/uploads/3/3/0/6/3306481/ap_issue_7_parts_of_business_activity_statment_bas_explained.pdf)).
The net payable (1A − 1B) is identical either way. GP-005, dated 20 November against a 5 November invoice in
the same quarter, is correctly "G1 −220, 1A −20". A note in a later quarter would be "1B +20". The same logic
applies to GP-019's later-period void, which the draft reports as G1/1A negatives. The decreasing adjustment
also needs a valid **adjustment note** unless the GST is $75 or less
([GSTR 2000/1](https://www.ato.gov.au/law/view/pdf?DocID=GST%2FGSTR20001%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-001c3.pdf&PiT=20101029000001)),
so the credit-note document must meet adjustment-note content requirements.

Stripe (Q2) is a timing rule rather than a ledger rule. Stripe charges GST on all AU fees and issues a
**monthly tax invoice** ([Stripe support](https://support.stripe.com/questions/goods-and-services-tax-gst-for-australia-based-businesses)).
An input tax credit is attributable to a period only if the recipient holds the tax invoice when lodging that
period's return (s 29-10(3)) ([GSTR 2013/1](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20131%2FNAT%2FATO%2F00001)).
GP-004's per-payout ledger split (21.53 to 6200, 2.15 to 2210) is Int 1031-compliant, but the 1B amount
should carry a "pending tax invoice" evidence status. The BAS includes it only once the covering monthly
invoice is held, and the invoice total, which is authoritative, reconciles any cent difference. Relying on
the $75 no-tax-invoice threshold per fee is not recommended. Two details need T-0075 to check the Stripe API.
Whether `balance_transaction.fee_details` exposes the GST separately for AU accounts is **(unverified)**. Stripe
also says GST is added on top of fees unless GST-inclusive pricing is agreed, while GP-004 treats the 23.68
fee as GST-inclusive, so the scenario's fee arithmetic should be confirmed against a real AU payout. That last
point is an observation of this report, not a note finding.

## Assets, payroll and period-end lack the mechanisms AASB measurement assumes

The supplier-side postings are individually correct. GP-008 capitalises the $2,000.00 laptop ex GST, which
is consistent with AASB 116 cost excluding recoverable taxes **(unverified)**, and posts it at G10 +2,200.00.
GP-009 and GP-011 derecognise liabilities on bank confirmation. GP-010 is the standard Australian payroll
journal. The gaps appear afterwards. The design capitalises assets in the MVP but places the fixed-asset
register in Phase 2, and the chart has **no accumulated depreciation or depreciation expense account**. AASB 116
requires depreciation from the date an asset is available for use, with the method reflecting consumption, and
paras 60–62A confirm revenue-based depreciation is presumed inappropriate
([AASB 2014-4](https://www.aasb.gov.au/admin/file/content105/c9/AASB2014-4_08-14.pdf)). Component depreciation
of significant parts (para 43) applies too
([BDO common errors](https://www.bdo.com.au/en-au/content/accounting-news/accounting-news-july-2018/more-common-errors)).
The pilot's first month-end would therefore overstate assets unless a depreciation journal is posted.

Tax concessions must stay out of the ledger. The $20,000 instant asset write-off ran to 30 June 2026
([ATO](https://www.ato.gov.au/about-ato/new-legislation/in-detail/businesses/20000-dollars-instant-asset-write-off)),
and whether it is now permanent from 1 July 2026 is **conflicting**. Accountants Daily says it is law, Aspire
says it passed both houses on 19 August 2026 awaiting Royal Assent, and others say it is not legislated
([Accountants Daily](https://www.accountantsdaily.com.au/tax-compliance/22847-ato-issues-update-on-loss-carry-back-tax-offset-instant-asset-write-off-incentives);
[Aspire](https://aspireapp.com/en-au/blog/instant-asset-write-off-rules)). Either way it is a tax deduction, not
an AASB policy. The general ledger should keep book depreciation only, with any IAWO or small-business-pool
(15%/30%) shadow book held off-ledger. A "capitalisation threshold" setting is legitimate under AASB 116
para 9 aggregation **(unverified)**, but it must be labelled an entity materiality policy.

Payroll changed law under the draft. The SG rate reached its final 12% on 1 July 2025
([ATO](https://www.ato.gov.au/businesses-and-organisations/small-business-newsroom/the-final-sg-rate-increase-is-coming-on-1-july)),
so GP-010's $1,200.00 is right. It is right, though, only because the scenario assumes all gross pay is
qualifying earnings. The engine must import the SG amount from the provider, never compute 12% × gross,
because overtime and salary sacrifice change the base. **Payday Super** took effect for paydays on or after
1 July 2026 ([ATO media centre](https://www.ato.gov.au/media-centre/ato-calls-on-employers-to-prepare-for-payday-super)).
It requires super to reach the fund within **seven business days of payday**, with an extended period for a new
employee's first payday or a new fund, and assesses the new SG charge per qualifying-earnings day
([ATO making super payments](https://www.ato.gov.au/businesses-and-organisations/super-for-employers/payday-super/paying-super-on-payday/making-super-payments);
[ATO new SGC](https://www.ato.gov.au/businesses-and-organisations/super-for-employers/payday-super/missed-or-late-payday-super-payments/the-new-super-guarantee-charge)).
Mercer calls the extended period 20 **business** days while CFS says "20 days"; the conflict is unresolved
([Mercer](https://www.mercersuper.com.au/employers/learn/payday-super-changes)). The Small Business
Superannuation Clearing House reportedly closed on 1 July 2026, from a single secondary source
([Lawpath](https://lawpath.com.au/blog/payday-super)). GP-010's 2027-07-14 pay run falls under these rules, yet
UC-07 creates only a net-pay ABA batch. A **super payment golden**, a per-pay-run due date on SUPER_PAYABLE, an
overdue alert and an SGC/interest expense account are missing. PAYGW keeps its BAS/IAS cycle (W1 gross, W2
withheld) ([ATO PAYG on BAS](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding)).

AASB 119 then requires annual leave to be accrued as service is rendered, undiscounted when short-term. Long
service leave is an other long-term benefit at present value, discounted at high-quality corporate bond rates,
and shorthand techniques are allowed
([NSW Treasury TPG24-23](https://www.treasury.nsw.gov.au/sites/default/files/2024-07/tpg24-23-accounting-for-long-service-leave.pdf);
[BDO on G100 rates](https://www.bdo.com.au/en-au/blogs/corporate-reporting/december-2022/corporate-bond-rates-for-long-service-leave-calculations-available-for-purchase-from-the-g100)).
GP-010 records only the cash pay run, so leave provisions, accrued wages across a period end, and payroll tax and
workers' compensation accruals all need a mechanism. Whether super is payable on leave on-costs under the new
qualifying-earnings rules was not researched.

Period-end accruals are the common thread. AASB 137 separates provisions (uncertain timing or amount) from
accruals, which are goods or services received but not yet invoiced, including employee amounts; accruals sit in
trade and other payables ([IAS 37 text](https://www.faronline.se/dokument/ifrs-english/ias/ias0037_eng/)).
AASB 101 para 27's accrual basis is **(unverified)**. UC-10 lists "accruals" as a close step, but no golden or
mechanism exists. The design already has auto-reversing journals for FX revaluation (§3.7), and the same
**"post and auto-reverse on day 1 of next period"** flag would serve accrued expenses, accrued wages and accrued
super. A prepayment schedule mirrored from deferred revenue would handle prepaid expenses. It would also handle
SaaS implementation costs: under the IFRIC March 2021 agenda decision these are expensed when received, or
spread over the SaaS term when not distinct from access, and the March 2019 decision treats a mere right to
access hosted software as a service, not an intangible
([IFRS IC update March 2021](https://www.ifrs.org/content/ifrs/home/news-and-events/updates/ifric/2021/ifric-update-march-2021.html);
[BDO AU](https://www.bdo.com.au/en-au/content/accounting-news/accounting-news-may-2021/saas-implementation-costs);
[IAS Plus](https://www.iasplus.com/en/meeting-notes/ifrs-ic/2019/march/ias-38)).

Leases are a scope collision. The design lists "IFRS 16 lease accounting" as out of scope. AASB 16, however,
has **no size-based SME exemption**, only the elective short-term (≤ 12 months) and low-value exemptions, the
latter benchmarked at about US$5,000 when new in the Basis for Conclusions (paragraph number **unverified**)
([NSW Treasury AASB 16 guidance](https://www.treasury.nsw.gov.au/documents/guidance-aasb-16-leases-new-lease-standards);
[House of Control](https://www.houseofcontrol.com/blog/ifrs-16-exemptions-short-term-and-low-value)). A
services SMB with an office lease longer than 12 months must recognise a right-of-use asset and lease
liability. The minimum is to default to the exemptions and allow a manual ROU and lease-liability journal path,
whose amortisation can reuse the depreciation engine. Because it changes a design scope boundary, it is a
product-owner decision. AASB 102 inventory was not researched by search; the lower of cost and NRV with FIFO or
weighted average and no LIFO is **(unverified)**, and it is not needed for the services-first MVP.

Two cross-cutting standards fit the immutable ledger without conflict. **AASB 108** restates comparatives
retrospectively "as if a prior period error had never occurred"
([AASB 108](https://www.aasb.gov.au/admin/file/content105/c9/AASB108_08-15.pdf)). That governs presented
statements, not bookkeeping, so design principle D2 (reversal only, hard-locked periods) survives. The proposed
mechanism has four parts:

1. A `prior_period_adjustment` source type, posted in the current open period and tagged with
   `corrects_period_id`.
2. P&L-side lines go to a `PRIOR_PERIOD_ADJUSTMENTS` equity role that stores the original account.
3. A "restated" report mode moves each line back to its corrected period.
4. The "as originally reported" view is kept for the para 49 disclosures.

Paragraphs other than 49 are **(unverified)**, and IAS 8 is renamed "Basis of Preparation of Financial
Statements" from 2027 ([IFRS](https://www.ifrs.org/issued-standards/list-of-standards/ias-8-basis-of-preparation-of-financial-statements/));
the AASB equivalent rename is **(unverified)**. Record retention should default to at least seven years
([ACNC](https://www.acnc.gov.au/tools/topic-guides/record-keeping)). The Corporations Act s286 period comes
via a secondary source, and the ATO's five years is **(unverified)**.

**AASB 121** retranslates foreign-currency monetary items at the closing rate, with differences to profit or
loss ([AASB 121 compiled 2025](https://standards.aasb.gov.au/sites/default/files/2025-03/AASB121_08-15_COMPoct23_01-25.pdf)).
The §3.7 auto-reversing revaluation fits, but it must cover foreign-currency bank, card, loan and accrual
balances, not only AR and AP open items. It must also exclude non-monetary items such as prepayments,
deferred revenue and PP&E (Interpretation 22, **unverified**).

## Verdicts: posting by posting and question by question

The table gives a verdict for each Draft golden posting. "Approve as drafted" means no AASB or GST objection
was found, subject to the unverified items above. "PO" marks a product-owner decision.

| GP | Event | Standards engaged | Verdict | Required change |
|---|---|---|---|---|
| GP-001 | Sales invoice | AASB 15 p47, p38/35; Int 1031 | **Compliant** when invoiced at or after performance | Rule that "bill in advance" invoices use the deferral path; contract asset for unbilled work (later) |
| GP-002 | Bank receipt | AASB 9 settlement | **Compliant** | None |
| GP-003 | Stripe charge to clearing | AASB 9; AASB 15 principal | **Compliant** | Report Stripe clearing under receivables, not cash; see Q1 cut-off |
| GP-004 | Stripe payout, fee, GST on fee | Int 1031; s 29-10(3) | **Compliant (ledger)**; BAS timing gap | 1B gated on holding the monthly Stripe tax invoice; verify the fee/GST split and arithmetic in T-0075 |
| GP-005 | Credit note on paid invoice | AASB 15 variable consideration; Div 19; Int 1031 | **Mechanics compliant**; BAS correct only because it is same-period | Reason codes (price/return/scope vs credit loss, PO); AR credit balance reclassified to liability in the balance sheet; adjustment-note content; Q4 rule for later periods |
| GP-006 | Refund | AASB 15 p55 refund liability | **Compliant** | None |
| GP-007 | Bad-debt write-off + GST | AASB 9 5.5.15, 5.4.4; Div 21 | **Not compliant alone**: no ECL allowance | Supersede: write-off debits `AR_ECL_ALLOWANCE`; period-end ECL delta journal; GST adjustment as separate tax event; recovery golden (PO) |
| GP-008 | Bill with expense + capital asset | AASB 116 cost; Int 1031; G10/G11 | **Compliant at recognition**; downstream gap | Depreciation roles and run; capitalisation-threshold setting; disposal goldens (PO) |
| GP-009 | Supplier payment | AASB 9 derecognition | **Compliant** | None (Q6 is presentation) |
| GP-010 | Payroll journal | AASB 119 short-term; SG 12%; W1/W2 | **Compliant in structure** | Note that SG comes from the provider; super due date per pay run (Payday Super); leave provisions separate (PO) |
| GP-011 | Net pay batch | — | **Compliant** | Add a sibling super-payment golden (PO) |
| GP-012 | Prepayment, no invoice | GST s 29-5, Div 99; AASB 15 p106 | **Option A not compliant** (GST and liability measurement) | Supersede with Option B, or require a deposit tax invoice; Div 99 security-deposit flag (PO, Q7) |
| GP-013 | Prepayment applied | AASB 15; GST | **Compliant under Option B** (final GST 700.00) | Re-draft the worked example for Option B (PO) |
| GP-014 | Deposit invoice | AASB 15 p108, Ex 38; GST invoice attribution | **Compliant if non-cancellable**; liability measured correctly ex GST | `contract_non_cancellable` / `deposit_non_refundable` flag; report-layer netting when cancellable; forfeited-deposit (breakage, B44–B47 **unverified**) golden later (PO) |
| GP-015 | Final invoice net of deposit | AASB 15 | **Compliant** (revenue gross 10,000.00) | None |
| GP-016 | Annual subscription to deferred revenue | AASB 15 over time, p108, p63 | **Compliant for non-cancellable** contracts | Cancellable path (Ex 38 netting); financing warning when > 12 months |
| GP-017 | Deferred revenue release | AASB 15 straight-line stand-ready | **Compliant** | Pro-rate partial months by days (inference) |
| GP-018 | GST rounding | GST s 9-90; ATO invoice rules; Int 1031 | **18a not ATO-aligned at 4 dp storage; 18b compliant** | AU default per-document (total invoice rule); residual to largest revenue line (revenue 9.14), not ROUNDING (PO, accounting ADR amending §3.4) |
| GP-019 | Void by reversal | AASB 108; D2 | **Compliant** for current open period | Later-period BAS per the Q4 rule; prior-period-adjustment flag when the original period was reported and the error is material |

The open questions resolve as follows. Draft answers that the research supports can be confirmed; the rest
need the accountant.

| Q | Draft answer | Research verdict | Basis | PO decision? |
|---|---|---|---|---|
| Q1 Stripe fee timing | Receipt at charge, fee at payout | **Acceptable**, but a cut-off issue: accrue fees incurred and unpaid at month end if material; recognising the fee at charge gives cleaner cut-off | AASB accrual basis; no AASB 15 effect | Yes (choice) |
| Q2 Stripe fee GST / roles | 1B per payout; clearing and fee as connector settings | **Ledger per payout fine; 1B only when the monthly tax invoice is held**; settings rather than roles is unconstrained | s 29-10(3), GSTR 2013/1 | Yes (confirm evidence gating) |
| Q3 Bad-debt GST account | Dr GST collected; BAS 1B via GST-ADJ; cash no BAS | **Confirm draft**; add "no 1A recovery for cash basis"; decouple from the AASB 9 write-off; bad-debt account becomes the impairment setting plus a new allowance role | ATO adjustments; GSTR 2000/2; Int 1031 net presentation | Yes (ECL policy) |
| Q4 Credit-note BAS | Net into G1/1A | **Partly right**: net only when same BAS period as the original; later period → 1B decreasing adjustment, G-labels untouched; make it a company setting | ATO worked examples; Div 19 (same-period point **unverified**) | Yes |
| Q5 PAYROLL_CLEARING | Not used | **Use it** when the provider or a clearing service pays net pay and super; no AASB impact | Presentation only | Yes (low stakes) |
| Q6 Batch granularity | One entry per batch, one AP line per bill | **Confirm draft**; no standards constraint | Presentation/reconciliation | No (agent decision-log) |
| Q7 GST on prepayments | Option A drafted | **Reject Option A**; Option B or mandatory deposit tax invoice; Div 99 flag for genuine security deposits; whole-supply attribution risk where Div 156 does not apply | s 29-5; GSTR 2006/2; GSTR 2000/29 | Yes |
| Q8 Rounding | ROUNDING per design; per-line default | **Reverse both**: per-document is the ATO primary rule and should be the AU default; adjust the largest revenue line | ATO tax invoices; RQ-0009 | Yes (accounting ADR) |
| Q9 Refunds via ABA | Same verification and cooling-off | **Outside this research's scope** (security control, no AASB/GST rule found) | — | Yes (SoD policy) |
| Q10 Deposit account | Liability cleared by final invoice | **Confirm draft**: crediting revenue is not compliant; add the cancellable-contract condition | AASB 15 p106, p108, Ex 38 | Yes (condition) |
| Q11 Void after allocation | Void only when unallocated; else credit note | **Confirm draft**; add a prior-period-adjustment tag for errors in reported, locked periods | AASB 108 | Yes (with AASB 108 ADR) |

## Prioritised design changes for MVP, Phase 1 and later

Priority follows the MVP exit criterion: a pilot tenant closes and hard-locks a month with trial balance tying
to bank and Salesforce. Anything that would misstate that month's balance sheet or BAS sits in MVP. "PO" items
need the product owner (golden posting or accounting ADR per AGENTS.md §6); "Agent" items need only a
decision-log entry or a technical ADR.

| # | Change | Phase | Owner | Driver |
|---|---|---|---|---|
| 1 | Supersede GP-012 with Option B (or mandatory deposit tax invoice); add Div 99 security-deposit flag; re-draft GP-013 | **MVP** | PO | GST s 29-5 (Q7) |
| 2 | Change §3.4 AU default to per-document (total invoice rule), residual to the largest revenue line; supersede GP-018 | **MVP** | PO (accounting ADR) | ATO rounding rules (Q8) |
| 3 | `AR_ECL_ALLOWANCE` role; rename 6300 to impairment; write-off via allowance (supersede GP-007); manual ECL delta journal at close; recovery golden | **MVP** | PO | AASB 9 5.5.15, 5.4.4 |
| 4 | Credit-note reason codes; "credit loss" routes to the write-off posting | **MVP** | PO | AASB 15 vs AASB 9 |
| 5 | Credit-note BAS rule: same-period net vs later-period 1B, as a company setting; adjustment-note document content; apply to GP-019 later-period voids | **MVP** (engine) | PO | ATO adjustments (Q4) |
| 6 | Balance-sheet presentation layer: net 2200+2210 into one GST line; reclassify AR credit balances to a liability; Stripe clearing as receivable; `contract_liability` reporting class for 2400/2410 | **MVP** | Agent (PO review) | Int 1031; AASB 15 p105–109 |
| 7 | Non-recoverable-GST tax code that posts GST into the expense or asset line | **MVP** | Agent (tax pack reviewed by PO) | Int 1031 |
| 8 | Depreciation minimum: `ACCUM_DEPRECIATION` / `DEPRECIATION_EXPENSE` roles, capitalisation-threshold setting, recurring depreciation journal | **MVP** | PO (goldens) | AASB 116; GP-008 capitalises in MVP |
| 9 | Auto-reversing journal flag; `ACCRUED_EXPENSES` and `PREPAYMENTS` roles; accrual and prepayment goldens | **MVP** | PO | AASB 101/108 accrual basis; UC-10 "accruals" |
| 10 | Stripe 1B "pending tax invoice" evidence status and monthly reconciliation; verify the fee GST split in T-0075 | **MVP** | Agent (PO confirms Q2) | s 29-10(3) |
| 11 | `contract_non_cancellable` flag on deposit and subscription templates; report-layer netting when false | **MVP** (deposit format) | PO | AASB 15 Ex 38 (Q10) |
| 12 | Provision-matrix ECL job (ageing × rates, forward-looking override with note, approval) | Phase 1 | PO (method) | AASB 9 B5.5.35 |
| 13 | Payday Super: super-payment golden, SUPER_PAYABLE due date payday + 7 business days (extended for new employee/fund), overdue alert, SGC account; SG amount taken from provider | Phase 1 | PO | Payday Super law from 1 July 2026 |
| 14 | Leave provisions (annual leave; LSL current/non-current at present value), accrued wages, payroll-tax accrual; use PAYROLL_CLEARING per Q5 | Phase 1 | PO | AASB 119 |
| 15 | Fixed-asset register "lite" pulled forward from Phase 2: per-asset depreciation run, disposal goldens (gain, loss, GST on sale) | Phase 1 | PO | AASB 116 |
| 16 | AASB 108 `prior_period_adjustment` source type, equity role, restated-report mode | Phase 1 | PO (accounting ADR) | AASB 108; Q11 |
| 17 | Account attributes: current/non-current, cash-flow category, AASB 18 P&L category, expense nature; data-driven report templates | Phase 1 | Agent (ADR, PO review) | AASB 18 from 1 Jan 2027; ED 341 |
| 18 | FX revaluation covers FX bank, card, loan and accrual balances; excludes non-monetary items | Phase 1 | Agent | AASB 121 |
| 19 | 12-months-overdue bad-debt GST flag/report; recipient-side increasing adjustment golden | Phase 1 | PO | Div 21 (recipient side **unverified**) |
| 20 | Significant-financing warning in preview when payment and performance are more than 12 months apart | Phase 1 | Agent | AASB 15 p63 |
| 21 | Contract asset / unbilled revenue with milestone and progress billing; day-based pro-rating in revenue schedules | Phase 2 | PO | AASB 15 p35, p105–107 |
| 22 | Forfeited-deposit (breakage) golden; principal/agent product-profile flag | Phase 2 | PO | AASB 15 B34+, B44–B47 (**unverified**) |
| 23 | AASB 16 path: default exemptions plus a manual ROU/lease-liability journal and schedule; amend the §1 scope boundary | Phase 2 | PO (scope decision, AGENTS.md §6.4) | AASB 16, no SME exemption |
| 24 | Cash-flow statement (gross; GST on investing/financing as operating), statement of changes in equity with restatement row | Phase 2 | Agent (PO review) | AASB 107; Int 1031 |
| 25 | Tax depreciation shadow book (IAWO, small-business pool) off-ledger; AASB 102 inventory for the "AU trade" template; SaaS-vs-intangible account subtype | Later | PO | Tax law; AASB 102, AASB 138 |

## Conclusion

The research changes where LedgerForce's accounting risk sits. The double-entry tables are not the problem;
the period-end layer is. The draft golden postings describe what happens when a document is posted. AASB 9,
116, 119 and 137 are mostly about what must be posted **when nothing happens**: an allowance that grows as
invoices age, depreciation that accrues each month, leave that accrues with service. An MVP that hard-locks a
pilot month without those journals produces a trial balance that ties to the bank and still misstates the
balance sheet. The single most leveraged change is therefore not any one golden posting but a generic,
approved, auto-reversing or recurring period-end journal capability with system roles behind it. ECL deltas,
depreciation, accruals, prepayments and leave movements all ride on that one engine feature.

The second insight is that GST law, not the AASB, is the stricter master for the MVP. Q7 and Q8 have answers in
the GST Act and ATO rules that override design defaults (§3.8 Option A, §3.4 per-line rounding), and the BAS
label must come from the tax code and the attribution date rather than the GL account. That validates design
§3.6's "BAS is a query" and argues for extending tax codes with evidence status (Stripe invoices held) and
period-relative mappings (same-period vs later-period adjustments). Before any of this is Approved, the
unverified items need checking against primary text once network access to aasb.gov.au, ato.gov.au and
legislation.gov.au is available. They include the Int 1031 post-2027 status, Div 156 whole-supply attribution,
the AASB 15 paragraph wording and the Payday Super extended-period definition.
