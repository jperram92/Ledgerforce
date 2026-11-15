---
adr: 0079
title: "Print one chosen company bank account as the remittance account on customer invoices"
status: Proposed
date: 2026-11-15
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0079: Print one chosen company bank account as the remittance account on customer invoices

## Status

Proposed 2026-11-15 by claude (T-0165, RQ-0159). This is a **security** decision: it adds a
second permitted use of the bank-account decrypting call that ADR-0018 limits to payment files.
It stays Proposed until the product owner accepts it (AGENTS.md §6. The DL-0263 delegation does
not cover security). Nothing in this ADR is built yet. T-0165 ships the template support without
any decryption, and T-0180 builds the rest after acceptance.

## Context and problem statement

Design §4.1 step 8 lets a company accept bank transfer as a payment method. A customer can only
pay by transfer if the invoice shows the account name, BSB and account number of the company's
receiving account. RQ-0159 found:

- The company may have several bank accounts (`app.bank_account`), and nothing records which one
  receives customer payments. There is no default, primary or remittance flag, and no
  payment-instructions field in `app.ar_settings` (RQ-0159 S3, S4).
- Comparable systems keep an explicit choice: Odoo's per-invoice "Recipient Bank", defaulting to
  the company's first account, and ERPNext's company bank account flagged `is_default`
  (RQ-0159 S5–S7).
- The account number is envelope-encrypted (design §6.6, ADR-0018). The bank module documents
  `revealCompanyBankAccountNumber` as "Only for payment files (ABA, T-0054); never for display".
  Printing it on an invoice is a new disclosure path. Design §6.1 ranks payment redirection as the
  top risk: someone who could swap the printed account would divert customer receipts.

## Decision drivers

- Customers must be able to pay by bank transfer when the company accepts it (design §4.1 step 8).
- No guessing among several accounts. The account printed must be an explicit, audited choice.
- Keep ADR-0018's spirit: decrypt only where needed, never expose numbers in read APIs or the UI.
- Payment-redirection risk (design §6.1, §6.5 rule 2 applies the same idea to supplier accounts).
- Forward-only, additive schema (AGENTS.md §4).

## Considered options

1. **Remittance account setting + render-time decryption of that one account** (recommended).
2. **Free-text "payment instructions" in invoice settings** (the Xero/MYOB style): the user types
   the bank details as text.
3. **Pick automatically**: the only active account in the invoice currency, or none.
4. **Print masked details** (account name, BSB, last 3 digits) and no number.

### Option 1 — remittance account setting

- Good: one explicit choice, made in wizard step 8 and validated (active, same company, invoice
  currency). It is audited like the other settings.
- Good: the printed number is the encrypted number of a verified company account, so no second
  unencrypted copy exists.
- Bad: adds one decrypting use (rendering customer documents) next to payment files.
- Bad: needs a migration: nullable `app.ar_settings.remittance_bank_account_id` with a composite
  foreign key to `app.bank_account (tenant_id, company_id, id)`.

### Option 2 — free text

- Good: no decryption, and the simplest schema.
- Bad: a second, unencrypted, unverified copy of a bank account number. Anyone with settings
  access can change where customers pay with no link to a verified account. This is the
  redirection risk design §6.1 warns about.

### Option 3 — automatic pick

- Good: no new setting.
- Bad: ambiguous with several accounts, and it changes silently when an account is added. It
  still needs decryption.

### Option 4 — masked details

- Good: no decryption.
- Bad: a customer cannot pay with a masked number, so the method is unusable.

## Decision outcome

Proposed: **Option 1**.

1. Migration (lead, T-0180): `ALTER TABLE app.ar_settings ADD COLUMN remittance_bank_account_id
   uuid` (nullable) and `FOREIGN KEY (tenant_id, company_id, remittance_bank_account_id)
   REFERENCES app.bank_account (tenant_id, company_id, id)`. Additive only.
2. `setInvoiceSettings` accepts `remittanceBankAccountId`. It refuses an archived account, an
   account of another company, or (at render time) one whose currency is not the invoice's.
   Wizard step 8 lists "no remittance account" when `bank_transfer` is accepted and none is set.
3. Changing the remittance account is a bank-detail change for SoD purposes (design §6.5 rule 2
   by analogy): requester ≠ verifier, or small-team mode records the exception.
4. Decryption: a new `remittanceDetailsOf(trx, kms, companyId)` in the bank module may decrypt
   **only** the account named by `remittance_bank_account_id`, and **only** to build an invoice or
   statement document. ADR-0018's list of permitted uses becomes: payment files, plus the
   company's own remittance account on its customer documents. Read APIs and the UI stay masked.
5. Without a chosen account, the invoice keeps the T-0165 behaviour: the bank-transfer block asks
   for the invoice number as reference and says the bank details are available on request.

## Consequences

### Good

- Bank transfer becomes usable on invoices without a second copy of the number.
- The printed account is explicit, verified and audited.

### Bad / accepted trade-offs

- One more decrypting code path, limited to the company's own receiving account.
- Rendering needs the KMS, so the email handler and the document routes get a `kms` dependency.

### Follow-ups

- T-0180 (blocked until this ADR is accepted and the lead adds the migration).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Only the remittance account is decrypted, and only by the document path | T-0180 db test (`remittance.db.test.ts`) | verify.sh tests |
| Read APIs still return masked numbers | existing `packages/modules/bank/src/*.db.test.ts` | verify.sh tests |
| Without a remittance account the invoice prints no number | `packages/modules/documents/src/invoice-html.test.ts` (T-0165) | verify.sh tests |

## Links

- Design: §4.1 step 8, §6.1, §6.5, §6.6
- Research: RQ-0159
- Decision log: DL-0623
- Related ADRs: ADR-0018, ADR-0071, ADR-0048
- External sources: Odoo 18.0 `addons/account/models/account_move.py`; ERPNext `bank_account.json`
  (both retrieved 2026-11-15, see RQ-0159)
