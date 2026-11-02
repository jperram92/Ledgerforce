---
adr: 0050
title: "Let customer-only parties hold verified bank details for refunds"
status: Proposed
date: 2026-11-02
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0050: Let customer-only parties hold verified bank details for refunds

## Status
Proposed — security category: stays Proposed until the product owner accepts it (AGENTS.md §6;
the DL-0263 delegation covers accounting ADRs only). Nothing in this ADR is implemented.

## Context and problem statement
T-0055 / UC-11 step 3 refunds a customer credit through the next payment batch (GP-006).
postings.md Q9 was resolved by the owner (DL-0256): customer refunds use the **supplier**
bank-detail verification and cooling-off (design §6.5 rule 2). T-0055 does exactly that through
`app.party_payment_eligibility`. But design §4.2 lists bank details for *suppliers and employees*
only, and migration 0012's `app.party_bank_account_holder_check` (pinned by
`packages/modules/parties/src/bank-accounts.db.test.ts`) refuses bank details for any other party.
So today a customer can be refunded by bank only if the party also carries the supplier role (one
party, several roles — design §4.2), and a customer-only party's refund is excluded from the batch
with `NO_VERIFIED_BANK_DETAILS` (DL-0288).

## Considered options
1. **Keep the rule** (status quo, implemented by T-0055): to refund by bank, give the customer the
   supplier (payee) role; its bank details then go through the full verification and cooling-off.
2. **Widen the holder rule to customers**: `CREATE OR REPLACE app.party_bank_account_holder_check`
   to allow an active `customer` role too, update design §4.2, and supersede the parties test
   that pins "only suppliers and employees" with one that pins the new set. Verification, sealing
   (ADR-0018) and cooling-off stay unchanged.
3. **A separate "refund payee" role**: a narrower role created for refunds only; more model, the
   same data held.

## Decision outcome
Proposed: option 2 — the owner's Q9 answer already treats customer refund bank details like
supplier ones; holding them under the customer role avoids a supplier role (and its AP
side-effects such as appearing in supplier lists) on pure customers. Until accepted, option 1
applies.

## Consequences
- More parties hold sealed bank details (privacy: collected only when a refund is requested by bank;
  same encryption, masking, verification and audit as suppliers).
- Migration (forward-only): replace the holder check function; no data change.
- Tests: supersede the parties holder test; T-0055's `customer-only` exclusion test then expects an
  eligible refund once details are verified.

## Links
- postings.md Q9 / DL-0256; design §4.2, §6.5 rule 2, §6.6; ADR-0018; DL-0288; T-0055.
