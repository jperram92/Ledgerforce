/**
 * SS-PLAT-199 / SS-PLAT-200 / SS-PLAT-201 — lf_backup hardening after security review r12
 * (T-0244, ADR-0109, RQ-0191; builds on T-0227, ADR-0106).
 *
 * SS-PLAT-199: large-object creation is revoked from PUBLIC, so lf_backup (and lf_app) cannot
 * create a large object even with read-only switched off.
 * SS-PLAT-200: the backup checks its role at start-up and fails loudly with a named error when
 * lf_backup is missing, cannot log in, or is misconfigured (an install that skipped the upgrade
 * step no longer fails quietly every night).
 * SS-PLAT-201: the init script refuses a /0 or public CIDR, restores pg_hba.conf whenever
 * validation fails, tolerates a pre-existing parse error with a clear message, and sets the
 * lf_backup password only once its single-address rule is in force.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapCluster } from '../bootstrap.ts';
import { startTestDatabase, type TestDatabaseServer } from '../testing/start-test-database.ts';
import { createTestDatabase, type TestDatabase } from '../testing/test-db.ts';
import { BackupRoleError, checkBackupRole } from './backup-preflight.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const INIT_SCRIPT = join(ROOT, 'infra/compose/initdb/10-ledgerforce-roles.sh');
const BOOTSTRAP = join(ROOT, 'packages/db/bootstrap');
const BACKUP_CLI = join(ROOT, 'packages/db/src/cli/backup.ts');

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Runs `sqlText` on `url` with read-only switched off; returns the SQLSTATE or 'succeeded'. */
async function sqlstate(url: string, sqlText: string): Promise<string> {
  return withClient(url, async (c) => {
    await c.query('SET default_transaction_read_only = off');
    try {
      await c.query(sqlText);
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
    return 'succeeded';
  });
}

async function rejection(p: Promise<unknown>): Promise<BackupRoleError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackupRoleError) return e;
    throw e;
  }
  throw new Error('expected a BackupRoleError, but the check passed');
}

describe('SS-PLAT-199 lf_backup cannot create large objects', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrate: true });
  }, 120_000);
  afterAll(async () => {
    await tdb?.close();
  });

  it('SS-PLAT-199 lo_creat, lo_create and lo_from_bytea are not executable by PUBLIC', async () => {
    const { rows } = await tdb.admin.query<{ f: string; backup: boolean; app: boolean }>(
      `SELECT f, has_function_privilege('lf_backup', f, 'EXECUTE') AS backup,
              has_function_privilege('lf_app', f, 'EXECUTE') AS app
         FROM unnest(ARRAY['pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)',
                           'pg_catalog.lo_from_bytea(oid, bytea)',
                           'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)']) AS f
        ORDER BY f`,
    );
    expect(rows.every((r) => !r.backup && !r.app)).toBe(true);
    expect(rows).toHaveLength(5);
  });

  it('SS-PLAT-199 with read-only switched off, lf_backup and lf_app still get permission denied (42501)', async () => {
    for (const role of ['lf_backup', 'lf_app'] as const) {
      const url = tdb.url(role);
      expect(await sqlstate(url, 'SELECT lo_creat(-1)'), role).toBe('42501');
      expect(await sqlstate(url, 'SELECT lo_create(0)'), role).toBe('42501');
      expect(await sqlstate(url, `SELECT lo_from_bytea(0, '\\x01')`), role).toBe('42501');
    }
    const n = await tdb.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_largeobject_metadata',
    );
    expect(n.rows[0]).toEqual({ n: 0 });
  });
});

describe('SS-PLAT-200 / SS-PLAT-201 on a separate cluster', () => {
  let server: TestDatabaseServer;
  let hbaFile: string;
  let work: string;
  let keyring: string;
  const pw = { migrator: 'm-pw-200', app: 'a-pw-200', backup: 'b-pw-200' };
  const su = (database = 'postgres') => server.connectionString(database);
  const backupUrl = (password = pw.backup) =>
    server.connectionString('ledgerforce', 'lf_backup', password);

  function runInit(extra: Record<string, string>, path = process.env['PATH'] ?? '') {
    return spawnSync('bash', [INIT_SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: path,
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

  function runBackupCli(args: string[], url: string) {
    return spawnSync(process.execPath, [BACKUP_CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env['PATH'],
        LF_BACKUP_DATABASE_URL: url,
        LF_KMS_PROVIDER: 'local',
        LF_KMS_KEYRING_FILE: keyring,
      },
    });
  }

  async function login(url: string): Promise<string> {
    try {
      await withClient(url, async (c) => {
        await c.query('SELECT 1');
      });
      return 'ok';
    } catch (e) {
      return (e as Error).message;
    }
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'lf-t0244-'));
    keyring = join(work, 'keyring.json');
    writeFileSync(
      keyring,
      JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
    );
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
    if (work) rmSync(work, { recursive: true, force: true });
  });

  describe('SS-PLAT-200 the backup detects a missing or misconfigured lf_backup at start-up', () => {
    it('SS-PLAT-200 an install without lf_backup (upgrade step not run) fails the check with LF_BACKUP_ROLE_MISSING and the upgrade command', async () => {
      const e = await rejection(checkBackupRole(backupUrl()));
      expect(e.code).toBe('LF_BACKUP_ROLE_MISSING');
      expect(e.message).toMatch(/LF_BACKUP_ROLE_MISSING/);
      expect(e.message).toContain(
        'exec -u postgres postgres bash /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh',
      );
      expect(e.message).toContain('Docs/ops/backup-restore.md');
    });

    it('SS-PLAT-200 the backup CLI exits 2 at start-up with the named error, for a one-off run and for the nightly service', () => {
      const out = join(work, 'never.lfbackup');
      const once = runBackupCli(['--out', out], backupUrl());
      expect(once.status, once.stdout + once.stderr).toBe(2);
      expect(once.stderr).toMatch(/LF_BACKUP_ROLE_MISSING/);
      expect(existsSync(out)).toBe(false);

      const dir = join(work, 'daily');
      mkdirSync(dir);
      const daily = runBackupCli(['--daily', '--dir', dir], backupUrl());
      // It does not wait for the nightly slot: the service stops at once, so compose's restart
      // policy shows it as restarting and `logs backup` names the problem.
      expect(daily.status, daily.stdout + daily.stderr).toBe(2);
      expect(daily.stderr).toMatch(/LF_BACKUP_ROLE_MISSING/);
      expect(daily.stdout).not.toMatch(/backup service: daily/);
    });

    it('SS-PLAT-200 a login refused by pg_hba is LF_BACKUP_LOGIN_REJECTED; a wrong password is LF_BACKUP_LOGIN_FAILED', async () => {
      const closed = runInit({});
      expect(closed.status, closed.stdout + closed.stderr).toBe(0);
      expect((await rejection(checkBackupRole(backupUrl()))).code).toBe(
        'LF_BACKUP_LOGIN_REJECTED',
      );

      const open = runInit({ LF_BACKUP_ALLOWED_CIDR: '127.0.0.1/32' });
      expect(open.status, open.stdout + open.stderr).toBe(0);
      const wrong = await rejection(checkBackupRole(backupUrl('not-the-password')));
      expect(wrong.code).toBe('LF_BACKUP_LOGIN_FAILED');
      expect(wrong.message).toContain('lf_backup_password');
      expect(wrong.message).not.toContain('not-the-password');
    });

    it('SS-PLAT-200 a correctly bootstrapped lf_backup passes, and the CLI gets past the check', async () => {
      await expect(checkBackupRole(backupUrl())).resolves.toEqual({
        role: 'lf_backup',
        warnings: [],
      });
    });

    it('SS-PLAT-200 a misconfigured lf_backup fails with LF_BACKUP_ROLE_MISCONFIGURED naming every problem, until the bootstrap repairs it', async () => {
      await withClient(su(), async (c) => {
        await c.query('ALTER ROLE lf_backup NOBYPASSRLS CREATEDB');
        await c.query('ALTER ROLE lf_backup RESET default_transaction_read_only');
        await c.query('REVOKE pg_read_all_data FROM lf_backup');
        await c.query('GRANT lf_migrator TO lf_backup');
        await c.query('CREATE ROLE lf_backup_friend LOGIN');
        await c.query('GRANT lf_backup TO lf_backup_friend');
      });
      const e = await rejection(checkBackupRole(backupUrl()));
      expect(e.code).toBe('LF_BACKUP_ROLE_MISCONFIGURED');
      expect(e.problems).toEqual([
        'not BYPASSRLS',
        'has CREATEDB',
        'not a member of pg_read_all_data',
        'member of other roles: lf_migrator',
        'other roles are members of lf_backup: lf_backup_friend',
        'sessions do not start read-only (default_transaction_read_only is off)',
      ]);
      expect(e.message).toContain('10-ledgerforce-roles.sh');

      await withClient(su(), (c) => bootstrapCluster(c));
      await expect(checkBackupRole(backupUrl())).resolves.toEqual({
        role: 'lf_backup',
        warnings: [],
      });
    });

    it('SS-PLAT-200 a superuser is accepted with a warning; a role that cannot read past RLS is refused', async () => {
      const r = await checkBackupRole(server.connectionString('ledgerforce'));
      expect(r.role).toBe(server.superuser);
      expect(r.warnings.join(' ')).toMatch(/superuser.*lf_backup/);
      const app = await rejection(
        checkBackupRole(server.connectionString('ledgerforce', 'lf_app', pw.app)),
      );
      expect(app.code).toBe('LF_BACKUP_ROLE_CANNOT_BYPASS_RLS');
    });
  });

  describe('SS-PLAT-201 the pg_hba step of the init script', () => {
    it('SS-PLAT-201 refuses a /0 prefix and any public or invalid address, leaving pg_hba.conf unchanged', () => {
      const before = readFileSync(hbaFile, 'utf8');
      for (const cidr of ['0.0.0.0/0', '10.0.0.0/0', '::/0']) {
        const r = runInit({ LF_BACKUP_ALLOWED_CIDR: cidr });
        expect(r.status, cidr).not.toBe(0);
        expect(r.stderr, cidr).toMatch(/\/0 would allow lf_backup from every address/);
      }
      for (const cidr of ['8.8.8.8/32', '172.32.0.6/32', '2001:db8::6/128', '300.1.1.1/32']) {
        const r = runInit({ LF_BACKUP_ALLOWED_CIDR: cidr });
        expect(r.status, cidr).not.toBe(0);
        expect(r.stderr, cidr).toMatch(/LF_BACKUP_ALLOWED_CIDR/);
      }
      for (const cidr of ['172.30.227.6/33', '127.0.0.1/8 trust']) {
        const r = runInit({ LF_BACKUP_ALLOWED_CIDR: cidr });
        expect(r.status, cidr).not.toBe(0);
      }
      expect(readFileSync(hbaFile, 'utf8')).toBe(before);
    });

    it('SS-PLAT-201 the compose default (the backup container address as a /32) is accepted and admits no other address', async () => {
      const r = runInit({ LF_BACKUP_ALLOWED_CIDR: '172.30.227.6/32' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/lf_backup logins allowed from 172\.30\.227\.6\/32/);
      const firstRule = readFileSync(hbaFile, 'utf8')
        .split('\n')
        .find((l) => /^(local|host)/.test(l));
      expect(firstRule).toMatch(/^host\s+ledgerforce\s+lf_backup\s+172\.30\.227\.6\/32\s+/);
      // The test connects from 127.0.0.1, which is not the backup container's address.
      expect(await login(backupUrl())).toMatch(/pg_hba\.conf rejects connection/);
      const back = runInit({ LF_BACKUP_ALLOWED_CIDR: '127.0.0.1/32' });
      expect(back.status, back.stdout + back.stderr).toBe(0);
      expect(await login(backupUrl())).toBe('ok');
    });

    it('SS-PLAT-201 restores the previous pg_hba.conf when the validation itself fails', () => {
      const before = readFileSync(hbaFile, 'utf8');
      // A psql that fails only the post-write validation query, as a lost connection would.
      const bin = join(work, 'failing-bin');
      mkdirSync(bin, { recursive: true });
      const realPsql = spawnSync('bash', ['-c', 'command -v psql'], { encoding: 'utf8' })
        .stdout.trim();
      writeFileSync(
        join(bin, 'psql'),
        `#!/usr/bin/env bash\nfor a in "$@"; do\n  if [[ "$a" == *"lf_backup_hba_validation"* ]]; then echo 'psql: connection lost' >&2; exit 2; fi\ndone\nexec ${realPsql} "$@"\n`,
      );
      chmodSync(join(bin, 'psql'), 0o755);
      const r = runInit(
        { LF_BACKUP_ALLOWED_CIDR: '10.20.30.40/32' },
        `${bin}:${process.env['PATH'] ?? ''}`,
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/pg_hba\.conf restored/);
      expect(readFileSync(hbaFile, 'utf8')).toBe(before);
    });

    it('SS-PLAT-201 a pre-existing parse error is reported clearly and tolerated: roles done, rule and password unchanged', async () => {
      const before = readFileSync(hbaFile, 'utf8');
      appendFileSync(hbaFile, 'host    all    all    1.2.3.4/99    trust\n');
      const broken = readFileSync(hbaFile, 'utf8');
      const brokenLine = broken.split('\n').length - 1;
      try {
        const r = runInit({ LF_BACKUP_ALLOWED_CIDR: '127.0.0.1/32', LF_BACKUP_PASSWORD: 'new-pw' });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stderr).toMatch(/pg_hba\.conf already has errors/);
        expect(r.stderr).toContain(`line ${String(brokenLine)}`);
        expect(r.stderr).toMatch(/invalid CIDR mask in address "1\.2\.3\.4\/99"/);
        expect(r.stderr).not.toMatch(/would not parse/);
        expect(readFileSync(hbaFile, 'utf8')).toBe(broken);
        // The loaded rules and the password are unchanged: the old password still works.
        expect(await login(backupUrl())).toBe('ok');
        expect(await login(backupUrl('new-pw'))).toMatch(/password authentication failed/);
      } finally {
        writeFileSync(hbaFile, before);
        await withClient(su(), (c) => c.query('SELECT pg_reload_conf()'));
      }
    });
  });
});
