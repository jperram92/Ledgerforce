/**
 * Install or update the outbox queues on an owner (lf_migrator) pg-boss instance (RQ-0033).
 * Run once per deploy, after the SQL migrations: `pnpm --filter @ledgerforce/worker install-queue`.
 */
import type { PgBoss } from 'pg-boss';
import { OUTBOX_DEAD_LETTER_QUEUE, OUTBOX_QUEUE, OUTBOX_QUEUE_OPTIONS } from './queue.ts';

/** Never let pg-boss discard an undelivered job early: about 13 months (default is 14 days). */
const KEEP_QUEUED_SECONDS = 400 * 24 * 60 * 60;

export async function installOutboxQueues(owner: PgBoss): Promise<void> {
  // The dead-letter queue first: the main queue refers to it.
  const queues = [
    { name: OUTBOX_DEAD_LETTER_QUEUE, options: { retentionSeconds: KEEP_QUEUED_SECONDS } },
    {
      name: OUTBOX_QUEUE,
      options: { ...OUTBOX_QUEUE_OPTIONS, retentionSeconds: KEEP_QUEUED_SECONDS },
    },
  ];
  for (const q of queues) {
    if (await owner.getQueue(q.name)) await owner.updateQueue(q.name, q.options);
    else await owner.createQueue(q.name, q.options);
  }
}
