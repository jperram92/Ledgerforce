---
adr: 0061
title: "Bind new system roles through an additive second binding table and a union view"
status: Accepted
date: 2026-11-13
author: claude
category: data
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0061: Additive system-role binding for the period-end roles

## Status

Accepted 2026-11-13 by claude under the owner instruction DL-0405 ("accept all within risk"):
category `data`, not accounting or security. It changes no accounting treatment and no golden
posting, adds no table without `tenant_id`, grants `lf_app` nothing beyond what it already
holds on `app.account_system_role`, and every rule is proven by DB tests on the branch.
Cross-provider review (codex) of T-0117 still applies to the implementation.

## Context and problem statement

Design §3.2 makes the posting engine resolve accounts by **system role**, never by code.
Design §3.2 "AASB note" and §3.10 (T-0115; RQ-0095, RQ-0096; owner decision DL-0256) add seven
roles for period-end work: AR_ECL_ALLOWANCE (AASB 9), PREPAYMENTS and ACCRUED_EXPENSES
(accrual basis), ACCUM_DEPRECIATION and DEPRECIATION_EXPENSE (AASB 116), SGC_PAYABLE (Payday
Super / SG charge) and PRIOR_PERIOD_ADJUSTMENTS (AASB 108). The Approved golden postings
GP-024…GP-036 and GP-038 name them as `system:<ROLE>` bindings.

`app.account_system_role.role` (migration 0005) has an inline `CHECK (role IN (…17 roles…))`.
PostgreSQL 16/17 cannot change a CHECK expression without `DROP CONSTRAINT`, and a NOT VALID
replacement still needs the old one dropped (RQ-0143, verified on the local cluster). The
forward-only gate (AGENTS.md §0.6, `packages/db` migration policy) forbids DROP. T-0116 therefore
bound these accounts through template `suggestedSettings` and the golden map named them by code.

## Decision drivers

- Forward-only, additive SQL that runs on PostgreSQL 16 and 17 (DL-0007).
- One rule for every role: the same type, postable, control and active checks, the same lock
  ordering, the same "never unbound, never deleted" behaviour.
- Tenant isolation identical to the existing table (RLS ENABLE + FORCE, cross-tenant suite).
- Readers (posting engine, subledger checks, chart listing, reports) see one set of bindings.
- The next role should not hit the same wall.

## Considered options

1. **Second binding table + union view (chosen).** `app.account_system_role_ext` with the same
   columns, keys and foreign key, a role CHECK that calls an IMMUTABLE function, the existing
   assert trigger function, RLS and grants; `app.account_role_binding` as a
   `security_invoker` view over both tables.
   - Good: purely additive; no rewrite of stored rows; future roles need only
     `CREATE OR REPLACE` of two functions (the established `app.source_type_class()` pattern).
   - Bad: two physical tables; a role's table must be known when writing (`bindingTableFor()`
     in `system-roles.ts`).
2. **New column/table that replaces the old one** (add `role_v2`, backfill, deprecate).
   - Good: one table in the end.
   - Bad: a two-phase shape change with a deprecation ADR, duplicate primary-key semantics
     during transition, and every writer changed twice; no functional gain.
3. **Keep binding by template setting (status quo).**
   - Bad: the engine cannot resolve these roles; a re-typed or archived account is not guarded;
     violates design §3.2.

## Decision outcome

Chosen option 1, as migration `0062_gl_period_end_system_roles.sql`:

1. `app.system_role_is_extended(role)` — IMMUTABLE, true exactly for the seven roles. It may
   only ever be **widened** (CREATE OR REPLACE), never narrowed, and must never return true
   for a role that the 0005 CHECK accepts, so a role lives in exactly one table.
2. `app.system_role_allows(role, type)` is replaced (same signature and contract) with the 17
   existing rules plus: AR_ECL_ALLOWANCE, PREPAYMENTS, ACCUM_DEPRECIATION → `asset`;
   DEPRECIATION_EXPENSE → `expense`; ACCRUED_EXPENSES, SGC_PAYABLE → `liability`;
   PRIOR_PERIOD_ADJUSTMENTS → `equity` (RQ-0143 table, with sources). Contra accounts are typed
   `asset` with a `credit` normal balance, as in the template and comparable systems.
   None is a control role; all are postable (`app.system_role_is_control` and
   `app.assert_account_fits_role` are unchanged).
3. `app.account_system_role_ext` — identical shape to `app.account_system_role`:
   `tenant_id` (default from `app.tenant_id`), `company_id`, `role CHECK
   (app.system_role_is_extended(role))`, `account_id`, `bound_at`; PK
   `(tenant_id, company_id, role)`; FK to `app.account (tenant_id, company_id, id)`; index
   `(tenant_id, account_id)`; RLS ENABLE + FORCE; `tenant_isolation` USING + WITH CHECK;
   `lf_app` SELECT, INSERT, UPDATE (no DELETE). The trigger reuses
   `app.account_system_role_check()` unchanged (fits-role assert with `FOR SHARE` lock;
   role/company immutable on re-bind).
4. `app.account_guard_bound()` is replaced to check the account against the roles bound in
   **both** tables.
5. `app.account_role_binding` — `CREATE VIEW … WITH (security_invoker = true)` as
   `UNION ALL` of both tables (columns `tenant_id, company_id, role, account_id, bound_at`);
   `lf_app` SELECT. Every reader that resolves a role generically reads the view
   (posting engine role resolution and control-role lookup, subledger reconciliation/drift,
   chart listing, report role accounts). Readers of one fixed core role may keep reading the
   core table.
6. TypeScript: `SYSTEM_ROLES` grows to 24, `ROLE_ACCOUNT_TYPES` mirrors rule 2,
   `EXTENDED_SYSTEM_ROLES` mirrors rule 1, `bindingTableFor(role)` routes writes;
   `loadChartTemplate` binds each role into its table; the AU services template binds the
   seven accounts by `systemRole`; the golden map `AU_SERVICES_BINDINGS` resolves the seven
   `system:` bindings by role instead of by code.

## Consequences

### Good

- The engine resolves the period-end roles; a bound period-end account cannot be archived,
  made non-postable, given the control flag or re-typed out of its role's type.
- No stored row changes; no migration is edited; no new table without `tenant_id`.
- A future role is added by widening two functions in a new migration.

### Bad / accepted trade-offs

- Two physical binding tables. Writers must pick the table (`bindingTableFor`); a test
  proves that no role is accepted by both.
- A CHECK that calls a function relies on the function only being widened; the rule is
  written in the function comment, this ADR and the migration header.

### Follow-ups

- T-0145: AR write-off (`packages/modules/ar/src/write-off.ts`) still reads the allowance
  account from `ar_settings.ecl_allowance_account_id`; move it to the AR_ECL_ALLOWANCE role
  (keeping the setting as an explicit override, or deprecating it) once its golden replay
  allows.
- T-0146: the setup wizard and chart UI should let a user re-bind the period-end roles
  (UPDATE on `app.account_system_role_ext`) the same way as the core roles.

## Compliance and verification

| Check | Where | Gate |
| --- | --- | --- |
| Template binds all 24 roles once; 7 in the ext table; view returns all 24 | `packages/modules/gl/src/period-end-roles.db.test.ts` | test:db |
| Type rule per new role (independent expectation) and TS mirror agreement | `period-end-roles.db.test.ts`, `chart.db.test.ts` | test:db |
| Guard: archive / non-postable / control flag / re-type refused for ext-bound accounts | `period-end-roles.db.test.ts` | test:db |
| Unknown role and core role refused by the ext table; no role in both | `period-end-roles.db.test.ts` | test:db |
| lf_app cannot DELETE ext bindings; view hides other tenants (security_invoker) | `period-end-roles.db.test.ts` | test:db |
| RLS ENABLE + FORCE, policy, grants, cross-tenant select/aggregate/update/delete/insert | `packages/db/src/rls.db.test.ts` (generated suite) | test:db |
| Engine posts `{ role: 'PREPAYMENTS' }` etc.; golden runner replays GP-024…GP-038 via roles | `packages/ledger/src/golden/golden-engine.db.test.ts` | test:db, golden |
| No DROP/RENAME in the migration | migration policy (`packages/db/src/migrate.ts`) | runner |
