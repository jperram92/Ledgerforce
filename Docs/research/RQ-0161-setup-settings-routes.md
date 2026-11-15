---
id: RQ-0161
title: Which setup settings (wizard steps 1, 3, 4, 8, 10) already have HTTP routes, and what the missing ones must follow
status: answered
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0176, T-0185, T-0186]
linked_adrs: [ADR-0081]
superseded_by:
---

# RQ-0161 — HTTP routes for the setup settings screens

## Question

T-0176 asks for screens where an Owner or Finance Admin enters the settings that wizard steps 1,
3, 4, 8 and 10 check (`packages/modules/setup/src/wizard-validators.ts`). The card's open
questions:

- Q1. Which of these settings already have HTTP routes in `apps/api/src`?
- Q2. For the missing ones, which module functions exist, which permission applies, and what
  must the routes follow (idempotency, audit, masking, refusals)?
- Q3. Can any setting be changed in a way that harms the books (for example the base currency
  after journals exist)?
- Q4. How should the card be split?

## Why it matters

Missing routes are public API changes (design §10.6, needs an ADR). A setting that can be
changed after it has been used could make posted history wrong.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `grep -rn "@Controller\|@Get\|@Post\|@Put" apps/api/src --include=*.controller.ts` | 2026-11-15 | source code | Settings routes today: `GET/POST /sod/settings` (settings.read / settings.sod.manage), `PUT /accounts/system-roles/:role` (settings.chart.manage), `/setup/wizard`, `/setup/opening-balances`. `GET /companies` lists id, name, base_currency only. No route for company details, fiscal years, tax settings, tax codes, company bank accounts, number series, billing formats, invoice settings or Stripe settings. |
| S2 | `packages/modules/tax/src/tax-settings.ts`, `tax-codes.ts` | 2026-11-15 | source code | `setTaxSettings` (effective-dated from a month start, same date corrects), `taxSettingsOf`, `seedTaxCodes` (AU catalogue; a second run inserts nothing). |
| S3 | `packages/ledger/src/period.ts`, `period-matrix.ts`; migration 0018 | 2026-11-15 | source code | `generateFiscalYear(trx, {companyId, convention: {startMonth}, startYear})` inserts a year and twelve open monthly periods; the database refuses an overlapping year (`check_violation`) and fiscal years are never updated or deleted (lf_app has SELECT, INSERT only). |
| S4 | migrations 0002, 0015 | 2026-11-15 | source code | `app.company` has `legal_name`, `abn` (11 digits, `company_abn_checksum` CHECK), `base_currency` (ISO 4217 pattern); lf_app may UPDATE it. Nothing stops a base-currency change after journals exist. |
| S5 | `packages/modules/bank/src/bank-accounts.ts`; `apps/api/src/app.ts` (`kms` option) | 2026-11-15 | source code | `createCompanyBankAccount(trx, kms, companyId, input)` seals the number (ADR-0018) and validates BSB, number, APCA user id, ABA user name; `listCompanyBankAccounts` returns `***` + last 3. Routes that store bank details answer 503 `kms_not_configured` without a key service (ADR-0030). |
| S6 | `packages/modules/ar/src/invoice-settings.ts`, `packages/modules/documents/src/billing-formats.ts`, `packages/ledger/src/posting-engine.ts` (number series) | 2026-11-15 | source code | `setInvoiceSettings` (patch) and `invoiceSettingsOf`; `seedBillingFormats`; invoice numbers come from `app.number_series` code `AR-INV`. |
| S7 | `packages/shared/src/rbac/catalogue.ts` | 2026-11-15 | source code | `settings.setup.manage` and `settings.tax.manage` (Owner, Finance Admin), `settings.sod.manage` (Owner only), `settings.read` (also Accountant, Auditor). |
| S8 | `apps/api/src/gl/accounts.controller.ts` (T-0146), `apps/api/src/tenancy/tenant.interceptor.ts` | 2026-11-15 | source code | Precedent for a settings write: an Idempotency-Key is required, the same value again answers 200 `changed:false` and writes nothing; the interceptor writes one audit row per successful mutation with the handler's description. |
| S9 | Design §3.1 ("legal entity with its own base currency"), §4.1, §6.4–6.6 | 2026-11-15 | primary (design) | Base currency is a property of the legal entity that every journal of it is kept in; bank account numbers are masked to the last 3 digits. |

## Findings

1. Only step 10's approval amounts have a route (`/sod/settings`, S1). Steps 1, 3, 4 and 8 have
   module functions (S2, S3, S5, S6) but no route.
2. Each missing route can be a thin controller over an existing module function, as ADR-0075 did
   for the wizard. No table is missing for steps 1 and 3; no migration is needed.
3. The base currency is the currency every journal of the company is kept in (S9). Changing it
   after a journal exists would silently re-denominate posted history (inference). The database
   does not prevent it (S4), so the route must.
4. A fiscal year cannot be edited or removed once added (S3), so the route only adds one; an
   overlap is a refusal.
5. Idempotency for settings follows S8: the write is keyed and a repeat of the same values is a
   no-op answering 200.

## Conclusion / decision

1. Add thin settings routes under `/settings/*` (ADR-0081): company details and fiscal years
   (step 1, `settings.setup.manage`), tax settings and the standard tax codes (step 3,
   `settings.tax.manage`), then company bank accounts (step 4) and step 8's settings in
   follow-up cards. Reads need `settings.read`. Step 10 reuses `/sod/settings`.
2. The base currency can be changed only while the company has no journal entry: 409
   `BASE_CURRENCY_LOCKED` afterwards (DL-0641).
3. Split (Q4): T-0176 keeps steps 1 and 3; T-0185 step 4 (bank accounts); T-0186 steps 8 and 10.

## Confidence

`high`: every finding is from repository code and the design.

## Follow-ups

- ADR-0081, DL-0640 to DL-0642, cards T-0185 and T-0186.

**Affects:** apps/api/src/settings, apps/web/src/settings, design §4.1.
