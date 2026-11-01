# Australian GST accounting for LedgerForce postings (AASB Interpretation 1031 + ATO GST rules)

> Research notes, 2026-11-01, by claude (researcher sub-agent). Inputs read first: `Docs/accounting/postings.md`
> (GP-001…GP-019, open questions Q1–Q11), design §3.4/§3.6/§3.8, `RQ-0090` and `RQ-0009`.
>
> **Access limits (important for the report writer):** ato.gov.au, standards.aasb.gov.au, aasb.gov.au and
> legislation.gov.au could **not** be fetched from this environment (DNS blocked; WebFetch returned
> `ENOTFOUND`). Every "Cited finding" below comes from **search-engine extracts of the cited page**, not from a
> full read; paragraph numbers of rulings were mostly *not* visible. Anything taken from prior knowledge is
> marked **"unverified — from prior knowledge"** and must be checked before a golden posting is Approved.
> To verify, allow `ato.gov.au`, `standards.aasb.gov.au` and `legislation.gov.au` in the session network settings.

## 0. Interpretation 1031 baseline and the AASB 18 / AASB 107 question (context for all Qs)

### Takeaway
Interpretation 1031 requires revenue, expenses and assets net of GST (unless the GST is not recoverable),
receivables/payables stated GST-inclusive, the net GST position shown within receivables or payables, and cash
flows presented gross with the GST on investing/financing flows classified as operating. The current compilation
is listed as operative only for periods beginning before 1 January 2027, i.e. it coincides with AASB 18's
effective date; I could not confirm what replaces or amends it.

### Cited Findings
- Receivables and payables "shall be stated with the amount of GST included"; revenues, expenses and assets are
  recognised net of GST except where the Interpretation's exceptions apply (non-recoverable GST) —
  [AASB Int 1031 (standards.aasb.gov.au node 329)](https://standards.aasb.gov.au/node/329);
  [Int 1031 original PDF](https://aasb.gov.au/admin/file/content105/c9/INT1031_07-04.pdf)
- The net amount of GST recoverable from / payable to the taxation authority is included as part of receivables or
  payables in the statement of financial position (search extract paraphrase) —
  [AASB Int 1031](https://standards.aasb.gov.au/node/329)
- "Cash flows shall be included in the statement of cash flows on a gross basis, subject to paragraph 11 and to
  AASB 107"; "The GST component of cash flows arising from investing and financing activities which is recoverable
  from, or payable to, the taxation authority shall be classified as operating cash flows" —
  [Int 1031 compiled May 2019](https://www.aasb.gov.au/admin/file/content105/c9/INT1031_07-04_COMPmay19_01-20.pdf);
  [standards.aasb.gov.au node 329](https://standards.aasb.gov.au/node/329)
- The AASB compiled version is listed as applying to reporting periods beginning on or after 1 January 2020
  **but before 1 January 2027** — [standards.aasb.gov.au node 329](https://standards.aasb.gov.au/node/329)
- AASB 18 (for-profit) Appendix D "Amendments to Other Australian Accounting Standards" applies to periods
  beginning on or after 1 January 2027 — [AASB interpretations listing](https://standards.aasb.gov.au/interpretations?page=2);
  AASB 18 is "the most significant upcoming standard … from 2027/28" —
  [Grant Thornton TA 2026-1](https://www.grantthornton.com.au/insights/technical-alerts/ta-2026-1-whats-new-for-31-december-2025-reporting/)
- August 2026: AASB issued **AASB 2026-4** *Amendments to Australian Accounting Standards – Application of AASB 18
  and AASB 107 by Superannuation and Not-for-Profit Entities and Operating Cash Flow Reconciliation* (relief for NFP
  public sector and super entities) — [KPMG](https://kpmg.com/au/en/insights/financial-reporting/aasb-18-changes-for-super-funds-and-nfp.html);
  [BDO](https://www.bdo.com.au/en-au/blogs/corporate-reporting/aasb-18-relief-for-nfps-and-superannuation-entities)

### Inferences
- Paragraph numbers (para 7 net recognition, para 8 inclusive receivables/payables, para 9 net GST in
  receivables/payables, para 10 gross cash flows, para 11 GST on investing/financing → operating) are
  **unverified — from prior knowledge**; the wording above is verified via extracts.
- Note the nuance vs the brief: Int 1031 puts the **net** GST position *within receivables or payables*; it does not
  require a separate "GST asset/liability" line. For LedgerForce, `tax:GST.collected` (2200) and `tax:GST.paid`
  (2210) are bookkeeping control accounts; the balance sheet report should **net them** into one GST
  payable/receivable amount (presented within payables if net payable, receivables if net refundable).
- AASB 18 replaces AASB 101 (presentation) but AASB 107 is retained with amendments (indirect-method starting point =
  operating profit; interest/dividend classification fixed for non-financial entities) — **unverified — from prior
  knowledge**. Nothing found suggests the gross-cash-flow / GST-as-operating principle changes; the 2027 end date on
  the Int 1031 compilation most likely reflects a consequential re-compilation for AASB 18 references, not withdrawal.
- All golden postings (GP-001 revenue net, AR gross; GP-008 expense/asset net, AP gross; GP-004 fee net with GST to
  2210) already follow Int 1031 recognition. Non-recoverable GST (input-taxed purchases, private portion, missing
  tax invoice permanently) must be **capitalised into cost/expense**, which needs an "input-taxed / non-claimable"
  tax code that posts GST to the expense line rather than 2210.

### Gaps
- Could not read the post-2027 Int 1031 compilation or AASB 18 Appendix D text to confirm whether Int 1031 is
  amended, renumbered or carried forward unchanged. Check `standards.aasb.gov.au` for a 2027 compilation.

---

## Q7 — GST on a customer prepayment received before any tax invoice (accruals) — GP-012 Option A vs B

### Takeaway
On the accruals (non-cash) basis, GST on a taxable supply is attributable to the **earlier** of the period in which
**any** of the consideration is received or an invoice is issued (GST Act s 29-5). A part-payment / prepayment is
consideration, so Option A ("no GST at receipt") is wrong for a part-payment; only a genuine **security deposit**
(Division 99) defers attribution. Worse for Option B: under the basic rule the receipt of *any* consideration can
attribute the **whole** GST on the supply, not just 1/11 of the amount received, unless a special rule
(progressive/periodic supply, Division 156) splits the supply.

### Cited Findings
- Non-cash basis: "you attribute the GST to the earlier tax period in which you receive any of the consideration
  for the supply, or the tax period in which an invoice is issued" (explanatory statement extract describing
  s 29-5) — [legislation.gov.au F2017L00425 ES](https://legislation.gov.au/F2017L00425/asmade/2017-04-01/es/original/pdf)
- Cash basis: GST payable "will be attributable to the extent that the consideration is received in a tax period
  (subsection 29-5(2))" — [legislation.gov.au F2017L00425 ES](https://legislation.gov.au/F2017L00425/asmade/2017-04-01/es/original/pdf)
- GSTR 2000/29 basic attribution: the rules attribute "the whole or part of the GST payable or input tax credit to
  the tax period in which you receive or provide any part of the consideration or an invoice is issued" (extract) —
  [GSTR 2000/29](https://www.ato.gov.au/law/view/document?DocID=GST%2FGSTR200029%2FNAT%2FATO%2F00001&PiT=99991231235958)
- Security deposits: s 99-10(1) attributes GST on the part of the consideration that is a security deposit (when
  forfeited or applied), while GST on the balance is attributable under s 29-5 —
  [GSTR 2000/29 (extract)](https://www.ato.gov.au/law/view/pdf?DocId=GST%2FGSTR200029%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-029c4.pdf&PiT=20151021000001)
- GSTR 2006/2 (deposits held): an amount "may be consideration for a supply at the time that it is paid, for
  example, as a part payment under a purchase contract. In that case, the GST payable on the taxable supply is
  attributed to the tax period in which the payment is made" —
  [GSTR 2006/2](https://www.ato.gov.au/law/view/pdf?DocId=GST%2FGSTR20062%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2006-002c2.pdf&PiT=20130701000001)
- ATO edited private ruling: Div 99 applies only to "a genuine deposit and not a part payment"; for a part payment
  "the first instalment paid will trigger attribution for the total consideration (excluding the deposit amount)
  under section 29-5" — [ATO EPR](https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg) (private ruling —
  persuasive only, not binding on others)
- GSTR 2000/28 (standard land contract): the deposit does not trigger attribution when paid; attribution occurs when
  applied as consideration on settlement —
  [GSTR 2000/28](https://www.ato.gov.au/law/view/pdf?DocID=GST%2FGSTR200028%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-028c1.pdf&PiT=20070801000001)
- RQ-0090 already recorded: ATO "Identify your accounting basis" — earliest of consideration received or invoice
  issued — [ATO](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/identify-your-accounting-basis)

### Inferences
- **Option A (no GST at receipt) is not defensible on the accruals basis** for an ordinary project prepayment
  (30% of an $11,000 project): it is part-payment, not a Div 99 security deposit (security against performance,
  refundable/forfeitable). Option A is only correct if the tenant flags the receipt as a *security deposit*.
- **Option B (GST = 1/11 of the receipt, $300) is the conservative "proportional" view** and matches the cash-basis
  result. Under strict s 29-5(1) the receipt of $3,300 could attribute GST on the **entire** $11,000 supply
  ($1,000) to November, unless (a) the project is a progressive or periodic supply under **Division 156** (each
  progressive component treated as a separate supply, attributed as paid/invoiced) — **unverified — from prior
  knowledge**, or (b) the total consideration is not yet ascertainable (GST Regs 29-25 rule: attribute to the
  extent consideration is received/invoiced) — **unverified — from prior knowledge**. For a milestone-billed services
  project Div 156 will usually apply, which supports Option B.
- Engine design consequence: the GST basis matters at *receipt* for prepayments; GP-012 needs a tax code on the
  prepayment line (Dr Bank 3,300 / Cr CUSTOMER_PREPAYMENTS 3,000 / Cr GST collected 300; G1 +3,300, 1A +300), and
  GP-013's final invoice must then credit only the remaining GST (700). This is identical to the GP-014/GP-015 deposit
  invoice path, so the cleanest product rule is: **a prepayment against a taxable supply always gets a GST
  document** — either a deposit tax invoice (GP-014) or a receipt that carries GST (Option B); the "untaxed
  prepayment" path is restricted to (i) GST-free/input-taxed supplies, (ii) explicitly flagged Div 99 security
  deposits, (iii) unallocated customer money whose supply is unknown (then GST attributed on application —
  arguable; human gate).
- Int 1031 consistency: under Option B the liability `CUSTOMER_PREPAYMENTS` is carried **net of GST** (3,000) and the
  GST sits in GST collected; under GP-014 the same. Both comply (receivables/payables gross applies to AR/AP, the
  prepayment liability is a contract liability measured at the GST-exclusive consideration — inference).

### Gaps
- Exact paragraphs of GSTR 2000/29 on prepayments/part-payments and the Div 156 text were not readable; whether
  receipt of a part-payment attributes the *whole* GST for a non-progressive single supply needs the ruling text
  (GSTR 2000/29 paras ~13–45; GSTR 2000/35 on deposits at the start of an arrangement).
- No change to s 29-5 since 2024 was found (none searched beyond the above); GSTR 2000/29A3 updated it for tax-invoice
  amendments from 1 July 2010 — [GSTR 2000/29A3](https://www.ato.gov.au/law/view/document?docid=%22GST%2FGSTR200029A3%2FNAT%2FATO%2F00001%22).

---

## Q3 — Bad-debt GST: ledger against GST collected or GST paid; BAS 1A vs 1B; cash basis

### Takeaway
ATO: on the non-cash basis the supplier has a **decreasing adjustment = 1/11 of the amount written off** (wholly
taxable sale) in the period the debt is written off, or, absent write-off, when it becomes 12 months overdue;
decreasing adjustments are reported at **1B**, recovery is an **increasing adjustment at 1A**. Cash-basis
taxpayers never reported the unpaid GST, so no adjustment arises. The ledger account is a free choice for Int 1031
(both GST accounts net into one balance), so the BAS label must come from the tax code, not the GL account.

### Cited Findings
- Decreasing amounts at label 1B, increasing adjustments at 1A; with the GST calculation worksheet the decreasing
  adjustment goes to G18 instead — [ATO "How to make adjustments"](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments)
  (search extract; the search tool reported the page as updated September 2026 — not independently verified)
- Timing: tax period of write-off, or if not written off, the period you become aware it is 12 months overdue;
  amount 1/11 of the amount written off/overdue for a wholly taxable supply; reduced for partly taxable supplies;
  recovery → increasing adjustment in the period of recovery —
  [ATO "How to make adjustments"](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments);
  [GSTR 2000/2](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20002%2FNAT%2FATO%2F00001)
- A written record of the decision to write off is needed; making the BAS adjustment does not itself write the debt
  off — [ATO "How to make adjustments"](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments)
- Only non-cash (accruals) basis entities that made a taxable sale and already paid the GST can claim; a debt that is
  forgiven or set off cannot be "written off as bad" —
  [ATO types of adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/types-of-adjustments);
  RQ-0009 S8 extract of [GSTR 2000/2](https://www.ato.gov.au/law/view/document?docid=GST/GSTR20002/NAT/ATO/00001)
- Adjustment note: one extract says adjustment notes are **not** required for bad-debt adjustments (write-off is not an
  adjustment event) — [ATO "How to make adjustments"](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments);
  another search summary implied an adjustment note is needed unless GST ≤ $75 — **conflict**; the second appears to
  conflate general Div 19 decreasing adjustments with Div 21. Prior knowledge agrees with "not required" (unverified).
- Div 21 is the statutory home; adjustments reverse if payment later received —
  [KPMG multijurisdictional bad-debt analysis](https://assets.kpmg.com/content/dam/kpmg/xx/pdf/2020/04/indirect-tax-treatment-of-bad-debts-a-multijurisdictional-analysis.pdf)

### Inferences
- **BAS label:** GP-007's "1B +125.00" is correct per ATO guidance; recovery: 1A + (amount recovered × 1/11). Under
  the worksheet method: G18. Simpler BAS: 1B (no G-label effect).
- **Ledger account:** Int 1031 requires only that the **net** GST position be presented; it does not care whether the
  debit hits 2200 or 2210. Arguments:
  - *GST collected (2200, design §3.8):* economically reverses the never-collected output tax; 2200 then reconciles to
    "GST on sales net of bad-debt relief", and on cash basis it naturally clears the never-remitted 125.00.
  - *GST paid (2210):* makes each control account reconcile 1:1 to its BAS label (2200 ↔ 1A, 2210 ↔ 1B), which simplifies
    the BAS-to-GL reconciliation on accruals — but on **cash basis** it would leave 125.00 stuck in 2200 and put a
    phantom credit in 2210, so it is wrong for cash-basis tenants.
  - Recommendation: keep design §3.8 (Dr GST collected) **and** drive the BAS from the tax code `GST-ADJ`
    (accruals → 1B; cash → no label), with the BAS/GL reconciliation done on the *net* (1A − 1B vs 2200 + 2210). An
    alternative that satisfies both is a dedicated `GST adjustments` sub-account rolled into the net GST line.
- **Cash basis:** ledger entry identical (clears the 125.00 that the accrual ledger booked but the cash BAS never
  reported); BAS nothing; the 12-month-overdue trigger is irrelevant. A later recovery on cash basis is simply a
  receipt → G1/1A on receipt (s 29-5(2)), so the engine must *not* also emit a 1A recovery adjustment for cash tenants.
- Partial write-off: 1/11 × written-off amount, as GP-007 drafts; mixed-rate invoices need the proportion of taxable
  consideration (ATO "partly taxable" reduction).
- Engine needs a "12-months overdue" trigger as well as write-off (ATO allows the adjustment without write-off) —
  probably a Phase 1 report/flag rather than an automatic posting (product choice).

### Gaps
- Div 21 section text (21-5 supplier decreasing adjustment, 21-10 recovery, 21-15/21-20 recipient side) not read;
  the "accruals only" rule is from ATO guidance, not the Act text. Recipient-side (AP) bad debts: a buyer that claimed
  an ITC and has not paid for 12 months must make an **increasing** adjustment (1A) — **unverified — from prior
  knowledge**; not covered by any golden posting yet.

---

## Q4 — Credit/adjustment notes: net into G1/1A, or report as a 1B decreasing adjustment?

### Takeaway
ATO guidance reports a supplier's decreasing adjustment (price reduction, cancellation, refund) at **1B** (or G18
on the worksheet), with an ATO worked example treating a discount on an earlier sale as a decreasing adjustment
rather than an edit of G1. Netting into G1/1A is consistent with the law only when the reduction happens in the
**same** tax period as the original attribution (no adjustment arises then — unverified, prior knowledge). I could
not find an ATO statement on whether G1 is reduced by adjustment notes.

### Cited Findings
- Report increasing adjustments at 1A and decreasing amounts at 1B; overall decreasing adjustment at G18 if using
  the calculation worksheet; ATO worked examples: $108 discount on a $3,600 sale, refunded concert ticket sale → March
  decreasing adjustment of 1/11 of the refund — [ATO "How to make adjustments"](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments);
  [ATO sales worksheet PDF](https://www.ato.gov.au/api/public/content/b1cb2359-49ef-4d0f-bcec-098e36722d34_QC17537_Worksheets_js32842_w_pdf)
- A valid adjustment note is generally needed before claiming a decreasing adjustment unless the GST adjustment is
  $75 or less; a decreasing adjustment cannot be claimed until both documents forming the adjustment note are held —
  [GSTR 2000/1 adjustment notes](https://www.ato.gov.au/law/view/pdf?DocID=GST%2FGSTR20001%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-001c3.pdf&PiT=20101029000001);
  [ATO adjustment notes](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/adjustment-notes)
- G1 may be reported GST-inclusive or GST-exclusive (consistently); the worksheet's G8 is "total sales subject to GST
  after adjustments" — [ATO "Completing your BAS for GST"](https://www.ato.gov.au/api/public/content/0-98e0ef06-57b7-4811-a119-5236f1676a3c)
- Secondary: sales at G1 are shown net of adjustments in common practice —
  [Accounts Unplugged AP Issue 7](https://accountsunplugged.com/uploads/3/3/0/6/3306481/ap_issue_7_parts_of_business_activity_statment_bas_explained.pdf)
  (not an ATO source); an Australian "adjustment note" is not the same as a credit note; Xero/MYOB/QuickBooks label all
  corrections "credit notes" — [invoicedataextraction.com blog](https://invoicedataextraction.com/blog/australia-gst-adjustment-notes) (low-quality SEO source)

### Inferences
- Two lawful presentations exist in practice: (1) "adjustment" presentation — G1 unchanged, 1B += GST on the note
  (ATO adjustment guidance); (2) "net" presentation — G1 and 1A reduced in the note's period (what most SMB software
  appears to do; not confirmed for Xero). The net payable (1A − 1B) is identical either way, so the ATO risk is low,
  but data-matching of 1A vs income-tax turnover differs.
- Recommendation for the engine (design §3.6 "BAS is a query"): map the credit-note tax code with **two box
  mappings selectable by a company setting** — default *adjustment presentation* (1B, G-labels untouched) for notes
  relating to sales attributed in an **earlier** period, and *net presentation* (G1/1A) when the original invoice and
  the note fall in the **same** BAS period. GP-005 (credit note 2026-11-20 on an invoice of 2026-11-05, same quarter)
  is then correctly "G1 −220, 1A −20"; a note in a later quarter would be "1B +20". This needs a human decision (Q4)
  because it is a reporting-policy choice.
- Product must issue the document titled **"Adjustment note"** (or a credit note meeting adjustment-note content
  requirements) — the ATO requires the recipient to hold it before claiming its decreasing adjustment.
- Simpler BAS: either way only G1/1A/1B are shown.

### Gaps
- Could not read the ATO G1 instructions to confirm whether G1 should be reduced for adjustment notes; could not
  confirm Xero/MYOB behaviour from primary docs. Prior-knowledge claim that an adjustment event in the same period
  produces no "adjustment" (Div 19 applies only where GST was previously attributed) is **unverified**.

---

## Q8 — Is per-invoice GST rounding acceptable on AU tax invoices; ATO rounding rule

### Takeaway
Yes: for an invoice with several taxable sales the ATO allows the **total invoice rule** (total the GST and round
once to the nearest cent, 0.5 up; or, when every line is exactly 1/11, compute GST on the summed values and round
once) or the **taxable supply rule** (compute each line's GST, rounding only to the precision the system stores,
add, round the total to the cent). A single taxable sale rounds to the nearest cent, 0.5 up. Supplier and
customer may use different rules. Per-*document* rounding is therefore the textbook ATO method; the design's
"per line to cents" default is only literally within the taxable supply rule for a system that stores 2 dp.

### Cited Findings
- Two rules where more than one taxable sale is on the invoice: total invoice rule and taxable supply rule;
  total-invoice: total then round GST to the nearest cent, rounding 0.5 cents up; alternative when all lines are 1/11:
  add GST-exclusive values, calculate GST on the sum, round once; taxable-supply: calculate GST per sale, "where a
  line's GST has more decimal places than your accounting system can store, you round it up or down", add and round
  total to nearest cent; single sale → nearest cent 0.5 up; "you and your customers don't need to use the same
  rounding rules" — [ATO Tax invoices](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices)
- eInvoices calculate GST by default using the total invoice rule; "minor differences in values may occur due to you
  and your customer using different GST rounding rules" —
  [ATO guide to receiving eInvoices](https://www.ato.gov.au/api/public/content/23dcd77b380e47d4ba7e71d966c56502?v=ff6e9632)
- Statutory origin: s 9-90 (rounding of GST amounts) with a four-item worked example giving $4.41 under both methods —
  [EM, Indirect Tax Legislation Amendment Act 2000](https://www.ato.gov.au/law/view/print?DocID=NEM/EM200027/NAT/ATO/00008&PiT=99991231235958)
- Tax invoice may state "total includes GST" when GST is exactly 1/11 of the total —
  [ATO Tax invoices](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices);
  [GSTR 2013/1](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20131%2FNAT%2FATO%2F00001)

### Inferences
- Applied to GP-018 (3 lines × $3.35 GST-inclusive):
  - 18b per-document: 10.05/11 = 0.9136 → **0.91** = total invoice rule ✓.
  - Taxable supply rule with LedgerForce's 4-dp storage: 0.3045 × 3 = 0.9136 → **0.91** (same as 18b).
  - 18a per-line-to-cents: 0.30 × 3 = **0.90** — matches neither rule when the system stores 4 dp; it is only within
    the taxable supply rule's wording if line GST is *stored* at 2 dp. RQ-0009 already concluded the AU default should
    be the total invoice rule; this research supports that and contradicts design §3.4's "AU default: per line".
- Therefore Q8: per-document rounding is not merely acceptable — it is the ATO's primary rule; it should be the AU
  default (human gate, accounting ADR). Keep per-line-to-cents only as an option (some customers/eInvoicing partners
  expect line-level GST) and accept that the recipient may compute a cent differently.
- ROUNDING vs adjusting a line: Int 1031 requires revenue net of GST; a ROUNDING line of 0.01 is (in substance)
  revenue/GST reallocation. Allocating the residual to the largest revenue line keeps revenue = document total − GST
  exactly and keeps ROUNDING (a P&L account) at zero for sales documents; either is immaterial. The tax-invoice
  display must show the same line nets the ledger posts (otherwise displayed line amounts ≠ GL) — inference.

### Gaps
- Could not fetch the ATO page to quote verbatim or check its "last updated" date; s 9-90 text not read.

---

## Q2 — Stripe fee GST: claim per payout from the fee breakdown, or only from the monthly tax invoice?

### Takeaway
Stripe charges GST on all fees for AU accounts (added on top unless GST-inclusive pricing is agreed) and issues a
**monthly tax invoice** for the GST. Under s 29-10(3) an input tax credit is attributable to a period only if the
recipient **holds a tax invoice when lodging** the return for that period. So the *ledger* may post fee + GST per
payout (Int 1031: fee expense net, GST to GST paid), but the **1B claim** depends on holding Stripe's monthly tax
invoice by the BAS lodgement date; if not held, the credit is claimed in a later period.

### Cited Findings
- "For Stripe account holders in Australia, goods and services tax (GST) applies to all Stripe fees at the prevailing
  standard rate"; GST "applied in addition to the product and service fees, unless there is agreement on GST-inclusive
  pricing"; "You will be provided with a monthly tax invoice for the GST that is charged on your Stripe fees" —
  [Stripe support: Taxes on Stripe fees for Australia-based businesses](https://support.stripe.com/questions/goods-and-services-tax-gst-for-australia-based-businesses);
  [Stripe embedded-connect variant](https://support.stripe.com/embedded-connect/questions/taxes-on-stripe-fees-for-australia-based-businesses)
- "To claim an input tax credit for a particular tax period, you are required to hold a tax invoice when you give to
  the Commissioner a GST return for the period (subsection 29-10(3))"; the Commissioner can waive the requirement via
  legislative instruments under s 29-10(3) — [GSTR 2013/1](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20131%2FNAT%2FATO%2F00001);
  [ES F2017L00425](https://legislation.gov.au/F2017L00425/asmade/2017-04-01/es/original/pdf)
- ATO financial-services guide on merchant fees: the retailer "will be entitled to an input tax credit for the GST
  included in the merchant fee in the tax period in which they receive the tax invoice, provided the acquisition is
  creditable" — [ATO GIR Financial services ch13](https://www.ato.gov.au/law/view/pdf?DocId=GIR%2FFinancial-services-ch13&filename=law%2Fview%2Fpdf%2Fadhoc-sgml%2Fgstir-financial-services-ch13.pdf&PiT=99991231235958)
- No tax invoice needed where the GST-exclusive value is $75 or less (GSTR 2000/34 per search summary; RQ-0009 and
  Stripe cite the AU$82.50 GST-inclusive threshold) — [GSTR 2000/34](https://www.ato.gov.au/law/view/document?DocID=GST%2FGSTR200034%2FNAT%2FATO%2F00001&PiT=99991231235958);
  [Stripe: invoice types in Australia](https://stripe.com/au/resources/more/invoice-types-in-australia)
- Secondary: GST on Stripe fees is claimable as an ITC on the BAS, supported by the monthly invoice; code fees as
  GST-inclusive, not GST-free — [splose support](https://support.splose.com/en/articles/14482872-claiming-payment-processing-fees-as-a-tax-deduction-in-australia) (non-authoritative)

### Inferences
- **Ledger (GP-004) per payout is fine** and Int 1031-compliant (fee 21.53 to 6200 net, 2.15 to 2210, net settlement).
  The question is only the **BAS period** of the 1B amount.
- Recommended engine rule: post per payout with tax code `GST` on the fee line but mark the ITC as
  **"pending tax invoice"** (evidence status); the BAS query includes it in 1B for a period only when the Stripe
  monthly tax invoice covering that payout month is attached/marked held by lodgement. In practice a quarterly
  lodger holds all three monthly invoices before lodging, so per-payout attribution almost always lands in the same
  quarter; a monthly lodger may need to defer. Reconcile the monthly invoice GST to the sum of per-payout GST and post
  any cent difference (invoice is authoritative) — inference.
- Using the $75/$82.50 no-tax-invoice exception per transaction is **not recommended**: whether each Stripe fee is a
  separate supply is unconfirmed, and the monthly invoice exists anyway.
- Whether `balance_transaction.fee_details` exposes the GST component as a separate `tax` entry for AU accounts is
  **unverified — from prior knowledge** (RQ-0090 also left this open; T-0075 must check the Stripe API reference).
  If GST is "in addition to" fees, the fee breakdown should show it; GP-004 assumes the split comes from Stripe.
- Stripe clearing / merchant fees as connector settings (Q2 second half) is a design choice; nothing in Int 1031 or
  ATO rules constrains it.

### Gaps
- Did not confirm that Stripe's monthly document meets all tax-invoice requirements (it is described as a "tax
  invoice"); did not find the four-year time limit text for late ITC claims (s 93-5 — **unverified, prior knowledge**).

---

## Appendix-level facts: BAS labels G1, G10, G11, 1A, 1B, W1, W2 and Simpler BAS (supports all Qs)

### Takeaway
Simpler BAS (default for GST turnover < $10m since 1 July 2017) reports only G1, 1A, 1B; full reporting adds G2,
G3, G10, G11. W1 = gross salary/wages and other payments, W2 = PAYG amounts withheld from W1; STP pre-fills W1/W2.

### Cited Findings
- Simpler BAS: only G1 total sales, 1A GST on sales, 1B GST on purchases; default for small business since 1 July 2017 —
  [ATO Simpler BAS bookkeeping guide](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/goods-and-services-tax-gst/simpler-bas-gst-bookkeeping-guide);
  RQ-0009 S4 [ATO quarterly GST reporting](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/quarterly-gst-reporting)
- W1 includes gross pay, director fees, etc.; excludes salary-sacrificed amounts and super contributions; W2 = PAYG
  withheld from W1 payments; W5 = W2 + W4 + W3; STP reporters get W1/W2 pre-filled and should correct differences —
  [ATO PAYG withholding (BAS)](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding);
  [ATO PAYG pre-fill](https://www.ato.gov.au/businesses-and-organisations/hiring-and-paying-your-workers/single-touch-payroll/stp-and-activity-statements/ato-payg-withholding-pre-fill-for-activity-statements)
- G10 capital purchases vs G11 non-capital (GST-inclusive) — RQ-0009 S5
  [ATO Step 3 purchases](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/complete-your-bas/step-3-purchases)
- Cash basis available below $10m aggregated turnover — RQ-0009 S7
  [ATO choosing an accounting method](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method)

### Inferences
- GP-010 (payroll) should map W1 = gross wages (excluding employer super and salary-sacrifice) and W2 = PAYG
  withheld; super expense is BAS-excluded.
- Stripe fee (GP-004) belongs at G11 (full BAS) and 1B; bad-debt and adjustment-note GST have **no G-label** effect
  on Simpler BAS when reported as adjustments at 1A/1B.
- Changes since 2024: none found to the GST attribution, rounding, bad-debt or Simpler BAS rules; the relevant
  2026 change is on the AASB side (AASB 18 from 1 Jan 2027; AASB 2026-4, Aug 2026).

### Gaps
- No primary ATO page was fully read (network block); label meanings for G2/G3/G7/G18 rely on extracts and RQ-0009.
