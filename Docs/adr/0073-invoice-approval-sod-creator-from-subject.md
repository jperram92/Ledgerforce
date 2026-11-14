---
adr: 0073
title: "Approving one invoice over HTTP: maker-checker through the SoD engine, with the subject reporting its creator"
status: Accepted
date: 2026-11-14
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0073: Approving one invoice over HTTP: maker-checker through the SoD engine, with the subject reporting its creator

## Status

Accepted 2026-11-14 under the product owner's delegation of 2026-11-13: "Yes you are authorised
to make all these decisions based off best practices" (DL-0477 item 2). The lead settled the three
open points in DL-0561. Category: security.

## Context and problem statement

T-0132 adds `POST /ar/invoices/:id/approve`, so the invoice screen (T-0083) can approve and post
one draft. ADR-0072 created the permission `ar.invoice.approve` (Owner, Finance Admin, Approver).
DL-0477 item 2 adds a maker-checker rule: the draft's creator may not approve it, except in
small-team mode, the same as the credit-note rule.

The SoD engine (ADR-0026) learns who did what to a subject only from `app.sod_action`. Routes
declared with `@SoD(step, …)` write to that table. Invoices are created on paths that declare no
SoD step:
- Closed Won from Salesforce (T-0069);
- batch billing (T-0043, T-0120);
- deposit invoices;
- module calls.

The creator is stored on the invoice itself (`app.sales_invoice.created_by`, migration 0035). If
the engine reads only `app.sod_action`, it would never see an `invoice.create` step, so the rule
would never fire.

SoD step and rule ids are CHECK-enforced in SQL. Migration 0069 (lead, T-0169, DL-0561) added the
`invoice.create`/`invoice.approve` steps and the rule `SOD_INVOICE_SELF_APPROVAL`. The rule has
condition `always` and a small-team exception.

## Decision drivers

- Maker-checker for revenue entering the ledger (COSO control activities; OWASP ASVS V4 access
  control; design §6.4–6.5).
- One SoD engine. No ad-hoc checks in controllers (apps/api/AGENTS.md).
- No migration in this card (DL-0560), and no history row invented for paths that did not record
  one.
- Fail closed.
- Every mutating route has an idempotency key and returns the same result on replay (design §3.9).

## Considered options

1. **The subject reports its creator** (`SodSubject.createdBy`). The engine treats it as an
   `<subject>.create` step by that user, before the recorded history.
2. **Record `invoice.create` in `app.sod_action` on every invoice-creation path.**
3. **Ad-hoc check in the controller** (`created_by === actor`).

### Option 1 — subject reports its creator

- Good, because the invoice row is the authoritative record of who created it, on every path.
- Good, because the rule, the small-team exception, the refusal (403 `sod_violation`), the audit
  row and the weekly exception report are all the engine's existing behaviour.
- Bad, because it widens the ADR-0026 contract. A `subjectFrom` can now affect the decision
  beyond the amount, so it must read the creator from the database, never from the request.

### Option 2 — record on every creation path

- Good, because it keeps the engine contract unchanged.
- Bad, because it touches four creation paths in other modules and the worker, which run outside
  an HTTP request.
- Bad, because drafts that already exist have no history row, so the rule would silently allow
  them (fail open).

### Option 3 — ad-hoc check

- Bad, because it is not in the rule catalogue, has no small-team exception and no exception
  report, and is forbidden by apps/api/AGENTS.md.

## Decision outcome

Chosen option: **Option 1**, because it uses the authoritative record and fails closed for drafts
that existed before this change, without a migration.

The engine contract is extended as follows:
1. `SodSubject` gains `createdBy?: string | null`. When it is a user id, `checkSod` and
   `sodOutlook` evaluate as if the history began with the step `<subject type>.create` by that
   user.
2. If the subject type has no `create` step, a non-null `createdBy` is a programming error.
   `checkSod` throws, and the request fails; it is never ignored.
3. A route's `subjectFrom` reads `createdBy` from the database row of the subject, in the request
   transaction, under RLS. It never reads it from the request.

`POST /ar/invoices/:id/approve?company_id=…`:
1. Needs the permission `ar.invoice.approve`.
2. Declares `@SoD('invoice.approve', …)`. The subject is the invoice id and
   `createdBy = sales_invoice.created_by`, read from the database. An invoice the caller cannot see
   reports no creator, and the handler then answers 404.
3. The rule `SOD_INVOICE_SELF_APPROVAL` refuses the creator with 403
   `{error:'sod_violation', rule}`, and the refusal is audited. Small-team mode with nobody else
   eligible needs a `sod_exception` reason. The exception is recorded and appears on the weekly
   report (ADR-0026).
4. A request without `Idempotency-Key` (1–200 characters) gets 400 `idempotency_key_required`.
5. The posted invoice is the replay record, as for bills (DL-0420). The journal entry's own key is
   `ar-invoice:<id>`.
   - If the same user approves an already-posted invoice that they approved, the answer is 200
     with the posted result and `replayed: true`. Nothing new is posted.
   - If another user approves an already-posted invoice, the answer is 409 `already_posted`.
   - A void invoice gets 409 `not_draft`.
   - The SoD subject lock (ADR-0026) serialises concurrent approvals of the same invoice.
6. The handler calls `approveInvoice` (GP-001; the same journal as the T-0131 preview). Every
   successful request, including a replay, writes an audit row (`entity_type: sales_invoice`).
7. Without the document outbox or the posting outbox, the answer is 503 `outbox_unavailable`, and
   nothing is posted.
8. `GET /ar/invoices/:id` returns `approval: {allowed, rule, small_team_exception_required}` for
   the caller, from `sodOutlook`. The screen explains the rule before the user tries it. The route
   still decides.

## Consequences

### Good

- One rule catalogue and one refusal shape. Small-team exceptions for invoices appear on the
  existing weekly report.
- Drafts created before this change are protected too.

### Bad / accepted trade-offs

- A replay by the same approver with a different key also returns the posted result. The invoice
  id, not the key, is the natural idempotency key of "approve this invoice".
- A replay also records another `invoice.approve` row in `app.sod_action`. The action ledger is
  append-only, so a repeated row is harmless.

### Follow-ups

- None required. Other subjects may use `createdBy` the same way. Refunds (T-0152) record their
  own `refund.create` step.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| A reported creator is a prior `create` step: creator denied, another approver allowed, small team needs and records an exception, unsupported subject fails closed | `apps/api/src/sod/sod.db.test.ts` (T-0132 block) | api-db |
| Route: 403 without permission, SoD refusal for the creator, 400 without key, replay 200, other user 409, 404 for another tenant, GP-001 lines equal the preview, audited | `apps/api/src/ar/invoices.db.test.ts` (SS-UC01-12) | api-db |
| Holders of `ar.invoice.approve` | `packages/shared/src/rbac/rbac.matrix.test.ts` | unit |
| Screen shows the action only with the permission and explains refusals | `tests/e2e/web/invoice-approve.spec.ts` (SS-UC01-13) | e2e |

## Links

- Design: §3.9, §6.4, §6.5
- Decision log: DL-0477 item 2, DL-0561, DL-0570
- Related ADRs: ADR-0023, ADR-0026, ADR-0072
- External sources: OWASP ASVS 4.0.3 V4 (access control); COSO Internal Control — Integrated
  Framework (2013), control activities (segregation of duties)
