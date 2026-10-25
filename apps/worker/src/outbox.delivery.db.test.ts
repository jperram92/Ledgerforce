/**
 * SS-PLAT-24 — the outbox delivers at least once and handlers are idempotent (T-0030, ADR-0008,
 * RQ-0033). Real PostgreSQL; the worker runs as lf_app; pg-boss maintenance runs as lf_migrator.
 *
 * Scenario: a posted entry (a raw manual journal: no event posting rule exists while every golden
 * posting is Draft, so the "posted invoice" of the card is represented generically) produces one
 * outbox event. Worker 1
 * fetches the delivery job and its handler commits its effect, then the worker crashes before it
 * acknowledges the job. After the job's expiry (pg-boss TestClock, no sleeping) the owner's
 * supervise pass puts it back; worker 2 starts, the same job is redelivered, the inbox recognises
 * the event, the effect is not applied again, and the job completes.
 */
import { withTenant } from '@ledgerforce/db';
import { post, type PostingCommand } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import {
  deliver,
  HandlerRegistry,
  ledgerOutbox,
  OUTBOX_QUEUE,
  OUTBOX_QUEUE_OPTIONS,
  type DeliveryJob,
  type DeliveryResult,
  type OutboxEvent,
} from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Job } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';

let f: LedgerFixture;
let h: OutboxHarness;
const seen: OutboxEvent[] = [];
let failNext = false;

const registry = () =>
  new HandlerRegistry().register({
    name: 'test.effect',
    topics: ['ledger.entry.posted'],
    async handle(trx, event) {
      seen.push(event);
      await sql`INSERT INTO lf_test.effect (event_id, handler) VALUES (${event.id}, 'test.effect')`.execute(
        trx,
      );
      if (failNext) {
        failNext = false;
        throw new Error('downstream unavailable');
      }
    },
  });

const rent = (): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines: [
    { account: { id: f.acct['6200'] ?? '' }, debit: '1000.0000', memo: 'Rent October' },
    { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
  ],
});

const effects = async (eventId: string) =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM lf_test.effect WHERE event_id = $1',
      [eventId],
    )
  ).rows[0]?.n;

const inbox = async (eventId: string) =>
  (
    await f.admin.query<{ handler: string }>(
      'SELECT handler FROM app.outbox_inbox WHERE event_id = $1',
      [eventId],
    )
  ).rows.map((r) => r.handler);

async function postedEvent(): Promise<string> {
  const boss = await h.startRuntime();
  const r = await withTenant(h.app, f.tenantId, (trx) =>
    post(trx, rent(), { outbox: ledgerOutbox(boss) }),
  );
  const { rows } = await f.admin.query<{ id: string }>(
    'SELECT id FROM app.outbox_event WHERE aggregate_id = $1',
    [r.entryId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.id ?? '';
}

/** Let the job's lease lapse and run the owner's maintenance pass (the crashed worker's job). */
async function expireAndSupervise() {
  await h.clock.tick((OUTBOX_QUEUE_OPTIONS.expireInSeconds + 1) * 1000);
  await h.owner.supervise(OUTBOX_QUEUE);
}

/** An expired job is a failed attempt: it waits out the first backoff step (60-120 s). */
async function waitOutBackoff() {
  await h.clock.tick((OUTBOX_QUEUE_OPTIONS.retryDelay * 2 + 1) * 1000);
}

/** Start a worker process; resolve with the first delivery it reports. */
async function workerDelivers() {
  const boss = await h.startRuntime();
  let resolve: (v: { job: Job<DeliveryJob>; result: DeliveryResult }) => void = () => {};
  const first = new Promise<{ job: Job<DeliveryJob>; result: DeliveryResult }>((r) => {
    resolve = r;
  });
  await startOutboxWorker({
    boss,
    db: h.app,
    registry: registry(),
    onDelivered: (job, result) => resolve({ job, result }),
  });
  await h.clock.tick(5_000);
  const delivered = await first;
  await boss.stop({ graceful: true, timeout: 5_000 });
  return delivered;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003002');
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute(),
  );
  // A downstream system the handler writes to (test-only; no unique key, so a duplicate shows).
  await f.admin.query(`CREATE SCHEMA lf_test;
    CREATE TABLE lf_test.effect (event_id uuid NOT NULL, handler text NOT NULL);
    GRANT USAGE ON SCHEMA lf_test TO lf_app;
    GRANT SELECT, INSERT ON lf_test.effect TO lf_app;`);
  h = await createOutboxHarness(f.tdb);
});

afterAll(async () => {
  await h?.close();
  await f?.close();
});

describe('SS-PLAT-24 outbox delivery', () => {
  it('SS-PLAT-24: Outbox delivers at least once, handlers idempotent', async () => {
    const eventId = await postedEvent();

    // Worker 1 takes the job and its handler commits the effect ("send")...
    const w1 = await h.startRuntime();
    const [job] = await w1.fetch<DeliveryJob>(OUTBOX_QUEUE);
    expect(job?.id).toBe(eventId);
    expect(await deliver(h.app, registry(), job?.data as DeliveryJob)).toEqual({
      handled: ['test.effect'],
      skipped: [],
    });
    expect(await effects(eventId)).toBe(1);
    // ...then crashes before acknowledging: the job is still active, held by nobody.
    await w1.stop({ graceful: false });
    expect((await h.owner.getJobById(OUTBOX_QUEUE, eventId))?.state).toBe('active');

    // The worker restarts; after the lease expires the job is redelivered.
    await expireAndSupervise();
    expect((await h.owner.getJobById(OUTBOX_QUEUE, eventId))?.state).toBe('retry');
    await waitOutBackoff();
    const { job: again, result } = await workerDelivers();
    expect(again.id).toBe(eventId);
    expect(again.retryCount).toBe(1);
    expect(result).toEqual({ handled: [], skipped: ['test.effect'] });

    // The effect happened exactly once and the job is settled.
    expect(await effects(eventId)).toBe(1);
    expect(await inbox(eventId)).toEqual(['test.effect']);
    expect((await h.owner.getJobById(OUTBOX_QUEUE, eventId))?.state).toBe('completed');
    expect(seen.filter((e) => e.id === eventId)).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ tenantId: f.tenantId, topic: 'ledger.entry.posted' });
  });

  it('SS-PLAT-24 a handler that fails leaves no effect and no inbox row; the retry applies it once', async () => {
    const eventId = await postedEvent();
    failNext = true;
    const w = await h.startRuntime();
    const [job] = await w.fetch<DeliveryJob>(OUTBOX_QUEUE);
    expect(job?.id).toBe(eventId);
    const err = await deliver(h.app, registry(), job?.data as DeliveryJob).catch((e: unknown) => e);
    expect(String(err)).toMatch(/downstream unavailable/);
    expect(await effects(eventId)).toBe(0);
    expect(await inbox(eventId)).toEqual([]);
    await w.fail(OUTBOX_QUEUE, job?.id ?? '');

    // Backoff: the retry is not due at once (first retry 60-120 s with jitter).
    expect((await h.owner.getJobById(OUTBOX_QUEUE, eventId))?.state).toBe('retry');
    expect(await w.fetch(OUTBOX_QUEUE)).toEqual([]);
    await w.stop({ graceful: false });
    await waitOutBackoff();
    const { job: again, result } = await workerDelivers();
    expect(again.id).toBe(eventId);
    expect(result).toEqual({ handled: ['test.effect'], skipped: [] });
    expect(await effects(eventId)).toBe(1);
  });

  it('SS-PLAT-24 a job for another tenant cannot read the event (RLS)', async () => {
    const eventId = await postedEvent();
    const forged: DeliveryJob = { tenantId: '01900000-0000-7000-8000-00000000dead', eventId };
    await expect(deliver(h.app, registry(), forged)).rejects.toThrow(/not found/);
    expect(await effects(eventId)).toBe(0);
  });

  it('SS-PLAT-24 no pg-boss instance reported an error', () => {
    expect(h.errors).toEqual([]);
  });
});
