---
id: RQ-0166
title: Adding a company bank account over HTTP — safe repeats without a migration, and which controls apply (step-up, SoD, audit, masking)
status: answered
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0185]
linked_adrs: [ADR-0081, ADR-0084, ADR-0018, ADR-0030, ADR-0025, ADR-0079, ADR-0080]
superseded_by:
---

# RQ-0166 — Company bank accounts over HTTP: replay and controls

## Question

T-0185 adds `GET /setup/bank-accounts` and `POST /setup/bank-accounts` (setup wizard step 4).
Its open question, and the ones a security-sensitive write raises:

- Q1. A repeated create (network retry, double click) must not add a second bank account and
  must answer like the first. Can that be done without a migration (the card asks for no new
  table), and what is the replay record?
- Q2. Which access controls apply beyond `settings.setup.manage`: step-up re-authentication,
  segregation of duties (SoD)?
- Q3. What may the response, the audit row and error messages contain, given that the account
  number is sealed (ADR-0018) and masked to the last 3 digits everywhere (design §6.6)?
- Q4. ABA details (APCA user id, ABA user name) cannot be added to an existing account by
  `lf_app` (no UPDATE grant on those columns). Is that in scope?

## Why it matters

Bank details are the most fraud-prone data in an SMB ledger (design §6.1). A replay that creates
a second account, a route that leaks a clear number in a response or an audit row, or a missing
re-authentication on a bank-detail change would each break design §6.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/db/migrations/0013_bank_accounts_statements.sql` | 2026-11-15 | source code | `CREATE UNIQUE INDEX bank_account_active_gl_uq ON app.bank_account (tenant_id, gl_account_id) WHERE status = 'active'`: at most one active bank account per GL account. lf_app has `SELECT, INSERT` and `UPDATE (name, status, csv_mapping)` only. The trigger `bank_account_gl_check` refuses a GL account that is not an active, postable, non-control asset of subtype bank, or of another currency (`check_violation`). |
| S2 | `packages/modules/bank/src/bank-accounts.ts` | 2026-11-15 | source code | `createCompanyBankAccount` normalises the BSB to `NNN-NNN`, strips spaces from the number, seals it with AAD bound to tenant/company/row/field and stores `account_number_last3`; `listCompanyBankAccounts` returns `***` + last 3 and never decrypts; `revealCompanyBankAccountNumber` is reserved for ABA files and the remittance account (ADR-0018, ADR-0079). |
| S3 | `apps/api/src/settings/company-settings.controller.ts`, `apps/api/src/periods/close-checklist.controller.ts`, `apps/api/src/bank/bank-rec.controller.ts` | 2026-11-15 | source code | Repository precedent for idempotency without a key column: "the stored row is the replay record". `POST /setup/company/fiscal-years`: the same start again answers 200 `replayed:true`; any other overlap 409. Close checklist and bank reconciliation do the same with a natural key. |
| S4 | `audit.audit_log` grants, migrations 0003 and 0027 | 2026-11-15 | source code | lf_app has INSERT only on `audit.audit_log` ("no SELECT grant is added"), so the audit trail cannot serve as a key store. |
| S5 | IETF HTTPAPI WG, *The Idempotency-Key HTTP Header Field*, editor's draft, https://raw.githubusercontent.com/ietf-wg-httpapi/idempotency/main/draft-ietf-httpapi-idempotency-key-header.md (fetched) | 2026-11-15 | primary (standard draft) | "A resource MAY define what makes a key unique." "A resource MAY compute a fingerprint of the request payload … Field value match for selected element(s) in the request payload. If the fingerprint covers only part of the payload, requests that differ only outside that part are treated as the same request." Reuse with a different payload: "SHOULD reply with an HTTP 422"; a retry while the original is still processing: "SHOULD reply with an HTTP 409". |
| S6 | ERPNext `erpnext/accounts/doctype/bank_account/bank_account.py` (develop), https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/bank_account/bank_account.py (fetched) | 2026-11-15 | open-source comparable | A company bank account needs a non-group GL account of type Bank in the same company, and a second bank account on the same GL account is refused: "'{0}' account is already used by {1}. Use another account." Create/write is limited to Accounts Manager and Accounts User (bank_account.json permissions); no re-authentication. |
| S7 | Odoo 18 `odoo/addons/base/models/res_bank.py` and `addons/account/models/account_journal.py`, https://raw.githubusercontent.com/odoo/odoo/18.0/… (fetched) | 2026-11-15 | open-source comparable | `res.partner.bank` is unique on `(sanitized_acc_number, partner_id)` (the clear number, which Odoo stores unencrypted); a bank journal points to one company bank account. |
| S8 | Design §6.1 (threat table), §6.2 ("step-up re-authentication to release payment batches, change bank details or reopen a locked period"), §6.5 rule 2 (supplier and employee bank details: requester ≠ verifier, 24-hour cooling-off), §6.6 (envelope encryption; "masked in the UI (last 3 digits)"), §6.8 (audit every mutation) | 2026-11-15 | primary (design) | As quoted. §6.5's maker-checker names supplier and employee bank details; the company's own accounts are not in that rule. |
| S9 | ADR-0079 / ADR-0080, `apps/api/src/setup/remittance-account.controller.ts` (T-0180) | 2026-11-15 | source code / ADR | The money-redirection risk for the company's *own* accounts is which account is printed on customer invoices; that designation is maker-checker (settings.setup.manage + step-up 300 s + SoD `remittance_change.request/approve`). Adding an account does not designate it. |
| S10 | RQ-0165 S1/S2: OWASP ASVS 4.0.3 V3.7.1, ASVS 5.0 7.5.1 (fetched there) | 2026-11-15 | primary (standard) | Re-authentication or secondary verification "before allowing any sensitive transactions or account modifications"; full re-authentication before changing sensitive attributes (L2). |
| S11 | `apps/api/src/parties/bank-detail-changes.controller.ts` (T-0055) | 2026-11-15 | source code | Supplier bank-detail requests: `@RequireStepUp(300)`, 503 `kms_not_configured` without a key service, masked responses. |

## Findings

1. **A natural key already exists (Q1).** The database allows one active bank account per GL
   account (S1), exactly the rule ERPNext applies (S6). A create is therefore identified by
   *(company, GL account)*: whatever the Idempotency-Key, a second active account on that GL
   account can never be written. A key store is not needed and the audit log cannot be one (S4).
2. **Replay comparison without decrypting (Q1).** The stored row keeps every field of the request
   in clear except the number, of which it keeps the last 3 characters (S2). S5 allows a
   fingerprint of "selected elements": name, BSB, last 3 of the number, account name, currency,
   APCA user id, ABA user name, FI mnemonic. Equal → the same request: 200 with the stored account
   and `replayed: true`. Different → 409 `GL_ACCOUNT_IN_USE` (the account exists; the client must
   change the request, as ERPNext says "use another account"). Comparing the full number would
   need decryption, which ADR-0018 reserves for payment files and the remittance account; it is
   not widened for this. Residual case: a different number with the same last 3 and all other
   fields equal is answered as the existing account; the response and the screen show the stored
   masked number and say "was already there", so nothing is hidden (inference).
3. **Concurrent duplicates.** Two first requests racing both pass the check; the unique index
   refuses the second (23505). It is answered 409 `GL_ACCOUNT_IN_USE`, matching S5's 409 for a
   request still in flight; a retry then replays.
4. **Step-up (Q2).** Design §6.2 lists "change bank details" among step-up actions without
   limiting it to suppliers (S8); ASVS asks for re-authentication before sensitive account
   modifications (S10); the repository already applies 300 s to supplier bank-detail requests and
   the remittance designation (S9, S11). Adding a company bank account is a bank-detail change of
   the company: step-up 300 s applies. ERPNext and Odoo use roles only (S6, S7), so this is
   stricter than both.
5. **No SoD on add (Q2).** §6.5 rule 2 names supplier and employee bank details (S8). For the
   company's own accounts the payment-redirection path is the remittance designation, which is
   already maker-checker (S9). Adding an account moves no money and redirects none: ABA files
   are created from it only through payment batches, whose release is itself SoD + step-up.
6. **What leaves the server (Q3).** Responses use `listCompanyBankAccounts` (masked, S2). The
   audit row's `after` is that masked view. Validation messages of the module never echo the
   account number (only the BSB, which is public routing data). Database errors are mapped to
   fixed messages, never passed through (their detail can contain values).
7. **ABA details later (Q4).** `lf_app` cannot update `apca_user_id` / `aba_user_name` (S1).
   Allowing it is a grant change (a migration) and a bank-detail change with its own controls;
   out of this card's scope. Today an account without them can be archived and added again with
   them only through another route (archive has no HTTP route either). Follow-up card T-0193.

## Conclusion / decision

1. `POST /setup/bank-accounts` needs an Idempotency-Key (400 without) but keeps no key: the
   active bank account of the requested GL account is the replay record. Same selected fields →
   200 `replayed:true`; different → 409 `GL_ACCOUNT_IN_USE`; a lost race → 409 as well. No
   migration (migration 0075 is not used).
2. Access: `settings.setup.manage` + step-up 300 s; no SoD step. `GET` needs `settings.read`.
3. 503 `kms_not_configured` without a key service (ADR-0030); responses and the audit row are
   masked; mapped refusals: 400 (module validation), 404 `UNKNOWN_COMPANY` /
   `UNKNOWN_GL_ACCOUNT`, 422 `GL_ACCOUNT_NOT_BANK` (trigger), 409 `GL_ACCOUNT_IN_USE`.
4. Recorded in ADR-0084 (extends ADR-0081's route family) and DL-0700 to DL-0703; follow-up
   T-0193 (edit ABA details / archive over HTTP).

## Confidence

`high` for Q1, Q3 (repository code and the IETF draft); `medium` for Q2 (the design's wording
"change bank details" is read to include the company's own accounts; the stricter reading is
chosen).

## Follow-ups

- ADR-0084; DL-0700..DL-0703; T-0193.

**Affects:** apps/api/src/setup, apps/web/src/settings, packages/modules/bank.
