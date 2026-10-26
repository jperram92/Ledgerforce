/**
 * The outbox consumer (ADR-0008 rule 2, apps/worker AGENTS.md, T-0071). Runs on a runtime
 * (lf_app) pg-boss instance and settles each job itself (`perJobResults`, RQ-0044):
 *  - delivered → `completed`;
 *  - a retryable failure → `failed`: pg-boss retries with backoff (1 min to 6 h) and, after the
 *    tenth retry, moves the job to the dead-letter queue;
 *  - a permanent failure (`retryable === false`) → `deadletter` at once, no retries.
 * Each failed attempt is logged in app.outbox_delivery_failure (tenant transaction, after the
 * attempt rolled back); the job output is only `{ handler, failureId }` (no tenant data in
 * pg-boss). The dead-letter worker (sync-issue-worker.ts) turns dead letters into Sync issues.
 * A worker that dies holding a job loses it for `expireInSeconds`; the owner's supervise pass
 * then puts it back.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import {
  deliver,
  describeFailure,
  OUTBOX_QUEUE,
  parseDeliveryJob,
  recordDeliveryFailure,
  type DeliveryJob,
  type DeliveryResult,
  type FailureOutput,
  type HandlerRegistry,
} from '@ledgerforce/outbox';
import type { Kysely } from 'kysely';
import type { Job, JobResult, PgBoss } from 'pg-boss';

export interface OutboxWorkerOptions {
  boss: PgBoss;
  /** Kysely as lf_app; every delivery runs in withTenant transactions. */
  db: Kysely<Database>;
  registry: HandlerRegistry;
  /** Seconds between polls when the queue is empty (pg-boss default 2). */
  pollingIntervalSeconds?: number;
  /** Observability hook, called after a delivery's effects committed (before completion). */
  onDelivered?: (job: Job<DeliveryJob>, result: DeliveryResult) => void;
  /** Observability hook: the disposition handed to pg-boss for each job (before settlement). */
  onResult?: (job: Job<DeliveryJob>, result: JobResult) => void;
}

/** Deliver one job and decide its disposition; never throws for a delivery error. */
export async function processDelivery(
  db: Kysely<Database>,
  registry: HandlerRegistry,
  job: Job<DeliveryJob>,
  onDelivered?: OutboxWorkerOptions['onDelivered'],
): Promise<JobResult> {
  let failedHandler: string | null = null;
  try {
    const data = parseDeliveryJob(job.data);
    const result = await deliver(db, registry, data, {
      onHandlerError: (handler) => {
        failedHandler = handler;
      },
    });
    onDelivered?.(job, result);
    return { id: job.id, status: 'completed' };
  } catch (error) {
    const failure = describeFailure(error);
    if (failedHandler === null) {
      // Not a handler's error (malformed job, event not found, database down): let pg-boss retry.
      return { id: job.id, status: 'failed', output: { error: failure.errorName } };
    }
    const handler: string = failedHandler;
    const data = parseDeliveryJob(job.data);
    const failureId = await withTenant(db, data.tenantId, (trx) =>
      recordDeliveryFailure(trx, {
        eventId: data.eventId,
        handler,
        attempt: job.retryCount + 1,
        failure,
      }),
    );
    const output: FailureOutput = { handler, failureId };
    return { id: job.id, status: failure.retryable ? 'failed' : 'deadletter', output };
  }
}

/** Start consuming the outbox queue; returns the pg-boss worker id (for `offWork`). */
export async function startOutboxWorker(opts: OutboxWorkerOptions): Promise<string> {
  const options = {
    batchSize: 1,
    pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
    perJobResults: true,
  } as const;
  return opts.boss.work<DeliveryJob, JobResult[], typeof options>(
    OUTBOX_QUEUE,
    options,
    async (jobs) => {
      const results: JobResult[] = [];
      for (const job of jobs) {
        const r = await processDelivery(opts.db, opts.registry, job, opts.onDelivered);
        opts.onResult?.(job, r);
        results.push(r);
      }
      return results;
    },
  );
}
