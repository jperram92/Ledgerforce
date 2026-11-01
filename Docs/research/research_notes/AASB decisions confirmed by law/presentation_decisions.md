# Australian financial-reporting presentation decisions for LedgerForce report templates (confirmation round, Nov 2026)

> Research date 2026-11-01. Australia, for-profit private-sector SMEs. Builds on
> `Docs/research/research_notes/AASB alignment of LedgerForce postings/reporting_framework.md` (first round).
> **Source caveat:** every page fetch failed: DNS blocked for bdo.com.au, standards.aasb.gov.au and kpmg.com,
> and aasb.gov.au and asic.gov.au were blocked in round 1. Every cited finding comes from WebSearch result text,
> which is a search-engine summary of the page, not a full read. Items marked **unverified** have no retrieved
> source. No paragraph numbers have been verified unless stated.

## Decision 1 — AASB 18 timing for Tier 2 (AASB 1060) for-profit entities

### Takeaway
**CONFIRMED, with medium-high confidence.** ED 341 was **not finalised** as of the latest retrievable material. A pre-ballot draft of the amending standard ("AASB 2026-X") was on the agenda of AASB meeting M223 on 29–30 Oct 2026. I could not confirm that it has been issued or what its final effective date is. Today Tier 2 presentation requirements are AASB 101-based and sit **inside AASB 1060** (plus the paragraphs moved to AASB 108). So a for-profit Tier 2 entity is **not** required to switch to AASB 18 layout for periods beginning 1 Jan 2027. It may early-align once the amendment exists. The ED proposes mandatory alignment from periods beginning on or after **1 July 2030**, with early application permitted.

**Final decision:** keep the proposed default.
- Tier 2 tenants get the AASB 101/AASB 1060 layout by default; Tier 1 for-profit tenants get AASB 18 from periods beginning on or after 1 Jan 2027.
- An AASB 18 layout is available as an opt-in.
- Capture these account attributes now: current/non-current, cash-flow category, AASB 18 P&L category and expense nature.
- Keep the switch-over date as tenant/framework configuration data, not code. The final AASB 2026-X date may differ from 1 July 2030.

### Cited Findings
- ED 341 "Updating AASB 1060 to Align with AASB 18 Classification and Presentation Requirements" was opened for comment on 25 June 2026, with comments due 24 Aug 2026 — [AASB news](https://aasb.gov.au/news/open-for-comment-ed-341-updating-aasb-1060-to-align-with-aasb-18-classification-and-presentation-requirements/); [Pitcher Partners](https://www.pitcher.com.au/insights/proposed-changes-to-tier-2-simplified-disclosure-financial-statements/)
- The ED proposes amendments for annual periods beginning on or after **[1 July 2030]** (square brackets in the ED), with earlier application permitted, and 1 Jan 2028 for NFP private and public sector entities — [ED 341 PDF](https://aasb.gov.au/admin/file/content105/c9/ACCED341_06-26.pdf); [KPMG](https://kpmg.com/au/en/insights/financial-reporting/aasb-1060-alignment-with-aasb-18.html)
- The ED would put AASB 18 application guidance in a new Appendix B to AASB 1060 and would delete all the AASB 101 presentation paragraphs in AASB 1060. It does **not** extend management-defined performance measure (MPM) disclosures to Tier 2 — [KPMG](https://kpmg.com/au/en/insights/financial-reporting/aasb-1060-alignment-with-aasb-18.html); [ED 341](https://aasb.gov.au/admin/file/content105/c9/ACCED341_06-26.pdf)
- KPMG's summary describes a three-year implementation period. Tier 2 entities could adopt at the same time as Tier 1 from 1 Jan 2027, and the changes become mandatory later. This is consistent with early application from 2027 and a mandatory date of 1 July 2030 — [KPMG](https://kpmg.com/au/en/insights/financial-reporting/aasb-1060-alignment-with-aasb-18.html). A search summary presented the two dates as a "conflict"; on reading, they are an early-adoption date and a mandatory date.
- Current position per an AASB staff paper: "AASB 101 requirements were included in AASB 1060". Some AASB 101 paragraphs moved to AASB 108 *Basis of Preparation of Financial Statements*, and Tier 2 entities apply the presentation requirements in both AASB 108 and AASB 1060 — [AASB staff paper M212](https://www.aasb.gov.au/media/lo0naybl/08-3_sp_pirofaasb1060_aasb18_m212_pp.pdf); [AASB staff paper M218](https://www.aasb.gov.au/media/p4ypp0qm/03-1_sp_aligningaasb1060withaasb18_m218_pp.pdf)
- The M218 staff paper states an intention to make an updated AASB 1060 available before 1 Jan 2027 so that entities wishing to early adopt may do so — [AASB staff paper M218](https://www.aasb.gov.au/media/p4ypp0qm/03-1_sp_aligningaasb1060withaasb18_m218_pp.pdf)
- HLB's AASB 18 guide reportedly says AASB 18 "is currently not available for Tier 2 entities to adopt". This is from search-summary text only; I could not read the guide — [HLB guide part 1](https://hlb.com.au/a-guide-to-aasb-18-part-1-an-overview/)
- Pre-ballot draft "AASB 2026-X" amends AASB 1060 "to require a Tier 2 entity to present its financial statements in the same manner as Tier 1 entities" and retains two Tier 2 concessions (not identified in the snippets). It was tabled at M223 on 29–30 Oct 2026 — [Pre-ballot draft M223](https://aasb.gov.au/media/ncejyw5l/03-2_preballotdraft_aasb2026-x_m223_pp.pdf); [AASB October meeting notice](https://www.aasb.gov.au/news/aasb-october-board-meeting-agenda-and-papers-out-now/)
- Tier 2 *disclosure* requirements will be set through a separate due process, with later amendments to AASB 1060 — [Dept of Finance, changes to standards 2025-26](https://www.finance.gov.au/sites/default/files/2026-07/Changes_to_standards_relevant_to_2025-26_financial_statements.pdf)
- AASB 18 applies to for-profit entities (other than superannuation entities) from annual periods beginning on or after 1 Jan 2027, and to NFP and superannuation entities from 1 Jan 2028 — [KPMG AASB 18](https://kpmg.com/au/en/insights/financial-reporting/aasb-18-presentation-disclosure-financial-statements.html); [AASB news](https://aasb.gov.au/news/new-standard-aasb-18-issued/)
- PwC's submission supports 1 July 2030 and asks that related AASB 1060 work be aligned to the same date — [PwC submission](https://www.aasb.gov.au/admin/file/content106/c2/AASB%20-%20PwC%20Submission%20ED%20341_24-08-2026_155524.pdf)

### Inferences
- Between 1 Jan 2027 and the mandatory Tier 2 date, a for-profit Tier 2 entity presents under AASB 1060's embedded AASB 101-style requirements plus AASB 108. Tier 1 entities present under AASB 18. So LedgerForce needs **both** layouts live at the same time from 2027, selected per tenant reporting tier and per period.
- A 30 June year-end Tier 1 company first applies AASB 18 to FY beginning 1 July 2027. Comparatives are restated retrospectively (round 1), so the 2026-27 comparatives must be renderable in AASB 18 layout. That is another reason to capture the attributes now.
- Early adoption by Tier 2 is possible only once the AASB 2026-X amendment is issued. The layout switch therefore needs an "elected early application" flag.
- The 1 July 2030 date may change. Store it as framework configuration with an effective-from date, not as a constant.

### Gaps
- Whether AASB 2026-X was approved or issued at M223, and its final mandatory date. No board-decision summary or Action Alert for M223 was found. M223 is 29–30 Oct 2026, so the summary is probably not yet published.
- The two Tier 2 concessions retained in the pre-ballot draft (snippet only).
- HLB's "not available" statement is unread (fetch blocked).

## Decision 2 — Interpretation 1031 (GST) after 1 January 2027

### Takeaway
**Partly confirmed; status after 1 Jan 2027 not verified.** Interpretation 1031 *Accounting for the Goods and Services Tax (GST)* is still listed on the AASB standards site. The search text gives the current compilation's operative window as periods beginning on or after 1 Jan 2020 "but before 1 January 2027". That indicates a later compilation (or amendment) applies from 1 Jan 2027, most likely AASB 18 consequential reference updates, but I could not retrieve it. I found **no evidence** that Interpretation 1031 was withdrawn or renumbered. I also found no evidence that its GST cash-flow rule was changed. AASB 18 changes AASB 107 (interest and dividends), not the GST rule.

**Final decision:**
- Keep the gross cash-flow rule. Present cash flows gross of GST. Classify the recoverable/payable GST component of investing and financing cash flows as operating.
- Treat "Interpretation 1031 (as amended)" as the reference and re-check the 2027 compilation before Phase-1 cash-flow work.

### Cited Findings
- Compiled Interpretation 1031: cash flows shall be included in the cash flow statement on a gross basis, subject to para 11 and AASB 107. "The GST component of cash flows arising from investing and financing activities which is recoverable from, or payable to, the taxation authority shall be classified as operating cash flows." This is from search-summary text; the paragraph number is not verified — [INT 1031 compiled May 2019](https://www.aasb.gov.au/admin/file/content105/c9/INT1031_07-04_COMPmay19_01-20.pdf); [INT 1031 original](https://aasb.gov.au/admin/file/content105/c9/INT1031_07-04.pdf)
- The AASB standards page lists the current compilation as operative for periods beginning on or after 1 Jan 2020 but before 1 Jan 2027 (search text) — [standards.aasb.gov.au node 329](https://standards.aasb.gov.au/node/329); [INT 1031 May 2019 page](https://standards.aasb.gov.au/int-1031-may-2019)
- AASB 18 makes consequential amendments to "most of the AASB pronouncements" — [AASB news](https://aasb.gov.au/news/new-standard-aasb-18-issued/)
- A draft amending standard (Conceptual Framework / NFP, M218) contains a section "Amendments to Interpretation 1031". Its content was not visible in the snippet — [AASB staff paper M218](https://www.aasb.gov.au/media/qkrnh5lr/05-1_draftamendstandardaasb2026-x_m218_pp.pdf)
- AASB 18 changes AASB 107 on the classification of interest and dividends paid and received — [AASB Research Report 25](https://aasb.gov.au/media/4v4mrlws/rr25_cashflow_09-25.pdf)
- AASB 2026-4 covers application of AASB 18/107 by superannuation and NFP entities and the operating cash-flow reconciliation. Per the search summary, it does not mention Interpretation 1031 — [BDO](https://www.bdo.com.au/en-au/blogs/corporate-reporting/aasb-18-relief-for-nfps-and-superannuation-entities); [KPMG](https://kpmg.com/au/en/insights/financial-reporting/aasb-18-changes-for-super-funds-and-nfp.html)

### Inferences
- The "before 1 January 2027" end date most likely reflects AASB 18 consequential edits, for example replacing references to AASB 101 with AASB 18/AASB 108. Replacing a substantive GST rule without an ED would be unusual, and none was found.
- The cash-flow engine should derive the GST component of investing/financing receipts and payments from the tax lines of those bank transactions and reclassify it to operating ("GST paid/received" or within net operating receipts/payments).
- Under AASB 18 non-financial entities classify interest paid as financing and interest and dividends received as investing (round 1). That is independent of the GST rule and composes with it.

### Gaps
- The text of the 1 Jan 2027 compilation of Interpretation 1031 and the amending standard that created it (fetch blocked).
- The content of "Amendments to Interpretation 1031" in the M218 draft standard.
- Whether the Tier 2 (AASB 1060) cash-flow requirements reference Interpretation 1031 identically (assumed yes; unverified).

## Decision 3 — AASB 108 prior-period errors in an append-only ledger

### Takeaway
**CONFIRMED in principle; medium confidence on the post-2027 paragraph text.**
- From 1 Jan 2027 AASB 108 is retitled *Basis of Preparation of Financial Statements*. It absorbs some former AASB 101 paragraphs and keeps the policy, estimate and error requirements. I found no source saying error correction moved out of AASB 108.
- Retrospective restatement means comparatives and the opening balances of the earliest period presented are restated "as if the error had never occurred". This governs the presented statements, not bookkeeping.
- Established software practice matches the proposal. MYOB guidance says adjustments to a locked, reported period "should be completed in the current period, not in the prior reported period". Other ERPs date the journal in the current period against opening retained earnings.
- Xero's common workaround is to temporarily move the lock date. This back-dates entries and loses audit trail; LedgerForce should not copy it.

**Final decision:** keep the proposal.
- Post an approved `prior_period_adjustment` entry in the current open period to an equity (opening retained earnings / prior-period adjustments) account. Tag it with the corrected period and the original account.
- Add a "restated comparatives" report mode and keep the "as originally reported" view.
- Make the AASB 108 reference version-aware: "Accounting Policies, Changes in Accounting Estimates and Errors" before 2027, "Basis of Preparation of Financial Statements" from 1 Jan 2027.

### Cited Findings
- On issuing AASB 18 (June 2024) the AASB retitled AASB 108 *Basis of Preparation of Financial Statements* (previously *Accounting Policies, Changes in Accounting Estimates and Errors*). Some AASB 101 requirements moved to AASB 108 or AASB 7 "with only limited wording changes" — [Grant Thornton TA 2024-9](https://www.grantthornton.com.au/insights/technical-alerts/ta-2024-9/); [AASB 18 as made, legislation.gov.au](https://www.legislation.gov.au/F2024L00708/asmade/2024-06-20/text/original/epub/OEBPS/document_1/document_1.html); [BDO](https://www.bdo.com.au/en-au/blogs/corporate-reporting/a-new-australian-standard-for-presentation-and-disclosure-in-financial-statements-aasb-18)
- Under the revised AASB 108, in the absence of explicit guidance it "provides a basis for selecting and applying accounting policies" — [AASB 18 as made](https://www.legislation.gov.au/F2024L00708/asmade/2024-06-20/text/original/epub/OEBPS/document_1/document_1.html)
- IAS 8 has the same rename from 1 Jan 2027 (round 1) — [IFRS](https://www.ifrs.org/issued-standards/list-of-standards/ias-8-basis-of-preparation-of-financial-statements/)
- Retrospective restatement "as if a prior period error had never occurred". Comparatives are restated, or the opening balances of the earliest period presented if the error predates it, and para 49 disclosures apply (round 1) — [AASB 108 (2015)](https://www.aasb.gov.au/admin/file/content105/c9/AASB108_08-15.pdf)
- MYOB help: "Should adjustments need to be carried out, they should be completed in the current period, not in the prior reported period." Locked periods can be unlocked, and MYOB's "Transact in Closed Financial Years" permission controls posting into closed years — [MYOB help, locking a period](https://help.myob.com.au/advanced/Docs/Published/UserGuide/Finance_ManagingPeriods_LockingPeriod_Activity.html); [MYOB community](https://myob.lithium.com/discussions/accounting_software_general/unlocking-prior-locked-periods/810986/replies/811198)
- MYOB community: a journal to any P&L account in a prior year changes retained earnings. The moderator recommends confirming with an accountant — [MYOB community](https://myob.lithium.com/discussions/bus-acc/recording-company-income-tax-liability/778640/replies/778799)
- Xero: a lock date blocks entries dated before it. The usual workaround in integration guides is to temporarily move or remove the lock date, post, then restore it. Users criticise re-dating as losing audit trail. These are third-party and forum sources, not official Xero policy — [Rechargly help](https://intercom.help/rechargly/en/articles/15809779-managing-xero-lock-dates-when-reconciling-old-payouts); [Xero product ideas](https://productideas.xero.com/forums/967139-purchase-orders-bills-inventory/suggestions/49175939-lock-dates-allow-old-bills-invoices-to-fall-into?page=1)
- Oracle GL: posting a journal into a prior year adjusts retained earnings for the income/expense effect. Another platform's guidance dates the correction in the current reporting period as an adjustment to opening retained earnings — [Oracle GL docs](https://docs.oracle.com/cd/A60725_05/html/comnls/us/gl/jeperiod.htm); [FirstBit user guide](https://userguide.firstbit.ae/x/mICaEQ)
- A 2025 Tier 2 NFP ED reportedly proposed deleting content moved from AASB 101 to AASB 108 (including going concern) for Tier 2 NFP. It is a proposal and its status is unknown — BDO via [search summary](https://www.bdo.com.au/en-au/blogs/corporate-reporting/aasb-proposes-to-align-the-tier-2-financial-statements-presentation-with-aasb-18)

### Inferences
- The AASB 108 obligation sits on the presented financial statements (restated comparatives, an opening-equity adjustment in the statement of changes in equity, disclosures). The ledger can stay append-only. The current-period equity entry plus the corrected-period tag carries everything the restated view needs.
- Where the error is not material, normal practice is to correct it through current-period P&L. Materiality is the preparer's judgement, so the posting UI should offer both: an ordinary current-period adjustment, or a prior-period adjustment to equity. Choosing the second requires approval.
- LedgerForce's approach is stricter than Xero's: no re-dating into hard-locked periods. It is consistent with MYOB's stated guidance and with ERP practice.
- The golden posting and accounting ADR for `prior_period_adjustment` remain human gates (AGENTS.md §6).

### Gaps
- The post-2027 AASB 108 paragraph numbers for errors (round-1 paras 42/49 refer to the pre-2027 text; renumbering not verified).
- No official Xero help-centre article on prior-period adjustments was found. MYOB evidence is help pages and forum posts.
- The status of the 2025 Tier 2 NFP ED (not relevant to for-profit tenants).

## Decision 4 — Proprietary company thresholds, reporting duties and record-keeping periods

### Takeaway
**CONFIRMED with one live change.**
- Current large proprietary test (s45A, thresholds set by regulation), 2 of 3: consolidated revenue ≥ $50m, consolidated gross assets ≥ $25m, ≥ 100 employees.
- **Proposed change:** a Treasury exposure draft, *Corporations Amendment (Proprietary Company Thresholds) Regulations 2026*, released ~18/19 Oct 2026 with consultation closing 2 Nov 2026. It raises revenue to **$100m** and assets to **$50m**; employees stay at 100. It reportedly applies to financial years beginning on or after **1 July 2027**. It is **not yet law**.
- Small proprietary companies prepare reports only if:
  - ≥ 5% of voting shareholders direct it (s293, within 12 months of year end), or
  - ASIC directs it (s294), or
  - the company is foreign-controlled (s292(2)(b)), subject to relief under ASIC Instrument 2017/204.
- Record keeping: Corporations Act s286 requires **7 years** after the transactions are complete. For tax, ITAA 1936 **s262A** requires **5 years** from when records were prepared or obtained, or from completion of the transactions, whichever is later (s262A(4)), and longer where losses are carried forward.

**Final decision:**
- Hold thresholds as dated configuration rows, so the 2027 change is a data update, not a code change.
- Default retention is ≥ 7 years and never shorter. The ledger never deletes anyway; the setting governs attachments and offboarding.

### Cited Findings
- Current large proprietary test (2 of 3: ≥ $50m revenue, ≥ $25m gross assets, ≥ 100 employees), doubled from 1 July 2019 (round 1) — [ASIC](https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/are-you-a-large-or-small-proprietary-company/); [Nexia](https://nexia.com.au/news/large-proprietary-company-thresholds-doubled/)
- 2026–27 Budget announcement and Treasury consultation: revenue $50m to $100m, assets $25m to $50m, employees unchanged. ED regulations released 19 Oct 2026 (the Treasury hub says 18 Oct); submissions close 2 Nov 2026 — [Treasury consult hub](https://consult.treasury.gov.au/c2026-811281); [Treasurer media release 19 Oct 2026](https://ministers.treasury.gov.au/ministers/jim-chalmers-2022/media-releases/raising-reporting-thresholds-proprietary-companies); [HSF Kramer](https://www.hsfkramer.com/insights/2026-10/small-just-got-bigger-raising-the-threshold-for-large-proprietary-company-status); [Clayton Utz](https://www.claytonutz.com/insights/2026/august/regulatory-reset-large-company-thresholds-to-double-by-2027)
- Proposed start: financial years beginning on or after 1 July 2027. This comes from a law-firm analysis, not the official ED text — [HSF Kramer](https://www.hsfkramer.com/insights/2026-10/small-just-got-bigger-raising-the-threshold-for-large-proprietary-company-status)
- Until the regulations are made, current obligations continue — [Gilbert + Tobin Boardroom Brief](https://www.gtlaw.com.au/insights/boardroom-brief-week-commencing-26-october-2026)
- Companies that fall below the new thresholds would no longer need to lodge audited financial and directors' reports — [CA ANZ](https://www.charteredaccountantsanz.com/news-and-analysis/news/federal-budget-26-27-what-it-means-for-reporting-and-audit)
- The thresholds live in s45A and are set by regulation — [Nexia](https://nexia.com.au/?p=1626)
- s292(2): a small proprietary company prepares the reports only if directed under s293 or s294, or (para (b)) if controlled by a foreign company — [AustLII s292](https://austlii.edu.au/au/legis/cth/consol_act/ca2001172/s292.html)
- s293: shareholders with ≥ 5% of votes may direct preparation and sending of financial and directors' reports, possibly audited. The direction must be signed and given no later than 12 months after the end of the financial year — [AustLII s293](https://www5.austlii.edu.au/au/legis/cth/consol_act/ca2001172/s293.html); [ASIC](https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/small-proprietary-companies/small-proprietary-companies-not-controlled-by-a-foreign-company-and-are-not-disclosing-entities-where-shareholders-request-a-financial-report/)
- s294 "Small proprietary company — ASIC direction" exists. Its operative text was not retrieved — [ASIC](https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/small-proprietary-companies/small-proprietary-companies-not-controlled-by-a-foreign-company-where-asic-requests-a-financial-report)
- Foreign-controlled small proprietary relief: ASIC Corporations (Foreign-Controlled Company Reports) Instrument 2017/204. Directors resolve no earlier than 3 months before the start of the year, and relief is unavailable if the company is part of a large Australian group — [Instrument 2017/204, legislation.gov.au](https://www.legislation.gov.au/F2017L00307/asmade/2017-03-27/text/original/epub/OEBPS/document_1/document_1.html)
- s286: keep written financial records that correctly record and explain transactions and position and would enable true and fair statements to be prepared and audited. Retain them for 7 years after the transactions are complete. This applies to all companies including small proprietary — [ASIC company record keeping](https://asic.gov.au/for-business-and-companies/companies/company-building-blocks/company-record-keeping/); [Sprintlaw](https://sprintlaw.com.au/articles/s286-corporations-act-financial-record-keeping-requirements/)
- ATO legal basis: ITAA 1936 s262A(2) requires a business to keep records that record and explain all transactions. s262A(4) sets **5 years** after the records were prepared or obtained, or after completion of the transactions, whichever is later. Records relating to carried-forward losses are kept until the loss is fully used. The ATO cites TR 96/7 and TR 2018/2 (electronic records) — [ATO trust return instructions](https://www.ato.gov.au/forms-and-instructions/trust-tax-return-2016-instructions/introduction/requirements); [ATO FIF guide 2007 ch. 8](https://www.ato.gov.au/forms-and-instructions/foreign-investment-funds-guide-2007/chapter-8-record-keeping); [ATO fund return 2026](https://www.ato.gov.au/forms-and-instructions/fund-income-tax-return-2026-instructions/general-administration-for-funds)

### Inferences
- Most LedgerForce tenants are small proprietary companies with no Ch 2M financial report duty. The threshold rise would move more mid-size tenants into the "small" category from FY 2027-28 if made. Report templates should not assume an audit or lodgement duty. Store "reporting obligation" per tenant per financial year, derived from configured thresholds plus s293/s294/foreign-control flags.
- Retention policy: max(7 years from transaction completion under s286; 5 years under s262A from the later of preparation or completion; longer while tax losses are carried forward). In practice that means 7 years minimum and indefinite for loss-related records. Given the never-delete directive, the ledger already satisfies this; the policy matters for attachments and tenant exit exports.

### Gaps
- ASIC RG 85 content was not retrieved; its current relevance is unverified.
- The text of s294 was not retrieved.
- The commencement date of the 2026 threshold regulations is from a secondary source, and the final regulations are not made.
- Whether the employee test definition (end-of-half-year counting) is unchanged was not checked.
- The current s262A(4) wording was confirmed only via ATO guidance, not legislation.gov.au. The amendment-period alternative in older guidance ("or end of the period during which the assessment may be amended, whichever is later") is not confirmed as current.
