# Australian financial-reporting framework and cross-cutting standards (AASB 101/18, 107, 108, 121, 1060)

> Saved by the coordinator from the research stream's returned text (its own file write was refused).
> Research date 2026-11-01; Australia, for-profit private-sector SMEs. Sources caveat: every page fetch
> failed (DNS blocked: asic.gov.au, aasb.gov.au, bdo.com.au, kpmg.com); cited findings come from WebSearch
> result text, not full page reads. Items marked "unverified — from prior knowledge" have no retrieved source.
> Repository context read: RQ-0037 and solution design §1 (D2), §3.2, §3.3, §3.5, §3.7, §11.2.

## Headline answers
- Who must report: most LedgerForce customers (1–50 staff) are small proprietary companies, sole traders, partnerships or trusts with no general purpose statement duty (tax-driven accounts). A minority (small companies directed by shareholders, foreign-controlled subsidiaries, ACNC medium/large charities) need Tier 2 GPFS under AASB 1060. Outside AASB S2.
- AASB 18: 1 Jan 2027 for for-profit; 1 Jan 2028 NFP and super entities. Tier 2 alignment (ED 341) proposed 1 July 2030, not final — whether for-profit Tier 2 must switch in 2027 is unresolved.
- AASB 108 vs reversal-only: no conflict. Restatement is presentation. Post an approved prior-period adjustment journal in the current open period, tagged with the corrected period, to equity; reports rebuild restated comparatives from the tag.
- AASB 121: retranslate foreign-currency monetary items (cash, receivables, payables, loans) at closing rate, difference to P&L. Design's auto-reversing unrealised revaluation plus realised at settlement fits; must cover foreign-currency bank and loan accounts too.

## Q1. Who must prepare financial statements; capabilities for Tier 2 GPFS / AASB 18

### Takeaway
A proprietary company is large if 2 of 3: consolidated revenue ≥ $50m, consolidated gross assets ≥ $25m, ≥ 100 employees; large companies prepare, audit and lodge under Ch 2M. Entities required by legislation to comply with Australian Accounting Standards prepare GPFS (at least Tier 2, AASB 1060) for periods beginning on or after 1 July 2021. AASB 18 replaces AASB 101 for for-profit entities from 1 Jan 2027. LedgerForce needs account-level classification data to produce both AASB 101-style and AASB 18-style statements.

### Cited findings
- Large proprietary test (2 of 3: revenue ≥ $50m, gross assets ≥ $25m, ≥ 100 employees; controlled entities counted together) — ASIC https://asic.gov.au/regulatory-resources/financial-reporting-and-audit/preparers-of-financial-reports/are-you-a-large-or-small-proprietary-company/ (snippet); William Buck https://williambuck.com/news/business/general/proprietary-company-reporting-thresholds-doubled/; HLB https://hlb.com.au/large-proprietary-company-thresholds-doubled
- Thresholds doubled from $25m/$12.5m/50 for years beginning on or after 1 July 2019 — Hall & Wilcox https://hallandwilcox.com.au/large-proprietary-companies-significant-changes-to-financial-reporting-thresholds/; Treasury https://treasury.gov.au/sites/default/files/2019-04/c2019-t342318-a_j_brown.pdf
- Unverified — from prior knowledge: s45A definitions; s292 annual report duty; small company reports only if ≥5% shareholders direct (s293), ASIC directs (s294) or foreign-controlled and not consolidated; ASIC relief (Instrument 2016/785), RG 85.
- AASB 2020-2 removed SPFS for certain for-profit private-sector entities — AASB 2020-2 Key Facts https://www.aasb.gov.au/admin/file/content102/c3/AASB2020-2_KeyFacts_03-20.pdf; Forvis Mazars https://www.forvismazars.com/au/en/insights/latest-news/the-removal-of-special-purpose-reporting
- AASB 1060 replaced RDR; applies with AASB 2020-2 from 1 July 2021; full recognition and measurement, reduced disclosures — KPMG https://kpmg.com/au/en/insights/financial-reporting/farewell-spfs-welcome-simplified-disclosures.html; Grant Thornton TA 2020-06.
- Scope (Part 2M.3 reporters; constituting documents created/amended after 1 July 2020; others may still use SPFS/tax-basis) — unverified, from prior knowledge.
- ITC 56 (Sept 2025) post-implementation review of AASB 1060 and 2020-2 — https://www.aasb.gov.au/news/review-of-aasb-1060-aasb-2020-2/
- ACNC size from 1 July 2022: small < $500k, medium $500k–<$3m, large ≥ $3m — https://www.acnc.gov.au/media/news/upcoming-changes-charity-size-thresholds-are-good-news-for-charities
- AASB 101 paras 54, 60, 66/69, 82, 99 — unverified, from prior knowledge (matches RQ-0037 S3).
- AASB 18 issued June 2024 — https://aasb.gov.au/news/new-standard-aasb-18-issued/
- AASB 18 effective 1 Jan 2027 for-profit; 1 Jan 2028 NFP and super — https://standards.aasb.gov.au/node/4590; BDO; AASB staff paper M221.
- AASB 2026-4 (Aug 2026) relief for NFP and super entities (snippets only) — https://standards.aasb.gov.au/sites/default/files/2026-09/AASB2026-4_08-26.pdf
- ED 341 proposes aligning AASB 1060 with AASB 18 from 1 July 2030 (comments closed 24 Aug 2026; not final) — https://aasb.gov.au/news/open-for-comment-ed-341-updating-aasb-1060-to-align-with-aasb-18-classification-and-presentation-requirements/; KPMG; Pitcher Partners; Deloitte submission.
- AASB 18 categories operating/investing/financing; required subtotals operating profit and profit before financing and income taxes — ICAEW; PwC Viewpoint. Income tax and discontinued categories from prior knowledge.
- MPMs disclosed in one note, reconciled to the closest subtotal — ICAEW.
- Aggregation/disaggregation strengthened; by-function presenters disclose specified expenses by nature — BDO Belgium (list unverified).
- AASB 107 under AASB 18: indirect method starts from operating profit; non-financial entities classify interest paid as financing, interest and dividends received as investing — AASB staff paper M213; IFRS Community; KPMG US.
- IFRS 18 applied retrospectively — IFRS Community.
- AASB S2 Group 3 from 1 July 2027: Ch 2M duty and 2 of 3 (revenue ≥ $50m, assets ≥ $25m, > 100 employees); 2026-27 Budget proposes raising revenue test to $100m (not law) — KPMG guide; HWL Ebsworth; Accounting Times.

### Inferences
- Typical users are outside AASB S2 and Ch 2M; the RQ-0037 MVP set (TB, P&L, balance sheet, GL detail, BAS) is the realistic minimum.
- Tier 2 GPFS additionally need: current/non-current split (account attribute or subtype map); statement of changes in equity incl. a restatement row; cash flow statement; comparatives, restatable; OCI section (low priority).
- AASB 18 additions (30 June year-end: first year begins 1 July 2027): P&L category per account (operating, investing, financing, income tax, discontinued) defaulted from the chart template, overridable; nature attribute on expense accounts; report-line aggregation mapping separate from accounts; MPMs outside the ledger.
- Cash flow: each balance-sheet account needs a cash-flow category (working capital, investing, financing, cash and equivalents, non-cash); indirect method from operating profit; direct method derivable from bank journal lines by contra account.
- Tier 2 timing 2027–2030 ambiguous → report layouts as data-driven templates.

### Gaps
s45A, s292–s294, ASIC relief and RG 85 not verified; AASB 2020-2 scope test not confirmed; Tier 2 AASB 18 timing unresolved; AASB 2026-4 content beyond snippets unknown; no AASB 101/18 paragraph numbers verified.

## Q2. AASB 108 vs reversal-only correction; record keeping

### Takeaway
No conflict: AASB 108 governs presented statements, not bookkeeping. Use an immutable prior-period adjustment posted in the current period to equity, plus restated comparatives from the reporting layer; never edit or back-date into hard-locked periods. Keep records 7 years (s286, ACNC); ATO 5 years unverified.

### Cited findings
- Retrospective restatement of prior-period errors "as if a prior period error had never occurred"; restate comparatives or opening balances of the earliest period presented; para 49 disclosures — AASB 108 PDF https://www.aasb.gov.au/admin/file/content105/c9/AASB108_08-15.pdf; https://standards.aasb.gov.au/node/244; Grant Thornton factsheet.
- Para 42 restatement; estimates prospective (36–38); voluntary policy changes retrospective (22) — unverified, from prior knowledge.
- IAS 8 renamed "Basis of Preparation of Financial Statements" from 1 Jan 2027 — https://www.ifrs.org/issued-standards/list-of-standards/ias-8-basis-of-preparation-of-financial-statements/ (AASB 108 equivalent rename unverified).
- s286: keep records 7 years — Bright Law checklist (secondary).
- ACNC: 7 years — https://www.acnc.gov.au/tools/topic-guides/record-keeping
- ATO 5 years (ITAA 1936 s262A) — unverified, from prior knowledge.
- Design context: immutable posted rows; entry dates in a postable period; hard-locked reopen needs two approvers; retained earnings computed at report time — design §3.2, §3.3, §3.5; RQ-0037.

### Inferences — proposed mechanism (accounting ADR + golden posting, human gates)
1. Source type `prior_period_adjustment` posted in the current open period with `corrects_period_id` (or fiscal year), reason and approver.
2. P&L-side lines to a new equity role `PRIOR_PERIOD_ADJUSTMENTS` (or RETAINED_EARNINGS) storing `original_account_id`; balance-sheet lines to the real accounts. Current-year profit unchanged; RQ-0037 retained-earnings formula holds.
3. "Restated" report mode moves each adjustment line to its corrected period and original account; SOCE shows the cumulative effect on opening retained earnings of the earliest period presented; "as originally reported" view kept (para 49 amounts).
4. Fixes before statements are issued (soft-closed period) are ordinary adjusting entries under override.
5. Estimate changes need nothing special; voluntary policy changes reuse the mechanism.
6. Default retention ≥ 7 years; the ledger never deletes, so the constraint is on attachments and tenant offboarding.

### Gaps
AASB 108 paragraphs other than 49 not verified; post-AASB 18 AASB 108 not checked; s286/ATO via secondary sources; no source on Xero/MYOB prior-period adjustments.

## Q3. AASB 121 period-end FX revaluation

### Takeaway
At each reporting date retranslate foreign-currency monetary items at the closing rate, differences to P&L; non-monetary items at historical cost stay at the transaction rate. Design approach fits (realised at allocation; unrealised at period end auto-reversing day 1) but must also cover foreign-currency bank, card and loan balances.

### Cited findings
- Closing rate = spot rate at end of reporting period; exchange differences paras 27–34 — AASB 121 compiled 2025 https://standards.aasb.gov.au/sites/default/files/2025-03/AASB121_08-15_COMPoct23_01-25.pdf (snippets).
- Unverified — prior knowledge: functional currency paras 8–12; initial spot rate para 21 (average allowed para 22); para 23 monetary at closing, non-monetary at historical/fair-value date rate; para 28 differences to P&L; para 32 net investment to OCI.
- Under AASB 18, FX differences classified with the item that caused them — unverified.
- Design §3.7; FX_REALISED and FX_UNREALISED roles §3.2.

### Inferences
- Period end: for each open foreign-currency monetary balance post `open_txn_amount × closing_rate − carrying_base` against FX_UNREALISED — AR/AP open items via control accounts, foreign-currency bank and card accounts, loans and intercompany, foreign-currency accruals.
- Exclude non-monetary items: prepayments, inventory, PP&E, deferred revenue/advance consideration (Interpretation 22; unverified).
- Auto-reverse day 1; realised difference at settlement to FX_REALISED; open items never edited.
- Realised/unrealised split not required; default both to operating category; optional separate accounts for financing-related FX.
- Single-currency MVP needs none; Phase 1 must ship revaluation before any foreign-currency customer reaches a reporting date.

### Gaps
AASB 121 paras and AASB 18 FX classification not verified from text; tax FX (Div 775) out of scope.
