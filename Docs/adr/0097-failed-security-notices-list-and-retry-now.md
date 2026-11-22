---
adr: 0097
title: "Failed security notices: an admin list of their own and an append-only retry-now"
status: Accepted
date: 2026-11-22
author: claude
category: security
human_gate: yes (accepted under the owner's delegation DL-0691, with research RQ-0179)
supersedes: none
superseded_by: none
---

# ADR-0097: Failed security notices — admin list and append-only retry-now

## Status

Accepted on 2026-11-22 by claude under the product owner's standing instruction DL-0691 (the
building agent decides open security choices after research), backed by RQ-0179. It adds two
permissions (security model), a tenant-owned table (data model) and two API routes (public API),
so design §10.6 requires this record. Cross-provider review by codex still applies to the code.
Decision log: DL-0840..DL-0845. Task: T-0209. Amends nothing; ADR-0092 (dispatch) and ADR-0040
(Sync issues) are not edited.

## Context and problem statement

ADR-0092 retries a failed security notice every 6 h at most and never gives up (DL-0783). The
failure is recorded in `app.security_notice_delivery` (0073), but no screen shows it, so a fraud
control can fail silently. Design §5.6 and `apps/worker/AGENTS.md` require that failures that keep
going reach a person with the error and a one-click retry. The Sync issues inbox (ADR-0040, 0030)
is the existing place for connector failures.

## Decision drivers

- `app.sync_issue` requires an outbox event and a handler, and retries by re-sending a delivery
  job (RQ-0179 F1). Notices have neither.
- The notices concern Owners, Finance Admins and supplier bank details (ADR-0086 L2, design §6.5).
  The Sync issues audience includes the Accountant (RQ-0179 F3).
- Delivery history is append-only; notice tables grant lf_app only `UPDATE (status, sent_at)`.
- Every mutating route needs an `Idempotency-Key` (apps/api AGENTS.md, ADR-0093).
- Comparable systems keep failed outbound email in an administrator-only list with per-message
  retry (Odoo, django-post_office, Discourse; RQ-0179 S6–S8).

## Considered options

1. **A list of its own under Settings, new permissions, append-only retry rows** (chosen).
2. Sync issues source: widen `app.sync_issue` to non-outbox sources. Rejected: `event_id NOT NULL`
   cannot be relaxed by the forward-only runner; fake outbox events would misstate history; the
   Accountant would see and retry security notices.
3. Retry by updating the notice (`status = 'pending'`) as Odoo does. Rejected: the dispatcher's due
   rule reads the delivery rows, not the status, so it would not work without deleting or editing
   history; and it hides who asked for the retry.
4. Retry by inserting a synthetic delivery row. Rejected: a delivery row records an SMTP attempt;
   a fake one corrupts the attempt count and the history.

## Decision outcome

Option 1.

- **Permissions** (catalogue and `app.permission_known`): `security_notices.read` (`read`; Owner,
  Finance Admin, and the Auditor as every read, design §6.4) and `security_notices.retry` (`write`;
  Owner and Finance Admin). Neither is a step-up permission; both may be API-token scopes, like
  `sync.issues.*` (a retry only makes a notice send sooner).
- **Table** `app.security_notice_retry`: `id, tenant_id, notice_kind, remittance_notice_id,
  bank_detail_notice_id, after_attempt, requested_by, requested_at`. Exactly one notice id, matching
  the kind. `UNIQUE (tenant_id, <notice id>, after_attempt)`. Composite foreign key
  `(tenant_id, <notice id>, after_attempt)` to the delivery row; `(tenant_id, requested_by)` to
  `app.app_user`. A BEFORE INSERT guard refuses when that attempt is not `failed`, is not the
  latest attempt, or the notice has a `sent` row. RLS ENABLE + FORCE, tenant isolation, lf_app
  SELECT and INSERT, immutable (`app.sod_never_changed`).
- **Dispatcher** (`nextDue`): a delivery row blocks the notice when it is `sent`, or when its
  `next_attempt_at > now` and no retry row for the notice has `after_attempt >= attempt`. Nothing
  else changes; the next attempt is recorded as attempt n+1 as before.
- **API**
  - `GET /security-notices/failed` (`security_notices.read`): every notice in `failed` status of
    the tenant, oldest first, with kind, context (company or supplier name), masked recipient,
    attempts, last SMTP code, error code and message, last attempt time, next attempt time and
    `retry_requested`. Masking: first character of the local part, `•••`, `@domain`. Masked
    account numbers come from the payload (last 3 digits only).
  - `POST /security-notices/{kind}/{id}/retry` (`security_notices.retry`): `Idempotency-Key`
    required before anything else (400 `idempotency_key_required`), not stored. 201 with the
    updated item when a retry row was appended; 200 when the latest failed attempt was already
    released (replay, double press or race); 404 unknown; 409 `security_notice_not_failed` when
    the notice is pending, sent or has no recipient. Audited as `security_notice_retry`.
- **Web**: Settings → "Failed security notices" (`/settings/security-notices`), a list with a
  "Retry now" button per notice for holders of `security_notices.retry`; read-only otherwise;
  forbidden state for others.

### Consequences

- Good: the failure reaches the people who own the control, with the error and a one-click retry;
  the history stays complete (who asked, when, after which attempt).
- Good: no grant on existing tables changes.
- Bad: a second "failures" list beside Sync issues. Mitigated by linking both from Settings.
- Neutral: an Auditor can see the list (masked) but not retry.

## Compliance and verification

| Check | Where |
|---|---|
| Table shape, RLS, append-only, guard, cross-tenant | `packages/db/src/security-notice-retry.db.test.ts`, cross-tenant suite |
| Dispatcher sends a released notice at once; others keep their backoff | `packages/modules/email/src/security-notice-email.db.test.ts` |
| List (roles, tenant, fields, masking), retry (key, 201/200/409/404, audit) | `apps/api/src/security-notices/security-notices.db.test.ts` |
| Permission holders | `packages/shared/src/rbac/rbac.matrix.test.ts`, `user-lifecycle.db.test.ts` |
| Screen and retry action | `tests/e2e/web/security-notices.spec.ts` |

## Links

RQ-0179, ADR-0092, ADR-0086, ADR-0040, ADR-0023, ADR-0093, ADR-0018, DL-0783, DL-0691, T-0197,
T-0209, T-0219, T-0220.
