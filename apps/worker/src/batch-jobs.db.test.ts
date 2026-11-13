/**
 * Approved billing batches run in the worker, and posted invoices are emailed by it (T-0120,
 * UC-01/UC-02, SS-UC02-09). Runs against a real PostgreSQL, a real pg-boss runtime and the real
 * outbox delivery, as lf_app.
 * - Approving a batch writes `ar.batch.approved` into the outbox in the same transaction.
 * - Its handler enqueues one `ar.batch.run` job per batch; a second delivery adds none.
 * - The job posts every item. A re-run posts nothing more.
 * - Each `ar.invoice.posted` event delivers one email through invoiceEmailHandler. Redelivery
 *   sends nothing more.
 * - All job queues are installed at deploy time, so the worker never consumes a missing queue.
 */
import { approveBatch, BATCH_APPROVED, previewBatch, type DocumentOutbox } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { PdfRenderer } from '@ledgerforce/documents';
import { invoiceEmailHandler, type EmailMessage } from '@ledgerforce/email';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { deliver, enqueue, HandlerRegistry, type DeliveryJob } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchApprovedHandler, BATCH_RUN_QUEUE, parseBatchJob, runBatchJob } from './batch-jobs.ts';
import { AR_REMINDERS_QUEUE, DAILY_FANOUT_QUEUE } from './daily-jobs.ts';
import { installQueue } from './queue-admin.ts';

let f: LedgerFixture;
let h: OutboxHarness;
let boss: PgBoss;
let outbox: DocumentOutbox;
let batchId = '';
const renderer = new PdfRenderer();
const sent: EmailMessage[] = [];

const eventsOf = async (topic: string) =>
  (
    await f.admin.query<{ id: string }>(
      `SELECT id::text FROM app.outbox_event WHERE tenant_id = $1 AND topic = $2 ORDER BY id`,
      [f.tenantId, topic],
    )
  ).rows.map((r) => r.id);
const jobsIn = async (queue: string) =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1`,
      [queue],
    )
  ).rows[0]?.n ?? 0;
const job = (eventId: string): DeliveryJob => ({ tenantId: f.tenantId, eventId });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012001');
  await installQueue(f.tdb.url('lf_migrator'));
  h = await createOutboxHarness(f.tdb);
  boss = await h.startRuntime();
  outbox = {
    publish: async (trx, e) => {
      await enqueue(trx, boss, {
        companyId: e.companyId,
        topic: e.topic,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload,
      });
    },
  };
  await f.inTenant((trx) =>
    trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd', abn: '51824753556' })
      .where('id', '=', f.companyId)
      .execute(),
  );
  const profiles = await seedBillingCompany(f);
  await seedBillableCustomers(f, profiles, { count: 3, prefix: 'Run', billDate: '2026-11-01' });
  const approver = await f.addUser('approver');
  batchId = (
    await f.inTenant((trx) =>
      previewBatch(trx, {
        companyId: f.companyId,
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        idempotencyKey: 'run-nov',
      }),
    )
  ).batchId;
  await f.inTenant((trx) =>
    approveBatch(trx, { companyId: f.companyId, batchId, approvedBy: approver }, { outbox }),
  );
}, 240_000);

afterAll(async () => {
  await renderer.close();
  await (h as OutboxHarness | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0120: job queues exist before any worker consumes them', () => {
  it('installQueue (deploy, lf_migrator) installs the batch, reminder and fan-out queues', async () => {
    const { rows } = await f.admin.query<{ name: string }>(
      'SELECT name FROM pgboss.queue WHERE name = ANY($1) ORDER BY name',
      [[BATCH_RUN_QUEUE, AR_REMINDERS_QUEUE, DAILY_FANOUT_QUEUE]],
    );
    expect(rows.map((r) => r.name)).toEqual(
      [AR_REMINDERS_QUEUE, BATCH_RUN_QUEUE, DAILY_FANOUT_QUEUE].sort(),
    );
  });
});

describe('SS-UC02-09: an approved batch is posted and emailed by the worker', () => {
  it('approving writes ar.batch.approved in the same transaction', async () => {
    expect(await eventsOf(BATCH_APPROVED)).toHaveLength(1);
  });

  it('the handler enqueues one batch job; delivering again adds none', async () => {
    const [eventId = ''] = await eventsOf(BATCH_APPROVED);
    const registry = new HandlerRegistry().register(batchApprovedHandler({ boss }));
    await deliver(h.app, registry, job(eventId));
    await deliver(h.app, registry, job(eventId));
    // A second handler instance (e.g. a duplicate event) still yields one job per batch.
    await h.app.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`.execute(trx);
      await batchApprovedHandler({ boss }).handle(trx, {
        id: eventId,
        tenantId: f.tenantId,
        companyId: f.companyId,
        topic: BATCH_APPROVED,
        aggregateType: 'billing_batch',
        aggregateId: batchId,
        payload: { batchId },
        createdAt: new Date(),
      });
    });
    expect(await jobsIn(BATCH_RUN_QUEUE)).toBe(1);
  });

  it('SS-UC02-09 the batch job posts every item; a re-run posts nothing more', async () => {
    const data = parseBatchJob({ tenantId: f.tenantId, companyId: f.companyId, batchId });
    const first = await runBatchJob(h.app, { outbox }, data);
    expect(first).toMatchObject({ posted: 3, failed: 0, remaining: 0, status: 'posted' });
    const again = await runBatchJob(h.app, { outbox }, data);
    expect(again).toMatchObject({ posted: 0, remaining: 0, status: 'posted' });
    expect(await eventsOf('ar.invoice.posted')).toHaveLength(3);
  });

  it('SS-UC02-09 each posted invoice is emailed once by the worker handler; redelivery sends nothing', async () => {
    const registry = new HandlerRegistry().register(
      invoiceEmailHandler({
        sender: {
          send: async (m) => {
            sent.push(m);
            return `<${String(sent.length)}@test>`;
          },
        },
        renderer,
      }),
    );
    const posted = await eventsOf('ar.invoice.posted');
    for (const id of posted) await deliver(h.app, registry, job(id));
    expect(sent).toHaveLength(3);
    for (const id of posted) await deliver(h.app, registry, job(id));
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.attachments?.[0]?.filename.endsWith('.pdf'))).toBe(true);
  }, 120_000);

  it('job data must name tenant, company and batch', () => {
    expect(() => parseBatchJob({ tenantId: f.tenantId, companyId: f.companyId })).toThrow();
    expect(() => parseBatchJob(null)).toThrow();
  });
});
