---
id: RQ-0144
title: Which date is a company's reminder "run date", how can a daily job reach every tenant, and how is a per-party reminder pause stored and audited?
status: resolved
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0129, T-0147]
linked_adrs: [ADR-0062]
superseded_by:
---

# RQ-0144: Reminder run date, cross-tenant scheduling and the per-party pause

## Question

1. T-0129 open question: which time zone defines "the run date" for a company's daily
   overdue-reminder run?
2. How can a daily job in the worker run `runOverdueReminders` for every company of every
   tenant, given that the worker connects as `lf_app` under FORCE RLS?
3. How should UC-04's "AR Clerk can pause reminders per party (audited)" be stored, permissioned
   and audited?

## Why it matters

The run date decides which invoices are "N days overdue". An off-by-one-day time zone sends a
reminder a day early or late. Reaching every tenant from one process breaks the tenant boundary
unless it is designed. And a pause that is not audited breaks UC-04's acceptance.

## Findings (sources: this repository)

- **F1 — There is no company time zone.** `app.company` (0002) has no time-zone column. The only
  time-zone setting is the tenant-level `app.sod_settings.report_timezone` (0021), which is
  history, latest row wins, and defaults to `Australia/Sydney`. A trigger checks it against
  `pg_timezone_names`. Periods (design §3.5) are calendar dates with no time zone.
- **F2 — `lf_app` cannot list tenants.**
  - `app.tenant` has FORCE RLS with the `tenant_self` policy (0002). A row is visible only when
    `app.tenant_id` is set to that tenant.
  - The only cross-tenant primitive is `app.tenant_id_for_slug()` (0014, ADR-0016). It is
    SECURITY DEFINER, login only, "nothing else".
  - Outbox jobs work only because the tenant id travels inside the job data. Each job was
    enqueued from inside a tenant transaction.
  - A scheduled job has no tenant context, so it needs a new cross-tenant primitive, for
    example a SECURITY DEFINER function that returns active tenant ids. Alternatively, the owner
    instance (`lf_migrator`, queue-admin.ts) could enqueue one job per tenant.
  - Either way the tenant boundary and the worker's privileges change. `packages/db/AGENTS.md`
    and design §6 make such changes a **security** decision (ADR, human gate). ADR-0008 also
    says the `lf_app` worker "never installs, supervises or schedules".
- **F3 — An auditing mechanism exists.** The API's tenant interceptor writes one
  `audit.audit_log` row for every successful mutation, with actor, action, entity, IP and
  request id (SS-PLAT-30, T-0014, design §6.8). A pause/resume HTTP route is therefore audited
  without new audit code.
- **F4 — The right permission exists.** The catalogue has `ar.dunning.run` ("dunning" means the
  overdue reminders). The AR Clerk template has it, and Sales User does not. Reusing it needs
  no change to the role templates (ADR-0023), so no security ADR.
- **F5 — Storage follows existing patterns.**
  - Settings in this codebase are kept as history: `sod_settings` is append-only and the latest
    row wins. Reminder logs are append-only (0059).
  - A pause stored as an insert-only history row of `(party, paused, reason, by, at)` keeps
    who paused, when and why, even after a resume. That is the audit UC-04 asks for, kept with
    the data as well as in `audit.audit_log`.
  - Idempotency (design §3.9): mutating routes store their key with the row they create. An
    example is `receipts.controller.ts` (201 for a new row, 200 for a replay).

## Conclusion

1. **Run date:** the calendar date of the run instant in the tenant's latest
   `sod_settings.report_timezone`, or `Australia/Sydney` when no settings row exists (the column
   default). `runOverdueReminders` already takes `runDate` explicitly, so the scheduler computes
   it and the module stays pure. A per-company zone would need a design change; record it if
   multi-zone groups appear.
2. **Daily cross-tenant job:** do not build it on this card. It needs a security ADR. ADR-0062
   (Proposed) sets out the options, and the work moves to the new card **T-0147**, blocked on
   the owner. Until then the run stays callable per company (T-0068), so nothing that is built
   depends on the decision.
3. **Pause:**
   - Migration 0063 adds `app.ar_reminder_pause`, an insert-only history with an idempotency
     key (lf_app SELECT and INSERT; RLS ENABLE + FORCE).
   - `runOverdueReminders` skips parties whose latest row is `paused = true`.
   - `POST /ar/parties/:id/reminder-pause {company_id, paused, reason}` needs `ar.dunning.run`
     and an Idempotency-Key, and is audited by the interceptor (F3).
4. **Default schedule for new companies:** no production path creates a company yet. Only test
   fixtures do (`insertInto('app.company')` appears only in testing code), and the setup wizard
   is T-0123. So T-0129 AC-3 moves to T-0123, which calls the existing `seedReminderSchedule`.
