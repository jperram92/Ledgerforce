# @ledgerforce/db

Database foundation for LedgerForce (design §3.3, §6.7, §6.8): forward-only SQL migrations,
the cluster bootstrap for the two database roles, tenant context (`withTenant`), Kysely types,
and the integration-test harness, including the cross-tenant RLS suite (scenario SS-PLAT-04).

## Layout

| Path | What |
|---|---|
| `bootstrap/01_cluster_roles.sql` | Creates `lf_migrator` and `lf_app` (idempotent, no passwords). The only superuser step; run once per cluster |
| `bootstrap/02_database_grants.sql` | Per-database grants (CONNECT/CREATE for the migrator, CONNECT for the app) |
| `migrations/NNNN_name.sql` | Forward-only migrations, run as `lf_migrator` |
| `src/migrate.ts` | Migration runner with checksums and the no-delete policy |
| `src/tenant.ts` | `withTenant(db, tenantId, fn)` and `createDb(url)` |
| `src/schema.ts` | Kysely table types |
| `src/testing/` | `startTestDatabase()`, Vitest global setup, `createTestDatabase()`, cross-tenant suite |

## Roles

| Role | Attributes | Used for |
|---|---|---|
| `lf_migrator` | LOGIN, no SUPERUSER, no BYPASSRLS | Owns every schema object and runs migrations |
| `lf_app` | LOGIN, NOINHERIT, no SUPERUSER, no BYPASSRLS, owns nothing | Application runtime. Gets only SELECT/INSERT/UPDATE grants (INSERT-only on `audit.audit_log`), no DELETE/TRUNCATE/TRIGGER, and cannot create objects |

Tenant-owned tables have `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and the policy
`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`. If no tenant context is
set, no rows are visible.

## Tenant context

```ts
import { createDb, withTenant } from '@ledgerforce/db';
const db = createDb(process.env.DATABASE_URL!); // connect as lf_app
const companies = await withTenant(db, tenantId, (trx) =>
  trx.selectFrom('app.company').selectAll().execute(),
);
```

`withTenant` opens a transaction and runs `set_config('app.tenant_id', $1, true)`, the bind-safe
form of `SET LOCAL`. The setting ends at commit or rollback, so a pooled connection never carries
one tenant's context into the next request. Non-UUID ids are rejected before any SQL runs.

## Migrations

```bash
DATABASE_URL=postgres://lf_migrator:...@host/db pnpm --filter @ledgerforce/db migrate
```

- Files are named `NNNN_snake_case.sql` and numbered from `0001` with no gaps or duplicates.
  There is one global sequence for the whole product, so cross-package foreign keys always
  apply in order.
- `public.schema_migrations` records version, name, SHA-256 checksum, applied_at and applied_by.
  The runner refuses to start if an applied file was edited or removed, so write a new
  migration instead of changing an old one.
- Each migration runs in its own transaction together with its ledger row. Concurrent runners
  are serialised with an advisory lock.
- Policy (AGENTS.md directive 6, skill `migration`): the runner rejects any `DROP` except
  `ALTER COLUMN … DROP DEFAULT/NOT NULL`. It also rejects `RENAME`, `TRUNCATE`, `DELETE FROM`,
  `ALTER COLUMN … TYPE`, `DISABLE TRIGGER/RULE/ROW LEVEL SECURITY`,
  `NO FORCE ROW LEVEL SECURITY` and `BYPASSRLS`. Comments and string literals are ignored, but
  function bodies are checked.
- SQL must work on PostgreSQL 16 and 17 (DL-0007). `app.uuid_generate_v7()` fills in for
  PostgreSQL 18's `uuidv7()`.

## Test harness (DL-0007, RQ-0008)

`pnpm test:db` runs every `*.db.test.ts` through the Vitest `db` project. The global setup
(`src/testing/global-setup.ts`) calls `startTestDatabase()` once per run and picks one of three
modes:

| Mode | When | What |
|---|---|---|
| `external` | `LF_TEST_DATABASE_URL` is set (superuser URL). CI uses the `postgres:17` service container | Uses that server as is |
| `docker` | A Docker daemon is reachable | Testcontainers `postgres:17` |
| `local` | Otherwise | Builds a throw-away cluster with `initdb` + `pg_ctl` in a fresh temp directory on a free `127.0.0.1` port, with trust auth and fsync off. It is stopped and deleted on teardown, and also by an exit hook |

Overrides:

- `LF_TEST_DB_MODE=auto|external|docker|local` forces a mode.
- `LF_PG_BINDIR` sets the binary directory. By default the harness uses the newest
  `/usr/lib/postgresql/<v>/bin`, then `pg_config --bindir`.
- `LF_PG_OS_USER` sets the OS user for the cluster when tests run as root, because `initdb`
  refuses root. The default is `postgres`, falling back to `nobody`. The harness switches user
  through Node's `spawn` uid/gid, so no sudo is needed.
- `LF_TEST_ROLE_PASSWORD` sets the password given to `lf_app` and `lf_migrator`. It only matters
  in password-auth modes.

The global setup also applies `bootstrap/01_cluster_roles.sql`. Each test file then calls
`createTestDatabase({ migrate: true })`, which creates its own database, applies
`02_database_grants.sql` and runs all migrations as `lf_migrator`. It returns:

- `admin`: a superuser `pg.Pool` for seeding and verification. It bypasses RLS.
- `app`: a `Kysely<Database>` connected as `lf_app`.
- `url(role)`: a connection string for the given role.

### Cross-tenant suite (SS-PLAT-04)

`src/rls.db.test.ts` checks tenant isolation in two ways:

- `findRlsViolations()` fails if any table with `tenant_id`, or any table in the `app` or `audit`
  schemas, is missing `ENABLE` or `FORCE`, has no policy, lacks `tenant_id` without being listed
  in `GLOBAL_TABLES`, or gives `lf_app` TRUNCATE or TRIGGER. TRUNCATE matters because it skips
  RLS.
- `defineCrossTenantSuite()` finds every `tenant_id` table through `information_schema` and
  generates rows from the catalog, covering types, NOT NULL columns and foreign keys. For each
  table it proves that tenant A, connected as `lf_app`, cannot SELECT, aggregate, UPDATE, move
  rows into B, DELETE, TRUNCATE or INSERT-as-B tenant B's rows. Positive controls stop the
  suite from passing vacuously.

New tables are covered without any extra registration. If a table has a CHECK constraint the
generator cannot satisfy, add a column override to `DEFAULT_ROW_OVERRIDES` in
`src/testing/cross-tenant.ts`.

### Tenant context and pooled connections (T-0010, RQ-0013)

`withTenant` sets `app.tenant_id` with `set_config(..., true)` only, so the context ends at COMMIT
or ROLLBACK. Before setting it, `withTenant` checks the connection has **no** session-level value
and throws `TenantContextLeakError` if it does (fail closed). The lint rule
`lf/no-session-tenant-context` bans `SET [SESSION] app.tenant_id` and
`set_config('app.tenant_id', ..., false)` in product code. PgBouncer, if introduced, must run in
session or transaction pooling mode, never statement mode.
