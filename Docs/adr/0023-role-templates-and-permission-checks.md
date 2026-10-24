---
adr: 0023
title: "Role templates as code, tenant-scoped role assignments, and a fail-closed permission check on every endpoint"
status: Proposed
date: 2026-10-24
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0023: Role templates as code, tenant-scoped role assignments, fail-closed permission checks

## Status

Proposed — security category, awaiting product-owner acceptance. T-0012 is built to this
proposal so it can be judged on working, tested code. The role → permission matrix in
`packages/shared/src/rbac/catalogue.ts` is the part that most needs the product owner's eye
(see *Open points for the product owner*).

## Context and problem statement

Design §6.4 lists ten role templates with what each "can" and "cannot (by default)" do; §6.2 says
which roles need MFA and that a role change revokes all sessions; §6.3 says a role change (mover)
requires Owner or Finance Admin; §6.5 lists SoD rules (T-0015, not here). `apps/api/AGENTS.md`
requires authorisation "via RBAC + SoD checks in a guard, never ad hoc in controllers". UC-02
needs `ar.batch.run` (SS-UC02-07: a user without it is refused with 403 and the refusal is
audited). Before T-0012 every authenticated user of a tenant could call every endpoint.

Three questions need a decision:

1. Where do the role templates and the role → permission mapping live?
2. How are roles assigned to users, and how is a change made safe (revoke-all, audit, no delete)?
3. Where in the NestJS request lifecycle is the permission checked?

## Decision drivers

- No table without `tenant_id` unless a security ADR says so (`packages/db/AGENTS.md`); prefer an
  IMMUTABLE SQL function or a code constant, as migration 0005 did for `app.system_role_allows`.
- The mapping must be reviewable and versioned with the code that enforces it.
- Fail closed: a new endpoint that forgets to declare its permission must be refused, not open.
- Revoke-all on role change (§6.2, ADR-0016) must not depend on every caller remembering it.
- Never delete (directive 6): a revoked assignment stays as history.
- The check needs the verified principal, which exists only inside the tenant transaction
  (ADR-0016: the session is verified under the claimed tenant's RLS).

## Considered options

1. **Templates and mapping as an immutable code constant; role ids mirrored by an IMMUTABLE SQL
   function; assignments in a tenant table (chosen).**
2. Global `role_template` / `role_permission` tables without `tenant_id` (needs GLOBAL_TABLES and
   its own RLS; data that only changes with a release would sit in a mutable table).
3. Per-tenant copies of the templates seeded at provisioning (custom roles later). Templates would
   drift from the code that checks them, and every tenant needs a data migration when a
   permission is added.

### Option 1 — code constant + IMMUTABLE function + tenant assignments

- Good, because the mapping is reviewed in a PR, unit-tested as a matrix, and needs no table
  without `tenant_id`.
- Good, because adding a permission is a code change only.
- Bad, because custom roles (design §2 comparison table: "fixed role templates plus custom roles")
  need a tenant table later. That table can be added beside this one without changing it.

### Option 2 — global tables

- Good, because SQL could join permissions.
- Bad, because it needs a GLOBAL_TABLES entry and policy, and the data is still only changed by
  releases.

### Option 3 — per-tenant seeded copies

- Good, because it is the shape custom roles will need.
- Bad, because templates drift and every permission change becomes a data migration per tenant.

## Decision outcome

Option 1:

- `packages/shared/src/rbac/catalogue.ts` (`@ledgerforce/shared/rbac`): `PERMISSIONS`
  (`<area>.<object>.<action>`, each `read` or `write`), the ten `ROLE_TEMPLATES` with their
  permissions, `mfaRequired` (§6.2, data for T-0013) and `interactiveLogin` (Sales user,
  Integration), and `permissionsOf(roles)` = union over roles. The Auditor gets every `read`
  permission; the Owner gets all of them.
- Migration `0016_auth_roles_permissions.sql`:
  - `app.role_template_exists(text)`: IMMUTABLE, mirrors `ROLE_IDS`; a test proves they agree.
  - `app.user_role`: tenant-scoped (RLS ENABLE + FORCE, `tenant_isolation`), one row per grant,
    `granted_at/granted_by`, `revoked_at/revoked_by/revoke_reason`. At most one active grant per
    (user, role) (partial unique index). `lf_app` has SELECT, INSERT and UPDATE of the revoke
    columns only; no DELETE. A trigger refuses un-revoking and any other change.
  - An AFTER INSERT/UPDATE trigger bumps `app.app_user.session_epoch` in the same transaction
    (revoke-all, ADR-0016), so no code path can change a role without revoking sessions.
- API (`apps/api/src/authz/`):
  - `@RequirePermission('…')` on a handler or controller; `@AnyMember()` for routes that every
    signed-in member may use (`/auth/me`, `/auth/logout`, `/companies`).
  - The check runs in `TenantInterceptor`, right after the session is verified inside the tenant
    transaction, because NestJS runs guards *before* interceptors
    (<https://docs.nestjs.com/faq/request-lifecycle>) and the verified principal does not exist
    yet in a guard. It is still one central check, never ad hoc in controllers.
  - Fail closed: a tenant route with neither decorator gets 403 `{error:'forbidden',
    permission:null}`; a route that requires a permission and has no verified user principal
    gets 403.
  - Denied: 403 `{error:'forbidden', permission}`. The request transaction rolls back, so the
    denial is audited in its own transaction (`action = 'permission_denied'`, actor, permission,
    method and route, request id).
  - Role administration: `GET /users/:id/roles`, `POST /users/:id/roles` `{role}`,
    `POST /users/:id/roles/:role/revoke`. Granting or revoking Owner needs
    `users.roles.assign_owner` (Owner only); other roles need `users.roles.assign` (Owner,
    Finance Admin — §6.3 mover). Both are naturally idempotent. The last active Owner of a tenant
    cannot be revoked (409 `last_owner`). Each change is audited with before/after.
- Hook points left for later tasks: SoD (T-0015) plugs into the role-assignment service and the
  permission check; MFA (T-0013) reads `mfaRequired`; connector scopes and API tokens attach to
  the Integration role.

### Consequences

- Good: one catalogue, one check, fail-closed by default; role change and revoke-all are atomic.
- Bad: custom roles need a further table (additive). Users without an assignment can do nothing
  except `/auth/me`, `/auth/logout` and `/companies`; provisioning (T-0010s) must grant the first
  Owner.

## Open points for the product owner

The design's "Can / Cannot" columns do not name every permission. These readings were made and
are easy to change in the catalogue:

1. Finance Admin (adviser equivalent) is given the Accountant's permissions as well as
   configuration and periods, `users.roles.assign` (not Owner) and `audit_log.read`.
2. Payment-batch release (`ap.payment_batch.release`) is given to Owner and Approver; net-pay
   release (`payroll.net_pay_batch.release`) to Owner only; supplier bank-detail verification
   (`parties.bank_account.verify`) to Owner only.
3. The Auditor ("read-only everything") gets every `read` permission, including
   `payroll.employee_bank.read` and `users.read`.
4. Sales user and Integration get no LedgerForce permission.

## Compliance

- `packages/shared/src/rbac/rbac.matrix.test.ts` (matrix over §6.4).
- `packages/db/src/user-role.db.test.ts` (table, triggers, mirror of role ids).
- `apps/api/src/authz/permissions.db.test.ts` (403 + audit, fail-closed, role admin, revoke-all).
- `packages/db/src/rls.db.test.ts` (generated SS-PLAT-04 suite covers `app.user_role`).
