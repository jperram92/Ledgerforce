---
adr: 0024
title: "Period control: the §3.5 matrix as data, database-enforced invariant 3, personal overrides, two-approver reopen and the tenant lock-date policy"
status: Proposed
date: 2026-10-25
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0024: Period control — matrix as data, invariant 3 in the database, overrides, reopen, lock-date policy

## Status

Proposed — accounting category, awaiting product-owner acceptance. T-0023 is built to this
proposal so it can be judged on working, tested code. Three points need the product owner (see
*Open points*), above all the payout cell under AR lock (design §11.3 item 4).

## Context and problem statement

Design §3.3 invariant 3 says a posted entry's `entry_date` must fall in a period whose status
allows its source type, enforced by the database. §3.5 gives five statuses and who can post in
each, by AR / AP / journals only. §2 and §5.6 rule 5 add a tenant lock-date policy: reject, or
post to the first open date with a note. Source types such as bank/Stripe payouts, payroll and
reversals are not mapped (RQ-0012 item 4, RQ-0026).

## Decision drivers

- The matrix must be reviewable data, the same in TypeScript and SQL.
- The database refuses what the matrix refuses, even if application code is wrong (ADR-0004).
- Nothing about a period is updated in place except its status, and nothing is deleted.
- Undecided accounting choices must be visible and switchable, not hidden in code.

## Considered options

1. Matrix as a TypeScript constant mirrored by IMMUTABLE SQL functions, proven equal by tests
   (chosen; same pattern as `app.role_template_exists`, ADR-0023).
2. A global matrix table — needs a table without `tenant_id` (security ADR, human gate) and
   invites runtime edits of accounting rules.
3. Per-tenant matrix rows — every tenant could silently diverge from §3.5.

## Decision outcome

Chosen option 1, with:

- **Classes** (RQ-0026): AR = `ar_*` documents and `payments_stripe_charge`; AP = `ap_bill`,
  `ap_payment`, `payroll_pay_run`, `payroll_net_pay_batch`; journal = `manual_journal`;
  reversal = `ledger_reversal`; payout = `payments_stripe_payout`. Unknown source types are
  refused. Stored codes are golden names with `.` → `_` (the 0007 CHECK refuses dots).
- **Matrix**: Open → allow. AR locked → AR override, AP allow, journal allow, reversal override,
  payout = tenant setting. AP locked → journal allow, all else override. Soft closed → all
  override. Hard locked → all deny.
- **Override**: one `app.period_override` row per posting (company, period, source type,
  idempotency key), recorded only where the cell is "override", by a holder of
  `period.lock.override`, with a reason; the entry must be `created_by` that user. Audited.
- **Status changes**: SECURITY DEFINER functions only; forward needs `period.lock` (AR/AP lock) or
  `period.close` (soft close, hard lock); backward needs `period.reopen` and a reason; hard locked
  leaves only by request + approval by two different holders of `period.reopen`, with a reason.
  History in `app.period_status_change`, audit rows in `audit.audit_log`.
- **Lock-date policy** (tenant setting, history rows): `reject` (default) |
  `post_to_first_open_date_with_note` — the start of the first later period that allows the source
  type without override; the note states the original date, period and status.
- **Reconciliation**: statement lines dated in a hard-locked period cannot change status.

### Consequences

- Good: one reviewed table; the database enforces every cell (exhaustive test); every status
  change and override is attributable.
- Bad: every new source type needs a catalogue entry in TS and SQL (a new migration) — intended.
- Neutral: periods are monthly; 4-4-5 and 53-week calendars are later work.

## Open points for the product owner

1. **Payout under AR lock** (design §11.3 item 4): setting `payout_under_ar_lock`, default
   `override` (treated as AR). Should the default be `allow`, or should the setting go away?
2. Payroll source types classed as AP (an AP lock then needs an override); reversals need an
   override under any lock.
3. Default lock-date policy `reject`; RQ-0012 suggested "first open date" for automated sources.

## Compliance

`packages/ledger/src/period-matrix.test.ts` (SS-PLAT-06, SS-PLAT-57),
`packages/ledger/src/period-control.db.test.ts` (SS-PLAT-06, -56, -57),
`packages/ledger/src/period.enforce.db.test.ts` (UC scenarios), migration
`0018_ledger_periods.sql`, RQ-0026.
