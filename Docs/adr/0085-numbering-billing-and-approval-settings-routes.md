---
adr: 0085
title: "HTTP routes for numbering and billing (wizard step 8); Idempotency-Key required on POST /sod/settings (step 10)"
status: Proposed
date: 2026-11-15
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0085: Numbering and billing routes; a key on the approval-amounts route

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. Category architecture (a
public API change). It extends ADR-0081's `/setup/*` route family by this separate record, as
ADR-0081 says step 8 must; ADR-0081 is not edited. No new permission, table, migration or
third-party dependency, so no human gate. `apps/api` gains the workspace package
`@ledgerforce/documents` (internal, DL-0712).

## Context and problem statement
Wizard step 8 checks an active `ar_invoice_document` number series, an active billing format,
a brand colour, default payment terms, accepted payment methods and, when Stripe is accepted, the
Stripe clearing account (RQ-0167 S4). None of these can be set over HTTP, and no production code
creates a number series (RQ-0167 finding 1). Step 10's approval amounts have `POST /sod/settings`,
which is the only settings write without an Idempotency-Key (RQ-0167 S8).

## Decision drivers
- Thin controllers over module/ledger functions; the ledger owns `app.number_series`.
- A number series' prefix and width never change once a number is issued (design §3.4, the
  0010 guard); the API says so instead of letting the database abort the transaction.
- Every mutating endpoint requires an Idempotency-Key and is replay-safe (apps/api rules,
  DL-0642); one audit row per change.

## Decision
Routes under `/setup/billing` (JSON; no money):

1. `GET /setup/billing?company_id=` (settings.read) →
   `{company_id, series:[{code, prefix, pad_width, next_number, issued, status}],
   formats:[{code, name, posted, status}], invoice:{brand_colour, brand_accent_colour,
   default_payment_terms_days, accepted_payment_methods, has_logo}, stripe:{clearing_account_id}|null,
   clearing_accounts:[{id, code, name}]}`. `series` lists the company's `ar_invoice_document` and
   `ar_credit_note_document` rows that exist; `next_number` is the number the next document will
   get; `clearing_accounts` are the company's active, postable, non-control asset accounts.
2. `PUT /setup/billing/series {company_id, code, prefix, pad_width}` (settings.setup.manage,
   Idempotency-Key) through the ledger's `defineNumberSeries`: `code` is `ar_invoice_document` or
   `ar_credit_note_document`; `prefix` 0–20 of `A–Z a–z 0–9 - / _ .`; `pad_width` 1–18. Creates
   the series, or changes prefix/width while no number has been issued →
   `{series, changed}` (200). The same values again: `changed:false`, nothing written. Different
   values after a number was issued: 409 `NUMBER_SERIES_IN_USE`.
3. `POST /setup/billing/formats/standard {company_id}` (settings.setup.manage, Idempotency-Key)
   adds the AU catalogue formats the company lacks (`seedBillingFormats`) → 201 `{inserted}`,
   or 200 `{inserted:0}`.
4. `PUT /setup/billing/invoice {company_id, brand_colour, default_payment_terms_days,
   accepted_payment_methods, brand_accent_colour?}` (settings.setup.manage, Idempotency-Key)
   through `setInvoiceSettings` → `{invoice, changed}`; 400 `INVALID_INVOICE_SETTINGS` with the
   module's message.
5. `PUT /setup/billing/stripe {company_id, clearing_account_id}` (settings.setup.manage,
   Idempotency-Key) through the Stripe connector's `setStripeSettings` (payout fields untouched)
   → `{stripe, changed}`; 422 `INVALID_CLEARING_ACCOUNT` unless the account is one of
   `clearing_accounts`.

All writes: 404 `UNKNOWN_COMPANY` for an unknown or other tenant's company, 400
`idempotency_key_required` without a key, 400 `invalid_request` for a malformed body.

6. `POST /sod/settings` (unchanged otherwise, ADR-0026) now requires an Idempotency-Key, checked
   before the body: 400 `idempotency_key_required` and nothing written. The key is not stored:
   the route stays replay-safe by state (the current values again answer 200, no new row).

## Considered options
- Number series inserted by the API controller directly (rejected: the ledger owns the table).
- One `PUT /setup/billing` for everything (rejected: four owners — ledger, documents, ar, stripe
  connector — and four refusal kinds in one request).
- Stripe settings under a `/payments` prefix (rejected for now: one setup area keeps the
  permission story with ADR-0081).
- Leave `/sod/settings` keyless because it is state-idempotent (rejected: apps/api rule; no
  non-test caller, RQ-0167 finding 3).
- A key store table (rejected: needs a migration; every route converges on its requested state).

## Consequences
- Wizard step 8 and step 10 can be completed from screens.
- Any client of `POST /sod/settings` must send an Idempotency-Key (only tests did; updated).
- Logo, accent colour and Stripe payout accounts on screen follow in T-0195; the key on
  `POST /sod/exceptions/weekly/acknowledge` in T-0196.

## Links
RQ-0167, RQ-0161, ADR-0081, ADR-0071, ADR-0026, DL-0710 to DL-0714, T-0186.
