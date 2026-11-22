/**
 * SS-PLAT-174 / SS-PLAT-175 / SS-PLAT-176 — encrypted backup and the restore drill that proves the
 * journal hash chain (T-0143, ADR-0101, RQ-0183; design §6.9).
 *
 * A migrated database with posted journals in two tenants is backed up (pg_dump under an exported
 * snapshot, envelope-encrypted through the Kms), restored into a brand-new PostgreSQL cluster
 * (initdb/pg_ctl, DL-0007) and verified: every table's row count and every company's chain
 * (verifyChain, ADR-0017) must match the manifest. Altered bytes, a wrong key and a chain broken
 * before the backup must each fail loudly (non-zero exit naming the failure) and leave no
 * restored database behind.
 */
import { createDb } from '@ledgerforce/db';
import { BackupDecryptError, createBackup, openBackup } from '@ledgerforce/db/ops';
import { startTestDatabase, type TestDatabaseServer } from '@ledgerforce/db/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { sql } from 'kysely';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedgerFixture, type LedgerFixture, type Line } from '../testing/journal-fixture.ts';
import { runRestoreDrill } from './restore-drill.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = join(ROOT, 'packages/ledger/src/cli/restore-drill.ts');
const BACKUP_CLI = join(ROOT, 'packages/db/src/cli/backup.ts');

const TENANT_A = '01900000-0000-7000-8000-0000000143aa';
const TENANT_B = '01900000-0000-7000-8000-0000000143bb';

let a: LedgerFixture;
let b: LedgerFixture;
let target: TestDatabaseServer;
let dir: string;
let keyringFile: string;
let wrongKeyringFile: string;
let kms: LocalKeyringKms;
let wrongKms: LocalKeyringKms;
let backupFile: string;
/** Second posting company of tenant A (the fixture's otherCompany has no dimension set). */
let aSecond: string;

const keyringJson = () =>
  JSON.stringify({ active: 'backup-1', keys: { 'backup-1': randomBytes(32).toString('base64') } });

const sale = (amount: string): Line[] => [
  { code: '1200', debit: amount },
  { code: '4110', credit: amount },
];

async function post(f: LedgerFixture, company: string, n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    ids.push(
      await f.inTenant((trx) =>
        f.insertEntry(trx, sale(`${String(i)}00.0000`), {
          company,
          memo: `${tag}-SECRET-MEMO-${String(i)}`,
        }),
      ),
    );
  }
  return ids;
}

const targetUrl = () => target.connectionString('postgres');

/** Runs `fn` with a one-connection Kysely on `url` (superuser checks and tampering). */
async function withSu<R>(
  url: string,
  fn: (db: ReturnType<typeof createDb>) => Promise<R>,
): Promise<R> {
  const db = createDb(url, 1);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

const databaseExists = (name: string): Promise<boolean> =>
  withSu(targetUrl(), async (db) => {
    const r = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`.execute(db);
    return r.rows.length === 1;
  });

function runCli(args: string[], keyring: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      ...(process.env['LF_PG_BINDIR'] ? { LF_PG_BINDIR: process.env['LF_PG_BINDIR'] } : {}),
      LF_KMS_PROVIDER: 'local',
      LF_KMS_KEYRING_FILE: keyring,
      LF_RESTORE_SERVER_URL: targetUrl(),
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lf-restore-drill-'));
  const ring = keyringJson();
  keyringFile = join(dir, 'backup-keyring.json');
  wrongKeyringFile = join(dir, 'wrong-keyring.json');
  writeFileSync(keyringFile, ring, { mode: 0o600 });
  writeFileSync(wrongKeyringFile, keyringJson(), { mode: 0o600 });
  kms = LocalKeyringKms.fromJson(ring);
  wrongKms = await LocalKeyringKms.fromFile(wrongKeyringFile);

  a = await createLedgerFixture(TENANT_A);
  b = await createLedgerFixture(TENANT_B, { tdb: a.tdb });
  await post(a, a.companyId, 5, 'A1');
  aSecond = await a.addCompany('Harbour Second Pty Ltd');
  await post(a, aSecond, 3, 'A2');
  await post(b, b.companyId, 4, 'B1');

  target = await startTestDatabase({
    LF_TEST_DB_MODE: 'local',
    ...(process.env['LF_PG_BINDIR'] ? { LF_PG_BINDIR: process.env['LF_PG_BINDIR'] } : {}),
    ...(process.env['LF_TEST_DB_TMPDIR']
      ? { LF_TEST_DB_TMPDIR: process.env['LF_TEST_DB_TMPDIR'] }
      : {}),
  });

  backupFile = join(dir, 'nightly.lfbackup');
  await createBackup({ url: a.tdb.url('superuser'), out: backupFile, kms });
}, 240_000);

afterAll(async () => {
  await b?.close();
  await a?.close();
  await target?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('SS-PLAT-174 restore drill proves every company chain after restore into a fresh cluster', () => {
  it('SS-PLAT-174 restores the backup into a fresh cluster and reports every chain ok with the same entry counts', async () => {
    const report = await runRestoreDrill({
      file: backupFile,
      kms,
      serverUrl: targetUrl(),
      database: 'lf_drill_ok',
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    const byCompany = new Map(report.companies.map((c) => [c.companyId, c]));
    expect(byCompany.get(a.companyId)).toMatchObject({ tenantId: TENANT_A, ok: true, entries: 5 });
    expect(byCompany.get(aSecond)).toMatchObject({ tenantId: TENANT_A, ok: true, entries: 3 });
    expect(byCompany.get(b.companyId)).toMatchObject({ tenantId: TENANT_B, ok: true, entries: 4 });
    expect(report.tablesChecked).toBeGreaterThan(20);

    // The restored copy keeps the security model: roles exist, RLS still forced, lf_app owns nothing.
    await withSu(target.connectionString('lf_drill_ok'), async (db) => {
      const rls = await sql<{ f: boolean; o: string }>`
        SELECT relforcerowsecurity AS f, pg_get_userbyid(relowner) AS o
          FROM pg_class WHERE oid = 'app.journal_entry'::regclass`.execute(db);
      expect(rls.rows[0]).toEqual({ f: true, o: 'lf_migrator' });
      const lines = await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM app.journal_line`.execute(db);
      expect(lines.rows[0]?.n).toBe(String(2 * 12));
    });
  });

  it('SS-PLAT-174 the CLI exits 0 and prints one ok line per company', () => {
    const r = runCli(['--file', backupFile, '--database', 'lf_drill_cli'], keyringFile);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`company ${a.companyId} tenant ${TENANT_A} chain ok entries 5`);
    expect(r.stdout).toContain(`company ${b.companyId} tenant ${TENANT_B} chain ok entries 4`);
    expect(r.stdout).toMatch(/restore drill OK/);
  });
  it('SS-PLAT-174 the backup CLI (as the compose service runs it) writes a backup the drill CLI verifies', () => {
    const out = join(dir, 'cli.lfbackup');
    const b1 = spawnSync(process.execPath, [BACKUP_CLI, '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        ...(process.env['LF_PG_BINDIR'] ? { LF_PG_BINDIR: process.env['LF_PG_BINDIR'] } : {}),
        LF_BACKUP_DATABASE_URL: a.tdb.url('superuser'),
        LF_KMS_PROVIDER: 'local',
        LF_KMS_KEYRING_FILE: keyringFile,
      },
    });
    expect(b1.status, b1.stdout + b1.stderr).toBe(0);
    expect(b1.stdout).toMatch(/^backup \S+ written to .*cli\.lfbackup/);
    const r = runCli(['--file', out, '--database', 'lf_drill_from_cli'], keyringFile);
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const bad = spawnSync(process.execPath, [BACKUP_CLI, '--daily'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] },
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--daily needs --dir');
  });
});

describe('SS-PLAT-175 restore drill fails loudly on an altered backup or a broken chain', () => {
  it('SS-PLAT-175 a backup with one altered byte exits non-zero with BACKUP_DECRYPT_FAILED and leaves no database', async () => {
    const bytes = readFileSync(backupFile);
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = (bytes[mid] ?? 0) ^ 0x40;
    const altered = join(dir, 'altered.lfbackup');
    writeFileSync(altered, bytes);
    const report = await runRestoreDrill({
      file: altered,
      kms,
      serverUrl: targetUrl(),
      database: 'lf_drill_altered',
    });
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.code)).toEqual(['BACKUP_DECRYPT_FAILED']);
    expect(await databaseExists('lf_drill_altered')).toBe(false);

    const r = runCli(['--file', altered, '--database', 'lf_drill_altered_cli'], keyringFile);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BACKUP_DECRYPT_FAILED');
    expect(await databaseExists('lf_drill_altered_cli')).toBe(false);
  });

  it('SS-PLAT-175 a truncated backup exits non-zero with BACKUP_DECRYPT_FAILED', async () => {
    const bytes = readFileSync(backupFile);
    const truncated = join(dir, 'truncated.lfbackup');
    writeFileSync(truncated, bytes.subarray(0, bytes.length - 100));
    const report = await runRestoreDrill({
      file: truncated,
      kms,
      serverUrl: targetUrl(),
      database: 'lf_drill_truncated',
    });
    expect(report.failures.map((f) => f.code)).toEqual(['BACKUP_DECRYPT_FAILED']);
    expect(await databaseExists('lf_drill_truncated')).toBe(false);
  });

  it('SS-PLAT-175 the drill refuses to restore over an existing database', async () => {
    const report = await runRestoreDrill({
      file: backupFile,
      kms,
      serverUrl: targetUrl(),
      database: 'lf_drill_ok',
    });
    expect(report.failures.map((f) => f.code)).toEqual(['RESTORE_FAILED']);
    expect(report.failures[0]?.message).toMatch(/already exists/);
    expect(await databaseExists('lf_drill_ok')).toBe(true);
  });

  it('SS-PLAT-175 a journal line tampered before the backup exits non-zero naming the company, seq and reason', async () => {
    const tampered = await b.addCompany('Tampered Pty Ltd');
    const ids = await post(b, tampered, 3, 'B2');
    // The attacker the chain exists for: a superuser with every trigger switched off.
    await withSu(a.tdb.url('superuser'), (db) =>
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        await sql`UPDATE app.journal_line SET memo = 'edited after posting'
                   WHERE entry_id = ${ids[1]} AND line_no = 1`.execute(trx);
      }),
    );
    const tamperedBackup = join(dir, 'tampered-chain.lfbackup');
    await createBackup({ url: a.tdb.url('superuser'), out: tamperedBackup, kms });

    const report = await runRestoreDrill({
      file: tamperedBackup,
      kms,
      serverUrl: targetUrl(),
      database: 'lf_drill_tampered',
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      {
        code: 'CHAIN_BROKEN',
        message: `company ${tampered} (tenant ${TENANT_B}): chain broken at seq 2 (hash_mismatch, entry ${String(ids[1])})`,
      },
    ]);
    expect(report.companies.find((c) => c.companyId === a.companyId)?.ok).toBe(true);
    expect(await databaseExists('lf_drill_tampered')).toBe(false);

    const r = runCli(
      ['--file', tamperedBackup, '--database', 'lf_drill_tampered_cli'],
      keyringFile,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`CHAIN_BROKEN company ${tampered}`);
  });
});

describe('SS-PLAT-176 the backup at rest is encrypted and opens only with the configured key', () => {
  it('SS-PLAT-176 the file holds no plaintext dump, table name, tenant name, memo or company id', () => {
    const bytes = readFileSync(backupFile);
    expect((statSync(backupFile).mode & 0o777).toString(8)).toBe('600');
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('LFBACKUP');
    for (const needle of [
      'PGDMP',
      'journal_entry',
      'CREATE TABLE',
      'Harbour',
      'A1-SECRET-MEMO',
      a.companyId,
      TENANT_B,
    ]) {
      expect(bytes.includes(Buffer.from(needle)), needle).toBe(false);
    }
  });

  it('SS-PLAT-176 the configured key yields a pg_dump archive; a different key is refused', async () => {
    const opened = await openBackup(backupFile, kms);
    const first: Buffer[] = [];
    for await (const chunk of opened.payload()) {
      first.push(chunk as Buffer);
      break;
    }
    expect(Buffer.concat(first).subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(opened.manifest.chains.map((c) => c.companyId).sort()).toEqual(
      [a.companyId, a.otherCompanyId, aSecond, b.companyId, b.otherCompanyId].sort(),
    );

    await expect(openBackup(backupFile, wrongKms)).rejects.toBeInstanceOf(BackupDecryptError);
    const r = runCli(['--file', backupFile, '--database', 'lf_drill_wrong_key'], wrongKeyringFile);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BACKUP_DECRYPT_FAILED');
    expect(await databaseExists('lf_drill_wrong_key')).toBe(false);
  });

  it('SS-PLAT-176 the manifest and the dump come from the same snapshot (row counts match the restored copy)', async () => {
    const opened = await openBackup(backupFile, kms);
    expect(opened.manifest.tables['app.journal_entry']).toBe('12');
    expect(opened.manifest.tables['app.tenant']).toBe('2');
    expect(opened.manifest.tables['app.journal_line']).toBe('24');
  });
});
