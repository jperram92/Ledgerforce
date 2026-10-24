/**
 * SS-PLAT-04 (formerly SS-PLAT-RLS) — reusable cross-tenant isolation checks (design §6.7, AGENTS.md §4).
 *
 *  - findRlsViolations(): every table with a tenant_id column, and every table in the app/audit
 *    schemas, must have RLS ENABLED + FORCED, at least one policy, a tenant_id column (unless it
 *    is in GLOBAL_TABLES), and lf_app must not own it or hold TRUNCATE/TRIGGER on it
 *    (TRUNCATE is not subject to RLS).
 *  - defineCrossTenantSuite(): discovers every tenant_id table from information_schema at
 *    collection time and generates, per table, tests proving tenant A (as lf_app) cannot
 *    SELECT/aggregate, UPDATE, DELETE, TRUNCATE or INSERT-as-B tenant B's rows, plus positive
 *    controls so the suite can never pass vacuously. New tables are covered automatically; rows
 *    are generated from the catalog (types, NOT NULL, foreign keys). If a new table has a CHECK
 *    constraint the generator cannot satisfy, add a column override to DEFAULT_ROW_OVERRIDES.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../tenant.ts';

type Queryable = pg.Pool | pg.ClientBase;

export interface TableRef {
  schema: string;
  table: string;
  qualified: string;
}

/** Tables in RLS_SCHEMAS that legitimately have no tenant_id column (protected by own policy). */
export const GLOBAL_TABLES: readonly string[] = ['app.tenant'];
export const RLS_SCHEMAS: readonly string[] = ['app', 'audit'];

type Overrides = Readonly<Record<string, Readonly<Record<string, () => string>>>>;

/** Column values the generic generator cannot guess (CHECK constraints). */
export const DEFAULT_ROW_OVERRIDES: Overrides = {
  'app.app_user': { email: () => `user-${randomBytes(4).toString('hex')}@example.test` },
  'audit.audit_log': { actor_type: () => 'system' },
  'app.session': {
    secret_sha256: () => randomBytes(32).toString('hex'),
    created_at: () => '2026-01-01T00:00:00Z',
    last_seen_at: () => '2026-01-01T00:00:00Z',
    absolute_expires_at: () => '2026-01-01T12:00:00Z',
  },
  'app.account': {
    code: () => String(100_000 + (randomBytes(3).readUIntBE(0, 3) % 900_000)),
    type: () => 'asset',
    subtype: () => 'current_asset',
    normal_balance: () => 'debit',
  },
  // Its generated parent account is an active, postable, non-control asset (overrides above).
  'app.account_system_role': { role: () => 'UNDEPOSITED_FUNDS' },
  'app.dimension': { code: () => `dim_${randomBytes(4).toString('hex')}` },
  'app.dimension_value': { code: () => `v${randomBytes(4).toString('hex')}` },
  // Trigger-computed; the generator only needs to satisfy NOT NULL (the value is replaced).
  'app.dimension_set': { hash: () => '0'.repeat(64) },
};

export async function discoverTenantTables(db: Queryable): Promise<TableRef[]> {
  const { rows } = await db.query<{ schema: string; table: string }>(`
    SELECT c.table_schema AS schema, c.table_name AS table
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE c.column_name = 'tenant_id'
       AND t.table_type = 'BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND c.table_schema NOT LIKE 'pg\\_%'
     ORDER BY 1, 2`);
  return rows.map((r) => ({ ...r, qualified: `${r.schema}.${r.table}` }));
}

export interface RlsViolation {
  table: string;
  problems: string[];
}

export async function findRlsViolations(db: Queryable): Promise<RlsViolation[]> {
  const { rows } = await db.query<{
    qualified: string;
    rls: boolean;
    force: boolean;
    policies: number;
    has_tenant: boolean;
    app_truncate: boolean;
    app_trigger: boolean;
    app_owner: boolean;
  }>(
    `
    WITH candidates AS (
      SELECT c.oid, n.nspname, c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND (n.nspname = ANY($1::text[])
              OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                           AND a.attname = 'tenant_id' AND NOT a.attisdropped))
    )
    SELECT k.nspname || '.' || k.relname AS qualified,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = k.oid) AS policies,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.oid
                     AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
           has_table_privilege('lf_app', k.oid, 'TRUNCATE') AS app_truncate,
           has_table_privilege('lf_app', k.oid, 'TRIGGER') AS app_trigger,
           pg_get_userbyid(c.relowner) = 'lf_app' AS app_owner
      FROM candidates k JOIN pg_class c ON c.oid = k.oid
     ORDER BY 1`,
    [RLS_SCHEMAS],
  );
  const out: RlsViolation[] = [];
  for (const r of rows) {
    const problems: string[] = [];
    if (!r.rls) problems.push('RLS not enabled');
    if (!r.force) problems.push('RLS not forced');
    if (r.policies === 0) problems.push('no policy');
    if (!r.has_tenant && !GLOBAL_TABLES.includes(r.qualified)) {
      problems.push('no tenant_id column and not in GLOBAL_TABLES');
    }
    if (r.app_truncate) problems.push('lf_app has TRUNCATE (bypasses RLS)');
    if (r.app_trigger) problems.push('lf_app has TRIGGER');
    if (r.app_owner) problems.push('owned by lf_app');
    if (problems.length > 0) out.push({ table: r.qualified, problems });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Generic row generation from the catalog

interface ColumnInfo {
  name: string;
  udt: string;
  required: boolean; // NOT NULL, no default, not identity/generated
  insertable: boolean; // not identity ALWAYS / generated
  maxLen: number | null;
}

interface ForeignKey {
  columns: string[];
  ref: TableRef;
  refColumns: string[];
}

async function columnsOf(db: Queryable, t: TableRef): Promise<ColumnInfo[]> {
  const { rows } = await db.query<{
    name: string;
    udt: string;
    nullable: string;
    def: string | null;
    identity: string;
    identity_gen: string | null;
    generated: string;
    max_len: number | null;
  }>(
    `SELECT column_name AS name, udt_name AS udt, is_nullable AS nullable, column_default AS def,
            is_identity AS identity, identity_generation AS identity_gen, is_generated AS generated,
            character_maximum_length AS max_len
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [t.schema, t.table],
  );
  return rows.map((r) => {
    const insertable = r.generated !== 'ALWAYS' && r.identity_gen !== 'ALWAYS';
    return {
      name: r.name,
      udt: r.udt,
      insertable,
      required: insertable && r.nullable === 'NO' && r.def === null && r.identity !== 'YES',
      maxLen: r.max_len,
    };
  });
}

async function foreignKeysOf(db: Queryable, t: TableRef): Promise<ForeignKey[]> {
  const { rows } = await db.query<{
    cols: string[];
    rschema: string;
    rtable: string;
    rcols: string[];
  }>(
    `SELECT array(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
                    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i)::text[] AS cols,
            rn.nspname AS rschema, rc.relname AS rtable,
            array(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY u(n, i)
                    JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i)::text[] AS rcols
       FROM pg_constraint k
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE k.contype = 'f' AND k.conrelid = format('%I.%I', $1::text, $2::text)::regclass`,
    [t.schema, t.table],
  );
  return rows.map((r) => ({
    columns: r.cols,
    ref: { schema: r.rschema, table: r.rtable, qualified: `${r.rschema}.${r.rtable}` },
    refColumns: r.rcols,
  }));
}

function valueFor(t: TableRef, c: ColumnInfo): string {
  const rnd = randomBytes(4).toString('hex');
  if (c.udt.startsWith('_')) return '{}';
  switch (c.udt) {
    case 'uuid':
      return randomUUID();
    case 'text':
    case 'varchar':
    case 'citext':
      return `x-${rnd}`.slice(0, c.maxLen ?? 64);
    case 'bpchar':
      return 'A'.repeat(c.maxLen ?? 1);
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return '1';
    case 'bool':
      return 'false';
    case 'timestamptz':
    case 'timestamp':
      return new Date().toISOString();
    case 'date':
      return '2026-01-01';
    case 'json':
    case 'jsonb':
      return '{}';
    case 'inet':
      return '192.0.2.1';
    case 'bytea':
      return '\\x00';
    default:
      throw new Error(
        `cross-tenant row generator: no value for ${t.qualified}.${c.name} (${c.udt}); add it to DEFAULT_ROW_OVERRIDES`,
      );
  }
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const quoteTable = (t: TableRef): string => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;

/**
 * Build insertable column values for one row of `t` owned by `tenantId`. Required foreign-key
 * parents are created (as superuser) for the same tenant.
 */
export async function buildRow(
  admin: Queryable,
  t: TableRef,
  tenantId: string,
  overrides: Overrides = DEFAULT_ROW_OVERRIDES,
  depth = 0,
): Promise<Map<string, string>> {
  if (depth > 8) throw new Error(`cross-tenant row generator: FK chain too deep at ${t.qualified}`);
  const cols = await columnsOf(admin, t);
  const fks = await foreignKeysOf(admin, t);
  const values = new Map<string, string>();
  const byName = new Map(cols.map((c) => [c.name, c]));

  if (byName.has('tenant_id')) values.set('tenant_id', tenantId);
  for (const fk of fks) {
    const needed =
      fk.columns.some((c) => byName.get(c)?.required) && !fk.columns.every((c) => values.has(c));
    if (!needed) continue;
    if (fk.ref.qualified === 'app.tenant') {
      for (const c of fk.columns) values.set(c, tenantId);
      continue;
    }
    const parent = await seedRow(admin, fk.ref, tenantId, overrides, depth + 1);
    fk.columns.forEach((c, i) => {
      const v = parent[fk.refColumns[i] ?? ''];
      values.set(c, v instanceof Date ? v.toISOString() : String(v));
    });
  }
  const tableOverrides = overrides[t.qualified] ?? {};
  for (const c of cols) {
    if (!c.insertable || values.has(c.name)) continue;
    const o = tableOverrides[c.name];
    if (o) values.set(c.name, o());
    else if (c.required) values.set(c.name, valueFor(t, c));
  }
  return values;
}

/** Insert one row for `tenantId` as superuser (bypasses RLS); returns the stored row. */
export async function seedRow(
  admin: Queryable,
  t: TableRef,
  tenantId: string,
  overrides: Overrides = DEFAULT_ROW_OVERRIDES,
  depth = 0,
): Promise<Record<string, unknown>> {
  const values = await buildRow(admin, t, tenantId, overrides, depth);
  const cols = [...values.keys()];
  const { rows } = await admin.query<Record<string, unknown>>(
    `INSERT INTO ${quoteTable(t)} (${cols.map(quoteIdent).join(', ')})
     VALUES (${cols.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING *`,
    [...values.values()],
  );
  return rows[0] ?? {};
}

// ---------------------------------------------------------------------------------------------
// The generated suite

interface SuiteDb<DB> {
  admin: pg.Pool;
  app: Kysely<DB>;
}

type Attempt<T> = { denied: false; value: T } | { denied: true };

/** Run fn; an insufficient_privilege / RLS violation (SQLSTATE 42501) counts as "denied". */
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { denied: false, value: await fn() };
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return { denied: true };
    throw error;
  }
}

export async function defineCrossTenantSuite<DB>(
  db: SuiteDb<DB>,
  opts: { overrides?: Overrides; expectTables?: readonly string[] } = {},
): Promise<void> {
  const overrides = { ...DEFAULT_ROW_OVERRIDES, ...(opts.overrides ?? {}) };
  const tables = await discoverTenantTables(db.admin);
  const A = randomUUID();
  const B = randomUUID();
  const app = db.app;
  const asTenant = <T>(tenant: string, fn: (trx: Transaction<DB>) => Promise<T>) =>
    withTenant(app, tenant, fn);

  const privilege = async (t: TableRef, priv: string): Promise<boolean> => {
    const { rows } = await db.admin.query<{ p: boolean }>(
      `SELECT has_table_privilege('lf_app', $1::regclass, $2) AS p`,
      [quoteTable(t), priv],
    );
    return rows[0]?.p ?? false;
  };
  const snapshot = async (t: TableRef, tenant: string): Promise<string[]> => {
    const { rows } = await db.admin.query<{ j: string }>(
      `SELECT to_jsonb(x)::text AS j FROM ${quoteTable(t)} x WHERE tenant_id = $1 ORDER BY 1`,
      [tenant],
    );
    return rows.map((r) => r.j);
  };
  const count = async (t: TableRef, tenant: string): Promise<number> => {
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quoteTable(t)} WHERE tenant_id = $1`,
      [tenant],
    );
    return rows[0]?.n ?? 0;
  };
  const insertAs = (trx: Transaction<DB>, t: TableRef, values: Map<string, string>) =>
    sql`INSERT INTO ${sql.table(t.qualified)} (${sql.join([...values.keys()].map((c) => sql.ref(c)))})
        VALUES (${sql.join([...values.values()])})`.execute(trx);

  describe('SS-PLAT-04: RLS isolates tenants on every tenant table (generated from information_schema)', () => {
    beforeAll(async () => {
      await db.admin.query(
        `INSERT INTO app.tenant (id, name) VALUES ($1, 'RLS tenant A'), ($2, 'RLS tenant B')`,
        [A, B],
      );
      for (const t of tables) {
        await seedRow(db.admin, t, A, overrides);
        await seedRow(db.admin, t, B, overrides);
      }
    });

    it('discovers the tenant-owned tables (suite is not vacuous)', () => {
      expect(tables.length).toBeGreaterThan(0);
      for (const name of opts.expectTables ?? ['app.company', 'app.app_user', 'audit.audit_log']) {
        expect(tables.map((t) => t.qualified)).toContain(name);
      }
    });

    for (const t of tables) {
      describe(t.qualified, () => {
        it('SELECT: tenant A sees only its own rows, in reads and aggregates', async () => {
          const r = await attempt(() =>
            asTenant(A, (trx) =>
              sql<{ total: number; other: number; foreign: number }>`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE tenant_id = ${B})::int AS other,
                       count(*) FILTER (WHERE tenant_id IS DISTINCT FROM ${A})::int AS foreign
                  FROM ${sql.table(t.qualified)}`.execute(trx),
            ),
          );
          if (r.denied) {
            expect(await privilege(t, 'SELECT'), 'denied only because lf_app lacks SELECT').toBe(
              false,
            );
            return;
          }
          const row = r.value.rows[0];
          expect(row?.other).toBe(0);
          expect(row?.foreign).toBe(0);
          expect(row?.total).toBe(await count(t, A)); // positive control: A's rows are visible
          expect(row?.total).toBeGreaterThan(0);
        });

        it('SELECT: without a tenant context nothing is visible', async () => {
          const r = await attempt(() =>
            sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t.qualified)}`.execute(
              app,
            ),
          );
          if (!r.denied) expect(r.value.rows[0]?.n).toBe(0);
        });

        it("UPDATE: tenant A cannot change tenant B's rows", async () => {
          const before = await snapshot(t, B);
          const r = await attempt(() =>
            asTenant(A, (trx) =>
              sql`UPDATE ${sql.table(t.qualified)} SET tenant_id = tenant_id WHERE tenant_id = ${B}`.execute(
                trx,
              ),
            ),
          );
          if (!r.denied) expect(r.value.numAffectedRows ?? 0n).toBe(0n);
          expect(await snapshot(t, B)).toEqual(before);
        });

        it('UPDATE: tenant A cannot move its own rows into tenant B', async () => {
          const before = await count(t, B);
          const r = await attempt(() =>
            asTenant(A, (trx) =>
              sql`UPDATE ${sql.table(t.qualified)} SET tenant_id = ${B} WHERE tenant_id = ${A}`.execute(
                trx,
              ),
            ),
          );
          expect(r.denied).toBe(true);
          expect(await count(t, B)).toBe(before);
        });

        it("DELETE: tenant A cannot delete tenant B's rows", async () => {
          const before = await snapshot(t, B);
          const r = await attempt(() =>
            asTenant(A, (trx) =>
              sql`DELETE FROM ${sql.table(t.qualified)} WHERE tenant_id = ${B}`.execute(trx),
            ),
          );
          if (!r.denied) expect(r.value.numAffectedRows ?? 0n).toBe(0n);
          expect(await snapshot(t, B)).toEqual(before);
        });

        it('TRUNCATE: lf_app cannot truncate (TRUNCATE ignores RLS)', async () => {
          const before = await snapshot(t, B);
          const r = await attempt(() =>
            asTenant(A, (trx) => sql`TRUNCATE ${sql.table(t.qualified)}`.execute(trx)),
          );
          expect(r.denied).toBe(true);
          expect(await snapshot(t, B)).toEqual(before);
        });

        it('INSERT: tenant A cannot insert a row owned by tenant B', async () => {
          const values = await buildRow(db.admin, t, B, overrides);
          const before = await count(t, B);
          const r = await attempt(() => asTenant(A, (trx) => insertAs(trx, t, values)));
          expect(r.denied).toBe(true);
          expect(await count(t, B)).toBe(before);
        });

        it('INSERT (positive control): tenant A can insert its own row when granted INSERT', async () => {
          const values = await buildRow(db.admin, t, A, overrides);
          const before = await count(t, A);
          const r = await attempt(() => asTenant(A, (trx) => insertAs(trx, t, values)));
          if (await privilege(t, 'INSERT')) {
            expect(r.denied).toBe(false);
            expect(await count(t, A)).toBe(before + 1);
          } else {
            expect(r.denied).toBe(true);
          }
        });
      });
    }

    describe('app.tenant (the tenant table itself)', () => {
      it('tenant A sees exactly its own tenant row', async () => {
        const rows = await asTenant(A, (trx) =>
          sql<{ id: string }>`SELECT id FROM app.tenant`.execute(trx),
        );
        expect(rows.rows.map((r) => r.id)).toEqual([A]);
      });

      it("tenant A cannot update or delete tenant B's row", async () => {
        const upd = await attempt(() =>
          asTenant(A, (trx) =>
            sql`UPDATE app.tenant SET name = 'pwned' WHERE id = ${B}`.execute(trx),
          ),
        );
        if (!upd.denied) expect(upd.value.numAffectedRows ?? 0n).toBe(0n);
        const del = await attempt(() =>
          asTenant(A, (trx) => sql`DELETE FROM app.tenant WHERE id = ${B}`.execute(trx)),
        );
        if (!del.denied) expect(del.value.numAffectedRows ?? 0n).toBe(0n);
        const { rows } = await db.admin.query(`SELECT name FROM app.tenant WHERE id = $1`, [B]);
        expect(rows).toEqual([{ name: 'RLS tenant B' }]);
      });

      it('tenant A cannot create another tenant row', async () => {
        const r = await attempt(() =>
          asTenant(A, (trx) =>
            sql`INSERT INTO app.tenant (id, name) VALUES (${randomUUID()}, 'rogue')`.execute(trx),
          ),
        );
        expect(r.denied).toBe(true);
      });
    });
  });
}
