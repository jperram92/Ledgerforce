---
id: RQ-0153
title: Wizard steps 3, 8 and 10 — GST basis and BAS frequency rules, the AR invoice settings, and any missing SoD threshold
status: answered
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0158]
linked_adrs: [ADR-0071]
superseded_by:
---

# RQ-0153 — Settings for wizard steps 3, 8 and 10

## Question

T-0158 adds the settings RQ-0149 Q2 found that no module stores (design §4.1 steps 3, 8, 10).

- Q1. What are the ATO rules for a company's GST accounting basis (cash or accruals): who may use
  the cash basis? Should the tax settings or the step 3 validator refuse a basis?
- Q2. What BAS (GST reporting) frequencies exist and who may use each? Is any combination of
  basis and frequency unlawful, so that the validator must refuse it?
- Q3. What do "invoice branding", "payment terms" and "payment methods" (design §4.1 step 8) need
  to store for the MVP, and what makes step 8 complete?
- Q4. Does design §6.5 name an approval threshold that `app.sod_settings` (migration 0021) does
  not have?

## Why it matters

Design §3.6 ("cash vs accrual GST basis is a company setting; the engine records both and the
report picks one"), §4.1 steps 3/8/10, §6.5. If the validator refused a lawful choice, a company
could not finish the wizard. If it accepted settings that cannot be used, the first invoice would
lack terms or a way to pay.

## Sources consulted

ato.gov.au cannot be fetched directly from this session (DNS blocked), the same as in RQ-0009.
The ATO facts below come from a WebSearch limited to `ato.gov.au`, whose results quote the
pages, and from RQ-0009, which used the same method.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method (via RQ-0009 S7) | 2026-10-24 | primary (extract) | Cash basis is allowed for small business entities (aggregated turnover **< $10 million**), for those that account for income tax on a cash basis, and otherwise with ATO permission. Non-business enterprises: GST turnover ≤ $2m. |
| S2 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst | 2026-11-13 | primary (search extract) | Reporting is monthly, quarterly or annual. "Unless you have a turnover over $20 million or we have directed you to report monthly, you may choose to report and pay monthly, quarterly or annually." |
| S3 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/when-and-how-to-report-and-pay-gst/monthly-gst-reporting | 2026-11-13 | primary (search extract) | Monthly is required at GST turnover of $20 million or more and optional below. The ATO can move a non-compliant business to monthly for at least 12 months. |
| S4 | https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/quarterly-gst-reporting | 2026-11-13 | primary (search extract) | Quarterly is the default below $20 million, with full reporting, Simpler BAS or GST instalments. |
| S5 | https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/reports-and-returns/gst-annual-return/eligibility-to-continue-reporting-gst-annually | 2026-11-13 | primary (search extract) | Annual reporting is open to businesses that registered for GST voluntarily, with GST turnover under $75,000 ($150,000 for not-for-profit bodies). Eligibility is assessed as at 31 July each year. |
| S6 | `Docs/solution-design/solution-design.md` §3.6, §4.1, §4.2, §6.5 | 2026-11-13 | primary (design) | Step 8 asks for "invoice branding, payment terms, payment methods (Stripe, bank transfer)". The party carries its own payment terms (§4.2). §6.5 lists six SoD rules and their thresholds. |
| S7 | `packages/db/migrations/0021_auth_sod.sql`, `0025_parties_bank_detail_change.sql`, `0035_ar_sales_invoice.sql`, `0045_ap_bill_inbox.sql`, `0051_payments_stripe_webhook.sql`; `packages/modules/tax/src/bas.ts` | 2026-11-13 | source code | `sod_settings` holds the bill, credit-note, journal and batch thresholds. `bank_detail_settings` holds the cooling-off hours (default 24). `ar_settings` is one row per company. `document_attachment` accepts only bill PDFs. `stripe_settings` holds the Stripe clearing account. `bas.ts` already takes `basis: 'accrual' \| 'cash'` per query. |

## Findings

1. **Basis (S1).** Accruals is always allowed. Cash is allowed below $10m aggregated turnover,
   for cash-basis income tax payers, or with ATO permission. LedgerForce does not store turnover
   or ATO permissions, so the eligibility conditions cannot be checked (inference).
2. **Frequency (S2–S5).** Monthly is open to everyone and required at $20m or more, or when the
   ATO directs it. Quarterly is open below $20m. Annual is open only to voluntary registrants
   under $75k ($150k for not-for-profits).
3. **Combinations (S1–S5).** Any basis can be combined with any frequency. A cash-basis business
   is under $10m, so it may report monthly, quarterly or (if eligible) annually. An accruals
   business may report at any frequency it qualifies for. Whether a choice is allowed depends
   on turnover, registration and ATO directions, and LedgerForce holds none of these (inference).
4. **Effective dating.** A change in reporting cycle or basis applies from the start of a tax
   period, and every monthly, quarterly or annual GST period starts on the 1st of a month
   (S2–S5; inference for substituted accounting periods, which the MVP does not support).
5. **Step 8 (S6, S7).** No table stores branding, default terms or accepted methods.
   `ar_settings` is the per-company AR row that RQ-0149 named as the owner. There is no image
   store: `document_attachment` is limited to bill PDFs by a CHECK.
6. **SoD (S6, S7).** The thresholds in §6.5 are $10,000 for two batch releasers, $1,000 for bill
   self-approval, and $5,000 for journal approval, plus credit-note self-approval (DL-0131). All
   are in `sod_settings`. The 24-hour cooling-off is in `bank_detail_settings` (DL-0160).
   "Creator ≠ releaser", "author ≠ activator" and "two approvers for reopen" are rules without
   amounts. **No threshold is missing.**

## Conclusion / decision

1. **Tax (Q1, Q2).** Add `app.tax_settings` to the tax module: per company, effective-dated
   (`effective_from` is the 1st of a month), `gst_basis` `cash | accrual`, `bas_frequency`
   `monthly | quarterly | annual`, plus who set it and when. Step 3 lists
   "The GST accounting basis (cash or accrual) has not been set" and "The BAS reporting
   frequency (monthly, quarterly or annual) has not been set" when no row is in force on the
   as-of date. **No basis/frequency combination is refused:** every pair is lawful for some
   business, and the eligibility facts (turnover, voluntary registration, ATO direction) are
   not data LedgerForce holds. The module's doc comment states the ATO conditions, so the UI
   card (T-0091) can show them as guidance.
2. **AR (Q3).** Extend `app.ar_settings` (additive columns):
   - branding: `brand_colour` (required, `#RRGGBB`), optional `brand_accent_colour`, and an
     optional logo (`logo` bytea + `logo_content_type` `image/png | image/jpeg`, at most
     512 KiB). SVG is refused because it can carry script. The logo is optional because many
     small businesses have none; the brand colour is what makes branding "set".
   - `default_payment_terms_days` 0–365 (net days after the invoice date). The party's own
     terms (design §4.2) come later and override it.
   - `accepted_payment_methods` text[], a non-empty subset of `bank_transfer`, `stripe`.
   Step 8 lists, in this order: branding not set; default payment terms not set; no accepted
   payment method; and "Stripe is accepted but is not set up (no Stripe clearing account)" when
   `stripe` is accepted and `stripe_settings` has no row. Bank transfer needs an active bank
   account, which step 4 already requires.
3. **SoD (Q4).** No new threshold. Step 10 is unchanged.
4. Using the new settings is left to follow-up cards: the default terms setting an invoice's due
   date, and the branding and methods printed on the invoice PDF. The BAS report already takes
   the basis per query.

## Confidence

`high` for Q4 and Q3 (repository code and design). `medium` for Q1 and Q2: these are primary
ATO pages, but read through search extracts. The design is hedged so that it does not depend on
the thresholds: nothing is refused on turnover.

## Follow-ups

- ADR-0071 (data model). DL-0550 to DL-0553.
- T-0164: default payment terms set the due date of new invoices (party terms win when present).
- T-0165: invoice PDF shows the branding and the accepted payment methods.
- Re-check the ATO thresholds ($10m, $20m, $75k/$150k) when ato.gov.au can be fetched directly.

**Affects:** packages/modules/tax, packages/modules/ar, packages/modules/setup (validators 3, 8),
migration 0067, design §3.6, §4.1.
