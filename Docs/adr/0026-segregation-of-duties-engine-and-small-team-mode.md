---
adr: 0026
title: "Segregation-of-duties engine: rules as data, an append-only action ledger, tenant thresholds and visible small-team exceptions"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0026: Segregation-of-duties engine: rules as data, an append-only action ledger, tenant thresholds and visible small-team exceptions

## Status

Proposed — security category, waiting for product-owner acceptance. It extends ADR-0023 (role
templates; "SoD goes beside `Authz.require`") and ADR-0025 (MFA and step-up) without changing
either. The SoD thresholds are an open decision of design §11.2: the values below are the
design's placeholders, held as tenant settings, and must be confirmed by the product owner.
T-0015 is built to this proposal so it can be judged on working, tested code.

## Context and problem statement

Design §6.5 lists six enforced rules with configurable thresholds and a small-team mode; §6.4
adds "cannot" cells that are SoD, not RBAC (Owner cannot release a batch they created, Finance
Admin cannot activate a posting rule they authored, AR Clerk cannot approve own credit notes
above threshold, Approver cannot create the items they approve, Payroll Officer cannot release a
net-pay batch they created). RBAC (ADR-0023) answers "may this role ever do X"; SoD answers "may
*this person* do X *to this item*, given who did what to it before". The questions are: where
the rules live, where the history of "who did step X on entity Y" lives, how thresholds are
configured, how small-team mode weakens a control visibly, and where the check runs.

The business endpoints these rules protect (bills T-0052, payment batches T-0054, bank-detail
changes T-0037, credit notes T-0045, manual journals, posting rules, period reopen T-0023) mostly
do not exist yet, so the engine must be usable by declaration on those routes later.

## Decision drivers

- One central check, after the permission/MFA/step-up checks; never ad hoc in a controller
  (`apps/api/AGENTS.md`).
- Rules reviewable as data, testable as a pure function (SS-PLAT-16).
- History that cannot be rewritten by the application: the evidence of "who entered this bill"
  must survive (append-only, RLS, no UPDATE/DELETE for `lf_app`).
- Thresholds per tenant, with history, changed only by the Owner and audited; placeholder
  defaults flagged for the product owner (§11.2).
- Small-team mode never silent: an allowed conflict always leaves a recorded exception on a
  weekly report the Owner acknowledges (§6.5).
- Money as decimal strings / `NUMERIC(19,4)`, never floats.

## Considered options

1. **Rules as code data + pure evaluator + DB action ledger, checked in `TenantInterceptor` via
   a route decorator** (chosen).
2. Checks inside each module service (rejected: easy to forget, duplicated, not reviewable as a
   table; contradicts `apps/api/AGENTS.md`).
3. Rules enforced only by database triggers on each business table (as 0018 does for period
   reopen) (rejected for now: the business tables do not exist yet, every rule would be written
   twice, and small-team exceptions need request input. A trigger mirror can be added per table
   later as defence in depth.)
4. Derive history from `audit.audit_log` (rejected: `lf_app` has no SELECT on it, and its rows
   describe requests, not domain steps on a subject).

## Decision outcome

Chosen option 1.

- **Rules as data** (`packages/shared/src/sod/rules.ts`). Each rule names: an id and error code
  (`SOD_BILL_SELF_APPROVAL`, `SOD_BATCH_SELF_RELEASE`, …), its design reference, the guarded step
  (`<subject>.<step>`, e.g. `bill.approve`), the earlier steps on the same subject by the same
  person that conflict with it (e.g. `bill.enter`), a condition (`always`, `above_threshold`
  with a named threshold, or `journal_approval_required`), and whether small-team mode may
  except it. Rules 1–6 of §6.5 plus the §6.4 SoD cells are listed in the table in the file.
- **Pure evaluator** `evaluateSod(input)` returns `allow`, `deny(rule)` or
  `allow_with_exception(rule, kind)`. Input: the step, the actor, the subject's amount and flags,
  the subject's recorded history (step, actor), the tenant settings, the number of *other*
  active users who hold the route's permission, and an optional exception request. Amounts are
  compared with decimal.js on strings.
- **Action ledger** `app.sod_action` (migration 0021): one row per successful SoD-declared step
  — tenant, subject type and id, step, actor, amount, time, request id. Tenant-owned, RLS
  ENABLE + FORCE, `tenant_isolation`, `lf_app` SELECT/INSERT only, and a trigger refuses UPDATE
  and DELETE for everyone (directive 6).
- **Settings** `app.sod_settings` (history; latest row wins; no row = code defaults equal to the
  column defaults): `small_team_mode` (off), thresholds `bill_self_approval` 1,000.0000,
  `credit_note_self_approval` 1,000.0000, `journal_approval` 5,000.0000,
  `batch_two_releasers` 10,000.0000, and `report_timezone` (`Australia/Sydney`). Inserted only
  by an active holder of the new permission `settings.sod.manage` (Owner only), with a reason;
  audited by trigger. All values are placeholders pending §11.2.
- **Small-team mode.** When a rule would deny, the rule allows exceptions, the tenant has
  small-team mode on and *no other active user holds the route's permission*, the action is
  allowed only if the request carries `sod_exception` — either an external reviewer (another
  active user of the tenant, e.g. the outside accountant invited as Approver or Auditor, who is
  named as reviewing it) with a reason, or a recorded exception with a reason. Then one
  `app.sod_exception` row is written in the same transaction as the action (insert-only,
  trigger-audited). Without it the request is denied with the rule and
  `small_team_exception_required: true`. If another eligible person exists, the conflict is
  denied even in small-team mode: the control can be satisfied, so it must be.
- **Weekly report.** `GET /sod/exceptions/weekly?week_start=YYYY-MM-DD` (Monday, tenant report
  time zone; permission `audit_log.read`) lists that week's exceptions and whether the Owner has
  acknowledged the week; `POST /sod/exceptions/weekly/acknowledge` records an insert-only
  `app.sod_exception_ack` (Owner, `settings.sod.manage`). `GET`/`POST /sod/settings` read and
  change the settings.
- **Where the check runs.** A route declares `@SoD('<subject>.<step>', subjectFrom)`.
  `TenantInterceptor`, after MFA, permission and step-up, resolves the subject
  (`subjectFrom(req, trx)` → id, amount, flags), takes a transaction advisory lock on the
  subject, reads its history, settings and the eligible count under RLS, evaluates, and on a
  denial throws 403 `{error:'sod_violation', rule}` (the request rolls back; the denial is
  audited in its own transaction like the other access refusals). On success it records the
  step (and any exception) in the request transaction, after the handler. A route declares
  steps by step id (every rule for that step is evaluated) rather than by rule id, so a route
  cannot forget a rule that applies to its step.
- **What stays with the business tasks.** Batch release above the two-releaser threshold needs
  two distinct releasers (rule 1): the engine refuses a second release by the same person and
  exports `releasersRequired(amount, settings)`; counting releases to complete a batch is T-0054.
  Bank-detail cooling-off and previous-contact notice (rule 2) are T-0037. Period reopen
  (rule 6) stays enforced by migration 0018 (two different holders and a reason); its SoD rule
  allows no small-team exception, matching the database.

### Consequences

- Good: one table of rules; one place that checks; tamper-evident history; thresholds per tenant
  with history; small-team exceptions visible weekly.
- Good: business tasks only declare `@SoD(...)` on their routes and record their earlier steps
  (e.g. `bill.enter`) the same way.
- Bad: the action ledger duplicates facts the business tables will also hold (who created the
  bill). Accepted: it is the SoD evidence and outlives edits to business rows.
- Bad: an eligible-person count of zero is the trigger for small-team exceptions; a tenant could
  revoke roles to create the condition. Mitigation: role changes are audited and revoke all
  sessions (ADR-0023); exceptions are reported weekly.
- Neutral: one new permission (`settings.sod.manage`, Owner only).

## Compliance and verification

- SS-PLAT-16 (unit, table-driven + fast-check property), SS-UC05-05, SS-UC05-06, SS-UC06-02,
  SS-UC11-06 (api-db, real sessions, stand-in routes declared as the owning tasks must),
  SS-PLAT-62 (ledger, settings, exceptions and acks: RLS, append-only, Owner-only, audited),
  SS-PLAT-63 (interceptor order and 403 contract, audited denial). SS-PLAT-04 covers the new
  tables.
- Mutation checks recorded on the T-0015 card.

## Links

- Design §6.3, §6.4, §6.5, §11.2; RQ-0012 (SoD gaps); ADR-0023; ADR-0025; migration 0018.
- DL-0129 … DL-0133.
