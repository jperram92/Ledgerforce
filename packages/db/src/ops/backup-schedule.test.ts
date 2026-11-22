/**
 * SS-PLAT-174 — nightly backup schedule and retention for the compose backup service (T-0143 AC-4,
 * ADR-0101): the next run time, backup file names, and pruning that removes only lf-backup files
 * older than the retention window and always keeps the newest backup.
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backupFileName, nextRunAt, parseBackupConfig, pruneBackups } from './backup-schedule.ts';

const dir = mkdtempSync(join(tmpdir(), 'lf-backup-schedule-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SS-PLAT-174 nightly backup schedule and retention', () => {
  it('SS-PLAT-174 the next run is today at HH:MM UTC, or tomorrow when that has passed', () => {
    expect(nextRunAt(new Date('2026-11-22T01:00:00Z'), '02:30').toISOString()).toBe(
      '2026-11-22T02:30:00.000Z',
    );
    expect(nextRunAt(new Date('2026-11-22T02:30:00Z'), '02:30').toISOString()).toBe(
      '2026-11-23T02:30:00.000Z',
    );
    expect(nextRunAt(new Date('2026-12-31T23:59:00Z'), '00:00').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('SS-PLAT-174 backup files are named by UTC time so they sort chronologically', () => {
    expect(backupFileName(new Date('2026-11-22T02:30:05.123Z'))).toBe(
      'ledgerforce-20261122T023005Z.lfbackup',
    );
  });

  it('SS-PLAT-174 configuration has safe defaults and rejects bad values by name', () => {
    expect(parseBackupConfig({})).toEqual({ at: '02:30', retentionDays: 14 });
    expect(parseBackupConfig({ LF_BACKUP_AT: '23:05', LF_BACKUP_RETENTION_DAYS: '30' })).toEqual({
      at: '23:05',
      retentionDays: 30,
    });
    expect(() => parseBackupConfig({ LF_BACKUP_AT: '24:00' })).toThrow(/LF_BACKUP_AT/);
    expect(() => parseBackupConfig({ LF_BACKUP_RETENTION_DAYS: '0' })).toThrow(
      /LF_BACKUP_RETENTION_DAYS/,
    );
    expect(() => parseBackupConfig({ LF_BACKUP_RETENTION_DAYS: '1.5' })).toThrow(
      /LF_BACKUP_RETENTION_DAYS/,
    );
  });

  it('SS-PLAT-174 pruning removes backups older than the retention, keeps the newest and other files', async () => {
    const now = new Date('2026-11-22T03:00:00Z');
    const day = 86_400_000;
    const files = {
      'ledgerforce-20261101T023000Z.lfbackup': 21,
      'ledgerforce-20261107T023000Z.lfbackup': 15,
      'ledgerforce-20261109T023000Z.lfbackup': 13,
      'ledgerforce-20261122T023000Z.lfbackup': 0,
      'notes.txt': 40,
      'ledgerforce-20261020T023000Z.lfbackup.partial': 33,
    };
    for (const [name, ageDays] of Object.entries(files)) {
      const p = join(dir, name);
      writeFileSync(p, 'x');
      const t = new Date(now.getTime() - ageDays * day);
      utimesSync(p, t, t);
    }
    const removed = await pruneBackups(dir, 14, now);
    expect(removed.sort()).toEqual([
      'ledgerforce-20261020T023000Z.lfbackup.partial',
      'ledgerforce-20261101T023000Z.lfbackup',
      'ledgerforce-20261107T023000Z.lfbackup',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'ledgerforce-20261109T023000Z.lfbackup',
      'ledgerforce-20261122T023000Z.lfbackup',
      'notes.txt',
    ]);
  });

  it('SS-PLAT-174 the newest backup is kept even when every backup is past the retention', async () => {
    const d = mkdtempSync(join(dir, 'old-'));
    const now = new Date('2026-11-22T03:00:00Z');
    for (const [name, ageDays] of [
      ['ledgerforce-20261001T023000Z.lfbackup', 52],
      ['ledgerforce-20261002T023000Z.lfbackup', 51],
    ] as const) {
      const p = join(d, name);
      writeFileSync(p, 'x');
      const t = new Date(now.getTime() - ageDays * 86_400_000);
      utimesSync(p, t, t);
    }
    expect(await pruneBackups(d, 14, now)).toEqual(['ledgerforce-20261001T023000Z.lfbackup']);
    expect(readdirSync(d)).toEqual(['ledgerforce-20261002T023000Z.lfbackup']);
  });
});
