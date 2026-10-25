/**
 * The outbox consumer (ADR-0008 rule 2, apps/worker AGENTS.md). Runs on a runtime (lf_app)
 * pg-boss instance: each job is delivered with `deliver` (per-handler inbox, effect once) and
 * then completed by pg-boss. A throw fails the attempt; pg-boss retries with backoff (1 min to
 * 6 h) and finally moves the job to the dead-letter queue. A worker that dies holding a job
 * loses it for `expireInSeconds`; the owner's supervise pass then puts it back.
 */
import type { Database } from '@ledgerforce/db';
import {
  deliver,
  OUTBOX_QUEUE,
  parseDeliveryJob,
  type DeliveryJob,
  type DeliveryResult,
  type HandlerRegistry,
} from '@ledgerforce/outbox';
import type { Kysely } from 'kysely';
import type { Job, PgBoss } from 'pg-boss';

export interface OutboxWorkerOptions {
  boss: PgBoss;
  /** Kysely as lf_app; every delivery runs in withTenant transactions. */
  db: Kysely<Database>;
  registry: HandlerRegistry;
  /** Seconds between polls when the queue is empty (pg-boss default 2). */
  pollingIntervalSeconds?: number;
  /** Observability hook, called after a delivery's effects committed (before completion). */
  onDelivered?: (job: Job<DeliveryJob>, result: DeliveryResult) => void;
}

/** Start consuming the outbox queue; returns the pg-boss worker id (for `offWork`). */
export async function startOutboxWorker(opts: OutboxWorkerOptions): Promise<string> {
  return opts.boss.work<DeliveryJob>(
    OUTBOX_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await deliver(opts.db, opts.registry, parseDeliveryJob(job.data));
        opts.onDelivered?.(job, result);
      }
    },
  );
}
