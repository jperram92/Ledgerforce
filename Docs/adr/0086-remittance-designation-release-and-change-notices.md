---
adr: 0086
title: "Remittance account: archiving releases the designation; every approved change notifies all Owners and Finance Admins"
status: Accepted
date: 2026-11-15
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0086: Remittance account: archiving releases the designation; every approved change notifies all Owners and Finance Admins

## Status

Accepted 2026-11-15 by claude (T-0191). The product owner delegated security decisions backed by
research to the building agent (DL-0691). Research: RQ-0168. Decision log: DL-0720. This ADR adds
to ADR-0079 (controls 1 and 2) and ADR-0080. It supersedes neither.

## Context and problem statement

Security review r8 of T-0180 (DL-0694) raised two low findings:

- **L1.** A designated remittance account that is archived and later re-activated prints on
  invoices again, with no new approval. The designation survives the archive.
- **L2.** In small-team mode one person can approve their own remittance change. The only trace
  is the generic SoD exception on the weekly report. The change redirects customer payments, so
  that is too quiet (design §6.5: "weakened visibly, never silently").

## Decision drivers

- Enforce it in the database, like the rest of ADR-0080: no code path, including direct SQL as
  lf_app, may bring an account back into print or approve a change without notices.
- Reuse the existing notification path (`app.bank_detail_change_notice`, migration 0025, T-0053)
  rather than invent a new channel.
- Never put the clear account number in a notice (ADR-0018). Mask it to the last 3 digits.
- Forward-only, additive migration (AGENTS.md §4).

## Considered options

L1:
1. **Release the designation on any status change of the designated account** (chosen). This is
   ERPNext's "disable clears the default" (RQ-0168 S4).
2. Keep the designation and add a "suspended since" marker that a re-approval clears. Rejected:
   it is more state, and re-approving the same account conflicts with 0071's
   `bank_account_id IS DISTINCT FROM previous_bank_account_id` check.
3. Refuse to re-activate a designated account. Rejected: re-activating an account is legitimate,
   and the card asks that re-activation be possible but not print.

L2:
1. **A durable notice row per active Owner and Finance Admin, written by the database in the
   approving transaction** (chosen). This is the bank-detail notice pattern.
2. An outbox event that a worker turns into email. Rejected for now: it lives only in the
   TypeScript path, so a bypassing approval would send nothing. The email module also has no
   security-notice purpose yet. The dispatcher (T-0197) may still use the outbox to send.
3. Notify only in small-team mode. Rejected: a compromised approver session is the same risk in
   normal mode (RQ-0168 finding 4).

## Decision outcome

Migration 0072:

- **Release on archive.** `app.bank_account_remittance_release()` is an AFTER UPDATE OF status
  trigger on `app.bank_account`. When the status of a designated account changes, it sets
  `app.ar_settings.remittance_bank_account_id = NULL` for its company and writes an audit row
  (`remittance_account.released`, masked).
  - The 0071 guard `app.ar_settings_remittance_guard()` is replaced with `CREATE OR REPLACE`. It
    keeps its contract and now allows exactly this write without an approval: a clear to NULL,
    from inside a trigger (`pg_trigger_depth() >= 2`, as in 0028).
  - The guard also refuses to designate an account that is not `active`.
  - To print the account again, someone requests a new change and it is approved, so it is
    notified.
- **Notices.** `app.remittance_account_notice` holds one row per recipient. Its columns are change,
  company, recipient user/name/email, `status pending|sent|failed|no_recipient`, masked `payload`,
  `created_at` and `sent_at`.
  - A SECURITY DEFINER trigger on the `requested → approved` update of
    `app.remittance_account_change` writes the rows. Recipients are every `active` user holding
    an unrevoked `owner` or `finance_admin` role, including the requester and approver. If there
    is none, it writes one `no_recipient` row.
  - The payload holds the new and previous accounts (name, account name, BSB,
    `***` + last 3, currency), the requester and approver (id, name, email), both times, and
    `self_approved`.
  - Tenant-owned: RLS ENABLE + FORCE. lf_app has SELECT and UPDATE(status, sent_at) only. A guard
    allows only `pending/failed → sent/failed` and refuses DELETE.
- Requests and rejections do not notify. A release on archive is audited but not notified,
  because it cannot redirect money (RQ-0168 conclusion 4).
- Delivery (email) is T-0197, shared with `bank_detail_change_notice`.

### Consequences

- Good: every approved change, by any path, leaves notices in the same transaction. A
  self-approval in small-team mode is visible to every Owner and Finance Admin. Archiving can no
  longer leave a dormant designation behind.
- Bad: notices are not sent until T-0197 ships, as with bank-detail notices since T-0053. They are
  durable and indexed for the dispatcher.
- Neutral: a company whose remittance account is archived prints no bank details until a new
  change is approved.

## Links

RQ-0168, RQ-0150, ADR-0079, ADR-0080, ADR-0018, DL-0694, DL-0720, migration
`packages/db/migrations/0072_ar_remittance_hardening.sql`, T-0191, T-0197.
