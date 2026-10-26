---
adr: 0034
title: "Audit log read path: a permission-checked SECURITY DEFINER reader instead of SELECT for lf_app; admin read routes for users, caller access and the audit log"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0034: Audit log read path and admin read routes

## Status

Proposed — security category, waiting for product-owner acceptance. It builds on ADR-0023 (role
templates and permission checks), ADR-0025 (MFA and step-up) and ADR-0027 (user lifecycle and
tokens) without changing them. T-0093 is built to this proposal so it can be judged on working,
tested code. Research: [RQ-0038](../research/RQ-0038-admin-ui-audit-read-path.md).

## Context and problem statement

Design §6.4 gives the Auditor (and the Owner and Finance Admin) read access to the audit log;
§6.8 keeps the log in a separate schema "the application can insert into but not update".
Migration 0003 grants `lf_app` INSERT only on `audit.audit_log`, so nothing in the product can
read the log today. T-0093's audit log viewer needs a read path. The admin screens also need a
list of users (only `GET /users/:id` exists) and need to know what the caller may do, while
`GET /auth/me` cannot change shape (its body is asserted exactly by existing tests).

## Decision drivers

- Least privilege for the application role: reading the whole audit trail should not be one
  forgotten decorator away from any route.
- The append-only guarantee and the "no RETURNING on audit" rule stay as they are.
- Tenant isolation in depth: RLS plus an explicit tenant filter.
- Follow the project's pattern for privileged operations (migration 0018 period functions).

## Considered options

### Option A — `GRANT SELECT ON audit.audit_log TO lf_app`

Simplest; RLS keeps tenants apart. But every code path running as lf_app could read every audit
row of the tenant (IP addresses, user agents, before/after values) with only the API decorator in
the way, and unbounded queries become possible.

### Option B — a SECURITY DEFINER reader function (chosen)

`audit.read_log(p_actor, p_filter_actor, p_action, p_entity_type, p_entity_id, p_from, p_to,
p_before, p_limit)`, owned by `lf_migrator`, `STABLE`, `SET search_path = pg_catalog, pg_temp`,
`EXECUTE` granted to `lf_app` only (revoked from PUBLIC). lf_app keeps INSERT only on the table.

### Option C — a separate reporting role or read replica

Right for large exports later; too much machinery for one screen now.

## Decision outcome

Option B, plus three read routes.

1. **`audit.read_log`** (migration 0027):
   - refuses without a tenant context (`app.tenant_id` unset → 42501);
   - refuses unless `p_actor` is an active user of the tenant holding a role whose template
     includes `audit_log.read` — `app.role_allows_audit_read(role)`, a mirror of the catalogue
     (owner, finance_admin, auditor) proved equal to `ROLE_TEMPLATES` by a test (42501);
   - filters `tenant_id` explicitly and stays under FORCE RLS as the table owner;
   - `p_limit` must be 1..100 (22023); rows newest first by `id`, keyset `id < p_before`;
   - action matches case-insensitively as a substring; entity type and id exactly; actor by id;
     `p_from` inclusive, `p_to` exclusive.
2. **`GET /audit-log`** (`audit_log.read`): query `actor`, `action`, `entity_type`, `entity_id`,
   `from`, `to` (calendar dates in the tenant's report time zone), `before`, `limit` (default
   50). Answers `{ entries, next_before }`. Read-only; no route changes an audit row.
3. **`GET /users`** (`users.read`): every user of the tenant with status and active roles.
4. **`GET /auth/me/access`** (any member): `{ roles, permissions }` — active role ids and the
   request's effective permissions (role permissions ∩ token scopes). The browser uses it only to
   hide or disable actions; the API stays the authority.

## Consequences

### Good

- lf_app still cannot SELECT the audit table; the only read is a bounded, permission-checked,
  tenant-scoped function. A future route that forgets its decorator still gets 42501 for a user
  without an audit-reading role.
- The admin screens can be permission-aware without changing `/auth/me`.

### Bad / accepted trade-offs

- `p_actor` is supplied by the application; the database check is defence in depth, not proof
  of identity (same as the period functions of migration 0018).
- The role mirror must be kept in step with `catalogue.ts` (the test fails if it drifts).
- Reading the audit log is not itself audited (GET requests are not audited today). Open
  question for the product owner (design §6.9 mentions alerts on mass export).

### Follow-ups

- Quarterly access review sign-off (design §6.3 item 4) is not built by T-0093.
- An export of the audit log for auditors would need its own route and limits.

## Compliance and verification

- `packages/db/src/audit-read.db.test.ts`: lf_app direct SELECT → 42501; reader returns only
  the tenant's rows; refuses a non-audit role, a disabled user, a foreign-tenant user, no tenant,
  a limit outside 1..100; filters and keyset pages; the role mirror equals the catalogue.
- `apps/api/src/audit/audit-log.db.test.ts` and `apps/api/src/users/users.list.db.test.ts`:
  routes, permissions (403 for roles without them), shapes and tenant isolation.

## Links

- RQ-0038; design §6.4, §6.8; ADR-0023, ADR-0025, ADR-0027; migration 0003, 0018; T-0093.
