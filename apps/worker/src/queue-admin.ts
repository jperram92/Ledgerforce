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

export async function installQueue(ownerUrl: string): Promise<void> {
  await assertOwnerRole(ownerUrl);
  const boss = new PgBoss(ownerBossOptions(ownerUrl));
  await boss.start();
  try {
    await installOutboxQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function startMaintenance(ownerUrl: string): Promise<PgBoss> {
  await assertOwnerRole(ownerUrl);
  return new PgBoss(ownerBossOptions(ownerUrl, { migrate: false, supervise: true })).start();
}
