---
adr: 0081
title: "HTTP routes for the setup settings screens (company details, fiscal years, tax settings, tax codes)"
status: Proposed
date: 2026-11-15
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0081: HTTP routes for the setup settings screens

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. The category is
architecture, a public API change. It adds no permission (the catalogue already has
`settings.setup.manage`, `settings.tax.manage`, `settings.read`), no table, no migration and no
dependency, so it has no human gate. Steps 4 and 8 (T-0185, T-0186) extend this ADR's route
family under the same rules; each adds its routes to this record by a new ADR that supersedes it
or by an amendment section, never by editing the decided routes.

## Context and problem statement
The setup wizard (T-0091, ADR-0075) shows what steps 1, 3, 4, 8 and 10 are missing, but only
step 10's approval amounts can be entered over HTTP (`/sod/settings`). RQ-0161 found module
functions for everything else and no routes. T-0176 builds the screens; they need routes.

## Decision drivers
- Thin controllers over module functions (apps/api rules); no setting rule lives in the API
  except the guard RQ-0161 finding 3 requires.
- Every write: Idempotency-Key, one audit row (the interceptor), tenant transaction as lf_app.
- Another tenant's company is 404, as on the wizard routes.
- Posted history must never change meaning (design §3.1).

## Decision
Routes (JSON, money-free; dates `YYYY-MM-DD`):

1. `GET /settings/company?company_id=` (settings.read) →
   `{company_id, name, legal_name, abn, base_currency, base_currency_locked, fiscal_years:[{label, start_date, end_date}]}`.
   `base_currency_locked` is true once the company has a journal entry.
2. `PUT /settings/company {company_id, legal_name, abn, base_currency}` (settings.setup.manage,
   Idempotency-Key) → the view of 1 plus `changed`. The same values again: 200 `changed:false`,
   nothing written. Refusals: 400 malformed (legal name 1–200 characters, ABN 11 digits after
   removing spaces, ISO 4217 code), 422 `INVALID_ABN` (checksum, from `company_abn_checksum`),
   409 `BASE_CURRENCY_LOCKED` (a different base currency once a journal entry exists, DL-0641).
3. `POST /settings/company/fiscal-years {company_id, start}` (settings.setup.manage,
   Idempotency-Key; `start` is the 1st of a month) adds one fiscal year of twelve monthly periods
   through `generateFiscalYear` → 201 `{label, start_date, end_date, periods, replayed:false}`.
   A year with exactly that start already there: 200 with it and `replayed:true`. Any other
   overlap: 409 `FISCAL_YEAR_OVERLAP`. Fiscal years are never changed or removed here.
4. `GET /settings/tax?company_id=` (settings.read) →
   `{company_id, as_of, settings:{effective_from, gst_basis, bas_frequency}|null, codes:[{code, name, kind, rate, effective_from, effective_to, status}]}`;
   `as_of` is today in the tenant's report time zone; `rate` is a decimal string.
5. `PUT /settings/tax {company_id, effective_from, gst_basis, bas_frequency}`
   (settings.tax.manage, Idempotency-Key) through `setTaxSettings` → `{settings, changed}`.
   The same values for the same month again: 200 `changed:false`. 400 for anything the module
   refuses (`INVALID_TAX_SETTINGS`, with its message).
6. `POST /settings/tax/codes/standard {company_id}` (settings.tax.manage, Idempotency-Key) adds
   the standard Australian codes the company does not have (`seedTaxCodes`) →
   201 `{inserted}` when some were added, 200 `{inserted:0}` otherwise.

All writes answer 404 `UNKNOWN_COMPANY` for an unknown or other tenant's company and 400
`idempotency_key_required` without a key.

## Considered options
- One generic `PATCH /settings` over every module (rejected: mixes permissions and owners).
- Module routes under each module's prefix (`/tax/settings`, `/companies/:id`) (rejected for
  now: the screens are one Settings area; `/settings/*` keeps the permission story in one place).
- Allow the base currency to change at any time (rejected: re-denominates posted history).

## Consequences
- The wizard's steps 1 and 3 can be completed without the API by hand.
- New public routes to keep in the route inventory (`routes.test.ts` checks each declares access).

## Links
RQ-0161, ADR-0075, DL-0640, DL-0641, DL-0642, T-0176, T-0185, T-0186.
