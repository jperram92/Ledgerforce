---
id: RQ-0176
title: Changing the ABA details of a company bank account, and archiving it, over HTTP — what may change, which controls apply (step-up, SoD, audit), and what archiving the remittance account does
status: answered
opened: 2026-11-16
resolved: 2026-11-16
opened_by: claude
linked_tasks: [T-0193, T-0185, T-0191]
linked_adrs: [ADR-0094, ADR-0084, ADR-0086, ADR-0080, ADR-0018, ADR-0025]
superseded_by:
---

# RQ-0176 — Company bank account: change ABA details, archive

## Question

T-0193 lets an Owner or Finance Admin set the APCA user id, ABA user name and FI mnemonic of an
existing company bank account, and archive an account (RQ-0166 finding 7). Questions:

- Q1. Which columns may `lf_app` change in place, and which stay immutable?
- Q2. Card open question: should archiving the designated remittance account be refused, or force
  a new designation (T-0191)?
- Q3. Does segregation of duties (design §6.5) apply to either change, or are permission, step-up
  and audit enough?
- Q4. Request shape and repeat semantics: may a field be cleared; what is a repeat; may an
  archived account be edited or archived again?

## Why it matters

The ABA details go into every batch payment file (RQ-0006); archiving retires an account that may
be printed on customer invoices (ADR-0079/0080) and that payment batches pay from. A grant that
lets the app rewrite where money comes from or goes to, or an archive that silently leaves a
retired account printed, would break design §6.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/db/migrations/0013_bank_accounts_statements.sql` | 2026-11-16 | source code | `GRANT UPDATE (name, status, csv_mapping) ON app.bank_account TO lf_app`; "lf_app may change only name, status and csv_mapping; new payment details are a new row". CHECKs: `apca_user_id ~ '^[0-9]{6}$'`, `aba_user_name` BECS 1–26, `aba_fi_mnemonic ~ '^[A-Z]{3}$'`. Partial unique index: one *active* bank account per GL account. |
| S2 | `Docs/research/RQ-0006-aba-direct-entry-format.md` (S1 there: APCA BECS Procedures App. C2/C7 field table) | 2026-11-16 | primary-derived | Type 0 (descriptive) record: pos 21–23 FI mnemonic of the *user's* FI, 31–56 user preferred name, 57–62 APCA/DE user id. Type 1 records: the payee's BSB/account (from the detail record), the trace BSB/account (where returns go) and remitter name (pos 97–112). |
| S3 | `packages/modules/ap/src/aba-export.ts` | 2026-11-16 | source code | The header uses `aba_fi_mnemonic`, `aba_user_name`, `apca_user_id`; the trace account is `bank.bsb` and the unsealed account number; payees come from `app.party_bank_account` (supplier bank details, maker-checker T-0055); only an `active` company account is used; the batch must be `released` (SoD + step-up). The remitter name is `aba_user_name`. |
| S4 | `packages/db/migrations/0072_ar_remittance_hardening.sql`, ADR-0086, RQ-0168 Q1 | 2026-11-16 | source code / ADR | `bank_account_remittance_release` (AFTER UPDATE OF status): a status change of the designated remittance account sets the designation to NULL in the same statement and writes `remittance_account.released` (masked). The settings guard refuses to designate a non-active account. Re-designation needs a new approved change, which notifies every Owner and Finance Admin. |
| S5 | Design §6.2 ("step-up re-authentication to … change bank details"), §6.5 rule 2 ("Supplier and employee bank details: requester ≠ verifier; 24-hour cooling-off …"), §6.6 (masked to last 3 digits), §6.8 (audit every mutation) | 2026-11-16 | primary (design) | As quoted. §6.5 names supplier and employee bank details and payment batches; the company's own ABA header fields are not listed. |
| S6 | ERPNext `bank_account.json` (develop), https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/bank_account/bank_account.json (fetched) | 2026-11-16 | open-source comparable | A company bank account has a `disabled` flag (archive) and editable fields; `write` permission for role "Accounts Manager"; no maker-checker and no re-authentication. |
| S7 | Odoo 18 `addons/account/models/account_journal.py`, https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_journal.py (fetched) | 2026-11-16 | open-source comparable | A bank journal's `bank_account_id` (`res.partner.bank`) is edited with the journal (`bank_acc_number` related, `readonly=False`); journals are archived (`active`), not deleted; access is by accounting-manager group, no maker-checker. |
| S8 | RQ-0166 findings 4–5 (OWASP ASVS 4.0.3 V3.7.1 / 5.0 7.5.1 fetched there), ADR-0084 | 2026-11-16 | primary (standard) / ADR | Re-authentication before sensitive account modifications; adding a company account: `settings.setup.manage` + step-up 300 s, no SoD because it redirects no money. |
| S9 | IETF HTTPAPI *Idempotency-Key* draft (RQ-0166 S5) | 2026-11-16 | primary (standard draft) | A resource may define the fingerprint; PUT is idempotent by HTTP semantics (RFC 9110 §9.2.2: "the intended effect on the server of multiple identical requests … is the same as the effect for a single such request"). |
| S10 | `packages/modules/bank/src/statements.ts:77`, `packages/modules/setup/src/wizard-validators.ts` | 2026-11-16 | source code | Statement import refuses an archived account; wizard step 4 counts only active accounts. History (statements, reconciliations) keeps pointing at the archived row. |

## Findings

1. **Only the three ABA header columns become updatable (Q1).** They describe the company to its
   own bank (S2 type 0). Where money goes (payees) comes from supplier bank details under SoD
   (S3); where returns go (trace BSB/number) comes from `bsb` and the sealed number, which stay
   immutable (S1). `bsb`, `account_name`, the number columns, `currency`, `gl_account_id`,
   `company_id` and the key columns keep no UPDATE grant: a changed number is a new account (the
   0013 rule), so the change is visible as a new row with its own audit and, for the invoices, a
   new maker-checker designation (S4).
2. **Archiving the remittance account releases it (Q2).** T-0191 already decided and built this
   in the database (S4): refusing would block retiring a closed account until someone first
   designates another (which needs a second approver), and leaving it designated would print a
   retired account. The release is fail-safe: invoices print no account until a new approved
   change, which notifies everyone. The route only reports it (`remittance_released: true`) so the
   screen can tell the user; nothing new is needed in the database.
3. **No SoD step for either change (Q3).** §6.5 rule 2 names supplier and employee details (S5).
   The ABA header cannot redirect a payment: the payee and trace accounts are outside these
   columns (finding 1), the bank refuses a file whose user id is not the uploader's, and every
   file comes from a released batch, which is itself SoD + step-up (S3). A wrong user name changes
   the remitter name payees see, a nuisance but not a diversion. Archiving moves no money and, for
   the remittance account, removes it from invoices (fail-safe). ERPNext and Odoo use a manager
   role only (S6, S7). LedgerForce applies `settings.setup.manage` + step-up 300 s (§6.2, S8) and
   a masked before/after audit row (§6.8): stricter than both comparables, consistent with
   ADR-0084. *Inference*: `packages/modules/AGENTS.md` "bank-detail … flows go through the SoD
   engine (design §6.5)" is read, as in RQ-0166 finding 5, as the §6.5 bank-detail rule.
4. **Request shape (Q4).** `PUT` replaces all three ABA fields together; each is required,
   because an ABA file needs all three (S3) and clearing one has no use (archiving retires the
   account). The same values again are 200 `changed:false` and write no `bank_account` audit row
   (S9; the request itself is still audited by the interceptor as every mutation is). An archived
   account cannot be edited (409 `BANK_ACCOUNT_ARCHIVED`; also refused by a trigger, so a path
   around the route cannot either). Archiving an archived account again is 200 `changed:false`.
   Re-activation is not offered (not in the card; the existing status grant and GL trigger are
   unchanged).

## Conclusion / decision

1. Migration 0074: `GRANT UPDATE (apca_user_id, aba_user_name, aba_fi_mnemonic) ON
   app.bank_account TO lf_app` (additive) and a trigger refusing a change of those columns on an
   archived row. All other columns stay immutable for `lf_app` (DB test).
2. `PUT /setup/bank-accounts/:id/aba {company_id, apca_user_id, aba_user_name, aba_fi_mnemonic}`
   and `POST /setup/bank-accounts/:id/archive {company_id}`: `settings.setup.manage`, step-up
   300 s, Idempotency-Key, audited with masked before/after; same state again 200
   `changed:false`; no SoD (finding 3).
3. Archiving the designated remittance account is allowed and releases it (ADR-0086, migration
   0072); the response says `remittance_released`.
4. Recorded in ADR-0094 (supersedes ADR-0084 in part: its consequence "APCA user id and ABA user
   name cannot be added to an existing account") and DL-0800..DL-0803.

## Confidence

`high` for Q1, Q2, Q4 (repository code, ABA field table, HTTP semantics); `medium` for Q3 (the
design's §6.5 wording is read to exclude the company's own ABA header; the comparables are less
strict than the chosen controls).

## Follow-ups

- ADR-0094; DL-0800..DL-0803; T-0193.

**Affects:** packages/db/migrations, packages/modules/bank, apps/api/src/setup, apps/web/src/settings.
