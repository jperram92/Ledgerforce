---
id: RQ-0179
title: Where do failed security notices go in front of a person, who sees them, and how is "retry now" recorded without editing history?
status: answered
opened: 2026-11-22
resolved: 2026-11-22
opened_by: claude
linked_tasks: [T-0209]
linked_adrs: [ADR-0097, ADR-0092, ADR-0040, ADR-0023, ADR-0093]
superseded_by:
---

# RQ-0179 — Surfacing failed security notices with a retry-now action

## Question

T-0197 (ADR-0092, DL-0783) emails the security notices `app.remittance_account_notice` (0072) and
`app.bank_detail_change_notice` (0025). Each attempt is a row in `app.security_notice_delivery`
(0073). A failed notice is retried every 6 h at most and never given up, but no screen shows it.

- **Q1. Home.** Do failed notices belong in the Sync issues inbox (design §5.6 rule 2, T-0071,
  `app.sync_issue` from 0030) or in a list of their own?
- **Q2. Audience.** Which roles see the list, and which may retry?
- **Q3. Retry now.** How does "retry now" make the notice due at the next dispatch while
  `app.security_notice_delivery` stays append-only and the notice tables keep their narrow grants?
- **Q4. What is shown.** Which fields, and how are recipient and account masked?

## Why it matters

The notices are a fraud control (design §6.5 rule 2, ADR-0086 L2). A notice that keeps failing
silently defeats the control; the worker rule is that failures that keep going end up in front
of a person (`apps/worker/AGENTS.md`, design §5.6). Showing them to the wrong roles, or letting a
retry rewrite the attempt history, weakens the same control.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §5.6 | 2026-11-22 | primary (design) | "Failures retry with exponential backoff (1 min to 6 h), then land in a **Sync issues** inbox with the error, payload and a one-click retry." The section is "Salesforce integration" reliability. |
| S2 | `Docs/solution-design/solution-design.md` §6.4 table | 2026-11-22 | primary (design) | Auditor: "Read-only everything including audit log"; Finance Admin: configuration; Owner: everything. |
| S3 | `packages/db/migrations/0030_sync_issues.sql` | 2026-11-22 | source code | `app.sync_issue` has `event_id NOT NULL` referencing `app.outbox_event`, `handler`, `connector`, `payload_ref`; retry re-sends a pg-boss delivery job. |
| S4 | `packages/shared/src/rbac/catalogue.ts` | 2026-11-22 | source code | `sync.issues.read` and `sync.issues.manage` are held by the Accountant role (and so Finance Admin and Owner). |
| S5 | `packages/modules/email/src/security-notice-email.ts` (`nextDue`) | 2026-11-22 | source code | A notice is due when `status IN ('pending','failed')` and no delivery row is `sent` or has `next_attempt_at > now`. |
| S6 | https://raw.githubusercontent.com/odoo/odoo/17.0/addons/mail/models/mail_mail.py and `.../security/ir.model.access.csv`, `.../views/mail_mail_views.xml` | 2026-11-22 | source code (comparable OSS ERP) | Outgoing mail has state `exception` ("Delivery Failed") with `failure_type`/`failure_reason`; `action_retry` puts failed mail back to `outgoing`; the "Retry" button is visible only on `exception`/`cancel`. `mail.mail` access is granted to `base.group_system` (settings administrators) only, in the Technical > Emails menu, separate from connector queues. |
| S7 | https://raw.githubusercontent.com/ui/django-post_office/master/post_office/admin.py | 2026-11-22 | source code (comparable OSS) | An admin action "Requeue selected emails" sets `status=queued`; failed emails live in the Django admin, not in a sync/integration queue. |
| S8 | https://raw.githubusercontent.com/discourse/discourse/main/config/routes.rb | 2026-11-22 | source code (comparable OSS) | `email_logs` (sent, skipped, bounced, rejected) are routes under `AdminConstraint` — an admin-only email log. |
| S9 | `Docs/adr/0093-idempotency-key-on-weekly-sod-acknowledgement.md`, `apps/api/src/settings/settings-common.ts` `requireKey` | 2026-11-22 | primary (project) | Mutating routes require `Idempotency-Key` (400 `idempotency_key_required`); a route idempotent by state does not store the key. |
| S10 | `packages/db/migrations/0073_platform_security_notice_delivery.sql` | 2026-11-22 | source code | Delivery rows are append-only (`app.sod_never_changed`), `UNIQUE (tenant_id, <notice id>, attempt)`; lf_app SELECT, INSERT. Notice tables: lf_app `UPDATE (status, sent_at)` only. |

## Findings

1. `app.sync_issue` is an outbox-delivery record: every row needs an `outbox_event` and a handler,
   and its retry re-sends a pg-boss delivery job (S3). A security notice is not an outbox event
   and is not retried by a job of its own; the every-minute dispatcher polls (ADR-0092, S5).
   Fitting notices in would need a nullable `event_id` (a column cannot be made nullable without
   ALTER of an existing constraint — forbidden by the forward-only runner) or fake outbox events.
2. Design §5.6 rule 2 is in the Salesforce-integration section (S1). Its intent — a failure that
   keeps going reaches a person, with the error and a one-click retry — applies; its location
   (the connector inbox) does not bind email notices.
3. The Sync issues audience includes the Accountant (S4). The remittance notice goes to Owners and
   Finance Admins only (ADR-0086 L2); the supplier notice concerns a bank-detail change, which only
   the Owner may verify. An Accountant should not triage these.
4. Comparable systems keep failed outbound email in an administrator-only email list with a
   per-message retry, separate from integration queues (S6, S7, S8). Odoo shows the failure type
   and reason and offers "Retry" only on failed mail (S6).
5. Those systems retry by *updating* the message's state (S6, S7). LedgerForce's delivery history
   is append-only (S10), so the equivalent is an appended "retry requested" row the dispatcher
   reads (inference, consistent with the T-0209 card note).
6. Design §6.4 gives the Auditor read access to everything (S2), so a `read` permission is held by
   the Auditor automatically (catalogue `READ_PERMISSIONS`). Retry is a write.

## Conclusion / decision

- **Q1.** A list of its own: **Settings → Failed security notices**, route
  `GET /security-notices/failed`, not the Sync issues inbox. Record the reason in ADR-0097.
- **Q2.** Two new permissions: `security_notices.read` (`read`: Owner, Finance Admin, and the
  Auditor by design §6.4) and `security_notices.retry` (`write`: Owner and Finance Admin). The
  Accountant and every clerk role see nothing. The card's "Owners and Finance Admins" is honoured
  for the action; the Auditor's read-only view follows §6.4 and is recorded in DL-0841.
- **Q3.** A new append-only table `app.security_notice_retry` (tenant-owned, RLS ENABLE + FORCE,
  lf_app SELECT, INSERT, immutable trigger). One row per *failed attempt* released:
  `(tenant_id, notice id, after_attempt)` unique, with a composite foreign key to that delivery
  row, and a guard trigger that the attempt is `failed`, is the latest attempt, and the notice has
  not been sent. The dispatcher treats a failed attempt as not blocking when a retry row with
  `after_attempt >= attempt` exists for the notice. `POST /security-notices/{kind}/{id}/retry`
  requires `Idempotency-Key` (S9, not stored), answers 201 for a new request and 200 when the
  latest failed attempt is already released (idempotent by state, also under a race through
  `ON CONFLICT DO NOTHING`), 409 when the notice is not failed. Audited (`security_notice_retry`).
- **Q4.** Show kind, a plain-words subject (company or supplier name), the recipient email
  masked to its first character and domain (`j•••@example.com`), attempts, the last SMTP code,
  error code and a secret-free error message (already stored that way), last attempt time, next
  attempt time and whether a retry-now is waiting. Account numbers only from the masked payload
  (last 3 digits). No payload is returned raw.

## Confidence

`high` for Q1–Q3 (project source and design read directly; three comparable systems' source
read). `medium` for the exact masking form of the email (no single standard; follows the project's
"show the minimum needed to recognise" rule of ADR-0018).

## Follow-ups

- Notices in `no_recipient` (no address on record) are also undelivered; surfacing them with a
  "set a contact" path is card T-0219.
- A count badge on the Settings section or a home-screen alert for failed notices: card T-0220.

**Affects:** packages/db (migration), packages/modules/email (dispatcher), packages/shared (rbac),
apps/api, apps/web, ADR-0097.
