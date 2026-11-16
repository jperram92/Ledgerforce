---
adr: 0084
title: "HTTP routes for the company bank accounts settings screen (setup wizard step 4)"
status: Proposed
date: 2026-11-15
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0084: HTTP routes for company bank accounts (setup wizard step 4)

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. Category architecture (a
public API change). It extends the route family of ADR-0081 by a new record, as ADR-0081 asks;
it changes no decided route of ADR-0081. It adds no permission, no table, no migration and no
dependency, and it widens no decryption use of ADR-0018, so it has no human gate. Its security
controls apply existing decisions (ADR-0018, ADR-0025, ADR-0030) and are researched in RQ-0166.

## Context and problem statement
Wizard step 4 needs at least one active company bank account, and one with an APCA user id and an
ABA user name for batch payment files. The bank module has `createCompanyBankAccount` (sealed
number) and `listCompanyBankAccounts` (masked) but no route. T-0185 builds the screen.

## Decision drivers
- Bank details are fraud-prone (design §6.1); numbers sealed at rest and masked to the last 3
  digits in every response, log and audit row (§6.6, ADR-0018).
- Every write: Idempotency-Key, same result on replay, one audit row, tenant transaction as lf_app.
- No migration (card constraint): the replay record must be data that already exists.

## Decision
Under the API's `setup` prefix:

1. `GET /setup/bank-accounts?company_id=` (settings.read) →
   `{company_id, base_currency, kms_configured, accounts:[{id, name, gl_account_id, gl_account_code, gl_account_name, currency, bsb, account_name, account_number, apca_user_id, aba_user_name, aba_fi_mnemonic, status}], gl_accounts:[{id, code, name, currency, in_use}]}`.
   `account_number` is `***` + the last 3 characters. `gl_accounts` lists the company's active,
   postable, non-control asset accounts of subtype bank; `in_use` is true when one already has an
   active bank account.
2. `POST /setup/bank-accounts {company_id, gl_account_id, name, bsb, account_number, account_name, currency, apca_user_id?, aba_user_name?, aba_fi_mnemonic?}`
   (settings.setup.manage, step-up 300 s, Idempotency-Key, audited) through
   `createCompanyBankAccount` → 201 `{account, replayed:false}`.
   - Replay (RQ-0166): the GL account's active bank account is the replay record. If its name,
     BSB, last 3 of the number, account name, currency, APCA user id, ABA user name and FI
     mnemonic equal the request's (after the module's normalisation, `sameCompanyBankAccount`),
     200 `{account, replayed:true}` and nothing is written; otherwise 409 `GL_ACCOUNT_IN_USE`.
     A concurrent duplicate refused by the unique index is 409 `GL_ACCOUNT_IN_USE` too.
   - Refusals: 400 `idempotency_key_required`; 400 `invalid_request` (malformed or the module's
     validation message); 404 `UNKNOWN_COMPANY` / `UNKNOWN_GL_ACCOUNT`; 422 `GL_ACCOUNT_NOT_BANK`
     (the database trigger: not an active postable non-control bank asset, or another currency);
     503 `kms_not_configured` without a key service (ADR-0030); 401 `step_up_required`.
   - The audit row (`entity_type: bank_account`) carries the masked view only. No response,
     message or audit row contains the clear number; database errors map to fixed messages.
   - No SoD step: adding an account redirects no money; the account printed on invoices is
     chosen through the maker-checker remittance routes (ADR-0080).

## Considered options
- A key store table (rejected for this card: needs a migration; the unique index already
  identifies the request).
- Derive the row id from the key (uuid v5 of tenant, company and key) (rejected: changes the
  module's id scheme for one route and still cannot compare the number without decrypting).
- Decrypt the stored number to compare a replay in full (rejected: widens ADR-0018's decryption
  uses; the masked comparison is shown to the user, RQ-0166 finding 2).
- SoD maker-checker on adding (rejected: design §6.5 rule 2 names supplier and employee details;
  remittance designation already carries it).
- No step-up (rejected: design §6.2 "change bank details", ASVS V3.7.1).

## Consequences
- Wizard step 4 can be completed in the app.
- APCA user id and ABA user name cannot be added to an existing account (no UPDATE grant): T-0193.
- New public routes enter the route inventory (`routes.test.ts`).

## Links
RQ-0166, ADR-0081, ADR-0018, ADR-0025, ADR-0030, ADR-0080, DL-0700..DL-0703, T-0185, T-0193.
