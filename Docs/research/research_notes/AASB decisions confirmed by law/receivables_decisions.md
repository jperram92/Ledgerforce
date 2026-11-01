# Receivables and revenue decisions: confirmation against AASB 9, AASB 15, AASB 1060 and practice

> Researcher notes, 2026-11-01. Scope: Australian for-profit SMEs (Tier 2 / small proprietary companies). Builds on `Docs/research/research_notes/AASB alignment of LedgerForce postings/revenue_and_receivables.md` (round 1).
> **Source limits:** WebFetch could not reach www.ifrs.org or www.pitcher.com.au; both hosts are outside this session's allowed network domains. aasb.gov.au and legislation.gov.au had already failed in round 1. Every citation below therefore comes from **search-result text**: secondary summaries, firm guidance, vendor and community help pages, and search snippets of the standards' HTML pages. **No verbatim standard text was retrieved.** AASB paragraph numbers follow IFRS numbering (standard AASB convention, **unverified from prior knowledge**).
> Items marked **(unverified)** were not confirmed by a retrieved source.

## D1. ECL allowance on trade receivables (AR_ECL_ALLOWANCE; direct write-off where immaterial)

### Takeaway
**CONFIRMED, with one wording change.**
- AASB 9 requires a lifetime ECL loss allowance on trade receivables (simplified approach, 5.5.15). The provision matrix (B5.5.35) is a permitted practical expedient, not a requirement.
- Write-off under 5.4.4 is mandatory once there is no reasonable expectation of recovery, and it is a derecognition event. Debiting the allowance on write-off is standard allowance-method mechanics. MYOB's own help documents it.
- Direct write-off has a legitimate basis in AASB 108 para 8: accounting policies need not be applied when the effect is immaterial. That relief does not extend to immaterial departures made intentionally to achieve a particular presentation.
- Wording change: treat "direct write-off" as a **materiality election documented by the tenant**, not as an alternative policy. For entities not preparing AASB financial statements it is simply a management or tax basis.
- Xero, MYOB AccountRight and QuickBooks AU have **no native ECL allowance feature**. Practitioners write off bad debts with a credit note coded to a bad-debts expense account. A doubtful-debts provision, where one is kept, is a manual journal (Dr bad/doubtful debts expense / Cr allowance).
- Typical SMB "loss rates" are an ageing matrix or a flat historical bad-debt percentage. There is no regulatory default rate.

### Cited Findings
- AASB 108 / IAS 8 para 8: the accounting policies in the standards need not be applied when the effect of applying them is immaterial. Immaterial departures may not be made intentionally to achieve a particular presentation of financial position, performance or cash flows. "Material" takes its meaning from IAS 1 para 7 (AASB 101). — [IFRS IAS 8 HTML 2024 (search snippet)](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2024/issued/ias8.html); [iasplus IAS 8 summary](https://www.iasplus.com/standard/ias08.htm); [Ind AS 8 equivalent text](https://ca2013.com/?p=24709). The para 8 wording appears in the search snippets. The cross-reference to para 41 (intentional immaterial errors) is **unverified**.
- Practice Statement 2 is **non-mandatory** guidance on materiality judgements for GPFS under AAS. The current compiled version (Dec 2022 amendments) is operative from 1 Jan 2024. The IASB kept it non-mandatory partly to avoid it looking SME-specific. Materiality is both quantitative and qualitative. — [AASB PS 2 Dec 2022](https://standards.aasb.gov.au/ps-2-dec-2022); [AASB IFRS PS2 BC](https://aasb.gov.au/admin/file/content105/c9/IFRSPS2_BC_1-22.pdf); [BDO Australia, AASB issues PS 2](https://www.bdo.com.au/en-au/accounting-news/accounting-news-march-2018/aasb-issues-practice-statement-2)
- AASB 9: the simplified approach is mandatory for trade receivables without a significant financing component (5.5.15). The provision matrix is a practical expedient (B5.5.35). Write-off is required under 5.4.4. — round-1 citations: [IFRS Community impairment](https://ifrscommunity.com/?p=606); [PwC CH provision matrix guide](https://www.pwc.ch/en/publications/2020/IFRS%209%20-%20Impairment%20-%20Provision%20Matrix%20-%20Practical%20Guide.pdf); [IASB ap27c April 2024](https://cdn.ifrs.org/content/dam/ifrs/meetings/2024/april/iasb/ap27c-feedback-analysis-application-ifrs9-impairment-requirements.pdf)
- MYOB (MYOB Advanced help) documents both methods:
  - **Allowance method:** a write-off reduces AR and the allowance by equal amounts, leaving net realisable value unchanged (Dr allowance / Cr AR, no expense).
  - **Direct method:** Dr Balance Write-Off expense / Cr AR.
  — [MYOB Advanced help, Write-Off Methods](https://help.myob.com.au/advanced/Docs/Published/UserGuide/AR__con_Direct_Write-Off_Method.html). I found no AccountRight-specific allowance feature; the AccountRight community points to a "write off bad debts" help article that uses an expense account. — [MYOB community](https://myob.lithium.com/discussions/bus-acc/account-classification/785071) (snippet only)
- Xero has **no write-off button**. The common method is a credit note applied to the invoice and coded to a "Bad and Doubtful Debts" expense account; under accrual GST this also adjusts GST. Xero's product team said it has no near-term plan for a bad-debt write-off feature. Users complain the invoice then shows as "paid". — [Xero Product Ideas, write off as bad debt](https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/45104662-invoices-bills-feature-to-write-off-as-bad-deb); [Poolwerx (Xero-based) bad debt guide](https://evolutionplatform.poolwerx.com.au/support/solutions/articles/13000112168-managing-bad-debt); [Flying Solo](https://www.flyingsolo.com.au/?p=1146166)
- Xero users raise a provision for doubtful debts as a **manual journal**. Xero's product-ideas forum reports that users cannot journal directly to AR control. — [Xero Product Ideas, allow journals to AR/AP](https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/47565272-allow-journals-to-accounts-payable-receivable) (user commentary)
- QuickBooks Online: create a "Bad debts" product or service, then a credit note using that item, applied to the invoice. No official QBO AU page was found confirming the GST effect. — [QuickBooks community](https://quickbooks.intuit.com/learn-support/global/service-items/write-off-bad-debt-in-quickbooks-online/00/383018); [Intuit community article](https://community.intuit.com/articles/1776391-write-off-bad-debt); [QuickBooks AU blog, bad debt deductions](https://quickbooks.intuit.com/au/blog/taxes/tax-deductions-for-bad-debts/)
- Australian teaching example for a GST-inclusive write-off against the allowance: Dr allowance 1,500 / Dr GST 150 / Cr debtor 1,650. The expense was recognised when the allowance was created. — [StudyPulse VCE accounting](https://vce.studypulse.au/learn/ACCT/writing_off_debts)
- ATO GST: a decreasing adjustment is made in the period the debt is written off, **or** once it has been overdue 12 months or more. An increasing adjustment is made on recovery. Forgiving a debt is not writing it off. — [ATO, making adjustments on activity statements](https://ato.gov.au/business/gst/in-detail/managing-gst-in-your-business/reporting,-paying-and-activity-statements/making-adjustments-on-your-activity-statements/?page=3); [ATO, bad debts](https://ato.gov.au/Business/Income-and-deductions-for-business/Deductions/Deductions-for-unrecoverable-income-(bad-debts)) (search summaries)
- SMB loss-rate practice:
  - Ageing matrix with historical rates that rise with age; an illustrative example shows 0.8% current and 48% at over 90 days. — [learnsignal provision matrix](https://www.learnsignal.com/blog/ifrs-9-provision-matrix-trade-receivables/)
  - Flat "historical bad debt rate × total receivables" (for example 3%), offered as an illustration only. — [ScaleSuite (AU) debtor management](https://www.scalesuite.com.au/resources/debtor-management-strategies-for-australian-small-businesses)
  - Many businesses provide for invoices over 90 days old; 30 days past due is a credit-risk indicator. — [QAO, AASB 9 impairment](https://qao.qld.gov.au/blog/financial-instruments-changes-aasb-9-impairment)
  - No authoritative default rate exists.

### Inferences
- **Recommended decision D1 (confirm as proposed, refined):**
  - (a) Add the `AR_ECL_ALLOWANCE` contra-asset.
  - (b) The write-off journal is Dr allowance (ex-GST) + Dr GST payable (decreasing adjustment, when the ATO conditions are met) / Cr AR. Any excess over the allowance goes Dr impairment expense.
  - (c) The period-end allowance adjustment is a manual journal in MVP. Later it becomes a provision-matrix job: ageing buckets × tenant rates, a forward-looking override with a mandatory note, and individually assessed debtors at a specific rate.
  - (d) The tenant setting `ar.impairment_method = allowance | direct_writeoff` defaults to `allowance`. Choosing `direct_writeoff` requires a recorded materiality note, reflecting AASB 108 para 8 and the "not intentional" limit.
  - (e) Recoveries post Dr bank / Cr impairment expense (or reinstate the receivable), with a GST increasing adjustment.
- LedgerForce would be **ahead of Xero, MYOB and QBO**, which only offer an expense-coded credit note. A one-click "write off" that posts a proper journal, with no credit note that pretends the invoice was "paid", is a differentiator. It also avoids the GST mistake of treating a write-off as a credit note (supply adjustment) rather than a bad-debt adjustment. **(inference)**
- Do not model write-offs as credit notes: a credit note is a supply-price adjustment for GST, whereas a bad debt is a Division 21 adjustment. **(inference; GST detail belongs to the GST researcher)**

### Gaps
- B5.5.35 and 5.4.4 verbatim text not retrieved.
- No CPA Australia or CA ANZ guidance on a minimum SME ECL approach was found.
- The steps in MYOB AccountRight's own help article were not retrieved.
- There is no official Xero Central article for bad-debt provisions, only community and vendor sources.

## D2. Deposit and annual-subscription invoices issued before performance

### Takeaway
**CONFIRMED in principle; the practical approach needs a softer framing.**
- AASB 15 (paras 105–108, Example 38) recognises a receivable plus a contract liability only when the right to consideration is unconditional, meaning the contract is non-cancellable and the amount is due.
- For a cancellable contract invoiced in advance, Example 38 Case A recognises **neither** a receivable nor a contract liability before the cancellation right lapses. BDO describes the practical result as net presentation until the due date, or receipt if earlier.
- Mainstream SMB software (Xero, MYOB, QBO) always posts the invoice to AR. Deferred revenue is handled by coding to a liability account, by a manual journal, or by a deposit/prepayment workaround. None of them nets by cancellability.
- So the **ledger should stay gross** (needed for GST attribution and the AR subledger), and Example 38 should be applied as a **reporting-layer net presentation** for not-yet-due advance invoices on cancellable contracts. This matters only where material.

### Cited Findings
- Example 38 (ASC 606 mirror, Deloitte DART): if the invoice is issued before the cancellation date, the entity does not recognise the receivable and contract liability, because it does not yet have an unconditional right to consideration. Case A is the cancellable contract and Case B the non-cancellable one. — [Deloitte DART 14.2](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-14-presentation/14-2-contract-liabilities); [Deloitte DART Appendix B index](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/appendix-b-codification-example-index/appendix-b-codification-example-index)
- IFRS 15 IE: Example 38, "Contract liability and receivable", sits under the Presentation heading starting at IE197. — [IFRS 15 IE HTML (search snippet)](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2025/issued/ifrs15-ie.html); [AASB copy of IFRS 15 IE](https://www.aasb.gov.au/admin/file/content105/c9/IFRS15_IE_1-22.pdf). The individual paragraph numbers (IE198 to IE200) are **unverified**.
- BDO: entities that bill in advance should show the contract liability and the trade receivable **net** until the earlier of the payment due date (when the receivable is recognised) and, by inference, cash receipt. — [BDO UK](https://www.uk-tst2.bdo.global/en-gb/insights/business-edge/business-edge-2018/will-advance-billing-hurt-your-balance-sheet) (snippet truncated; the second trigger is **unverified**)
- Contract assets and liabilities are presented net at contract level (BC317). — [IFRS Community](https://ifrscommunity.com/knowledge-base/ifrs-15-contract-assets-and-contract-liabilities/)
- If both parties can terminate a wholly unperformed contract without penalty, no contract exists (para 12). Billing mechanics cannot force a receivable before the unconditional right arises. — [IFRS Community, identifying a contract](https://ifrscommunity.com/?p=1998); [cpdbox, contract asset vs receivable](https://www.cpdbox.com/036-contract-asset-vs-account-receivable/)
- SMB practice:
  - Xero has no native deferral on invoices; a product-ideas request asks for "ability to recognise future revenue".
  - Common workarounds are a quote/prepayment that is not a tax invoice, then conversion to an invoice; or an invoice coded to an unearned-revenue liability, released by journal.
  - Public-sector procedure (Cambridge) books the invoice gross, then journals income to a balance-sheet liability.
  — [Xero Product Ideas, recognise future revenue](https://productideas.xero.com/forums/967115-invoices-quotes/suggestions/44960389-invoices-ability-to-recognise-future-revenue?page=4); [AccountingWEB, Xero and pro-formas](https://www.accountingweb.co.uk/any-answers/xero-and-pro-formas); [Ruddr, retainers in Xero](https://help.ruddr.io/faqs-and-troubleshooting/ruddr-and-xero/how-do-i-account-for-a-retainer-prepaid-services-with-ruddr-and-xero); [Cambridge finance appendix B](https://www.finance.admin.cam.ac.uk/files/appb.pdf)

### Inferences
- **Recommended decision D2:**
  1. The ledger always posts the advance invoice gross: Dr AR / Cr contract liability (ex-GST) / Cr GST. Never credit revenue.
  2. Each invoice carries the flags `contract_cancellable` / `deposit_refundable`, and a `due_date`.
  3. The balance-sheet report nets AR against the related contract liability for open invoices where (a) the contract is cancellable or the deposit refundable, (b) the invoice is not yet due, and (c) it is unpaid. This uses the reporting class `contract_liability` and a note.
  4. Offer the alternative workflow of a "payment request" (not a tax invoice) for tenants who want neither AR nor GST before receipt. That posts GP-012 Option B on receipt.
  5. Materiality: for most SMBs, invoices issued in advance and not yet due at period end are small. The netting is a presentation refinement, not a ledger correctness issue, so it can ship after MVP behind a report option, default on for AASB-reporting tenants.
- The proposal's "do not recognise until payment" option should be the **payment-request workflow**, not a hidden ledger behaviour. **(inference)**

### Gaps
- Verbatim AASB 15 paras 105–108 and IE197–IE200 were not retrieved.
- No Australian (CPA, CA ANZ or Big-4 AU) source on advance billing or netting was found.
- The interaction of GST attribution on a tax invoice for a cancellable contract with Example 38 is unconfirmed by any Australian source.
- KPMG Insights material was not found in search results.

## D3. Credit-note reason codes: price concession or return versus credit loss

### Takeaway
**CONFIRMED as a distinction; materiality is usually low but not trivial.**
- A price concession, return or variable-consideration adjustment reduces **revenue** (AASB 15 paras 47, 50–54 and 9 as interpreted by Examples 2 and 3).
- A credit loss is an **impairment expense** under AASB 9, presented separately (AASB 101 82(ba)).
- The IASB acknowledges IFRS 15 gives no test to separate an implicit price concession from an impairment, that practice diverges, and in April 2024 it decided to take no further action. So reason codes recording **intent at the time of the credit** are the practical, auditable approach.
- It matters because it changes reported revenue and gross margin, not profit. For most SMBs the amounts are small, but it affects revenue-based KPIs and any revenue-linked covenants or earn-outs.

### Cited Findings
- It may not always be apparent whether an entity has granted an implicit price concession or incurred an impairment loss. A price concession decreases revenue; an impairment loss is an expense. IFRS 15 has no guidance on making the distinction. Some entities apply IFRS 15 (price concession) and others apply IFRS 9 (ECL). The staff recommended no further action on price reductions. — [IASB PIR ap6a, applying IFRS 15 with IFRS 9 (April 2024)](https://www.ifrs.org/content/dam/ifrs/meetings/2024/april/iasb/ap6a-ifrs15-pir-applying-ifrs-15-with-ifrs-9.pdf); [iasplus April 2024 meeting notes](https://www.iasplus.com/en/meeting-notes/iasb/2024/april)
- Examples 2 ("Consideration is not the stated price — implicit price concession") and 3 ("Implicit price concession") address the interaction of para 9 (collectability) with paras 47 and 52. — same IASB paper; [IFRS 15 IE (snippet)](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2025/issued/ifrs15-ie.html). The example conclusions were not retrieved.
- Earlier IASB staff analysis on collectability, and practitioner commentary on price concessions. — [IASB ap7a collectability 2013](https://www.ifrs.org/content/dam/ifrs/meetings/2013/july/iasb/revenue-recognition/ap7a-collectability.pdf); [RevenueHub price concessions](https://www.revenuehub.org/price-concessions/)
- SMB software practice: Xero and QBO users record bad debts as credit notes coded to a bad-debts **expense** account rather than revenue, which in effect is a reason distinction made by account coding. — [Poolwerx/Xero guide](https://evolutionplatform.poolwerx.com.au/support/solutions/articles/13000112168-managing-bad-debt); [QuickBooks community](https://quickbooks.intuit.com/learn-support/global/service-items/write-off-bad-debt-in-quickbooks-online/00/383018)

### Inferences
- **Recommended decision D3:** a mandatory `reason_code` on credit notes from an enumerated list, routed as follows:
  - `price_adjustment`, `return`, `scope_reduction`, `billing_error` → reduce revenue (GP-005).
  - `goodwill_concession` → reduce revenue.
  - `credit_loss` → not allowed as a credit note. Route it to the write-off flow (D1), because it is an AASB 9 derecognition and an ATO Division 21 bad-debt adjustment rather than a GST supply adjustment.
- Policy text for tenants: a concession granted for **commercial** reasons (dispute, service quality, retention) is revenue reduction even when the customer is slow-paying. Use credit loss only when the reason is the customer's **inability to pay**. This mirrors the intent-based divergence the IASB acknowledges.
- Implicit price concessions expected at inception (habitual acceptance of less) are out of MVP scope. Flag them for the accountant.

### Gaps
- The facts and conclusions of Examples 2 and 3 were not retrieved verbatim.
- No Australian SME-specific guidance on reason coding was found. The materiality statement is an inference.

## D4. Presentation: contract liabilities, AR credit balances, Stripe clearing

### Takeaway
- **Contract liabilities:** CONFIRMED. Customer prepayments and deferred revenue are contract liabilities (paras 105–106); alternative captions such as "deferred revenue" or "customer deposits" are allowed (para 109, **unverified**). Aggregate them under a `contract_liability` reporting class.
- **AR credit balances:** CONFIRMED with nuance. A customer's credit balance cannot be netted against other customers' debit balances: offsetting requires an enforceable right and an intention to settle net (AASB 132 para 42). At reporting date, reclassify customer-level net credit balances to liabilities (contract liability, or refund liability / payable for overpayments). Netting **within** the same customer is acceptable where the legal right exists.
- **Stripe clearing:** PARTIALLY REFUTED as a hard rule. Practice is mixed.
  - Xero practice books Stripe as a bank-type "Other" clearing account.
  - US filers often classify card settlements due in under 5 days as cash equivalents.
  - Bookkeeping guides in the accrual view use a "Stripe receivable" account.
  - AASB 107 does not decide it by name. Funds held by Stripe pending payout are a claim on Stripe, and they fit "receivable / other financial asset" better than cash in hand or a demand deposit. Classification as cash equivalent is a supportable judgement only if short-term, readily convertible and of insignificant risk.
  - Recommendation: present as a receivable by default; allow a tenant override to "cash equivalents" with a policy note.

### Cited Findings
- AASB 107 defines cash equivalents as short-term, highly liquid investments that are readily convertible to known amounts of cash and subject to an insignificant risk of changes in value. "Short-term" is normally around three months or less from acquisition, an illustration rather than a bright line. — [AASB 107 (search snippet)](https://www.aasb.gov.au/admin/file/content105/c9/AASB107_08-15.pdf); [Grant Thornton Malaysia, cash flow pitfalls](https://www.grantthornton.com.my/insights/technical-publications/Cash-flow-statements-common-pitfalls-and-application-issues-Part-I-Definition-of-Cash-and-Cash-Equivalents/)
- A US registrant treats card-transaction proceeds settling in under 5 days as cash equivalents. This is a filer's own policy, not AASB authority. — [SEC filing R23](https://www.sec.gov/Archives/edgar/data/103595/000109690613001552/R23.htm) (snippet)
- Bookkeeping practice: a "Stripe Receivable" account is used in the accrual view in place of "Stripe Cash". — [Puzzle help](https://help.puzzle.io/en/articles/8422710-how-do-i-reconcile-stripe-clearing-accounts)
- Xero practice: a Stripe clearing account is set up as a bank-type account of type "Other", not connected to a feed; it nets to zero per payout cycle. — [Synder, reconcile Stripe in Xero](https://synder.com/blog/how-to-reconcile-stripe-payments-in-xero/); [Dext, Stripe and Xero best practice](https://commerce.app.dext.com/blog/best-accounting-practices-stripe-xero/29); [Enrolmy KB](https://enrolmy.com/kb/article/2503001365)
- Stripe balance mechanics: settled funds sit in the Stripe balance and are paid out on the payout schedule. — [Stripe, PayPal settlement preference](https://docs.stripe.com/payments/paypal/choose-settlement-preference)
- Offsetting (AASB 132 / IAS 32 para 42) requires a currently enforceable legal right to set off and an intention to settle net. Items that do not meet it stay gross. Same-customer netting is seen in practice. Credit balances in AR arise from overpayments, returns, allowances and advance payments. — [MetroAG offsetting note](https://reports.metroag.de/annual-report/2019-2020/notes/notes-to-the-balance-sheet/38-offsetting-financial-assets-and-financial-liabilities.html); [ICAI EAC opinion](https://eacopinion.icai.org/html/38/1.pdf); [simplestudies, unusual balances](https://simplestudies.com/accounting-for-unusual-account-balances-and-offsetting.html/page/4). (Low-to-medium authority; no IFRS source states "reclassify AR credit balances" directly.)
- Contract liabilities (para 106) and receivables (para 108): see D2 and round 1. — [IFRS Community](https://ifrscommunity.com/knowledge-base/ifrs-15-contract-assets-and-contract-liabilities/)
- AASB 1060 is the single source of Tier 2 disclosures. Illustrative guides carry a separate "Trade and other receivables" note. Older AASB analysis shows reduced ECL disclosures for Tier 2, and a 2013 exposure draft proposed relief for entities using lifetime ECL on trade receivables. AASB 2025-2 adds Tier 2 financial-instrument disclosures from 1 Jan 2026. — [Pitcher GPFS SDS illustrative guide June 2025](https://www.pitcher.com.au/wp-content/uploads/2025/05/GPFS-SDS-IllustrativeGuide-June-2025.pdf) (not fetchable); [AASB ACCED237 Tier 2 supplement](https://www.aasb.gov.au/admin/file/content105/c9/ACCED237_07-13_Tier2Supp.pdf); [Accru, AASB 2025-2](https://accru.com/?p=20931); [Deloitte AU Tier 2 model report June 2025](https://www.deloitte.com/au/en/services/audit-assurance/analysis/June-2025-tier-2-model-financial-report.html)

### Inferences
- **Recommended decision D4:**
  1. Reporting classes: `contract_liability` (customer deposits 2400 + deferred revenue 2410 + reclassified customer credit balances arising from prepayments); `refund_liability_or_payable` (overpayments and credit notes owed back); `trade_receivables` gross of the `AR_ECL_ALLOWANCE` contra.
  2. At the reporting date, a report-level reclass moves customers with a net credit balance out of AR into liabilities. There is no ledger entry; the reclass is disclosed in the report's working.
  3. Stripe clearing defaults to the `other_receivables` (financial asset) class, with a tenant policy option to present it in cash equivalents. The bank-feed UX can still treat it like a bank account, as Xero does. Present the merchant-fee accrual separately if material.
- The AASB 1060 disclosure for contract balances and allowance movements needs confirming before building Tier 2 note templates. **(unverified)**

### Gaps
- Verbatim AASB 107 paras 6–7, AASB 132 para 42, AASB 15 para 109 and the AASB 1060 receivables and credit-risk paragraphs were not retrieved.
- No IFRS IC agenda decision specific to payment-processor balances was found.
- No Australian Big-4 view on Stripe or PayPal balances was found.

## Summary of recommended decisions and confidence

| # | Decision | Verdict | Confidence | Main unverified points |
|---|---|---|---|---|
| D1 | `AR_ECL_ALLOWANCE` contra; write-off Dr allowance; manual period-end journal in MVP, matrix later; default on; direct write-off as a documented materiality election (AASB 108 para 8) | Confirmed | High on the standard; medium on SMB practice (community and vendor sources) | B5.5.35 and 5.4.4 wording; MYOB AccountRight help; ATO timing interplay |
| D2 | Ledger gross (Dr AR / Cr contract liability ex-GST); Example 38 applied as report-level netting for cancellable, not-due, unpaid advance invoices; payment-request workflow as alternative | Confirmed (practical approach is an inference) | Medium-high on the rule; medium on the practice framing | Para 105–108 and IE text; BDO second trigger; GST interaction |
| D3 | Mandatory credit-note reason codes; credit loss routed to the write-off flow | Confirmed | High (IASB 2024 paper) | Example 2/3 conclusions |
| D4 | Contract liability class; customer-level credit balances reclassified at reporting date; Stripe as receivable by default with cash-equivalent override | Contract liability and credit balances confirmed; Stripe "never cash" softened to a default plus policy option | Medium | AASB 107/132 text; no authoritative Stripe guidance |
