# Confirmation of four Australian GST treatment decisions (Q7, Q8, Q4, bad debts + Stripe fees)

> Research notes, 2026-11-01, claude researcher sub-agent. Builds on
> `Docs/research/research_notes/AASB alignment of LedgerForce postings/gst_accounting.md` (first round), which is
> cited below as **R1**; findings already sourced there are not repeated in full.
>
> **Access limits (read first):** from this session WebFetch failed (`ENOTFOUND`, host outside the allowed network)
> for ato.gov.au, legislation.gov.au, austlii.edu.au, central.xero.com, help.myob.com.au, support.stripe.com and
> quickbooks.intuit.com. **No primary page was read in full.** Every "Cited finding" is taken from search-engine
> extracts of the cited page. Statements marked **[unverified — prior knowledge]** are not sourced and must be
> checked before a golden posting is Approved. To verify, allow `ato.gov.au`, `legislation.gov.au`,
> `central.xero.com`, `help.myob.com.au`, `support.stripe.com` and `quickbooks.intuit.com` in the session
> network settings.

## Q7 — GST on a customer prepayment / part-payment before any tax invoice (accruals basis)

### Takeaway
**CONFIRMED, with a sharper rule than first proposed.** On the accruals basis, s 29-5(1) attributes GST to the
earliest period in which *any* consideration is received or an invoice is issued. For a **single, non-progressive
supply** the first part-payment attributes GST on the **whole** supply. Only Division 156 (progressive or periodic
supplies, where each component counts as a separate supply) or the "total consideration not known" determination
limits it to the part paid. Untaxed prepayments are right only for GST-free or input-taxed supplies and for genuine
Div 99 security deposits. Confidence: **medium-high**. The rule is consistent across the ATO's binding and
private-ruling extracts, but the s 29-5 and Div 156 text was not read.

### Cited Findings
- Accruals basis: GST is attributed to "the earlier tax period in which you receive any of the consideration for
  the supply, or the tax period in which an invoice is issued". Cash basis: "to the extent that the consideration is
  received" (s 29-5(2)) — [ES F2017L00425](https://legislation.gov.au/F2017L00425/asmade/2017-04-01/es/original/pdf) (R1)
- GSTR 2000/29: attributes "the whole or part of the GST payable … to the tax period in which you receive or provide
  any part of the consideration or an invoice is issued" — [GSTR 2000/29](https://www.ato.gov.au/law/view/document?DocID=GST%2FGSTR200029%2FNAT%2FATO%2F00001&PiT=99991231235958) (R1)
- GSTR 2006/2: a payment that is "a part payment under a purchase contract" is consideration when paid, and "the GST
  payable on the taxable supply is attributed to the tax period in which the payment is made" —
  [GSTR 2006/2](https://www.ato.gov.au/law/view/pdf?DocId=GST%2FGSTR20062%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2006-002c2.pdf&PiT=20130701000001) (R1)
- ATO edited private ruling, citing GSTR 2000/35 paras 115 and 118. To come within Div 99 "the deposit must be a
  genuine deposit and not a part payment". A Div 99 deposit is attributed when it is forfeited or applied. For a
  part payment, "the first instalment paid will trigger attribution for the total consideration (excluding the
  deposit amount) under section 29-5" —
  [ATO EPR](https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg) (persuasive only; R1 plus this round's search
  extract)
- Division 156: "each progressive or periodic component of a taxable supply" is treated as a separate supply. The
  ATO says you "report each payment you receive … in the reporting period you receive it" —
  [ATO progressive or periodic sales and purchases](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/agent-consignment-and-progressive-transactions/gst-agent-consignment-and-progressive-transactions/progressive-or-periodic-sales-and-purchases)
  (search extract)
- Commissioner's attribution determinations that limit attribution "to the extent" of consideration received or
  invoiced: one for supplies where total consideration is not known, and one for retentions (attributed when
  received) — [ATO legislative determination PAR 2017/3](https://www.ato.gov.au/law/view/pdf/ldt/par2017-003.pdf);
  [PAR 2000/6](https://www.ato.gov.au/law/view/pdf/ldt/par2000-006.pdf) (search summary. Which instrument says what
  was not confirmed from the text.)
- *Commissioner of Taxation v Qantas Airways Ltd* (High Court 2012) discusses s 29-5 attribution on payment. The
  search summary says GST is payable once, at the attributable period —
  [vLex](https://au.vlex.com/vid/commissioner-of-taxation-v-793810169) (secondary summary)
- Xero: the "Prepayment" option of Receive Money "will allow you to generate a tax transaction when the payment on
  account is received". The "Overpayment" option carries no GST, and users report that it understates the GST
  liability — [Xero product ideas forum](https://productideas.xero.com/forums/967115-invoices-quotes/suggestions/47719241-customer-payments-payments-on-account-instead-o);
  [Poolwerx Xero prepayment guide](https://evolutionplatform.poolwerx.com.au/support/solutions/articles/13000109082-xero-record-a-prepayment);
  [AccountingWEB thread](https://www.accountingweb.co.uk/node/78306) (community and partner sources, not Xero Central)

### Inferences
- **Recommended decision (Q7):**
  1. Default: a receipt before invoice for a taxable supply posts GST at receipt.
  2. Amount of GST: the **whole supply's GST** if the supply is a single, non-progressive supply with known total
     consideration (s 29-5(1), EPR). Otherwise 1/11 of the amount received, when the document is flagged
     **progressive/periodic (Div 156)** or the total consideration is not yet known.
  3. Product simplification: most SMB prepayments (project milestones, subscriptions, staged work) are Div 156
     supplies, so "1/11 of receipt" is the usual result. That is also Xero's mechanism: a Prepayment carries a tax
     rate on the received amount.
  4. Expose a "single supply, whole GST on first payment" flag rather than defaulting to it. **Human gate:** this is
     an accounting ADR. The proportional default under-reports GST for a true single supply, such as goods sold
     under one contract with a 30% part-payment.
  5. Untaxed prepayment only for GST-free or input-taxed supplies, Div 99 security deposits (attributed when
     forfeited or applied), or unidentified receipts (no supply yet identified).
- Under the whole-supply rule, a later invoice must not repeat the GST already attributed. The engine needs a
  per-supply "GST attributed to date" balance.
- Xero and MYOB do not model the single-supply whole-GST rule. Their prepayment carries GST only on the amount
  received [unverified for MYOB].

### Gaps
- s 29-5, Div 99 and Div 156 statutory text and GSTR 2000/35 paras 12, 27, 115 and 118 were not read (host blocked).
- The exact legislative instrument for "total consideration not known" (GST Regs / PAR 2017/3?) is unconfirmed.
- MYOB and QBO AU handling of customer deposits: no source found.

## Q8 — GST rounding on tax invoices

### Takeaway
**CONFIRMED that per-invoice rounding ("total invoice rule") is lawful and is the ATO's primary rule. NOT
confirmed as market practice:** QuickBooks Online AU officially follows the **taxable supply rule** (per line).
Xero and MYOB also calculate GST per line, rounded to the cent, with no per-invoice switch in AU found. Per-line
rounding to cents is also lawful under the taxable supply rule for a system that stores 2 dp. The ATO says supplier
and customer may use different rules. Putting a cent residual on the largest revenue line, rather than a rounding
account, is a design choice that no rule addresses. Confidence: **high** on legality, **medium** on vendor
defaults (forum or support sources).

### Cited Findings
- **ATO rounding rules (R1):** two rules apply when an invoice has several taxable sales.
  - Total invoice rule: total the unrounded GST and round once, 0.5 cent up.
  - Taxable supply rule: GST per sale, "where a line's GST has more decimal places than your accounting system can
    store, you round it up or down", then add and round to the nearest cent.
  - "you and your customers don't need to use the same rounding rules."
  - Source: [ATO Tax invoices](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices)
- ATO eInvoicing calculates GST "by default using the total invoice rule" —
  [ATO guide to receiving eInvoices](https://www.ato.gov.au/api/public/content/23dcd77b380e47d4ba7e71d966c56502?v=ff6e9632) (R1)
- Statutory origin: s 9-90 rounding of GST, with an EM worked example —
  [EM Indirect Tax Legislation Amendment Act 2000](https://www.ato.gov.au/law/view/print?DocID=NEM/EM200027/NAT/ATO/00008&PiT=99991231235958) (R1)
- QuickBooks Online AU: software must use either the "Total invoice rule" or the "Taxable supply rule", and "QBO
  follows the 'Taxable supply rule'". The total is then adjusted from line-level tax amounts —
  [Intuit AU community/support](https://quickbooks.intuit.com/learn-support/en-au/gst-and-bas/gst-rounding-2cents/01/1113739) (search extract)
- QBO: "header-level tax is unavailable" (said in a Singapore thread, so not confirmed for AU) — same search, Intuit SG community
- Xero: users report that Xero calculates GST on each line, rounded to the nearest cent, and have filed ideas asking
  to "Round GST on subtotal only rather than line-by-line". No AU per-invoice setting found —
  [Xero idea: round GST on subtotal](https://productideas.xero.com/forums/967115-invoices-quotes/suggestions/51245653-invoice-round-gst-on-subtotal-only-rather-than-li);
  [Xero idea: AU manually edit GST](https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/47069233-au-manually-edit-au-gst-on-transactions)
- MYOB AccountRight recalculates GST line by line so that the cumulative GST on the taxable total so far is correct
  (a running-total method), and adjusts a line by a cent where needed —
  [MYOB community](https://myob.lithium.com/discussions/sales_and_purchases/invoice-comes-through-0-01-out-due-to-gst-rounding-how-do-i-fix-in-myob/658401);
  [MYOB idea: rounding on total amount](https://myob.lithium.com/idea/essentialsideas/sales-gst-rounding-to-be-done-on-total-amount-to-avoid-rounding-differences/161118).
  An integration vendor says MYOB "invoices don't have built-in fields for rounding adjustments" and recalculates
  line tax itself — [WorkGuru](https://support.workguru.io/support/solutions/articles/43000783373-rounding-with-myob)
- MYOB Advanced has a dedicated "GST Rounding" document —
  [MYOB Advanced GST Rounding PDF](https://help.myob.com.au/files/advanced/images/MYOB%20Advanced%20Business%20-%20GST%20Rounding.pdf)
  (could not be fetched; content unknown)
- Reckon users report that GST is calculated per line item —
  [Reckon community](https://community.reckon.com/discussion/comment/20616815/)

### Inferences
- **Recommended decision (Q8):**
  - Keep the **total invoice rule as the AU default**. It is the ATO's first-listed rule and the ATO eInvoicing
    default, and with LedgerForce's 4-dp storage it matches the taxable supply rule.
  - Offer a per-tenant **"per line (taxable supply rule, 2 dp)"** option. Every major AU SMB package works this way
    in practice, and customers migrating from Xero/QBO or matching supplier invoices will expect it.
  - Residual on the largest revenue line: acceptable, and it keeps the ROUNDING account out of sales documents.
  - The printed tax invoice must show the same line nets that the ledger posts.
  - Document the 1-cent differences against Xero/QBO-generated invoices as expected. The ATO explicitly allows
    supplier and recipient to differ.
- The MYOB "running total" variant (adjust the GST of the line that tips the cumulative rounding) gives the same
  total GST as the total invoice rule, but places the residual on the *last* line rather than the largest.
  [Inference from forum descriptions.]

### Gaps
- No official Xero Central or MYOB help article confirming the default was read (hosts blocked). The s 9-90 text was
  not read. Whether the Commissioner's "total invoice rule" and "taxable supply rule" sit in a legislative
  instrument or only in ATO guidance is unconfirmed [prior knowledge: ATO administrative guidance supporting s 9-90].

## Q4 — Adjustment and credit notes on the BAS

### Takeaway
**PARTLY CONFIRMED.** ATO guidance confirms three points:
- A price reduction or refund on an earlier sale is a **decreasing adjustment**, reported at **1B** (G18 on the
  worksheet) in the period in which you **become aware** of it.
- A valid **adjustment note** is needed before claiming a decreasing adjustment, unless the GST is **$75 or less**.
- If the note is not held at lodgement, the adjustment goes into the first BAS lodged after it is received.

The "same period → net into G1/1A" leg is an **inference** (Div 19 / s 29-20 [unverified — prior knowledge]); no ATO
text was found saying so explicitly. Software (Xero, QBO, Zoho) treats a credit note as a negative sale with the
sales tax code, dated on the credit note date. That reduces **G1 and 1A in the credit note's period regardless of
the original invoice's period**. The net GST payable is identical either way. Confidence: **medium**.

### Cited Findings
- Decreasing adjustments are reported at 1B (G18 if using the GST calculation worksheet); increasing adjustments at
  1A. ATO worked examples: a $108 discount on an earlier $3,600 sale, and a refunded ticket → decreasing adjustment
  of 1/11 of the refund —
  [ATO How to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments) (R1 and this round's extract)
- Timing: "include the adjustment in your activity statement for the tax period you become aware of the adjustment".
  If the adjustment note is not held, report "in the first BAS you lodge after receiving the adjustment note" —
  [ATO How to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments);
  [ATO adjustment notes](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/adjustment-notes)
- Adjustment note threshold: "you need a valid adjustment note before you can make a decreasing adjustment … unless
  the adjustment is for GST of $75 or less" —
  [ATO adjustment notes](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/adjustment-notes);
  [GSTR 2000/1](https://www.ato.gov.au/law/view/pdf?DocID=GST%2FGSTR20001%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-001c3.pdf&PiT=20101029000001) (R1)
- The ATO distinguishes adjustments from correcting GST errors. Errors also use 1A/1B, but the process is separate —
  [ATO completing your BAS to correct GST errors](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/correcting-gst-errors/completing-your-bas-to-correct-gst-errors)
- Xero: changes to transactions in a filed period flow into the next BAS as "prior period adjustments". Advice in
  community threads is to reduce 1B in the later period. Users note that the GST reconciliation does not
  auto-populate filed amounts —
  [Flying Solo: Xero correcting GST mistake](https://www.flyingsolo.com.au/forums/topic/xero-correcting-gst-mistake/);
  [Xero idea: GST reconciliation filed amounts](https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/49743143-gst-reconciliation-report-save-the-filed-amount)
- Third-party integrations report that credit notes "copy to Xero as GST on Income", which means negative sales on
  the sales tax rate — [Axcelerate community](https://support.axcelerate.com.au/hc/en-gb/community/posts/207549437/comments/210823707)
- Zoho Books AU: G1 is computed from "Invoices, Credit Notes, Invoice Payment and Credit Note Refund", so credit
  notes reduce G1 — [Zoho Books GST figures](https://zstatic.zohostatic.com/sa/books/kb/reports/gst-figures.md)
- A secondary source says Xero, MYOB and QBO label all corrections "credit notes" —
  [invoicedataextraction.com](https://invoicedataextraction.com/blog/australia-gst-adjustment-notes) (low quality)

### Inferences
- **Recommended decision (Q4):**
  - **Default ("software-compatible net" presentation):** the credit or adjustment note reduces G1 and 1A in the
    period of the note's date. This matches Xero, QBO and Zoho behaviour and what bookkeepers expect. The net amount
    payable (1A − 1B) equals the strict ATO presentation.
  - **Tenant setting "ATO adjustment presentation":** when the note relates to a sale attributed to an *earlier
    lodged* period, report its GST at **1B** (G18 on the worksheet) and leave G1 unchanged. This is the ATO-literal
    form and the proposed decision.
  - The proposal (same period → net; later period → 1B) is the most defensible against the ATO text, and is
    acceptable as the default if the product owner prefers strict over familiar.
  - Either way, this is a reporting-presentation choice with no tax-payable difference. Record it in an accounting
    ADR (human gate).
- Either way, the issued document must satisfy adjustment-note requirements: titled "adjustment note" (or
  equivalent), referencing the original tax invoice. The "≤ $75 GST no note" exemption applies only to the
  *recipient's* claim. The supplier should still always issue a note.
- If an increasing correction (debit note) arises in a later period, report it at 1A (increasing adjustment).

### Gaps
- No official Xero, MYOB or QBO AU help page read on credit notes in BAS. Vendor behaviour comes from community or
  integration sources plus the Zoho KB.
- ATO G1 instructions on whether G1 is reduced by adjustments were not read. Div 19, s 29-20 and s 29-75 text was
  not read.
- "Same period → no adjustment arises" remains **unverified — prior knowledge**.

## Bad debts (Div 21) and Stripe fees (s 29-10(3))

### Takeaway
**Bad debts CONFIRMED** (from ATO guidance; the Div 21 text was not read). On the accruals basis only, the
supplier's decreasing adjustment is 1/11 of the amount written off for a wholly taxable sale (reduced for partly
taxable sales). It arises when the debt is written off, or, if not written off, when it has been overdue for 12
months or more. It is reported at 1B (G18 on the worksheet). A recovery is an increasing adjustment at 1A.
- Adjustment note for bad debts: **probably not required**. The ATO requirement attaches to decreasing adjustments
  from adjustment events (Div 19). A write-off is not an adjustment event. Confidence: **medium** (conflicting
  extracts; Act text unread).

**Stripe fees CONFIRMED:** the input tax credit is attributable only to a period for whose return the tax invoice is
held at lodgement (s 29-10(3), GSTR 2013/1).
- Stripe issues a **monthly** tax invoice for GST on fees, available by the 10th of the following month.
- That invoice is built on balance transactions by **UTC "Created" timestamp**.
- Confidence: **high** for the rule; **medium** for Stripe mechanics (support-page extracts).

### Cited Findings
- Bad debts are their own adjustment type. They apply where you write off a bad debt on a taxable sale, or the debt
  has been overdue for 12 months or more; there are purchase-side equivalents and recovery rules; for partly taxable
  sales "the amount of the adjustment is reduced accordingly" —
  [ATO Types of adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/types-of-adjustments)
- Timing, 1/11 amount, 1B / G18, recovery at 1A, a written record of the write-off decision, accruals-only — R1
  citing [ATO How to make adjustments](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/making-adjustments-on-your-activity-statements/how-to-make-adjustments)
  and [GSTR 2000/2](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20002%2FNAT%2FATO%2F00001)
- Adjustment note for bad debts:
  - A secondary source says a supplier's bad-debt GST adjustment "is handled through the BAS without issuing an
    adjustment note" — [invoicedataextraction.com](https://invoicedataextraction.com/blog/australia-gst-adjustment-notes)
    (low quality).
  - An R1 extract of the ATO "How to make adjustments" page reportedly says the same.
  - The ATO general rule ("generally you need a valid adjustment note before you can make a decreasing adjustment")
    is stated without a bad-debt carve-out in this round's extracts — [ATO adjustment notes](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/adjustment-notes).
  - **Conflict not fully resolved.**
- Software caveat: one AU software help article warns that entering customer adjustments to write off a bad debt
  "will not reduce the GST collected on your BAS". A dedicated bad-debt tax treatment is needed —
  [Access Attaché help](https://intercom.help/access-attache-83d6d2/en/articles/17422082)
- Stripe:
  - "GST applies to all Stripe fees at the prevailing standard rate", added on top unless GST-inclusive pricing is
    agreed; "You will be provided with a monthly tax invoice for the GST that is charged on your Stripe fees" —
    [Stripe support AU](https://support.stripe.com/questions/goods-and-services-tax-gst-for-australia-based-businesses) (R1)
  - Tax invoices for fees are downloadable in the Dashboard (Documents, or Settings → Plans and fees → Invoice
    history), "available by the 10th" of the following month.
  - None is issued if tax details are missing or no tax applied that month.
  - The ABN is set under Tax Details —
    [Stripe: Download tax invoices for Stripe fees](https://support.stripe.com/questions/download-tax-invoices-for-stripe-fees?locale=en-GB);
    [Stripe: Tax invoices](https://support.stripe.com/questions/tax-invoices)
  - Invoices are based on balance transactions by their "Created" timestamp in **UTC**, not the "Available on"
    date — [Stripe: Global taxation of Stripe fees](https://support.stripe.com/questions/global-taxation-of-stripe-fees)
- s 29-10(3): to claim an input tax credit for a period, "you are required to hold a tax invoice when you give to the
  Commissioner a GST return for the period" — [GSTR 2013/1](https://www.ato.gov.au/law/view/document?docid=GST%2FGSTR20131%2FNAT%2FATO%2F00001) (R1)
- The ATO GST Industry Issues guide on merchant fees: an input tax credit is available "in the tax period in which
  they receive the tax invoice" —
  [ATO GIR Financial services ch13](https://www.ato.gov.au/law/view/pdf?DocId=GIR%2FFinancial-services-ch13&filename=law%2Fview%2Fpdf%2Fadhoc-sgml%2Fgstir-financial-services-ch13.pdf&PiT=99991231235958) (R1)

### Inferences
- **Recommended decision (bad debts):**
  - Confirm GP-007: accruals only; 1/11 × written-off amount (pro-rata for mixed-rate invoices); 1B or G18; recovery
    → 1A.
  - Cash basis: no BAS effect, and the ledger clears the never-remitted GST.
  - Do **not** require an adjustment note for a bad-debt write-off. Instead require a **write-off record**
    (approver, date, amount), which the ATO says is needed.
  - Add the "≥ 12 months overdue" trigger as a report or flag.
  - The recipient side (an unpaid bill 12 months overdue → increasing adjustment at 1A) is
    [unverified — prior knowledge] and needs its own card.
- **Recommended decision (Stripe):**
  - Post fee + GST per payout in the ledger.
  - Hold the 1B claim as **"pending tax invoice"** until the Stripe monthly invoice for that month is attached.
  - Group by **UTC month** to match Stripe's invoice. Fees created between 00:00 and 10:00/11:00 AEST/AEDT on the
    1st of a month belong to the *previous* month's Stripe invoice. For a monthly lodger, that boundary can cross a
    BAS period.
  - Reconcile the invoice GST against the sum of per-payout GST, and post any cent difference (the invoice wins).
  - Quarterly lodgers (BAS due the 28th of the month after quarter end) normally hold all three invoices by the
    10th, so 1B lands in the same quarter.
  - A late-received invoice → claim in the first later BAS. A 4-year time limit applies (s 93-5)
    [unverified — prior knowledge].
- Do not rely on the $82.50 / $75 no-tax-invoice exception for Stripe fees. A monthly invoice exists, and whether
  each fee is a separate supply is unclear.

### Gaps
- Div 21 sections (21-5, 21-10, 21-15, 21-20) and s 29-75 not read; whether the ATO adjustment-note rule
  carves out bad debts is unconfirmed from primary text.
- Not confirmed: whether the Stripe API `balance_transaction.fee_details` exposes AU GST as a separate `tax` entry
  (prior knowledge says yes, type `tax`, but unverified).
- Not confirmed: whether Stripe's monthly document carries every s 29-70 tax-invoice element.
- How Xero/MYOB handle bad debts on BAS (Xero: a credit note or write-off coded to a bad-debt account with GST) was
  not researched in this round. No source found.
