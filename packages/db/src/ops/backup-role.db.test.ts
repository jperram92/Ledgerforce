/**
 * SS-PLAT-193 / SS-PLAT-194 — the least-privilege `lf_backup` role (T-0227, ADR-0106, RQ-0188).
 *
 * SS-PLAT-193: `createBackup` connecting as `lf_backup` dumps every tenant's rows past FORCEd RLS
 * and the restored copy matches the manifest; the role can write nothing, create nothing, disable
 * no trigger, run no SECURITY DEFINER function and owns nothing.
 * SS-PLAT-194: the cluster bootstrap and the compose init script (which is also the documented
 * upgrade step for existing installs) create the role idempotently, repair a pre-existing,
 * over-privileged `lf_backup`, and confine its logins via a managed pg_hba.conf block to the
 * backup network.
 */
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapCluster } from '../bootstrap.ts';
import { startTestDatabase, type TestDatabaseServer } from '../testing/start-test-database.ts';
import { createTestDatabase, type TestDatabase } from '../testing/test-db.ts';
import { createBackup, readManifest } from './backup.ts';
import { restoreBackup } from './restore.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const INIT_SCRIPT = join(ROOT, 'infra/compose/initdb/10-ledgerforce-roles.sh');
const BOOTSTRAP = join(ROOT, 'packages/db/bootstrap');

const A = randomUUID();
const B = randomUUID();

let tdb: TestDatabase;
let dir: string;
let kms: LocalKeyringKms;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const asBackup = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> =>
  withClient(tdb.url('lf_backup'), fn);

/** Runs `sql` as lf_backup with read-only switched off and returns the SQLSTATE it fails with. */
async function failsAs(sqlText: string): Promise<string> {
  return asBackup(async (c) => {
    await c.query('SET default_transaction_read_only = off');
    try {
      await c.query(sqlText);
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
    return 'succeeded';
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lf-backup-role-'));
  kms = LocalKeyringKms.fromJson(
    JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
  );
  tdb = await createTestDatabase({ migrate: true });
  await tdb.admin.query(
    `INSERT INTO app.tenant (id, name) VALUES ($1, 'Backup Tenant A'), ($2, 'Backup Tenant B')`,
    [A, B],
  );
}, 120_000);

afterAll(async () => {
  await tdb?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SS-PLAT-193 lf_backup dumps every tenant and can write nothing', () => {
  it('SS-PLAT-193 has BYPASSRLS and pg_read_all_data only: no superuser, DDL, replication or other membership', async () => {
    const { rows } = await tdb.admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin,
              rolinherit, rolconnlimit, rolconfig,
              ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                     WHERE m.member = r.oid ORDER BY 1) AS member_of,
              ARRAY(SELECT u.rolname::text FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
                     WHERE m.roleid = r.oid ORDER BY 1) AS members
         FROM pg_roles r WHERE rolname = 'lf_backup'`,
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: true,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
        rolinherit: true,
        rolconnlimit: 4,
        rolconfig: ['default_transaction_read_only=on'],
        member_of: ['pg_read_all_data'],
        members: [],
      },
    ]);
    const owned = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'lf_backup'::regrole`,
    );
    expect(owned.rows[0]).toEqual({ n: 0 });
  });

  it('SS-PLAT-193 createBackup as lf_backup includes every tenant and restores to the same manifest', async () => {
    // RLS is forced and lf_backup sets no tenant: only BYPASSRLS lets it see both rows.
    const seen = await asBackup((c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.tenant WHERE id IN ($1, $2)`, [
        A,
        B,
      ]),
    );
    expect(seen.rows[0]).toEqual({ n: 2 });

    const out = join(dir, 'as-lf-backup.lfbackup');
    const { manifest } = await createBackup({ url: tdb.url('lf_backup'), out, kms });
    expect(Number(manifest.tables['app.tenant'])).toBeGreaterThanOrEqual(2);
    expect(Object.keys(manifest.tables).length).toBeGreaterThan(20);

    const database = `lf_backup_role_${randomBytes(4).toString('hex')}`;
    const restored = await restoreBackup({
      file: out,
      kms,
      serverUrl: tdb.url('superuser').replace(`/${tdb.name}`, '/postgres'),
      database,
    });
    try {
      expect(await readManifest(restored.url)).toEqual(manifest);
      const names = await withClient(restored.url, (c) =>
        c.query<{ name: string }>(
          `SELECT name FROM app.tenant WHERE id IN ($1, $2) ORDER BY name`,
          [A, B],
        ),
      );
      expect(names.rows.map((r) => r.name)).toEqual(['Backup Tenant A', 'Backup Tenant B']);
    } finally {
      await withClient(tdb.url('superuser').replace(`/${tdb.name}`, '/postgres'), (c) =>
        c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      );
    }
  });

  it('SS-PLAT-193 holds no write, truncate, trigger or references privilege on any table, sequence write or SECURITY DEFINER function', async () => {
    const tables = await tdb.admin.query<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          AND has_table_privilege('lf_backup', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')`,
    );
    expect(tables.rows).toEqual([]);
    const seqs = await tdb.admin.query(
      `SELECT s FROM (SELECT c.oid::regclass::text AS s, c.oid
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE c.relkind = 'S' AND n.nspname NOT LIKE 'pg\\_%'
                        AND n.nspname <> 'information_schema' OFFSET 0) q
        WHERE has_sequence_privilege('lf_backup', q.oid, 'USAGE, UPDATE')`,
    );
    expect(seqs.rows).toEqual([]);
    const definers = await tdb.admin.query(
      `SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND has_function_privilege('lf_backup', p.oid, 'EXECUTE')`,
    );
    expect(definers.rows).toEqual([]);
    const schemas = await tdb.admin.query(
      `SELECT nspname FROM pg_namespace WHERE has_schema_privilege('lf_backup', oid, 'CREATE')`,
    );
    expect(schemas.rows).toEqual([]);
    const db = await tdb.admin.query(
      `SELECT has_database_privilege('lf_backup', current_database(), 'CREATE') AS c,
              has_database_privilege('lf_backup', current_database(), 'TEMPORARY') AS t,
              has_database_privilege('lf_backup', current_database(), 'CONNECT') AS k`,
    );
    expect(db.rows[0]).toEqual({ c: false, t: false, k: true });
  });

  it('SS-PLAT-193 INSERT, UPDATE, DELETE, TRUNCATE and DDL fail even with read-only switched off', async () => {
    expect(await failsAs(`INSERT INTO app.tenant (name) VALUES ('Injected')`)).toBe('42501');
    expect(await failsAs(`UPDATE app.tenant SET name = 'Changed' WHERE id = '${A}'`)).toBe('42501');
    expect(await failsAs(`DELETE FROM app.tenant WHERE id = '${A}'`)).toBe('42501');
    expect(await failsAs(`TRUNCATE app.tenant`)).toBe('42501');
    expect(await failsAs(`INSERT INTO audit.audit_log (action) VALUES ('x')`)).toBe('42501');
    expect(await failsAs(`CREATE TABLE public.lf_backup_probe (x int)`)).toBe('42501');
    expect(await failsAs(`CREATE TABLE app.lf_backup_probe (x int)`)).toBe('42501');
    expect(await failsAs(`CREATE TEMP TABLE lf_backup_probe (x int)`)).toBe('42501');
    expect(await failsAs(`CREATE SCHEMA lf_backup_probe`)).toBe('42501');
    expect(await failsAs(`CREATE ROLE lf_backup_probe`)).toBe('42501');
    expect(await failsAs(`GRANT lf_migrator TO lf_backup`)).toBe('42501');
    expect(await failsAs(`ALTER ROLE lf_backup NOBYPASSRLS SUPERUSER`)).toBe('42501');
    const tenant = await tdb.admin.query<{ name: string }>(
      `SELECT name FROM app.tenant WHERE id = $1`,
      [A],
    );
    expect(tenant.rows[0]?.name).toBe('Backup Tenant A');
  });

  it('SS-PLAT-193 cannot disable triggers or row security, and its sessions start read-only', async () => {
    expect(await failsAs(`ALTER TABLE app.journal_line DISABLE TRIGGER ALL`)).toBe('42501');
    expect(await failsAs(`ALTER TABLE app.tenant NO FORCE ROW LEVEL SECURITY`)).toBe('42501');
    expect(await failsAs(`SET session_replication_role = replica`)).toBe('42501');
    const ro = await asBackup(async (c) => {
      const s = await c.query<{ v: string }>(
        `SELECT current_setting('default_transaction_read_only') AS v`,
      );
      let lo = 'succeeded';
      try {
        await c.query('SELECT lo_creat(-1)');
      } catch (e) {
        lo = (e as { code?: string }).code ?? 'unknown';
      }
      return { v: s.rows[0]?.v, lo };
    });
    // 25006 read_only_sql_transaction: a large object (the one object PUBLIC may always create)
    // cannot be created in the default read-only session.
    expect(ro).toEqual({ v: 'on', lo: '25006' });
  });
});

describe('SS-PLAT-194 bootstrap, init script and upgrade step', () => {
  let server: TestDatabaseServer;
  let hbaFile: string;
  const pw = { migrator: 'm-pw-194', app: 'a-pw-194', backup: 'b-pw-194' };
  const su = (database = 'postgres') => server.connectionString(database);

  function runInit(extra: Record<string, string>) {
    return spawnSync('bash', [INIT_SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        PGHOST: server.host,
        PGPORT: String(server.port),
        POSTGRES_USER: server.superuser,
        POSTGRES_DB: 'ledgerforce',
        LF_BOOTSTRAP_DIR: BOOTSTRAP,
        LF_MIGRATOR_PASSWORD: pw.migrator,
        LF_APP_PASSWORD: pw.app,
        LF_BACKUP_PASSWORD: pw.backup,
        ...extra,
      },
    });
  }

  async function loginAsBackup(): Promise<string> {
    try {
      await withClient(
        server.connectionString('ledgerforce', 'lf_backup', pw.backup),
        async (c) => {
          await c.query('SELECT 1');
        },
      );
      return 'ok';
    } catch (e) {
      return (e as Error).message;
    }
  }

  beforeAll(async () => {
    server = await startTestDatabase({
      LF_TEST_DB_MODE: 'local',
      ...(process.env['LF_PG_BINDIR'] ? { LF_PG_BINDIR: process.env['LF_PG_BINDIR'] } : {}),
      ...(process.env['LF_TEST_DB_TMPDIR']
        ? { LF_TEST_DB_TMPDIR: process.env['LF_TEST_DB_TMPDIR'] }
        : {}),
    });
    await withClient(su(), async (c) => {
      await c.query('CREATE DATABASE ledgerforce');
      hbaFile = (await c.query<{ hba_file: string }>('SHOW hba_file')).rows[0]?.hba_file ?? '';
    });
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('SS-PLAT-194 bootstrapCluster creates lf_backup idempotently and repairs a pre-existing over-privileged one', async () => {
    await withClient(su(), async (c) => {
      await c.query(`CREATE ROLE lf_backup SUPERUSER CREATEDB CREATEROLE REPLICATION NOLOGIN`);
      await c.query(`CREATE ROLE lf_backup_friend LOGIN`);
      await bootstrapCluster(c);
      await c.query(`GRANT lf_migrator TO lf_backup`);
      await c.query(`GRANT lf_backup TO lf_backup_friend`);
      await bootstrapCluster(c, { backup: pw.backup });
      await bootstrapCluster(c, { backup: pw.backup });
      const r = await c.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin,
                rolconnlimit,
                ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                       WHERE m.member = r.oid ORDER BY 1) AS member_of,
                ARRAY(SELECT u.rolname::text FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
                       WHERE m.roleid = r.oid ORDER BY 1) AS members
           FROM pg_roles r WHERE rolname = 'lf_backup'`,
      );
      expect(r.rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: true,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolcanlogin: true,
          rolconnlimit: 4,
          member_of: ['pg_read_all_data'],
          members: [],
        },
      ]);
    });
  });

  it('SS-PLAT-194 the init script (fresh install and upgrade step) confines lf_backup logins to the backup subnet, idempotently', async () => {
    // No subnet configured: the role exists but may log in from nowhere.
    const first = runInit({});
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(await loginAsBackup()).toMatch(/pg_hba\.conf rejects connection/);

    // A subnet that is not ours: still rejected.
    const other = runInit({ LF_BACKUP_ALLOWED_CIDR: '172.30.227.0/29' });
    expect(other.status, other.stdout + other.stderr).toBe(0);
    expect(await loginAsBackup()).toMatch(/pg_hba\.conf rejects connection/);

    // The backup service's subnet (here the loopback address the test connects from): allowed,
    // with the password the script set; a wrong password is refused.
    const ours = runInit({ LF_BACKUP_ALLOWED_CIDR: '127.0.0.1/32' });
    expect(ours.status, ours.stdout + ours.stderr).toBe(0);
    const again = runInit({ LF_BACKUP_ALLOWED_CIDR: '127.0.0.1/32' });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(await loginAsBackup()).toBe('ok');
    await expect(
      withClient(server.connectionString('ledgerforce', 'lf_backup', 'wrong'), (c) =>
        c.query('SELECT 1'),
      ),
    ).rejects.toThrow(/password authentication failed/);
    // Only the LedgerForce database: lf_backup cannot log in to another one.
    await expect(
      withClient(server.connectionString('postgres', 'lf_backup', pw.backup), (c) =>
        c.query('SELECT 1'),
      ),
    ).rejects.toThrow(/pg_hba\.conf rejects connection/);

    // Exactly one managed block, placed before every other rule; the other roles are untouched.
    const hba = readFileSync(hbaFile, 'utf8');
    expect(hba.match(/^# BEGIN lf_backup/gm)).toHaveLength(1);
    const firstRule = hba.split('\n').find((l) => /^(local|host)/.test(l));
    expect(firstRule).toMatch(
      /^host\s+ledgerforce\s+lf_backup\s+127\.0\.0\.1\/32\s+scram-sha-256$/,
    );
    await withClient(server.connectionString('ledgerforce', 'lf_app', pw.app), (c) =>
      c.query('SELECT 1'),
    );
  });

  it('SS-PLAT-194 the init script refuses a malformed subnet and leaves pg_hba.conf unchanged', async () => {
    const before = readFileSync(hbaFile, 'utf8');
    const bad = runInit({ LF_BACKUP_ALLOWED_CIDR: '0.0.0.0/0 trust\nhost all all all' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/LF_BACKUP_ALLOWED_CIDR/);
    expect(readFileSync(hbaFile, 'utf8')).toBe(before);
  });
});
