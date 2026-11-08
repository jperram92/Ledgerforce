# packages/db — migrations, roles, tenant context, DB test harness

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The database foundation: cluster bootstrap (`lf_migrator`, `lf_app`), the single ordered
migration sequence `migrations/NNNN_*.sql`, the migration runner, `withTenant`, Kysely types and
the integration-test harness, including the cross-tenant RLS suite. Details are in
[`README.md`](README.md).

## Local rules
- **One migration sequence for the whole product.** It lives in `packages/db/migrations/`, even
  for tables owned by `packages/ledger` or a module, so that foreign keys always apply in order.
  Name the owning package in the header comment. Use skill `migration`.
- **Never edit or renumber a migration that has been merged.** The runner checks SHA-256
  checksums and refuses to start if one changed. Prettier ignores `*.sql` so formatting cannot
  change a checksum.
- **Forward-only and additive.** The runner rejects DROP, RENAME, TRUNCATE, DELETE FROM,
  ALTER COLUMN TYPE, DISABLE TRIGGER/RLS, NO FORCE RLS and BYPASSRLS. Do not get around this by
  building SQL dynamically inside a `DO` block.
- **Every tenant-owned table** needs `tenant_id uuid NOT NULL` (default
  `nullif(current_setting('app.tenant_id', true), '')::uuid`), `ENABLE` + `FORCE ROW LEVEL
  SECURITY`, a `tenant_isolation` policy with USING and WITH CHECK, and explicit grants to
  `lf_app`. Grant SELECT/INSERT/UPDATE by default and SELECT/INSERT only for ledger tables.
  Never grant DELETE, TRUNCATE or TRIGGER. The cross-tenant suite finds the table automatically
  and fails if any of these is missing.
- **Tables without `tenant_id`** in `app` or `audit` must be listed in `GLOBAL_TABLES` in
  `src/testing/cross-tenant.ts`, with a reason, and still need RLS. Adding a table there needs a
  `security` ADR (human gate).
- **Roles:** the application connects as `lf_app` only. Migrations run as `lf_migrator` only.
  Neither role may be superuser or have BYPASSRLS. Changing `bootstrap/*.sql` is a security
  change and needs an ADR.
- **Runtime access** goes through `withTenant(db, tenantId, fn)`. Never call `SET app.tenant_id`
  at session level, because it would leak across pooled connections.
- `audit.audit_log` is INSERT-only for `lf_app`. Do not use `RETURNING`, which needs SELECT.
- SQL must run on PostgreSQL 16 **and** 17 (DL-0007).

## Tests
- Unit tests in `src/**/*.test.ts` (`pnpm test`) cover the migration policy, file loading and
  harness mode selection.
- Integration tests in `src/**/*.db.test.ts` (`pnpm test:db`) run against a real PostgreSQL. Use
  `createTestDatabase()` from `src/testing/test-db.ts`. Never mock the database.
- Write the failing `*.db.test.ts` first and capture the RED output, then write the migration.
