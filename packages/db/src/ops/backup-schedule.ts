/**
 * Nightly schedule and retention for the compose backup service (T-0143 AC-4, ADR-0101).
 * LF_BACKUP_AT is the daily run time in UTC (HH:MM, default 02:30); LF_BACKUP_RETENTION_DAYS
 * (default 14) removes lf-backup files older than that many days, always keeping the newest
 * complete backup. Only files this service writes (`ledgerforce-*.lfbackup[.partial]`) are touched.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BACKUP = /^ledgerforce-\d{8}T\d{6}Z\.lfbackup$/;
const PARTIAL = /^ledgerforce-\d{8}T\d{6}Z\.lfbackup\.partial$/;

export interface BackupScheduleConfig {
  at: string;
  retentionDays: number;
}

export function parseBackupConfig(
  env: Readonly<Record<string, string | undefined>>,
): BackupScheduleConfig {
  const at = env['LF_BACKUP_AT'] || '02:30';
  if (!AT.test(at)) throw new Error('LF_BACKUP_AT must be HH:MM (UTC, 00:00-23:59)');
  const days = env['LF_BACKUP_RETENTION_DAYS'] || '14';
  if (!/^[1-9]\d{0,3}$/.test(days)) {
    throw new Error('LF_BACKUP_RETENTION_DAYS must be a whole number of days from 1 to 9999');
  }
  return { at, retentionDays: Number.parseInt(days, 10) };
}

export function nextRunAt(now: Date, at: string): Date {
  const m = AT.exec(at);
  if (!m) throw new Error('LF_BACKUP_AT must be HH:MM (UTC)');
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2])),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function backupFileName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `ledgerforce-${stamp}.lfbackup`;
}

/** Remove expired backups in `dir`; returns the removed file names. */
export async function pruneBackups(
  dir: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const names = (await readdir(dir)).filter((n) => BACKUP.test(n) || PARTIAL.test(n));
  const newest = names
    .filter((n) => BACKUP.test(n))
    .sort()
    .at(-1);
  const removed: string[] = [];
  for (const name of names) {
    if (name === newest) continue;
    const s = await stat(join(dir, name));
    if (s.mtimeMs < cutoff) {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
