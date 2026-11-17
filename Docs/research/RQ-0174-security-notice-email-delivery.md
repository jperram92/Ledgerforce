---
id: RQ-0174
title: How should security notices (bank-detail and remittance account changes) be emailed, retried and recorded?
status: answered
opened: 2026-11-16
resolved: 2026-11-16
opened_by: claude
linked_tasks: [T-0197]
linked_adrs: [ADR-0092, ADR-0086, ADR-0046, ADR-0062, ADR-0008]
superseded_by:
---

# RQ-0174 — How should security notices be emailed, retried and recorded?

## Question

T-0197 must send the durable notices that the database already writes:
`app.bank_detail_change_notice` (migration 0025, T-0053) and `app.remittance_account_notice`
(migration 0072, T-0191, ADR-0086).

- **Q1. Content.** What must a security notice email contain, and what must it leave out? Covers
  account numbers, links, "if this wasn't you" guidance and contact details.
- **Q2. Trigger.** Should the worker learn about a new notice from an outbox event, or by polling
  the pending index (`*_notice_pending_idx`)?
- **Q3. Record and idempotency.** Where is a delivery recorded so that each notice is sent once?
  `app.email_delivery.purpose` (0037) has no security purpose, and its CHECK cannot be widened in
  place.
- **Q4. Retry.** How is an SMTP failure retried with backoff, and what happens when it keeps
  failing?

## Why it matters

The notices are a fraud control (design §6.5 rule 2; ADR-0086 L2). An attacker who controls one
account redirects payments. The notice is how the legitimate people find out in time, for
example within the 24 h cooling-off of a supplier bank change. A notice that is never sent, is
sent twice to the wrong place, or that itself looks like phishing defeats the control. A notice
that leaks a full account number creates a new exposure (ADR-0018).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x15-V6-Authentication.md | 2026-11-16 | primary | 6.3.7 (L3): "Verify that users are notified after updates to authentication details, such as credential resets or modification of the username or email address." 6.3.5: notify on suspicious authentication. These are the only V6 requirements that mention notification. |
| S2 | https://raw.githubusercontent.com/OWASP/ASVS/v4.0.3/4.0/en/0x11-V2-Authentication.md (via RQ-0168 S3) | 2026-11-15 | primary | 2.2.3: secure notifications after updates to sensitive account details, by email or SMS "as long as no sensitive information is disclosed in the notification". |
| S3 | NIST SP 800-63B-4 §4.6 "Account Notifications", https://raw.githubusercontent.com/usnistgov/800-63-4/nist-pages/sp800-63b/events/index.html (the source of pages.nist.gov/800-63-4/sp800-63b/events/, which was not reachable from the session) | 2026-11-16 | primary | "Events that require notification SHALL cause a notification to be sent to the notification addresses stored in the subscriber account." "Notifications SHALL be sent to all notification addresses except postal addresses." "The notification SHALL provide clear instructions, including contact information, in case the recipient repudiates the event associated with the notification." The purpose is to "help the subscriber detect possible fraud". |
| S4 | https://www.cyber.gov.au/protect-yourself/securing-your-email/email-security/preventing-business-email-compromise and https://www.cyber.gov.au/business-government/protecting-devices-systems/hardening-systems-applications/email-hardening/protecting-against-business-email-compromise (search summaries; ASD ACSC) | 2026-11-16 | primary (regulator guidance, read via search summary) | Verify any change of bank details by calling the sender "on a known and verified phone number", not one given in the email, because a number in the email could belong to the criminal. If money was sent, contact the bank immediately. |
| S5 | https://www.ncsc.gov.uk/collection/small-organisations-guide-to-cyber-security/spotting-cyber-attacks (search summary); https://www.ncsc.gov.uk/guidance/phishing | 2026-11-16 | primary (regulator guidance, via search summary) | "Don't use the numbers or links in the message – use the details from their official website." Recommends DMARC, SPF and DKIM against spoofing of the sending domain. |
| S6 | Stripe "Payout account was changed" notice; Stripe external-account-update verification email (search results: support.stripe.com bank-accounts-and-payouts FAQ, help.getslick.com, support.hint.com) | 2026-11-16 | secondary | Stripe emails the account holder when payout details change, as a security measure against unauthorised changes. It shows only the last 4 digits. A change does not affect payouts already in transit. support.stripe.com could not be opened from the session, so the exact wording is not confirmed. |
| S7 | Xero product-ideas forum threads 44961091 and 44961181; apps.xero.com VendorAlert listing; support.xbert.io article 11069292 | 2026-11-16 | secondary | Xero sends "Automatic Xero Alert: Bank account for …" only to the user who made the edit. Customers ask for all users or nominated users to be notified. Third-party apps (VendorAlert, XBert) exist to email chosen people when a contact's bank field changes, on a schedule of about 6 h. This confirms the gap that ADR-0086 closes and that a polling sweep is an accepted delivery model. |
| S8 | `packages/modules/email/src/invoice-email.ts` (`sendOnce`), `packages/db/migrations/0037_email_delivery.sql`, ADR-0046 | 2026-11-16 | source code | Email sending is at-least-once: SMTP cannot join the transaction. A row in a dedupe table, committed with the work, stops a redelivery from sending again. 0037's `purpose` CHECK lists invoice, statement, reminder and remittance only. |
| S9 | `packages/db/migrations/0054_ap_payment_confirmation.sql` header, `0062_gl_period_end_system_roles.sql` header; `packages/db/AGENTS.md` | 2026-11-16 | source code | The forward-only runner refuses DROP CONSTRAINT, so a CHECK cannot be widened in place. The precedent is a new table (DL-0107, DL-0117, DL-0258). |
| S10 | `packages/db/migrations/0025_parties_bank_detail_change.sql`, `0072_ar_remittance_hardening.sql` | 2026-11-16 | source code | Both notice tables are written inside SECURITY DEFINER database functions and triggers in the approving transaction. 0072 does this "so an approval that bypasses the module still notifies". lf_app has SELECT and UPDATE(status, sent_at) only. A guard allows `pending/failed → sent/failed`. Partial index `(tenant_id, created_at) WHERE status IN ('pending','failed')`. Payloads hold BSB, account name and `***` plus the last 3 digits. No clear number is stored. |
| S11 | `packages/outbox/src/outbox.ts` (`enqueue`), `apps/worker/src/daily-jobs.ts`, migration 0064, ADR-0062 | 2026-11-16 | source code | An outbox event is written with its pg-boss job through pg-boss `fromKysely(trx)` from TypeScript. Nothing in SQL can create the pg-boss job. Tenant enumeration (`app.active_tenant_ids()`) is owner-only (lf_migrator). The scheduler fans out one job per tenant and the worker runs it as lf_app under RLS. |
| S12 | `apps/worker/AGENTS.md`, design §5.6 rule 2 | 2026-11-16 | primary (design) | Retries use exponential backoff from 1 min to 6 h, then a Sync issues inbox entry. |
| S13 | `packages/outbox/src/sync-issues.ts`, migration 0030 | 2026-11-16 | source code | `app.sync_issue` rows are keyed by `(event_id, handler)`. They have a foreign key to `app.outbox_event` and a `dead_letter_job_id NOT NULL`, so a Sync issue exists only for an outbox delivery. |
| S14 | nodemailer 10.1.2 `SMTPConnection` errors (`dist/esm/smtp-connection/index.js`, `dist/esm/errors.js`) | 2026-11-16 | source code | A rejected command raises an Error with `code` (e.g. `EENVELOPE`, `EMESSAGE`, `ECONNECTION`), `responseCode` (the SMTP reply code) and `response`. |

## Findings

1. **A notice must reach the person and tell them what to do if they did not make the change, with
   a contact route that does not depend on the email** (S3; S1 for authentication details).
   NIST requires "clear instructions, including contact information, in case the recipient
   repudiates the event".
2. **Notices must not disclose sensitive information** (S2). Payment providers show only the
   last digits (S6). The stored payloads are already masked to the last 3 digits (S10), so the
   email cannot leak more than the payload holds.
3. **Links and numbers in emails are the phishing vector** (S4, S5). Regulators tell people to use
   a known phone number or the official site, not details in the message. Inference: a security
   notice that contains a link trains recipients to click links in "security" emails. One with no
   links and no phone numbers, which tells them to use their own known contact, is consistent
   with that advice and cannot be cloned into a working lure.
4. **Some payload fields are attacker-influenced free text** (inference from S10). The
   requester types the bank account `name` and `account_name`. A user's display name also comes
   from input. If they are printed verbatim, an attacker could plant "call 1800 … to confirm" or
   a URL inside a genuine security notice. Such text must be made inert: one line, length-capped,
   URL schemes and `www.` broken. Fields that add nothing to recognition, such as
   `account_name`, are left out.
5. **The notice rows are written in SQL, and SQL cannot enqueue the pg-boss job** (S10, S11). An
   outbox event would need a second write path in TypeScript that every approval path calls.
   0072 explicitly guards against approvals that bypass the module, so that path would miss
   exactly the case it exists for. Polling the pending index covers every row, however it was
   written (S10). Third-party Xero monitors also deliver by polling (S7).
6. **Polling must stay tenant-isolated** (S11). The scheduler (lf_migrator) can enumerate active
   tenants. The worker (lf_app) reads each tenant's notices under RLS. A new cross-tenant read
   function for "tenants with due notices" would widen the owner's view of tenant data, so it is
   not needed and not proposed.
7. **`app.email_delivery` cannot take a new purpose** (S8, S9). Its record also has no place for
   failed attempts, and both are needed: "failed" with backoff, and an audit of each try. A
   separate append-only table follows the precedent.
8. **A Sync issue needs an outbox event** (S13). A polled notice has none, so the dead-letter
   path does not apply as it stands. The design rule exists so that failures are not silent
   (S12).
9. **Delivery is at-least-once** (S8). A crash between the SMTP accept and the commit can send
   twice. A row lock (`FOR UPDATE SKIP LOCKED`, allowed because lf_app holds column UPDATE)
   stops two workers from sending the same notice at the same time. A partial unique index stops
   two `sent` records.

## Conclusion / decision

- **Q1 (content).** Plain-text email only, with no HTML and no links. Subject:
  `Security notice: …`, with no numbers.
  - The body states the event, the company, the masked accounts (BSB plus "ending in" the last 3
    digits), and when the change happened, in the tenant's report time zone.
  - For the internal notice it also states who requested and who approved, with emails, and flags
    self-approval.
  - It states that only the last 3 digits are shown and that the email contains no links.
  - "If you did not expect this": do not reply, do not use any link or phone number sent about
    the change, and use a contact you already know (for the supplier: the company, on a phone
    number already held; for staff: the requester or approver by phone). Sign in the usual way,
    by bookmark or typed address, and act in LedgerForce. If money may have moved, contact the
    bank.
  - Attacker-influenced text is neutralised: one line, at most 80 characters, and `://` and
    `www.` broken. `account_name` is omitted.
  - The NIST "contact information" requirement is met by naming the people or company to contact
    and telling the recipient to use a number they already hold. Printing a number is avoided
    because the tenant could not prove it is genuine, and S4 says not to trust one from an email.
- **Q2 (trigger).** Poll. The scheduler (lf_migrator) installs a pg-boss schedule
  `security.notices.fanout` every minute (UTC). Its consumer sends one
  `security.notices.dispatch` job per active tenant, with a job id derived from queue, tenant and
  UTC minute, so a second fan-out in the same minute adds nothing. The worker (lf_app) takes each
  due notice in its own tenant transaction, `FOR UPDATE SKIP LOCKED`, sends, and records.
- **Q3 (record).** Migration 0075 adds `app.security_notice_delivery`.
  - It is tenant-owned and append-only (SELECT and INSERT for lf_app; the `sod_never_changed`
    trigger), with one row per attempt: kind, the notice id (a composite foreign key per notice
    table), the attempt number, the outcome `sent | failed`, the address, the subject, the SMTP
    message id or error summary, and `next_attempt_at` for a failure.
  - A partial unique index allows one `sent` row per notice.
  - The notice row moves `pending/failed → sent` (with `sent_at`) or `→ failed` in the same
    transaction, under the existing grants.
  - `no_recipient` rows are never selected.
- **Q4 (retry).** A failed attempt n is due again after min(6 h, 1 min · 2^(n−1)), which is
  1, 2, 4 … 256 min, then 6 h. There is no terminal give-up: a security notice is never abandoned.
  It stays `failed`, visible, and retried every 6 h. Surfacing failed security notices in the
  Sync issues inbox, or as an admin alert, is follow-up T-0209. It is recorded as a deviation from
  the "then a Sync issue" rule, because Sync issues are keyed to outbox events (finding 8).
- Without SMTP configured, the worker still consumes the jobs. Notices stay `pending` and the
  gap is logged at start, as for invoice email.
- Decision log DL-0780..DL-0783. ADR-0092 (security, accepted under DL-0691).

## Confidence

`high` for content (S1–S5 primary) and for the mechanics (source code S8–S14, proven by the
db tests of T-0197). `medium` for the payment-provider comparison (S6, S7 secondary, wording not
confirmed).

## Follow-ups

- T-0209: surface failed security notices (Sync issues inbox or an admin alert) with a retry-now
  action.
- Deployment: the installer docs should recommend SPF, DKIM and DMARC for the `LF_SMTP_FROM`
  domain (S5). This is an operational note in ADR-0092.
- Re-check if a general in-app notification centre is designed (RQ-0168 follow-up).

**Affects:** packages/modules/email, apps/worker (scheduler, worker), packages/db migration 0075,
ADR-0092, design §6.5 rule 2, ADR-0086 L2.
