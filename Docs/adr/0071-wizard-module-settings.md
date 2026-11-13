---
adr: 0071
title: "Store GST basis and BAS frequency in tax_settings, and invoice branding, terms and methods in ar_settings"
status: Proposed
date: 2026-11-13
author: claude
category: data
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0071: Store GST basis and BAS frequency in tax_settings, and invoice branding, terms and methods in ar_settings

## Status

Proposed 2026-11-13 by claude under design §10.6 (category data, no human gate). It becomes
Accepted on green CI and the cross-provider review of T-0158.

## Context and problem statement

Design §4.1 step 3 asks for the GST basis (cash or accrual) and the BAS frequency. Step 8 asks
for invoice branding, payment terms and payment methods (Stripe, bank transfer). RQ-0149 Q2
found that no module stores these settings and assigned them to **tax** and **ar**, never to
the wizard (ADR-0067). RQ-0153 resolved the rules: every basis/frequency pair is lawful for some
business, and eligibility depends on turnover and ATO facts that LedgerForce does not hold. It
also found that design §6.5 names no SoD threshold missing from `app.sod_settings`. New columns
and tables change the data model (design §10.6), so this ADR records them.

## Decision drivers

- One owner per setting. The wizard validators read it (ADR-0067).
- Effective dating for tax settings: a basis or frequency change applies from the start of a
  tax period (design §3.6, RQ-0153 finding 4).
- Forward-only, additive migration. RLS ENABLE + FORCE on tenant-owned tables (AGENTS.md §4).
- Do not refuse a lawful choice the system cannot verify (RQ-0153 finding 3).

## Considered options

1. **tax_settings table (effective-dated) + new columns on ar_settings.**
2. **One wizard-owned settings row** holding all five settings.
3. **Columns on app.company** for all five settings.

### Option 1

- Good: each setting lives with the module that will use it (the BAS report, invoicing).
- Good: tax settings keep their history by date.
- Bad: two places to read. This is accepted, because the validators already read many modules.

### Option 2

- Bad: ADR-0067 and RQ-0149 forbid wizard-owned copies of module settings.

### Option 3

- Bad: platform would own tax and AR concepts, and company columns are not effective-dated.

## Decision outcome

Chosen option: **Option 1**. The rules:

1. Migration `0067_tax_ar_wizard_settings.sql`. The owners are `@ledgerforce/tax` (table) and
   `@ledgerforce/ar` (columns).
2. `app.tax_settings`: `id`, `tenant_id`, `company_id`, `effective_from` date (the 1st of a
   month), `gst_basis` `cash | accrual`, `bas_frequency` `monthly | quarterly | annual`,
   `set_by` (nullable app user), `set_at`. It is unique on
   `(tenant_id, company_id, effective_from)`. RLS ENABLE + FORCE, a `tenant_isolation` policy,
   and lf_app SELECT, INSERT, UPDATE (no DELETE). The setting in force on a date is the row with
   the latest `effective_from` on or before it. Saving twice for the same date corrects that row
   (upsert). Saving a different date adds a row, so earlier periods keep their setting.
3. No basis/frequency combination is refused (RQ-0153 conclusion 1).
4. `app.ar_settings` gains these nullable columns, all checked by the database:
   - `brand_colour` and `brand_accent_colour`: `#RRGGBB`.
   - `logo` bytea and `logo_content_type` (`image/png | image/jpeg`, ≤ 512 KiB, both set or
     both null).
   - `default_payment_terms_days`: 0–365.
   - `accepted_payment_methods` text[]: a non-empty subset of `bank_transfer` and `stripe`,
     with no duplicates.
   The module checks the logo's magic bytes against its content type. SVG is not accepted.
5. Step 3 requires a tax setting in force on the as-of date. Step 8 requires `brand_colour`,
   `default_payment_terms_days`, at least one accepted method, and a Stripe clearing account when
   `stripe` is accepted. Step 10 is unchanged.
6. The module API: `setTaxSettings` / `taxSettingsOf` (tax), and `setInvoiceSettings` /
   `invoiceSettingsOf` (ar). Setup's validators call these readers.

## Consequences

### Good

- Steps 3 and 8 now check everything design §4.1 asks for. Nothing is duplicated.
- The BAS report can read the basis in force for a period instead of taking it as an argument
  (follow-up).

### Bad / accepted trade-offs

- The logo is stored in the settings row, so `SELECT *` would carry the bytes. Readers must
  select only the columns they need (the module does).
- The wizard cannot warn about an ineligible choice, such as annual reporting for a $1m company,
  because LedgerForce holds no turnover. The UI shows the ATO conditions as guidance.

### Follow-ups

- T-0164: default payment terms set the due date of new invoices.
- T-0165: the invoice PDF shows the branding and the accepted payment methods.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Steps 3 and 8 list each missing setting, then pass (SS-PLAT-121) | `packages/modules/setup/src/wizard-settings.db.test.ts` | `pnpm test:db` |
| CHECK constraints (month start, enums, colour, logo, terms, methods); module refusals | `packages/modules/setup/src/wizard-settings.db.test.ts` | `pnpm test:db` |
| RLS ENABLE + FORCE, policy, grants, cross-tenant isolation of `app.tax_settings` | `packages/db/src/rls.db.test.ts` (finds the table itself) | `pnpm test:db` |

## Links

- Design: §3.6, §4.1, §4.2, §6.5, §10.6
- Research: RQ-0153, RQ-0149, RQ-0009
- Decision log: DL-0550, DL-0551, DL-0552, DL-0553
- Related ADRs: ADR-0067
- External sources: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst (2026-11-13)
