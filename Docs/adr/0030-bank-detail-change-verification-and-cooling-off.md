---
adr: 0030
title: "Bank-detail change verification: database-enforced workflow, requester ≠ verifier at commit, step-up proof, cooling-off eligibility and durable notices"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0030: Bank-detail change verification with cooling-off

## Status

Proposed — security category, waiting for product-owner acceptance. It builds on ADR-0018
(envelope-encrypted bank details), ADR-0025 (MFA and step-up) and ADR-0026 (SoD engine) without
changing them. It adds three public routes and their error contract. T-0053 is built to this
proposal so it can be judged on working, tested code. Research: RQ-0034.

## Context and problem statement

Design §6.1 names payment redirection (changed supplier bank details) as the top real-world
threat. §6.5 rule 2: "requester ≠ verifier; 24-hour cooling-off before a changed account can be
paid; automatic notice to the party's previous remittance contact"; §6.2: step-up to change bank
details; §6.1: out-of-band confirmation. Migration 0012 (T-0037) stored bank accounts with a
`status`, but `lf_app` could insert any status and update it freely, so application code could
make an unverified account active. The questions: where the rules are enforced, how the
verifier's step-up and the small-team exception are honoured there, what "previous contact"
and "cooling-off" mean in data, and what payment batches (T-0054) call.

## Decision drivers

- A single bug or bypass in application code must not let an unverified account be paid.
- Requester ≠ verifier applies to every role, the Owner included (RQ-0012 item 7 d).
- Small-team mode (ADR-0026) must still work, visibly.
- The cooling-off is configuration, measured by the database clock.
- No dependency on work in flight (outbox T-0030, email T-0042, payment batches T-0054).

## Considered options

### Option A — rules in the API only (SoD engine + route checks)

Simple, but `lf_app` keeps write access to the tables: any other code path (a job, an import,
a later route) could activate an account without verification.

### Option B — rules in the database, the API in front (chosen)

The tables are written only by SECURITY DEFINER functions with the checks inside; guards bind
every role; the API keeps the user-facing checks (permission, step-up, SoD engine) and maps
database refusals to HTTP answers.

### Option C — a separate approvals service

Out of scope for the MVP and duplicates the SoD engine.

## Decision outcome

Chosen: **Option B**.

1. **Workflow table** `app.bank_detail_change`: requested → verified | rejected, one open change
   per party, `lf_app` SELECT only. Functions `app.bank_detail_change_request`, `…_verify`,
   `…_reject` (SECURITY DEFINER, search_path pinned, FORCE RLS still applies to the owner).
   The first account of a party also goes through it (a change from "no account").
2. **Request** checks `parties.bank_account.change_request` (mirrored in SQL), that the actor
   entered the pending account, and a fresh step-up; it snapshots the active account and the
   party's remittance contacts (with an email) at that moment.
3. **Verify** checks `parties.bank_account.verify` (Owner), a fresh step-up and a mandatory
   out-of-band confirmation note; sets `payable_from = verified_at + cooling_off_hours` by the
   database clock (hours frozen on the row); supersedes the old account; activates the new one;
   writes one `app.bank_detail_change_notice` per snapshotted contact (or one `no_recipient`
   notice), masked details only; audits.
4. **Requester ≠ verifier at COMMIT**: a deferred constraint trigger refuses a verification by
   the requester unless small-team mode is on and an `app.sod_exception` row for
   `SOD_BANK_DETAIL_SELF_VERIFY`, this change and this actor exists by COMMIT (the SoD
   interceptor writes it after the handler, ADR-0026). Spike RQ-0034 S6.
5. **Step-up proof in the database** (defence in depth): the API passes the acting session id;
   the function requires it to be the actor's own, active, unrevoked, current-epoch, not
   expired or idle, MFA (`amr` mfa/otp/hwk or the default MFA `acr`) and `auth_time` at most
   300 s old. A deployment that maps MFA to another `acr` fails closed until the function is
   extended. The API's ADR-0025 check stays authoritative for the user-facing answer.
6. **Account guard** on `app.party_bank_account`: new rows are `pending_verification`; `active`
   only with a verified change for that row; `superseded`/`archived` are final; at most one
   active account per party.
7. **Cooling-off configuration** `app.bank_detail_settings` (history, latest wins): default
   24 h, range 1–720 h, Owner only (`settings.sod.manage`), audited.
8. **Eligibility contract** for payment batches: `app.party_payment_eligibility(uuid[])` →
   per party `eligible`, `reason` (`BANK_DETAILS_COOLING_OFF` | `NO_VERIFIED_BANK_DETAILS`),
   the active verified account and `payable_from`; module wrapper `paymentEligibility`.
9. **API** (all under TenantInterceptor):
   - `POST /parties/:partyId/bank-accounts` `{bsb, account_number, account_name}` →
     201 `{id, party_id, status:'requested', bank_account:{…masked}}`; permission
     change_request, step-up 300 s, SoD step `bank_detail_change.request` (subject = a
     server-chosen change id).
   - `POST /bank-detail-changes/:changeId/verify` `{confirmation_note}` → 200
     `{id, status:'verified', payable_from}`; permission verify, step-up 300 s, SoD step
     `bank_detail_change.verify` (403 `sod_violation` `SOD_BANK_DETAIL_SELF_VERIFY`).
   - `POST /bank-detail-changes/:changeId/reject` `{reason}` → 200 `{id, status:'rejected'}`.
   - Errors: 400 `invalid_bank_details` | `confirmation_note_required` | `invalid_rejection`,
     401 `step_up_required`, 403 `forbidden`, 404 `not_found`, 409
     `bank_detail_change_not_pending` | `bank_detail_change_open`, 503 `kms_not_configured`
     (`createApi({kms})` not given).

## Consequences

### Good

- No code path with `lf_app` can make an account payable without a second person, a step-up
  and the cooling-off; proven by tests and a mutation run (T-0053 card).
- The small-team exception still works and stays visible on the weekly report.
- T-0054 has a ready, tested eligibility check with the reason it must show.

### Bad / accepted trade-offs

- The first payment to a new supplier waits for the cooling-off (fail-safe reading; human gate).
- A self-verification refused only by the database fails at COMMIT (the API's SoD engine
  refuses it first with a clean 403; the COMMIT failure is a 500 on a path that skipped it).
- `lf_app` can still insert `app.sod_exception` rows (ADR-0026); with small-team mode on, a
  compromised code path could pair one with a self-verification. It is listed on the weekly
  report that the Owner acknowledges.
- The DB step-up window (300 s) and MFA values are fixed in SQL; changing the policy needs a
  migration.

### Follow-ups

- T-0054: call `paymentEligibility` when building a batch.
- T-0030/T-0042: dispatch `app.bank_detail_change_notice` (set `status`, `sent_at`).
- Wire a KMS into `main.ts` (deployment configuration) and a settings route for the cooling-off.
- UI for request/verify (a later UI task).

## Compliance and verification

- `packages/modules/parties/src/bank-change.workflow.db.test.ts` (SS-UC06-05, SS-UC06-09
  database layer, bypass guards, SQL permission mirror).
- `apps/api/src/parties/bank-change.workflow.db.test.ts` (SS-UC06-09 on real routes).
- `packages/db/src/rls.db.test.ts` (cross-tenant suite covers the three new tables).
- Mutation check recorded in `.agent/backlog/T-0053.md`.

## Links

- Design §6.1, §6.2, §6.4, §6.5 rule 2; UC-06.
- RQ-0034, RQ-0012 item 7, ADR-0018, ADR-0025, ADR-0026; migration 0025; DL-0156..DL-0160.
