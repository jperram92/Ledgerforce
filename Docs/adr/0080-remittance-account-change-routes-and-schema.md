---
adr: 0080
title: "Remittance account: maker-checker change record, database guards and routes"
status: Accepted
date: 2026-11-15
author: claude
category: api
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0080: Remittance account: maker-checker change record, database guards and routes

## Status

Accepted 2026-11-15 by claude (T-0180). This ADR records the data model and public API that carry
out the controls of ADR-0079, which the product owner accepted (DL-0568, RQ-0150). It makes no new
security decision. Category api/data (design §10.6), so it is not a human gate. Recorded in DL-0630.

## Context and problem statement

ADR-0079 requires that:

- invoices print exactly one designated company bank account;
- setting or changing that account needs `settings.setup.manage`, step-up and a second person;
- every change is audited with masked values;
- the account number is decrypted only in the document render path.

This ADR answers four questions. How is the choice stored? How is maker-checker enforced so that no
code path can skip it? What routes does the API offer? How does the render path get the KMS?

## Decision drivers

- Payment redirection is the top risk (design §6.1). The control must hold in the database too,
  not only in the API guard, as it does for supplier bank details (migration 0025).
- Reuse the SoD engine and step-up exactly as supplier bank-detail changes do (ADR-0026, ADR-0025).
- Forward-only, additive schema (AGENTS.md §4).
- No clear number in any response, audit row, outbox event or stored record (ADR-0018).

## Considered options

1. **A change record plus a guard on the setting** (chosen). `app.remittance_account_change`
   records requested → approved | rejected. A trigger on `app.ar_settings` refuses any write of
   `remittance_bank_account_id` unless a change of that company to exactly that value was
   approved in the same transaction.
2. **A column only, guarded by the API.** Simpler, but any other code path could change where
   customers pay without a second person.
3. **Reuse `app.bank_detail_change`.** That table is for party accounts (suppliers, employees),
   with cooling-off and notices to remittance contacts. A company's own receiving account has
   none of these, and mixing the two would blur both sets of rules.

## Decision outcome

Option 1.

### Schema (migration 0071)

- `app.ar_settings.remittance_bank_account_id uuid NULL` with
  `FOREIGN KEY (tenant_id, company_id, remittance_bank_account_id) REFERENCES app.bank_account
  (tenant_id, company_id, id)`.
- `app.remittance_account_change`:
  - columns: id, company, `bank_account_id` (NULL = remove the account), `previous_bank_account_id`,
    status, requested_by/at, decided_by/at, `decided_xact`, reason;
  - RLS ENABLE + FORCE; lf_app SELECT/INSERT/UPDATE;
  - at most one requested change per company;
  - an insert needs an active account of the company; decided rows are final;
  - the trigger sets `decided_xact = pg_current_xact_id()` on approval.
- `ar_settings_remittance_guard`: the remittance column changes only if a change approved in this
  transaction names the new value.
- `remittance_account_change_sod`: a deferred constraint trigger. It refuses an approval by the
  requester at COMMIT, unless small-team mode is on and the SoD interceptor recorded the exception
  (`SOD_REMITTANCE_SELF_APPROVAL`). This mirrors 0025.
- SoD: steps `remittance_change.request` and `remittance_change.approve`, and rule
  `SOD_REMITTANCE_SELF_APPROVAL` (condition always, small-team exception allowed). They are
  mirrored in `packages/shared/src/sod/rules.ts`.

### Routes

| Route | Permission | Step-up | SoD | Answers |
|---|---|---|---|---|
| `GET /setup/remittance-account?company_id=` | `settings.read` | — | — | `{account, pending}` masked (`account_number: "***678"`); 404 for another tenant's company |
| `PUT /setup/remittance-account/changes/:id` `{company_id, bank_account_id \| null}` | `settings.setup.manage` | 300 s | `remittance_change.request` | 201 requested; 200 replay (same id, requester and target); 404 `BANK_ACCOUNT_NOT_FOUND`; 409 `CHANGE_PENDING`, `CHANGE_ID_CONFLICT`; 422 `BANK_ACCOUNT_ARCHIVED`, `NO_CHANGE` |
| `POST /setup/remittance-account/changes/:id/approve` `{company_id}` | `settings.setup.manage` | 300 s | `remittance_change.approve` | 200 approved (in force at once); 200 replay; 403 `sod_violation` for the requester; 409 `NOT_PENDING`, `STALE_REQUEST` |
| `POST /setup/remittance-account/changes/:id/reject` `{company_id, reason}` | `settings.setup.manage` | — | — | 200 rejected; 400 without a reason |

The client chooses the change id, which makes the request idempotent, as for refunds (ADR-0074).
Every new request, approval and rejection is audited as `remittance_account_change`. The audit row
holds masked accounts only.

### Render path

- `remittanceDetailsOf(trx, kms, companyId, {currency})` in `@ledgerforce/bank` opens only the
  designated, active account, and only in the invoice's currency.
- `loadInvoiceDocument(..., { kms })` fills `bankTransfer` when bank transfer is accepted.
- The template prints the fixed line `REMITTANCE_PHONE_CHECK` under the details.
- The worker builds the KMS with `kmsFromEnv`. Without one, invoices keep the T-0165 text
  ("available on request").

## Consequences

### Good

- No code path, including a direct SQL update by lf_app, can change the printed account without a
  second person's approval in the same transaction.
- The audit trail and the change records hold ids and masked values only.

### Bad / accepted trade-offs

- Rendering needs the KMS: `documents` depends on `@ledgerforce/bank` (a workspace package, not a
  third-party dependency), and the email handler takes an optional `kms`.
- Approving a change sets the account at once. There is no cooling-off, because the company's own
  receiving account has no third party to notify. The phone line on every invoice is the
  customer-side control (RQ-0150 F2).

## Compliance and verification

| Check | Where |
|---|---|
| Only an approval writes the setting; requester ≠ approver at COMMIT; small-team exception | `packages/modules/ar/src/remittance-account.db.test.ts` |
| Only the designated account is decrypted | `packages/modules/bank/src/remittance.db.test.ts` |
| Invoice prints the details, the reference and the phone line; the number is stored nowhere | `packages/modules/documents/src/invoice-pdf.db.test.ts`, `invoice-html.test.ts`, `packages/modules/email/src/invoice-email.db.test.ts` |
| Routes: permission, step-up, SoD, replay, masked audit, tenant isolation | `apps/api/src/setup/remittance-account.db.test.ts` |
| RLS on the new table | `packages/db/src/rls.db.test.ts` (generated) |
| SoD lists in SQL equal the TypeScript rules | `packages/db/src/sod.db.test.ts` |

## Links

- ADR-0079, ADR-0018, ADR-0025, ADR-0026, ADR-0074; RQ-0150; DL-0630 to DL-0634; T-0180, T-0183
