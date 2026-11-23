/**
 * The nightly sweep for Stripe refunds that no refund document records (T-0208, ADR-0103,
 * RQ-0185), following the daily fan-out of ADR-0062.
 *
 * Owner side, as lf_migrator, in the scheduler:
 * - `installStripeRefundSweepSchedule` stores the nightly schedule (UTC) and creates the queues.
 * - `fanOutStripeRefundSweep` sends one `stripe.refunds.sweep` job per active tenant and UTC day;
 *   the job id is derived from queue, tenant and day, so a second fan-out that day adds nothing.
 *
 * Application side, as lf_app, in the worker (only when Stripe is configured):
 * - `runTenantStripeRefundSweep` lists each company's candidates in one tenant transaction, then
 *   sweeps each document in its own tenant transaction (`sweepStripeRefund`: party lock, read-only
 *   lookup, one `ar.refund.stripe_unrecorded` event per stray document). It records nothing and
 *   creates nothing at Stripe. The event's read-only handler turns it into a Sync issue.
 *   A document whose lookup fails (Stripe unreachable) does not stop the others; the job then
 *   fails so pg-boss retries it, and the retry is idempotent (open reports are not repeated).
 *
 * STRIPE_REFUND_SWEEP_CRON (15:35 UTC) is 01:35 or 02:35 in Sydney, after the daily reminders.
 */
import type { DocumentOutbox } from '@ledgerforce/ar';
import {
  stripeRefundSweepCandidates,
  sweepStripeRefund,
  type StripeClient,
  type UnrecordedFinding,
} from '@ledgerforce/connector-stripe';
import { withTenant, type Database } from '@ledgerforce/db';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { activeTenantIds, jobId, parseTenantJob } from './daily-jobs.ts';

export const STRIPE_REFUND_SWEEP_FANOUT_QUEUE = 'stripe.refunds.sweep.fanout';
export const STRIPE_REFUND_SWEEP_QUEUE = 'stripe.refunds.sweep';
export const STRIPE_REFUND_SWEEP_CRON = '35 15 * * *';

/** Owner instance only (lf_migrator): the queues and the nightly schedule. Idempotent. */
export async function installStripeRefundSweepSchedule(owner: PgBoss): Promise<void> {
  for (const name of [STRIPE_REFUND_SWEEP_FANOUT_QUEUE, STRIPE_REFUND_SWEEP_QUEUE]) {
    if (!(await owner.getQueue(name))) {
      await owner.createQueue(name, { retryLimit: 3, retryDelay: 600, retryBackoff: true });
    }
  }
  await owner.schedule(
    STRIPE_REFUND_SWEEP_FANOUT_QUEUE,
    STRIPE_REFUND_SWEEP_CRON,
    {},
    { tz: 'UTC' },
  );
}

/** Owner instance only: one sweep job per active tenant for the UTC day of `now`. */
export async function fanOutStripeRefundSweep(
  owner: PgBoss,
  ownerUrl: string,
  now: Date,
): Promise<{ tenants: string[]; sent: number }> {
  const tenants = await activeTenantIds(ownerUrl);
  const day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const tenantId of tenants) {
    const id = await owner.send(
      STRIPE_REFUND_SWEEP_QUEUE,
      { tenantId },
      { id: jobId(STRIPE_REFUND_SWEEP_QUEUE, tenantId, day) },
    );
    if (id) sent += 1;
  }
  return { tenants, sent };
}

export interface TenantStripeRefundSweep {
  readonly companies: {
    companyId: string;
    swept: number;
    reported: { refundId: string; finding: UnrecordedFinding }[];
    failed: number;
  }[];
}

/** Worker (lf_app): sweep every company of one tenant; one tenant transaction per document. */
export async function runTenantStripeRefundSweep(
  db: Kysely<Database>,
  deps: { client: StripeClient; outbox: DocumentOutbox },
  tenant: unknown,
): Promise<TenantStripeRefundSweep> {
  const { tenantId } = parseTenantJob({ tenantId: tenant });
  const plan = await withTenant(db, tenantId, async (trx) => {
    const companies = await trx.selectFrom('app.company').select('id').orderBy('id').execute();
    const out: { companyId: string; ids: string[] }[] = [];
    for (const c of companies) {
      out.push({ companyId: c.id, ids: await stripeRefundSweepCandidates(trx, c.id) });
    }
    return out;
  });
  const companies: TenantStripeRefundSweep['companies'] = [];
  const errors: unknown[] = [];
  for (const p of plan) {
    const reported: { refundId: string; finding: UnrecordedFinding }[] = [];
    let failed = 0;
    for (const refundId of p.ids) {
      try {
        const r = await withTenant(db, tenantId, (trx) =>
          sweepStripeRefund(trx, deps.client, deps.outbox, { companyId: p.companyId, refundId }),
        );
        if (r.published && r.finding) reported.push({ refundId, finding: r.finding });
      } catch (error) {
        failed += 1;
        errors.push(error);
      }
    }
    companies.push({ companyId: p.companyId, swept: p.ids.length, reported, failed });
  }
  if (errors.length > 0) {
    throw new Error(
      `stripe refund sweep: ${String(errors.length)} document(s) could not be checked with Stripe; the job is retried`,
    );
  }
  return { companies };
}

/** Worker (lf_app): consume `stripe.refunds.sweep`, one tenant per job. */
export async function startStripeRefundSweepWorker(opts: {
  boss: PgBoss;
  db: Kysely<Database>;
  client: StripeClient;
  outbox: DocumentOutbox;
}): Promise<string> {
  return opts.boss.work(STRIPE_REFUND_SWEEP_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { tenantId } = parseTenantJob(job.data);
      await runTenantStripeRefundSweep(opts.db, opts, tenantId);
    }
  });
}

/** Owner instance: consume `stripe.refunds.sweep.fanout` (the schedule's job) by fanning out. */
export async function startStripeRefundSweepFanOutWorker(
  owner: PgBoss,
  ownerUrl: string,
): Promise<string> {
  return owner.work(STRIPE_REFUND_SWEEP_FANOUT_QUEUE, { batchSize: 1 }, async () => {
    await fanOutStripeRefundSweep(owner, ownerUrl, new Date());
  });
}
