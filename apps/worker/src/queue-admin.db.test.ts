/**
 * SS-PLAT-69 — pg-boss is installed and maintained only as the schema owner (T-0030, RQ-0033).
 * `installQueue` runs at deploy right after the SQL migrations; it must refuse any role other
 * than lf_migrator (lf_app must never create or upgrade queue objects, ADR-0008 rule 5) and be
 * safe to run again.
 */
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { OUTBOX_DEAD_LETTER_QUEUE, OUTBOX_QUEUE, OUTBOX_QUEUE_OPTIONS } from '@ledgerforce/outbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATCH_RUN_QUEUE } from './batch-jobs.ts';
import { AR_REMINDERS_QUEUE, DAILY_FANOUT_QUEUE } from './daily-jobs.ts';
import { installQueue } from './queue-admin.ts';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  await tdb?.close();
});

const queues = async () =>
  (
    await tdb.admin.query<{ name: string; retry_limit: number; dead_letter: string | null }>(
      `SELECT name, retry_limit, dead_letter FROM pgboss.queue ORDER BY name`,
    )
  ).rows;

describe('SS-PLAT-69 queue install', () => {
  it('SS-PLAT-69 refuses to install as lf_app', async () => {
    await expect(installQueue(tdb.url('lf_app'))).rejects.toThrow(/lf_migrator/);
    const { rows } = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'pgboss'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('SS-PLAT-69 installs pg-boss, the outbox queues and the job queues (T-0120) as lf_migrator, idempotently', async () => {
    await installQueue(tdb.url('lf_migrator'));
    await installQueue(tdb.url('lf_migrator'));
    expect(await queues()).toEqual([
      { name: BATCH_RUN_QUEUE, retry_limit: 3, dead_letter: null },
      { name: AR_REMINDERS_QUEUE, retry_limit: 3, dead_letter: null },
      { name: DAILY_FANOUT_QUEUE, retry_limit: 3, dead_letter: null },
      {
        name: OUTBOX_QUEUE,
        retry_limit: OUTBOX_QUEUE_OPTIONS.retryLimit,
        dead_letter: OUTBOX_DEAD_LETTER_QUEUE,
      },
      { name: OUTBOX_DEAD_LETTER_QUEUE, retry_limit: 2, dead_letter: null },
    ]);
  });
});
