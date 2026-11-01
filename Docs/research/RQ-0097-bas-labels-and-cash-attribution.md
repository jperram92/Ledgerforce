---
id: RQ-0097
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-01
opened_by: claude
task: T-0035
---
# RQ-0097 — BAS labels per tax code, and how GST is attributed on the cash basis

## Question
T-0035 needs, for a period, G1/G2/G3/G4/G10/G11/1A/1B/W1/W2 on the accruals and the cash basis.
1. What does each label hold, and which are lodged vs worksheet-only (G13/G14)?
2. On the cash basis, how much of a document's GST belongs to a period with a part payment?
3. What do W1 and W2 hold?
4. How do adjustments (bad debts, credit notes) appear on each basis?

## Findings (with sources)
1. **GST labels.** G1 total sales (GST-inclusive when the calculation worksheet method is used —
   "you must include GST in amounts you report at all labels … if you are using the calculation
   worksheet method"); G2 export sales (GST-free); G3 other GST-free sales; G4 input-taxed sales;
   G10 capital purchases (including GST); G11 non-capital purchases (including GST); G13
   purchases for making input-taxed sales and G14 purchases without GST in the price are
   **worksheet-only**: kept in records and used to calculate 1B, not reported on the BAS form;
   1A GST on sales, 1B GST on purchases. Sources: ATO "Complete your BAS"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/complete-your-bas>;
   ATO "Step 4 – calculating purchases using the calculation worksheet"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/managing-gst-in-your-business/reporting-paying-and-activity-statements/completing-your-bas-for-gst/complete-your-bas/step-4-calculating-purchases-using-the-calculation-worksheet>;
   corroborated by a vendor guide (Wiise "Understand BAS calculation sheet"
   <https://docs.wiise.com/understand-bas-calculation-sheet>). An older ATO page asked for G13 on
   the BAS; the current page governs.
2. **Cash basis.** GST on a sale (credit on a purchase) is attributable to the period in which the
   consideration is received (paid), "but only to the extent that the consideration is received in
   that tax period"; a part payment attributes only that part. Sources: ATO "Identify your
   accounting basis"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/identify-your-accounting-basis>;
   ATO "Choosing an accounting method"
   <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method>;
   GST attribution determinations on legislation.gov.au (e.g. F2017L00346). The proportional
   formula (payment ÷ total consideration × GST) is our reading of "to the extent"; no ATO worked
   example was found — recorded as an inference.
3. **W1/W2.** W1 total gross salary, wages and other payments from which withholding is usually
   required; W2 the amounts withheld from W1 payments. Pre-filled from Single Touch Payroll, so the
   payroll provider is the source of truth. Source: ATO "PAYG withholding" (BAS)
   <https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding>;
   ATO PAYGW pre-fill <https://www.ato.gov.au/businesses-and-organisations/hiring-and-paying-your-workers/single-touch-payroll/ato-payg-withholding-pre-fill-for-activity-statements>.
4. **Adjustments.** Decreasing adjustment (bad debt written off) at 1B, increasing (recovery) at 1A,
   accruals only — a cash-basis entity never reported the GST (RQ-0090 finding 1, GP-024/GP-026).
   Credit notes default to netting into G1/1A in the period issued (DL-0256 Q4, GP-029, as Xero
   and QuickBooks); the ATO-adjustment presentation is a later setting.

## Conclusion
- Labels come from the tax code's `sales_labels` / `purchase_labels` (migration 0032). A line with a
  tax amount is a **base line**: on an income account it is a sale (signed credit − debit), on any
  other account a purchase (signed debit − credit); its G labels receive net + GST, 1A/1B the GST.
  A line coded with an `adjustment` code and no tax amount *is* the GST adjustment: a debit is a
  decreasing adjustment (purchase labels → 1B), a credit an increasing one (sales labels → 1A).
- **Accruals:** posted lines by entry date in the period (voids net out through their reversal).
- **Cash:** a document with an AR/AP open item is attributed in proportion to **cash** settled in
  the period — allocations whose counterpart is a receipt, refund, card charge or supplier payment —
  over its original amount. Credit notes, write-offs and voids settled against it are not cash, so
  an unpaid invoice later credited or written off never reaches the cash BAS. Adjustment lines are
  accruals-only. A tax-bearing document without an open item (a cash sale through the bank) is
  attributed on its entry date.
- **W1/W2** from payroll pay-run journals: W2 = PAYG withholding credited; W1 = net wages payable +
  PAYG withheld (gross from which withholding applies). Final values come from STP pre-fill.
- Labels G2/G3/G4 and the worksheet G13/G14 are now confirmed; `AU_TAX_CODES` drops `verify` for
  GST-free, export and input-taxed. GST on imports keeps `verify: true` (deferred-GST and import
  rules not researched).
- Amounts are returned in cents (half-up) per label; the BAS form's whole-dollar presentation is
  the Phase 1 report's job.
