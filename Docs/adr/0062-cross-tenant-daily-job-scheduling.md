---
adr: 0062
title: "Reach every tenant from a scheduled daily job without widening lf_app"
status: Proposed
date: 2026-11-13
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0062: Reach every tenant from a scheduled daily job without widening lf_app

## Status
Proposed. Category **security**, so it stays Proposed until the product owner decides (AGENTS.md §6).

## Context and problem statement
UC-04 needs a daily overdue-reminder run for every company (T-0129 split, T-0147). The worker connects as `lf_app` under FORCE RLS and cannot see `app.tenant` rows other than the one in `app.tenant_id` (0002, `tenant_self`). Outbox jobs carry their tenant id because they are enqueued inside a tenant transaction. A schedule has no tenant. The only cross-tenant primitive today is `app.tenant_id_for_slug()` (ADR-0016), which is login only. ADR-0008 says the `lf_app` worker never installs, supervises or schedules. RQ-0144 F2 has the details.

## Decision drivers
- The tenant boundary must stay a database guarantee. No process should get BYPASSRLS.
- Least privilege: the primitive must reveal only what the job needs (active tenant ids), never names or data.
- Pilot ops: one worker, one owner (maintenance) instance; no extra service.
- The same mechanism should serve later daily jobs (Stripe payouts T-0130, ECL, depreciation).

## Considered options
1. **Owner-instance fan-out.** The `lf_migrator` maintenance instance (queue-admin.ts) holds the pg-boss schedule. Daily, it reads the active tenant ids as the table owner, through a SECURITY DEFINER function owned by lf_migrator and executable only by lf_migrator. It enqueues one `ar.reminders.run` job per tenant with `{tenantId}` in the job data. The `lf_app` worker runs each job inside `withTenant`, computes the run date from the tenant's `report_timezone`, and runs every company of that tenant.
2. **`lf_app`-executable primitive.** `app.active_tenant_ids()` is SECURITY DEFINER, returns only ids of active tenants, and has EXECUTE granted to `lf_app`. The worker schedules and fans out itself. This is simpler, but any `lf_app` code path (the API included) could enumerate tenant ids.
3. **External cron.** An operator cron calls a CLI per tenant. This pushes tenant enumeration into ops and does not work in hosted SaaS without the same primitive.

## Decision outcome
**Recommended: option 1.** Enumeration stays with the owner role, which already administers pg-boss (ADR-0008 rule 5). `lf_app` gains nothing, and per-tenant work still runs under RLS. Option 2 is acceptable if the owner prefers a single process; then EXECUTE stays limited to `lf_app` and the function returns ids only. Pending owner decision.

## Consequences
- Option 1 needs the maintenance instance running in every deployment. T-0094 compose already runs it as `queue-admin`, but supervision credentials are an open question (ADR-0029).
- One migration adds the function and its grant, with RLS and privilege tests: `lf_app` cannot call it, and it returns ids only.
- Jobs are idempotent per company and run date (`app.ar_reminder` primary key), so a duplicate fan-out queues nothing twice.
