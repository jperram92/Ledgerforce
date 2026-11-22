/**
 * restoreBackup — authenticate an lf-backup file and restore it into a fresh database (T-0143,
 * ADR-0101, RQ-0183 Finding 6). The target server gets the idempotent LedgerForce bootstrap first
 * (cluster roles, then the database grants), so a brand-new cluster works; the decrypted stream
 * goes straight into `pg_restore --single-transaction --exit-on-error` (no plaintext on disk; only
 * authenticated chunks reach it). An existing database is never overwritten. On any failure the
 * database this call created is dropped.
 */
import type { Kms } from '@ledgerforce/shared/crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase } from '../bootstrap.ts';
import { BackupDecryptError, openBackup, type BackupManifest } from './backup-format.ts';
import { findPgTool, pgConnArgs, withDatabase } from './pg-tools.ts';

type Env = Readonly<Record<string, string | undefined>>;

export class RestoreError extends Error {
  readonly code = 'RESTORE_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function adminQuery(serverUrl: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: serverUrl });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(serverUrl: string, database: string): Promise<void> {
  if (!DB_NAME.test(database)) throw new RestoreError('invalid database name');
  await adminQuery(serverUrl, async (c) => {
    // Plain DROP first: PostgreSQL waits a few seconds for sessions that are already closing
    // (the drill's own pool), so they are not killed mid-shutdown; FORCE only if one remains.
    try {
      await c.query(`DROP DATABASE IF EXISTS ${database}`);
    } catch {
      await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  });
}

export async function restoreBackup(opts: {
  file: string;
  kms: Kms;
  /** Superuser URL on the target server (any existing database, e.g. /postgres). */
  serverUrl: string;
  /** New database to create; must not exist. Lower-case letters, digits and _ only. */
  database: string;
  env?: Env;
}): Promise<{ manifest: BackupManifest; backupId: string; url: string }> {
  const env = opts.env ?? process.env;
  if (!DB_NAME.test(opts.database)) {
    throw new RestoreError('database name must be lower-case letters, digits and _');
  }
  // Authenticate header and manifest before touching the target.
  const backup = await openBackup(opts.file, opts.kms);

  let created = false;
  try {
    await adminQuery(opts.serverUrl, async (c) => {
      const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database]);
      if (exists.rowCount !== 0) {
        throw new RestoreError(
          `database ${opts.database} already exists; the drill restores only into a new one`,
        );
      }
      await bootstrapCluster(c);
      await c.query(`CREATE DATABASE ${opts.database} TEMPLATE template0 ENCODING 'UTF8'`);
      created = true;
    });
    const url = withDatabase(opts.serverUrl, opts.database);
    await adminQuery(url, (c) => bootstrapDatabase(c));

    const { args, env: connEnv } = pgConnArgs(url);
    const child = spawn(
      findPgTool('pg_restore', env),
      ['--single-transaction', '--exit-on-error', ...args],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { PATH: env['PATH'] ?? '/usr/bin:/bin', ...connEnv },
      },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdin.on('error', () => {
      // pg_restore exiting early closes its stdin; the exit code reports the failure.
    });
    const payload = backup.payload();
    let decryptError: unknown;
    payload.on('error', (e) => {
      decryptError = e;
      // Abort pg_restore before it can commit: its single transaction then rolls back.
      child.kill('SIGKILL');
    });
    payload.pipe(child.stdin);
    const code = await exited;
    if (decryptError !== undefined) {
      throw decryptError instanceof BackupDecryptError ? decryptError : new BackupDecryptError();
    }
    if (code !== 0)
      throw new RestoreError(`pg_restore failed (exit ${String(code)}): ${stderr.trim()}`);
    return { manifest: backup.manifest, backupId: backup.backupId, url };
  } catch (e) {
    if (created) await dropDatabase(opts.serverUrl, opts.database);
    throw e;
  }
}
