---
adr: 0094
title: "Company bank account: change the ABA details in place, or archive it, over HTTP (grant + step-up + audit, no SoD)"
status: Accepted
date: 2026-11-16
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: ADR-0084 (in part — its consequence that ABA details cannot be added to an existing account)
superseded_by: none
---

# ADR-0094: Company bank account — change the ABA details, or archive it, over HTTP

## Status

Accepted 2026-11-16 by claude (T-0193). It widens a database grant of a bank-detail table and
decides that no SoD step applies, so it is a security ADR; the product owner delegated security
decisions backed by research to the building agent (DL-0691). Research: RQ-0176. Decision log:
DL-0800..DL-0803. It supersedes ADR-0084 in part (the consequence "APCA user id and ABA user name
cannot be added to an existing account (no UPDATE grant): T-0193"); the rest of ADR-0084 stands.
It adds to ADR-0086 (it relies on its release trigger) and changes no route of ADR-0084.

## Context and problem statement

Wizard step 4 needs an active bank account with an APCA user id and an ABA user name, and ABA
payment files need the FI mnemonic too. `lf_app` may update only `name`, `status` and
`csv_mapping` of `app.bank_account` (migration 0013), and no route archives an account, so an
account added without its ABA details cannot be completed in the app, and a closed account cannot
be retired.

## Decision drivers

- Where money goes (payees, supplier bank details under SoD) and where returns go (trace BSB and
  sealed number) must stay out of reach of an in-place edit (RQ-0176 finding 1).
- Design §6.2 step-up for bank-detail changes; §6.6 masking; §6.8 audit every mutation.
- The designated remittance account must never print once archived (ADR-0086).

## Decision

1. **Migration 0076** (additive): `GRANT UPDATE (apca_user_id, aba_user_name, aba_fi_mnemonic) ON
   app.bank_account TO lf_app`, and a BEFORE UPDATE trigger `bank_account_aba_archived_guard`
   refusing (`check_violation`) a change of those columns on a row whose status is `archived`
   (old or new). `bsb`, `account_name`, the number columns, `currency`, `gl_account_id`,
   `company_id` stay without an UPDATE grant: a different number is a new account.
2. **`PUT /setup/bank-accounts/:id/aba`** `{company_id, apca_user_id, aba_user_name,
   aba_fi_mnemonic}` (all three required, validated as on create) — `settings.setup.manage`,
   step-up 300 s, Idempotency-Key. 200 `{account, changed}`; the same values again are
   `changed:false` and describe no `bank_account` audit entity. A change writes one audit row
   `entity_type: bank_account` with the masked `before` and `after` views.
3. **`POST /setup/bank-accounts/:id/archive`** `{company_id}` — same controls. 200 `{account,
   changed, remittance_released}`; an archived account again is `changed:false`. Archiving the
   designated remittance account is allowed: the 0072 trigger releases the designation and audits
   `remittance_account.released`; the response says `remittance_released: true`.
4. Refusals: 400 `idempotency_key_required` / `invalid_request`; 404 `UNKNOWN_COMPANY` /
   `UNKNOWN_BANK_ACCOUNT` (another company's or tenant's account too); 409
   `BANK_ACCOUNT_ARCHIVED` for an ABA change on an archived account; 401 `step_up_required`;
   403 without the permission. No KMS is needed (nothing is sealed or unsealed).
5. **No SoD step** for either route (RQ-0176 finding 3): the ABA header identifies the company to
   its own bank and cannot redirect a payment; files come only from released batches (SoD +
   step-up); archiving moves no money and removes a remittance account from invoices.
6. Re-activating an archived account is not offered over HTTP.

## Considered options

- Maker-checker (SoD) on ABA changes (rejected: §6.5 rule 2 names supplier and employee details;
  no money is redirected; batch release already has SoD).
- Refuse to archive the designated remittance account (rejected: blocks retiring a closed account
  behind a second approver; the release is fail-safe and audited, ADR-0086).
- Allow clearing an ABA field (rejected: no use; an ABA file needs all three).
- Grant UPDATE on the BSB / number too (rejected: changes where returns go in place; 0013 rule).
- Audit in a database trigger (rejected for this change: the API interceptor already writes one
  audit row per mutation in the same transaction, as for the add route; a trigger would write a
  second row).

## Consequences

- Wizard step 4 can be completed for an account added without ABA details.
- The SS-PLAT-39 assertion "lf_app may not change apca_user_id" follows this ADR: it now proves
  that the BSB, account name and number columns stay immutable (DL-0801).
- New public routes enter the route inventory (`routes.test.ts`).

## Links

RQ-0176, RQ-0166, ADR-0084, ADR-0086, ADR-0080, ADR-0018, ADR-0025, DL-0800..DL-0803, T-0193.
