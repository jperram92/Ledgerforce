---
id: RQ-0109
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-02
opened_by: claude
task: T-0080
---
# RQ-0109 — Opening balances at conversion: source type, date, period rules and open AR/AP items

## Question
Design §4.1 step 9: "Opening balances: trial balance at conversion date plus open AR/AP items (CSV or
Xero import)". The card T-0080 asks for the opening-balance posting source type and period rules. No
golden posting covers it (postings.md GP-001…GP-036). Specifically:
1. What date does the opening journal carry, and in which period may it post?
2. How do open AR/AP items enter the ledger so that ageing, statements and allocation work on them,
   given that control accounts accept postings only from their subledger (design §3.2)?
3. What happens when the trial balance does not balance, or the open items do not add up to the
   AR/AP balances in it?
4. What is the GST/BAS effect (accruals and cash basis)?
5. How is a wrong opening balance corrected?

## Findings (with sources)
1. **Date = the day before the conversion date.** The conversion date is the first day transactions
   are processed in the new system; conversion balances are the closing trial balance of the old
   system for the day before it (e.g. 31 December for a 1 January conversion). Sources: Digit,
   "Xero conversion balances setup guide"
   <https://digit.business/insights/xero/xero-conversion-balances-setup-guide>; Fastlane, "How to
   enter conversion balances in Xero"
   <https://fastlane-global.com/hk/blog/how-to-enter-conversion-balances-in-xero/>; Intuit, "Enter
   and manage opening balances in QuickBooks Online" (start date and the real balance for that day)
   <https://quickbooks.intuit.com/learn-support/en-ca/help-article/accounting-bookkeeping/opening-balance/L8MOSuna8_CA_en_CA>.
   After entry the trial balance is compared with the old system's at that date and the dates
   before conversion are locked (Digit, above).
2. **Open items exist one by one and must total the control balance.** Xero will not save conversion
   balances while receivables or payables are incomplete; unpaid invoices and bills must exist as
   individual documents so later payments can be matched (Digit, above; "Xero setup common mistakes"
   <https://digit.business/xero-tips/xero-setup-common-mistakes-businesses>). QuickBooks practice
   enters each unpaid invoice separately, Dr Accounts receivable / Cr Opening balance equity, so
   future payments are allocated correctly (Packt, "Professional tips and workarounds for QuickBooks
   Online", ch. 1
   <https://packtpub.com/product/professional-tips-and-workarounds-for-quickbooks-online/9781801810371>).
   MYOB tracks historical customer invoices that must match the receivables asset account's opening
   balance (MYOB community, "Setting up opening balances in MYOB Business"
   <https://myob.lithium.com/discussions/bus-acc/setting-up-opening-balances-in-myob-business/800908>).
3. **Imbalances: all three products plug them.** Xero posts an unbalanced difference to *Historical
   adjustment*, MYOB to *Historical balancing*, QuickBooks to *Opening balance equity*. Practitioners
   describe these accounts as a flag "that something is wrong without identifying what", carried
   unexamined for years (Digit, above; AccountEdge help "Historical balances"
   <https://help.accountedge.com/ae03/mac/accounts-21.htm>; MYOB community "Historical balancing
   account balance is incorrect"
   <https://myob.lithium.com/discussions/sales_and_purchases/the-historical-balancing-account-balance-is-incorrect/847776>;
   Intuit, above).
4. **GST.** Under the accruals basis GST on the open invoices and bills was attributed when they were
   issued or received — before conversion, in the old system's BAS. Under the cash basis GST is
   attributable to the period in which the consideration is received or paid, to the extent it is
   received (GST Act s 29-5; ATO "Identify your accounting basis"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/identify-your-accounting-basis>;
   RQ-0097 finding 2). So for a cash-basis business the GST inside an open opening item belongs to the
   BAS of the period in which it is later paid — in LedgerForce, not the old system. The GST account
   balances themselves come across as trial-balance lines.
5. **Corrections.** Each product lets the conversion balances be edited until transactions depend on
   them. LedgerForce posts immutably (design §3.3), so the equivalent is a reversal of the opening
   entry, which the engine already refuses once an item has been allocated (postings.md Q11 rule), and
   a new opening entry.

## Conclusion (what we build — T-0080, GP-037)
- **One journal, source type `ledger.opening_balance`** (stored `ledger_opening_balance`), period class
  `journal`, dated the **balance date = conversion date − 1 day**. It must fall in an **open** fiscal
  period (the module refuses `ar_locked` and later statuses even though the class would allow some:
  the entry moves AR and AP). The fiscal year covering the balance date must exist (otherwise the
  engine's NO_PERIOD).
- **Open items are the AR/AP control lines of that journal**: one AR_CONTROL line per open customer
  document and one AP_CONTROL line per open supplier document, each with its party and due date, so
  the posting engine writes one subledger open item per document (ageing by due date, statements,
  ledger `allocate()` all work unchanged). AR_CONTROL and AP_CONTROL accept `ledger_opening_balance`
  (a ledger change, as for `ar.*`/`ap.*`). The trial-balance amount for each control account must
  **equal the sum of its items**; the trial-balance row itself is not posted (the items are). No
  clearing account is needed, so nothing can be left in one.
- **No plug account.** Unlike Xero/MYOB/QuickBooks, an unbalanced trial balance or items that do not
  add up to the control balance are **refused** with the difference named; the user fixes the source
  data. This removes the "historical adjustment" balance practitioners warn about and keeps the
  balance invariant without a suspense entry.
- **No tax codes on opening lines.** The GST accounts' balances come across as plain lines; the
  opening entry has no BAS effect on either basis. Each item records its GST content
  (`gst_amount`, data only). Cash-basis BAS on later receipts/payments of opening items needs that
  content and is follow-up work (card T-0125); until then the limitation is stated in GP-037.
- **One live opening balance per company**, and no other posted entry dated on or before the balance
  date (the opening TB would double count it). Correction = reverse (engine refuses once allocated)
  and post again.
- **Inputs:** trial-balance rows by account code; items by CSV `party,document_no,document_date,
  due_date,amount,gst_amount` (signed amounts: a customer credit or supplier debit balance is
  negative), party matched by id, Salesforce Account id or unique legal name, holding the customer
  (AR) or supplier (AP) role. Base currency only in this card; foreign-currency items and Xero
  import are follow-up work (card T-0126).

## Status
answered — 2026-11-02 (claude). Accounting treatment approved under the standing delegation
(AGENTS.md §6, DL-0263) as GP-037; decision DL-0314.
