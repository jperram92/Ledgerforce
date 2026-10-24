---
name: migration
description: Use for every LedgerForce database schema change - new tables, columns, indexes, roles, grants, RLS policies or triggers. Enforces forward-only additive plain-SQL migrations, tenant_id + RLS ENABLE/FORCE on tenant-owned tables, lf_migrator vs lf_app roles, NUMERIC money, PostgreSQL 16/17 compatibility, and a DB integration test written first.
---
# Skill: migration

Act as `.claude/agents/db-engineer.md`. Migrations are **forward-only and additive**
(`AGENTS.md` §0.6, §4).

## Forbidden in any migration

`DROP TABLE|COLUMN|CONSTRAINT|INDEX|TRIGGER|POLICY|FUNCTION` (except replacing a function body
with `CREATE OR REPLACE` that keeps its contract), `RENAME`, `TRUNCATE`, `DELETE`, data-losing
`ALTER … TYPE`, `DISABLE TRIGGER`, `NO FORCE ROW LEVEL SECURITY`, `BYPASSRLS` for `lf_app`,
editing a migration file that has already been merged.

## Steps

1. Write the DB integration test first (skill `tdd-cycle`), file `*.db.spec.ts`, e.g. "insert as
   tenant A, select as tenant B returns 0 rows", "UPDATE on posted journal_line raises". Run
   `pnpm test:db <file>` and capture RED.
2. Create the next migration file in the migrations directory of the owning package (see that
   package's `AGENTS.md`), named `NNNN_<snake_case_description>.sql` with the next free number.
   Plain SQL, idempotent guards where PostgreSQL supports them (`IF NOT EXISTS`).
3. For each **tenant-owned** table include, in the same migration:
   ```sql
   tenant_id uuid NOT NULL,
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
   CREATE POLICY <t>_tenant_isolation ON <t>
     USING (tenant_id = current_setting('app.tenant_id')::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
   GRANT SELECT, INSERT, UPDATE ON <t> TO lf_app;   -- ledger tables: SELECT, INSERT only
   ```
   and add the table to the cross-tenant test suite.
4. Types: money `NUMERIC(19,4)`, rates `NUMERIC(18,8)`, ids `uuid` (UUID v7 generated in app),
   timestamps `timestamptz`.
5. Changing a shape: add the new column/table → backfill in a later migration → mark the old one
   deprecated with `COMMENT ON COLUMN … IS 'DEPRECATED: use … (ADR-NNNN)'` → ADR (skill
   `write-adr`, category `data`).
6. Compatibility: use only features available in PostgreSQL 16 and 17 (DL-0007).
7. Run `pnpm test:db` (applies all migrations forward on a fresh cluster and on the previous
   schema), then `bash scripts/agent/verify.sh --quick`.
8. Self-check the diff:
   `git diff main...HEAD -- '*.sql' | grep -niE "^\+.*\b(drop|rename|truncate|disable trigger|bypassrls)\b"`
   must print nothing.
9. Log the decision (skill `log-decision`) and checkpoint (skill `checkpoint`).
