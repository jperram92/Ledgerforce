---
id: RQ-0007
title: PostgreSQL patterns — deferred balance trigger, immutability, forced RLS with SET LOCAL, gapless counters, PG16 vs PG17
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: [ADR-0003, ADR-0004]
---

# RQ-0007 — PostgreSQL ledger patterns

## Question

(a) Deferred constraint trigger enforcing sum(debit) = sum(credit) per entry at commit.
(b) Immutability trigger + privileges so `lf_app` cannot UPDATE/DELETE posted rows or disable triggers.
(c) RLS with FORCE, `SET LOCAL app.tenant_id` via `set_config`, non-owner app role, migrator role.
(d) Gapless per-series document counters under row lock.
(e) PG16 vs PG17 differences that matter.

## Why it matters

Design §3.3 "database-enforced invariants", §3.4 numbering, §6.7 tenant isolation; AGENTS.md §4.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | Experiment: [`assets/RQ-0007-verify.sql`](assets/RQ-0007-verify.sql) on a throwaway PostgreSQL **16.15** cluster (`initdb`/`pg_ctl`, local binaries) | 2026-10-24 | experiment | All results in Findings. |
| S2 | https://raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/doc/src/sgml/release-17.sgml | 2026-10-24 | primary | PG17: MAINTAIN privilege + `pg_maintain`; `transaction_timeout`; safe `search_path` during maintenance ops; 17.11 fixes CVE-2026-14666 "Invalidate role-dependent cached plans after role changes … may impact the expected behavior of row-level security policies". |
| S3 | https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/doc/src/sgml/release-16.sgml | 2026-10-24 | primary | 16.15 (release date 2026-08-13) carries the same CVE-2026-14666 fix. |
| S4 | PostgreSQL docs (CREATE TRIGGER / CREATE POLICY / ALTER TABLE, sgml in the same repo) | 2026-10-24 | primary | Constraint triggers must be AFTER ROW; `DEFERRABLE INITIALLY DEFERRED`; table owners bypass RLS unless `FORCE ROW LEVEL SECURITY`; `ALTER TABLE … DISABLE TRIGGER` requires ownership. |
| S5 | https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html (design source) | 2026-10-24 | secondary | Runtime tenant context via session variable + RLS on all tenant tables. |

## Findings (executed, S1)

Roles: `lf_owner` (NOLOGIN, owns schema `ledger`), `lf_migrator` (LOGIN, member of
`lf_owner`), `lf_app` (LOGIN, NOSUPERUSER, NOBYPASSRLS). `lf_app` granted only
`SELECT, INSERT` on journal tables and `UPDATE (status)` on `journal_entry`.

| Test | Result |
|---|---|
| T1 no tenant set → `SELECT` | 0 rows; INSERT → `new row violates row-level security policy` |
| T2 balanced 110 = 100 + 10, then status → posted | commits |
| T3 unbalanced (100 vs 99.99) | rejected **at COMMIT**: `journal entry … unbalanced by 0.0100` |
| T3b app runs `SET CONSTRAINTS ALL IMMEDIATE` | still enforced (fires earlier) — app cannot defer it away |
| T4 app UPDATE memo / DELETE line / UPDATE line of posted entry | `permission denied` (privilege layer) |
| T4b same as table owner (privileges bypassed) | trigger raises `posted journal entry … is immutable` / `lines of posted entry … are immutable`; posted → reversed status flip allowed |
| T5 app `ALTER TABLE … DISABLE TRIGGER` | `must be owner of table` |
| T5 app `SET session_replication_role = replica` | `permission denied to set parameter` |
| T5 app `TRUNCATE` | `permission denied` (+ BEFORE TRUNCATE trigger as second layer) |
| T6 tenant B session | sees 0 of A's rows; inserting a row with A's tenant_id rejected by WITH CHECK |
| T7 `set_config('app.tenant_id', x, true)` then COMMIT | value gone after commit — **but it reads back as `''`, not NULL** |
| T8 counter: allocate in a rolled-back txn, then again | both return `INV-000123` → rollback releases the number (gapless) |
| T9 owner/migrator with FORCE RLS and no tenant | 0 rows (owner is subject to RLS when FORCEd) |

Two defects found and fixed during the experiment:

1. **Empty-string GUC trap.** After any transaction that used `set_config(…, true)`, the
   placeholder `app.tenant_id` exists with value `''` for the rest of the session, so
   `current_setting('app.tenant_id', true)::uuid` throws `invalid input syntax for type uuid: ""`
   on pooled connections. Policies must use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
2. **Append-to-posted hole.** With only UPDATE/DELETE triggers, `lf_app` could INSERT a further
   balanced pair of lines into an already-posted entry (verified: succeeded silently). A
   `BEFORE INSERT` guard on `journal_line` rejecting inserts when the parent is not `draft`
   closes it (verified: `cannot add lines to posted entry …`).

Other notes:
- The deferred trigger is per row, so an entry with n lines runs n balance queries at commit.
  Acceptable for SMB volumes; if batch billing profiling shows cost, switch to a constraint
  trigger on `journal_entry` fired on the `draft → posted` transition (same guarantee, one query).
- A `SECURITY DEFINER` balance function runs as `lf_owner`, which is still subject to FORCE RLS,
  so it sees exactly the current tenant's lines — correct, and the tenant GUC is still set at
  commit-time trigger execution (T3 proved it).
- (e) **PG16 vs PG17:** nothing in these patterns differs (constraint triggers, FORCE RLS,
  `set_config`, column-level grants are identical). PG17 adds `MAINTAIN`/`pg_maintain` (do not
  grant to `lf_app`) and `transaction_timeout` (useful guard for the app role). Both branches
  received the RLS cached-plan CVE fix in **16.15 / 17.11** (Aug 2026) — relevant because
  LedgerForce relies on role-dependent RLS. Local 16.15 already has it.

## Conclusion / decision — minimal SQL (all verified on 16.15)

```sql
-- policies (every tenant-owned table)
ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON t
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- per transaction, from the app (never session-level SET):
SELECT set_config('app.tenant_id', $1, true);   -- = SET LOCAL, works with bind params

-- (a) balance
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT OR UPDATE ON ledger.journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced();
-- (b) immutability: BEFORE UPDATE OR DELETE on entry and line, BEFORE INSERT guard on line,
--     BEFORE TRUNCATE on both; grants: lf_app SELECT, INSERT + UPDATE(status) only
-- (d) counter: UPDATE number_series SET next_value = next_value + 1 WHERE … RETURNING …
--     inside the posting transaction (row lock serialises writers; rollback frees the number)
```

- Roles: `lf_owner` owns objects (NOLOGIN); `lf_migrator` is a member of `lf_owner` and runs
  migrations; `lf_app` has no ownership, no BYPASSRLS, no `SET` on `session_replication_role`,
  no TRUNCATE, no MAINTAIN.
- Stronger option for design §3.3 inv. 2 / AGENTS.md "ledger writes only through the posting
  engine": revoke INSERT on ledger tables from `lf_app` entirely and expose a
  `ledger.post_entry(jsonb)` SECURITY DEFINER function owned by `lf_owner`; then no module can
  write ledger rows except through that function. Recommended (security ADR, human gate).
- Pin minimum versions: PostgreSQL **≥ 16.15** (local) / **≥ 17.11** (production).
- Cross-tenant test suite must include a pooled-connection case (two transactions on one
  connection) to catch the empty-string trap.

## Confidence

High — every behaviour above was executed on PostgreSQL 16.15; version notes from the
PostgreSQL source tree release notes.

## Follow-ups

- Golden DB tests: port T1–T9 + insert guard into the integration suite (test-author).
- Security ADR (human gate): posting via SECURITY DEFINER function vs INSERT grants.

**Affects:** `packages/ledger` migrations, platform tenancy, `migration` skill, cross-tenant test
suite, ADR-0003, ADR-0004, design §3.3, §3.4, §6.7.
