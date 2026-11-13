/**
 * Approved billing batches run in the worker (T-0120, UC-02 steps 4–5).
 * - Approval writes `ar.batch.approved` into the outbox with the approval itself (approveBatch).
 * - `batchApprovedHandler` is that event's outbox handler. Its one effect is one
 *   `ar.batch.run` job per batch, with a job id derived from the batch, so a redelivery or a
 *   duplicate event enqueues nothing more.
 * - `runBatchJob` runs `runBatch` (T-0044) for the job. Every item is posted in its own tenant
 *   transaction, and posted items are skipped, so a retry after a crash continues without
 *   duplicates. The posted invoices' `ar.invoice.posted` events go through the outbox to
 *   `email.invoice_posted` (T-0042), which sends each invoice once.
 */
import { createHash } from 'node:crypto';
import {
  BATCH_APPROVED,
  runBatch,
  type BatchRunResult,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import type { OutboxHandler } from '@ledgerforce/outbox';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';

export const BATCH_RUN_QUEUE = 'ar.batch.run';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BatchJob {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
}

export function parseBatchJob(data: unknown): BatchJob {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ['tenantId', 'companyId', 'batchId'] as const) {
    const v = d[k];
    if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`batch job has no valid ${k}`);
    out[k] = v.toLowerCase();
  }
  return out as unknown as BatchJob;
}

/** A UUID derived from the batch: the same batch always gives the same job id. */
function jobIdFor(batchId: string): string {
  const h = createHash('sha256').update(`${BATCH_RUN_QUEUE}|${batchId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Outbox handler for `ar.batch.approved`: enqueue the batch job (once per batch). */
export function batchApprovedHandler(deps: { boss: PgBoss }): OutboxHandler {
  return {
    name: 'ar.batch_run',
    topics: [BATCH_APPROVED],
    async handle(_trx, event): Promise<void> {
      const job = parseBatchJob({
        tenantId: event.tenantId,
        companyId: event.companyId,
        batchId: event.aggregateId,
      });
      // send() answers null when a job with this id already exists: nothing more to do.
      await deps.boss.send(BATCH_RUN_QUEUE, { ...job }, { id: jobIdFor(job.batchId) });
    },
  };
}

/** Run one approved batch (lf_app). Safe to repeat: posted items are skipped. */
export function runBatchJob(
  db: Kysely<Database>,
  deps: { outbox: DocumentOutbox },
  job: BatchJob,
): Promise<BatchRunResult> {
  return runBatch(db, job.tenantId, { companyId: job.companyId, batchId: job.batchId }, deps);
}

/** Worker (lf_app): consume `ar.batch.run`, one batch per job. */
export async function startBatchWorker(opts: {
  boss: PgBoss;
  db: Kysely<Database>;
  outbox: DocumentOutbox;
}): Promise<string> {
  return opts.boss.work(BATCH_RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const j of jobs)
      await runBatchJob(opts.db, { outbox: opts.outbox }, parseBatchJob(j.data));
  });
}
