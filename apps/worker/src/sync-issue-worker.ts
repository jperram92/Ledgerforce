/**
 * The dead-letter consumer (design §5.6 rule 2, T-0071, RQ-0044). Each job in
 * `outbox.deliver.dead` is a delivery that pg-boss gave up on — ten retries exhausted (1 min →
 * 6 h) or dead-lettered at once for a permanent error. Its data is the original
 * `{ tenantId, eventId }`; `sourceOutput` is our `{ handler, failureId }` and `sourceRetryCount`
 * the retries spent. One tenant transaction turns it into a Sync issue (idempotent per
 * dead-letter job), then pg-boss completes the dead letter. Runs as lf_app.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import {
  OUTBOX_DEAD_LETTER_QUEUE,
  parseDeliveryJob,
  recordSyncIssue,
  type DeliveryJob,
  type SyncIssue,
} from '@ledgerforce/outbox';
import type { Kysely } from 'kysely';
import type { JobWithMetadata, PgBoss } from 'pg-boss';

export interface SyncIssueWorkerOptions {
  boss: PgBoss;
  db: Kysely<Database>;
  pollingIntervalSeconds?: number;
  /** Observability hook, called after the issue committed (before the dead letter completes). */
  onRecorded?: (issue: SyncIssue) => void;
}

/** Record the Sync issue for one dead letter. */
export async function recordDeadLetter(
  db: Kysely<Database>,
  job: JobWithMetadata<DeliveryJob>,
): Promise<SyncIssue> {
  const { tenantId, eventId } = parseDeliveryJob(job.data);
  return withTenant(db, tenantId, (trx) =>
    recordSyncIssue(trx, {
      eventId,
      attempts: (job.sourceRetryCount ?? 0) + 1,
      deadLetterJobId: job.id,
      output: job.sourceOutput,
    }),
  );
}

export async function startSyncIssueWorker(opts: SyncIssueWorkerOptions): Promise<string> {
  const options = {
    batchSize: 1,
    includeMetadata: true,
    pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
  } as const;
  return opts.boss.work<DeliveryJob, undefined, typeof options>(
    OUTBOX_DEAD_LETTER_QUEUE,
    options,
    async (jobs) => {
      for (const job of jobs) {
        const issue = await recordDeadLetter(opts.db, job);
        opts.onRecorded?.(issue);
      }
    },
  );
}
