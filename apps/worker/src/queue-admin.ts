/**
 * Queue administration as the pgboss schema owner, lf_migrator (ADR-0008 rule 5, RQ-0033,
 * DL-0153). Never run these with lf_app credentials.
 *
 *  - installQueue: at deploy, right after `pnpm --filter @ledgerforce/db migrate`. Installs or
 *    upgrades pg-boss's tables in schema pgboss (created by migration 0024) and the outbox queues.
 *  - startMaintenance: a long-running owner instance with pg-boss supervision on: it expires jobs
 *    of crashed workers (so they are redelivered), applies retention, keeps stats partitions.
 *    Its credentials are a security consideration (open question to the product owner).
 */
import { installOutboxQueues, ownerBossOptions } from '@ledgerforce/outbox';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { BATCH_RUN_QUEUE } from './batch-jobs.ts';
import { AR_REMINDERS_QUEUE, DAILY_FANOUT_QUEUE } from './daily-jobs.ts';

async function assertOwnerRole(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ u: string }>('SELECT current_user AS u');
    if (rows[0]?.u !== 'lf_migrator') {
      throw new Error(`pg-boss is administered as lf_migrator, not ${rows[0]?.u ?? '?'}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * The worker's job queues (T-0120). They are installed at deploy time with the outbox queues,
 * so a worker never consumes a queue that does not exist yet, whichever service starts first.
 * Idempotent.
 */
export async function installJobQueues(owner: PgBoss): Promise<void> {
  for (const name of [DAILY_FANOUT_QUEUE, AR_REMINDERS_QUEUE, BATCH_RUN_QUEUE]) {
    if (!(await owner.getQueue(name))) {
      await owner.createQueue(name, { retryLimit: 3, retryDelay: 300, retryBackoff: true });
    }
  }
}

export async function installQueue(ownerUrl: string): Promise<void> {
  await assertOwnerRole(ownerUrl);
  const boss = new PgBoss(ownerBossOptions(ownerUrl));
  await boss.start();
  try {
    await installOutboxQueues(boss);
    await installJobQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function startMaintenance(
  ownerUrl: string,
  opts: { schedule?: boolean } = {},
): Promise<PgBoss> {
  await assertOwnerRole(ownerUrl);
  // schedule: true runs pg-boss's cron timekeeper (the daily fan-out, ADR-0062, T-0147).
  return new PgBoss(
    ownerBossOptions(ownerUrl, {
      migrate: false,
      supervise: true,
      schedule: opts.schedule ?? false,
    }),
  ).start();
}
