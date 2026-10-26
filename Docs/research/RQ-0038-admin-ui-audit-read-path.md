---
id: RQ-0038
title: Admin screens — audit log read path, caller permissions in the browser, step-up routing, and the missing list endpoints
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0093]
linked_adrs: [ADR-0034, ADR-0023, ADR-0025, ADR-0026, ADR-0027]
superseded_by:
---

# RQ-0038 — What the admin screens need from the API and the database

## Question

T-0093 builds four screens in `apps/web`: users (list, invite, offboard with a successor), role
assignment, the weekly SoD exceptions report with Owner acknowledgement, and an audit log viewer
(filter by actor, action, entity and date; paginated; read-only). On base 658a793:

- Q1 `lf_app` holds INSERT only on `audit.audit_log` (migration 0003; `packages/db/AGENTS.md`:
  "Do not use RETURNING, which needs SELECT"). How does the API read the audit log, and who may?
- Q2 There is no list of users (`GET /users/:id` only). How does the users screen get its rows?
- Q3 The web app knows only `GET /auth/me` (tenant, user, display name). How does it know what the
  caller may do, so it can hide or disable actions (ui-engineer rule "permission-aware")?
- Q4 What does the browser do when an API answers `401 {error:'step_up_required', max_age}` or
  `403 {error:'mfa_required'}`?
- Q5 How is the audit log paginated, and which time zone do the date filters use?

## Why it matters

The audit log holds every actor, action, before/after value, IP address and user agent of the
tenant (design §6.8). A read path that is wider than needed leaks it across roles or tenants; one
that lets the application change it breaks the append-only guarantee. A screen that offers
actions the caller cannot take breaks P6 ("a disabled button with no reason"; "403 Forbidden").

## Sources consulted

The sandbox could not reach postgresql.org, owasp.org or the RFC editor on 2026-10-25 (the egress
proxy answered `CONNECT tunnel failed, response 403`; not retried). External sources are cited
from the author's knowledge of these well-known documents and marked secondary. The database
behaviour is established by this task's own integration tests, which are the primary source for
what the product does.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §6.4 (Auditor: "Read-only everything including audit log"), §6.8 ("stored in a separate schema the application can insert into but not update"), §6.3 (mover/leaver), §6.5 (weekly report the owner must acknowledge) | 2026-10-25 | primary (design) | The audit log is readable by the Auditor; the application must not be able to change it. |
| S2 | `packages/shared/src/rbac/catalogue.ts` | 2026-10-25 | source code | `audit_log.read` is held by Owner (all), Finance Admin and Auditor (all read permissions). `users.read` by Owner, Finance Admin, Auditor; `users.manage` by Owner only; `users.roles.assign` by Owner and Finance Admin; `users.roles.assign_owner` by Owner only. |
| S3 | `Docs/ui/information-architecture.md` §2, §3, S19 | 2026-10-25 | primary (IA) | Settings → users & roles at `/settings/users` (Owner ●, Finance Admin ◐ no Owner changes, Auditor ◐ read); Reports → control exceptions, audit log; audit log visible to Owner, Finance Admin, Auditor (Accountant ◐). |
| S4 | Migrations 0003, 0018 (`app.period_set_status`, SECURITY DEFINER, `SET search_path = pg_catalog, pg_temp`, actor permission re-checked in SQL), 0021 (`app.sod_exception_report`) | 2026-10-25 | source code | Project pattern for privileged operations: a definer function owned by `lf_migrator`, fixed search path, explicit grant to `lf_app`, the actor's permission checked again in the database. |
| S5 | RQ-0034 S6 (experiment, 2026-10-25) | 2026-10-25 | experiment (project) | A SECURITY DEFINER function owned by `lf_migrator` runs as `lf_migrator`; with FORCE RLS the definer (the table owner) still sees only the current tenant's rows. |
| S6 | PostgreSQL 16 documentation, "CREATE FUNCTION — Writing SECURITY DEFINER Functions Safely" and "Row Security Policies" (FORCE ROW LEVEL SECURITY) | 2026-10-25 | secondary (unreachable) | A definer function should set `search_path` to exclude schemas writable by untrusted users; table owners bypass RLS unless FORCE is set. |
| S7 | OWASP ASVS 4.0.3 V7.3 "Log protection" and the OWASP Logging Cheat Sheet | 2026-10-25 | secondary (unreachable) | Logs must be protected from unauthorised access and modification; access to logs should be restricted and itself controlled. |
| S8 | `apps/api/src/authz/mfa.ts`, `apps/api/src/auth/auth.controller.ts` (`GET /auth/step-up?max_age&return_to`, `RETURN_TO` guard), ADR-0025, RFC 9470 (OAuth 2.0 Step-up Authentication Challenge) | 2026-10-25 | source code + secondary | A route needing step-up answers `401 {error:'step_up_required', max_age}`; the client starts `/auth/step-up` with `max_age` and a same-origin `return_to`; the callback refreshes the session and returns there. `403 {error:'mfa_required'}` means the role needs MFA and the session has none. |
| S9 | `apps/api/src/authz/routes.test.ts`, `auth/session.db.test.ts` and `authz/permissions.db.test.ts` | 2026-10-25 | source code (tests) | `GET /auth/me` is asserted with `toEqual` on its exact body; adding fields to it would change existing assertions (forbidden by the round protocol). |
| S10 | PostgreSQL 16 documentation, "LIMIT and OFFSET" | 2026-10-25 | secondary (unreachable) | Rows skipped by OFFSET still have to be computed, so a large OFFSET is slow; and OFFSET pages shift when rows are added. |
| S11 | This task's tests: `packages/db/src/audit-read.db.test.ts`, `apps/api/src/audit/audit-log.db.test.ts` | 2026-10-25 | experiment (this task) | lf_app's direct `SELECT` on `audit.audit_log` is refused (42501); `audit.read_log` returns only the current tenant's rows, refuses an actor without an audit-reading role (42501), caps the page size and is not callable without a tenant. |

## Findings

1. **Q1 — read path.** Granting `SELECT ON audit.audit_log TO lf_app` would let every code path of
   the application read the whole tenant's audit trail, guarded only by a controller decorator.
   The project's pattern for privileged operations (S4) is narrower: one SECURITY DEFINER function
   `audit.read_log(...)`, owned by `lf_migrator`, `SET search_path = pg_catalog, pg_temp` (S6),
   STABLE (it cannot write), `EXECUTE` granted to `lf_app` only. It (a) requires a tenant context,
   (b) re-checks in SQL that the acting user is active and holds a role whose template includes
   `audit_log.read` (owner, finance_admin, auditor — a mirror of the catalogue proved equal by a
   test, as `app.permission_known` is), (c) filters by `tenant_id` explicitly *and* stays under
   FORCE RLS as the owner (S5), (d) returns at most 100 rows per call. lf_app keeps INSERT only on
   the table, so the append-only guarantee and the "no RETURNING" rule are unchanged. The API
   route `GET /audit-log` needs `audit_log.read` (TenantInterceptor) and passes the acting user.
   Because it widens what the application role can read, this is a security decision: ADR-0034,
   Proposed, human gate.
2. **Q2 — users list.** `app.app_user` and `app.user_role` are already readable by lf_app under RLS
   (S4, `GET /users/:id`). A `GET /users` route with `users.read` returning each user with their
   active roles needs no migration.
3. **Q3 — caller permissions.** `/auth/me` cannot change (S9). A new member route
   `GET /auth/me/access` returns `{ roles, permissions }`: the active role ids and the request's
   *effective* permissions (role permissions, cut down to a token's scopes — the same set
   TenantInterceptor checks). The browser uses it only to hide or disable actions; the API remains
   the authority and every refusal still comes from the server.
4. **Q4 — step-up and MFA.** On `401 step_up_required` the web app leaves the SPA for
   `/auth/step-up?max_age=<n>&return_to=<current path and search>` (S8); the API validates
   `return_to` with its open-redirect guard. On `403 mfa_required` the screen says that the role
   needs two-step sign-in and offers sign-in again; on any other 401 it goes to sign-in
   (`reason=expired`), as the shell does.
5. **Q5 — pagination and dates.** Keyset pagination on the identity `id` (newest first,
   `before=<id>`), not OFFSET (S10): stable while new rows arrive and cheap on the existing
   `(tenant_id, occurred_at)` index. Date filters are calendar dates interpreted in the tenant's
   report time zone (`app.sod_report_timezone()`, the zone the weekly SoD report already uses), so
   "25 Oct" means the same day on both admin reports. Action matches case-insensitively as a
   substring (actions are free text such as `POST /users/:userId/roles` or `user.joined`); entity
   type and entity id match exactly; actor is a user id chosen from the users list.

## Conclusion

Build `audit.read_log` (migration 0027) under ADR-0034 (security, Proposed) and the three read
routes `GET /users`, `GET /auth/me/access`, `GET /audit-log`. The screens use them, route
step-up challenges to `/auth/step-up`, and hide or disable what the caller's effective
permissions do not allow, with the reason shown.

Not resolved here (open for the product owner): whether *reading* the audit log should itself be
audited (design §6.9 mentions alerts on mass export; GET requests are not audited today), and the
quarterly access review sign-off (design §6.3 item 4), which this task does not build.

**Confidence:** high for Q1–Q3 and Q5 (project code, design and this task's tests); medium for the
wording of S6, S7 and S10, which could not be re-read on 2026-10-25.
**Affects:** T-0093; migration 0027; ADR-0034; any later screen that reads the audit log (e.g.
the invoice detail's audit panel, S03) should reuse `GET /audit-log` with an entity filter.
