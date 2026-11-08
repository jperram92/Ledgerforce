---
adr: 0003
title: "PostgreSQL shared schema with forced row-level security for tenant isolation"
status: Proposed
date: 2026-10-24
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0003: PostgreSQL shared schema with forced row-level security for tenant isolation

## Status

Proposed — **Design-committed; awaiting product-owner acceptance.** The design commits to this
(D4, §6.7), but tenant isolation is a security decision and the human gate for `security`
ADRs applies (AGENTS.md §6). Implementation may proceed on the design-committed option; the
ADR flips to Accepted when the product owner applies the `adr:security` label.

## Context and problem statement

LedgerForce is multi-tenant: a **tenant** is the security boundary (§3.1), and hosted SaaS
will hold many small businesses' books in one installation (§7.2). The threat model lists
"tenant data leakage — bug omits a tenant filter" as a top risk (§6.1). Agent-written code
makes a forgotten `WHERE tenant_id = …` a realistic failure mode, so isolation must not depend
on every query being written correctly. At the same time, self-hosted SMB installs are usually
a single tenant, and "large or regulated customers can run a dedicated database" (§6.7).

PostgreSQL facts that shape the decision (checked 2026-10-24):

- RLS policies apply to normal roles once `ENABLE ROW LEVEL SECURITY` is set; **table owners
  and superusers bypass RLS unless `FORCE ROW LEVEL SECURITY` is also set**, and roles with
  `BYPASSRLS` always bypass it (PostgreSQL docs, "Row Security Policies").
- AWS prescriptive guidance for multi-tenant PostgreSQL recommends a runtime tenant context
  (e.g. a session/transaction setting) read by the policy, and enabling RLS on every table that
  holds tenant data.

## Decision drivers

- Isolation enforced by the database, not only by application code (design principle 1 spirit;
  §6.7).
- Operational simplicity for hosted SaaS with many small tenants (one schema to migrate).
- Same code must also run single-tenant on a dedicated database.
- Testability: isolation must be provable by an automated suite on every build (§10.8 gate 5).
- Works with a transaction-scoped connection pool (pg-boss, Kysely) without leaking context.

## Considered options

1. **Shared schema + `tenant_id` column + RLS `ENABLE` and `FORCE`, tenant set per transaction
   with `SET LOCAL app.tenant_id`.**
2. **Schema-per-tenant** (one PostgreSQL schema per tenant, `search_path` switched per request).
3. **Database-per-tenant** (one database or cluster per tenant).
4. **Shared schema with application-level filtering only** (no RLS).

### Option 1 — Shared schema + forced RLS

- Good, because one migration run covers all tenants; cross-tenant reporting for accounting
  firms (§3.1 "Later") stays possible through explicit, audited paths.
- Good, because a missing `WHERE` in application code returns zero rows instead of another
  tenant's rows — the database is the last line of defence.
- Good, because `FORCE` closes the table-owner bypass; separating `lf_migrator` (owner) from
  `lf_app` (no `BYPASSRLS`, not owner) closes the remaining gap.
- Good, because `SET LOCAL` scopes the tenant to the transaction, so pooled connections cannot
  carry a stale tenant into the next request.
- Bad, because every policy adds a predicate; needs `tenant_id`-leading indexes.
- Bad, because a bug in a policy itself affects every tenant — hence the per-table
  cross-tenant test suite.
- Bad, because "noisy neighbour" load is shared (acceptable at SMB scale; dedicated DB option).

### Option 2 — Schema-per-tenant

- Good, because strong logical separation and easy per-tenant dump.
- Bad, because migrations must run N times; thousands of schemas strain the catalog and
  tooling; `search_path` mistakes on a pooled connection leak data just like a missing filter.
- Bad, because pg-boss and shared reference data need special handling.

### Option 3 — Database-per-tenant

- Good, because the strongest isolation and simple per-tenant restore.
- Bad, because cost and operations scale linearly with tenants — too heavy for 1–50 staff
  businesses on hosted SaaS; connection-pool fan-out.
- Neutral: still supported as a *deployment* option for large/regulated customers (same code,
  single tenant), so it is not lost.

### Option 4 — Application filtering only

- Good, because simplest to write.
- Bad, because a single forgotten filter in agent-written code leaks books between businesses;
  unacceptable given §6.1.

## Decision outcome

Chosen option (design-committed): **Option 1 — shared schema with forced RLS**, with Option 3
available as a deployment variant.

Rules:

1. Every tenant-owned table has `tenant_id uuid NOT NULL`, `ENABLE ROW LEVEL SECURITY` and
   `FORCE ROW LEVEL SECURITY`, and a policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)`
   with a matching `WITH CHECK`.
2. Roles: `lf_migrator` owns tables and runs migrations; `lf_app` is used by api/worker, is not
   an owner, has no `BYPASSRLS`, no `SUPERUSER`, and no privilege to disable triggers.
3. The app sets `SET LOCAL app.tenant_id = …` at the start of every transaction; a missing
   setting makes policies fail closed (no rows / error), never open.
4. A migration that adds a tenant-owned table without RLS + FORCE + policy fails CI.
5. Cross-tenant test suite runs on every build: tenant A cannot SELECT, aggregate, export,
   UPDATE, DELETE or subscribe (outbox/jobs) to tenant B's rows, for every table.

## Consequences

### Good

- Isolation survives application bugs; easy to demonstrate to auditors (SOC 2 path, §6.10).
- One schema, one migration path, works on hosted and self-hosted.

### Bad / accepted trade-offs

- Policy predicates and `tenant_id` indexes on every table.
- Background jobs must set the tenant context explicitly per job.
- Cross-tenant operations (accounting-firm views) need a separate, explicitly-audited design
  later — a future ADR.

### Follow-ups

- Backlog: platform tenancy task (roles, policy helper, catalog check), cross-tenant test
  generator that enumerates tables from `pg_catalog`.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Catalog check: every table with a `tenant_id` column has `relrowsecurity` and `relforcerowsecurity` true and at least one policy | integration test against the migrated DB (`pg_class`, `pg_policies`) | §10.8 gate 5 |
| `lf_app` has `rolbypassrls = false`, is not owner of any tenant table | role test (`pg_roles`) | gate 5 |
| Generated cross-tenant suite: for every tenant table, select/update/delete/export as tenant B returns 0 rows or fails | `packages/platform/test/cross-tenant.*.spec.ts` (backlog) | gate 5 |
| Transaction without `app.tenant_id` sees no tenant rows | same suite | gate 5 |
| Runs on PostgreSQL 16 (local harness) and 17 (Testcontainers/CI) | ADR-0013 harness | gate 2 |

## Links

- Design: D4, §3.1, §6.1, §6.7, §10.8 (gate 5), §11.3 item 8
- Decision log: DL-0007 (harness)
- Related ADRs: ADR-0004 (trigger privileges), ADR-0013 (DB harness), ADR-0014 (migrations)
- External: PostgreSQL "Row Security Policies" — https://www.postgresql.org/docs/17/ddl-rowsecurity.html ;
  AWS Prescriptive Guidance, RLS recommendations —
  https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html
