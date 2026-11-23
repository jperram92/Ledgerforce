/**
 * Encrypted backup CLI (T-0143, ADR-0101; runbook Docs/ops/backup-restore.md).
 *
 *   node packages/db/src/cli/backup.ts --out /backups/manual.lfbackup     one backup, then exit
 *   node packages/db/src/cli/backup.ts --daily --dir /backups             the compose service
 *
 * Database: LF_BACKUP_DATABASE_URL, or LF_DB_HOST / LF_DB_PORT / LF_DB_NAME with
 * LF_BACKUP_DB_USER (compose: lf_backup, ADR-0106; fallback postgres; must bypass RLS) and
 * LF_BACKUP_DB_PASSWORD(_FILE).
 * Key: LF_KMS_PROVIDER=local + LF_KMS_KEYRING_FILE (a dedicated backup keyring), or transit.
 * Schedule: LF_BACKUP_AT (UTC HH:MM, default 02:30), LF_BACKUP_RETENTION_DAYS (default 14).
 * Exit 0 on success, 1 on a failed backup, 2 on bad configuration. Secrets are never printed.
 */
import { kmsFromEnv, type Kms } from '@ledgerforce/shared/crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readSecret, requireEnv } from '../env.ts';
import { createBackup } from '../ops/backup.ts';
import {
  backupFileName,
  nextRunAt,
  parseBackupConfig,
  pruneBackups,
} from '../ops/backup-schedule.ts';

function fail(message: string, code: number): never {
  console.error(`backup: ${message}`);
  process.exit(code);
}

function databaseUrl(env: NodeJS.ProcessEnv): string {
  const full = env['LF_BACKUP_DATABASE_URL'];
  if (full) return full;
  const host = requireEnv(env, 'LF_DB_HOST');
  const name = requireEnv(env, 'LF_DB_NAME');
  const port = env['LF_DB_PORT'] || '5432';
  const user = env['LF_BACKUP_DB_USER'] || 'postgres';
  const u = new URL(`postgres://${host}:${port}/${encodeURIComponent(name)}`);
  u.username = encodeURIComponent(user);
  const password = readSecret(env, 'LF_BACKUP_DB_PASSWORD');
  if (password !== undefined) u.password = encodeURIComponent(password);
  return u.toString();
}

let opts: { out?: string; daily?: boolean; dir?: string };
let url: string;
let config: ReturnType<typeof parseBackupConfig>;
let kms: Kms;
try {
  ({ values: opts } = parseArgs({
    options: { out: { type: 'string' }, daily: { type: 'boolean' }, dir: { type: 'string' } },
    strict: true,
  }));
  if (!opts.out === !opts.daily) throw new Error('give exactly one of --out <file> or --daily');
  if (opts.daily && !opts.dir) throw new Error('--daily needs --dir <directory>');
  url = databaseUrl(process.env);
  config = parseBackupConfig(process.env);
  const configured = await kmsFromEnv(process.env);
  if (!configured) throw new Error('LF_KMS_PROVIDER is required (local or transit)');
  kms = configured;
} catch (e) {
  fail((e as Error).message, 2);
}

async function once(file: string): Promise<void> {
  const started = Date.now();
  const { backupId, manifest } = await createBackup({ url, out: file, kms });
  console.log(
    `backup ${backupId} written to ${file} in ${String(Date.now() - started)} ms: ` +
      `${String(Object.keys(manifest.tables).length)} tables, ${String(manifest.chains.length)} company chains`,
  );
}

if (opts.out) {
  try {
    await once(opts.out);
  } catch (e) {
    fail(`backup failed: ${(e as Error).message}`, 1);
  }
  process.exit(0);
}

const dir = opts.dir ?? '';
console.log(
  `backup service: daily at ${config.at} UTC into ${dir}, retention ${String(config.retentionDays)} days`,
);
for (;;) {
  const next = nextRunAt(new Date(), config.at);
  await new Promise((r) => setTimeout(r, next.getTime() - Date.now()));
  try {
    await once(join(dir, backupFileName(new Date())));
    const removed = await pruneBackups(dir, config.retentionDays);
    if (removed.length > 0) console.log(`pruned ${String(removed.length)}: ${removed.join(', ')}`);
  } catch (e) {
    // The service keeps running; the failure is visible in the logs and the missing file.
    console.error(`backup: nightly backup FAILED: ${(e as Error).message}`);
  }
}
