---
adr: 0092
title: "Security notices are emailed by a polling dispatcher: masked, link-free, sent once, retried with backoff"
status: Accepted
date: 2026-11-16
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0092: Security notices are emailed by a polling dispatcher: masked, link-free, sent once, retried with backoff

## Status

Accepted 2026-11-16 by claude (T-0197). The product owner delegated security decisions backed by
research to the building agent (DL-0691). Research: RQ-0174. Decision log: DL-0780..DL-0783.
This ADR adds to ADR-0086 (L2), ADR-0046 (email) and ADR-0062 (scheduled fan-out). It supersedes
none of them.

## Context and problem statement

The database writes durable security notices in the approving transaction:

- `app.bank_detail_change_notice` (0025) goes to a supplier's previous remittance contact after
  a verified bank-detail change.
- `app.remittance_account_notice` (0072) goes to every active Owner and Finance Admin after an
  approved change of the invoice remittance account.

Nothing sends them. The notices are a fraud control (design §6.5 rule 2). They have to reach the
right person once, promptly, without leaking account numbers, and without looking like the
phishing they warn about.

## Decision drivers

- Every notice row must be delivered, however it was written. Rows are written by SECURITY
  DEFINER SQL, including approvals that bypass the TypeScript module.
- Tenant isolation: the worker reads notices as lf_app under RLS only.
- Forward-only migrations: `app.email_delivery.purpose` cannot be widened (no DROP CONSTRAINT).
- Retries with backoff from 1 min to 6 h (design §5.6).
- OWASP ASVS (notify without sensitive data), NIST SP 800-63B-4 §4.6 (clear instructions and
  contact if repudiated), and ASD/NCSC anti-phishing advice (no links; use known contact
  details).

## Considered options

1. **Outbox event per notice.** Rejected. SQL cannot create the pg-boss job, so every approval
   path in TypeScript would have to publish. A bypassing approval, the case 0072 guards against,
   would never be sent.
2. **Poll the pending index, fanned out per tenant by the scheduler** (chosen).
3. **A cross-tenant "tenants with due notices" owner function.** Rejected. It widens the owner
   role's view of tenant data to save a cheap indexed query per tenant per minute.
4. **Reuse `app.email_delivery`.** Rejected. Its purpose CHECK cannot be widened, and it has no
   place for failed attempts or backoff.

## Decision

1. **Trigger.**
   - The scheduler (lf_migrator) installs the pg-boss schedule `security.notices.fanout`
     (`* * * * *`, UTC).
   - Its consumer sends one `security.notices.dispatch` job per active tenant
     (`app.active_tenant_ids()`). The job id is derived from queue, tenant and UTC minute, so a
     repeated fan-out in the same minute adds nothing.
   - The worker (lf_app) consumes each job inside `withTenant` and dispatches that tenant's due
     notices.
2. **Due.**
   - A notice is due when its status is `pending`, or when it is `failed` and no attempt has a
     `next_attempt_at` later than now.
   - `no_recipient` rows are never selected.
   - Each notice is handled in its own tenant transaction, locked
     `FOR UPDATE OF n SKIP LOCKED`. lf_app's column UPDATE grant allows the lock, so concurrent
     workers never send the same notice at once.
3. **Record (migration 0075).** `app.security_notice_delivery` holds one row per attempt.
   - Columns: `notice_kind`; `remittance_notice_id` or `bank_detail_notice_id`, each a composite
     tenant foreign key with exactly one set; `attempt`; `outcome` `sent | failed`; `to_addr`;
     `subject`; `message_id`; an error summary (`error_name`, `error_code`, `smtp_code`,
     `error_message` ≤ 500); `next_attempt_at` for failures; `attempted_at`.
   - A partial unique index allows one `sent` row per notice.
   - It is append-only (SELECT and INSERT for lf_app; `app.sod_never_changed()` on UPDATE and
     DELETE), tenant-owned, with RLS ENABLE and FORCE.
   - The notice row moves to `sent` (with `sent_at`) or to `failed` in the same transaction, under
     the existing 0025/0072 grants and guards.
   - Unique `(tenant_id, id)` constraints are added to both notice tables for the foreign keys.
     This is additive.
4. **Sending is at-least-once.** As ADR-0046 rule 3 says, SMTP cannot join the transaction. A
   crash after the SMTP accept and before the commit can repeat one notice. The lock and the
   unique `sent` index rule out every other duplicate.
5. **Backoff.** A failed attempt n is due again after min(6 h, 1 min · 2^(n−1)). There is no
   give-up: a security notice stays `failed` and is retried every 6 h until it is sent. Surfacing
   failed notices to an administrator is T-0209 (see Consequences).
6. **Content.**
   - Plain text only, with no HTML and no links. The subject starts `Security notice:` and
     carries no numbers.
   - The body shows only BSB plus "ending in" the last 3 digits, which the payload already masks.
     It also shows when the change happened, in the tenant's report time zone. For staff
     notices it names the requester and approver and flags self-approval.
   - It says only the last 3 digits are shown and that the email has no links.
   - "If you did not expect this": do not reply, and do not use links or phone numbers sent about
     the change. Contact the company (supplier notice) or the requester or approver (staff
     notice) on a number you already hold. Sign in the usual way. If money may have moved,
     contact your bank.
   - Attacker-influenced text (bank account label, display names) is neutralised: one line, at
     most 80 characters, with `://` and `www.` broken. `account_name` is not printed.
7. **No SMTP configured.** The worker still consumes the jobs. Notices stay `pending` and the gap
   is logged at start.

## Consequences

- Good: every notice is delivered regardless of how its approval was made. Delivery is
  idempotent and auditable per attempt. Tenants stay isolated. Notices cannot be cloned into a
  working phishing lure.
- Bad: one cheap indexed query per tenant per minute. Up to one minute of latency. At-least-once
  across a crash.
- Deviation: design §5.6 says retries end in a Sync issue. Sync issues are keyed to outbox
  events (migration 0030), and a polled notice has none. Failed notices are retried
  indefinitely and stay visible as `failed`. T-0209 adds the inbox or alert surface.
- Operations: the `LF_SMTP_FROM` domain should publish SPF, DKIM and DMARC (NCSC) so that the
  notices cannot be spoofed easily.

## Links

RQ-0174, RQ-0168, ADR-0086, ADR-0046, ADR-0062, ADR-0018, T-0197, T-0209.
