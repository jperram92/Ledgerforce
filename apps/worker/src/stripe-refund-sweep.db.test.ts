/**
 * The nightly sweep for Stripe refunds no document records, as jobs (T-0208 AC-2, ADR-0103,
 * RQ-0185, following ADR-0062). Real PostgreSQL; pg-boss through the outbox harness (TestClock, no
 * sleeps); Stripe is the local stub replaying the documented sweep fixture (lists only).
 *
 * SS-UC11-17:
 * - the owner installs the nightly schedule idempotently and fans out one sweep job per active
 *   tenant and UTC day (a repeat that day adds nothing; a suspended tenant gets none);
 * - the tenant job (lf_app, RLS) publishes one `ar.refund.stripe_unrecorded` event per stray
 *   document through the real outbox; the outbox worker delivers it to the read-only handler, which
 *   fails permanently, and the dead letter becomes one open Sync issue with the plain message;
 * - a second run that night adds no event and no issue; nothing is recorded and nothing is created
 *   at Stripe.
 */
import { randomUUID } from 'node:crypto';
import { createCustomerRefund, type DocumentOutbox } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import {
  assertStripeRefundable,
  STRIPE_REFUND_UNRECORDED,
  STRIPE_REFUND_UNRECORDED_HANDLER,
  StripeClient,
  stripeRefundUnrecordedHandler,
} from '@ledgerforce/connector-stripe';
import {
  loadCassette,
  REFUND_SWEEP_FIXTURE,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
} from '@ledgerforce/connector-stripe/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { enqueue, getSyncIssue, HandlerRegistry, type SyncIssue } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import type { JobResult, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';
import {
  fanOutStripeRefundSweep,
  installStripeRefundSweepSchedule,
  runTenantStripeRefundSweep,
  STRIPE_REFUND_SWEEP_CRON,
  STRIPE_REFUND_SWEEP_FANOUT_QUEUE,
  STRIPE_REFUND_SWEEP_QUEUE,
} from './stripe-refund-sweep.ts';
import { startSyncIssueWorker } from './sync-issue-worker.ts';

let f: LedgerFixture;
let h: OutboxHarness;
let stub: RecordedStripe;
let client: StripeClient;
let suspended = '';
let strayId = '';
let strayNo = '';
let cleanId = '';
const running: PgBoss[] = [];

async function runtime(): Promise<PgBoss> {
  const b = await h.startRuntime();
  running.push(b);
  return b;
}
async function stop(b: PgBoss): Promise<void> {
  await b.stop({ graceful: true, timeout: 5_000 });
  running.splice(running.indexOf(b), 1);
}

const registry = () => new HandlerRegistry().register(stripeRefundUnrecordedHandler({ client }));

/** One outbox worker pass that ends when `jobId` is settled. */
async function outboxPass(jobId: string): Promise<JobResult> {
  const w = await runtime();
  let resolve: (r: JobResult) => void = () => {};
  const settled = new Promise<JobResult>((r) => {
    resolve = r;
  });
  await startOutboxWorker({
    boss: w,
    db: h.app,
    registry: registry(),
    onResult: (j, r) => {
      if (j.id === jobId) resolve(r);
    },
  });
  const result = await settled;
  await stop(w);
  return result;
}

/** One dead-letter worker pass that ends when the dead letter of `eventId` became an issue. */
async function deadLetterPass(eventId: string): Promise<SyncIssue> {
  const w = await runtime();
  let resolve: (r: SyncIssue) => void = () => {};
  const recorded = new Promise<SyncIssue>((r) => {
    resolve = r;
  });
  await startSyncIssueWorker({
    boss: w,
    db: h.app,
    onRecorded: (issue) => {
      if (issue.eventId === eventId) resolve(issue);
    },
  });
  const issue = await recorded;
  await stop(w);
  return issue;
}

const events = async () =>
  (
    await f.admin.query<{ id: string; aggregate_id: string }>(
      `SELECT id::text, aggregate_id::text FROM app.outbox_event
        WHERE tenant_id = $1 AND topic = $2 ORDER BY created_at, id`,
      [f.tenantId, STRIPE_REFUND_UNRECORDED],
    )
  ).rows;

const issues = async () =>
  (
    await f.admin.query<{ id: string; handler: string; status: string }>(
      `SELECT id::text, handler, status FROM app.sync_issue WHERE tenant_id = $1 ORDER BY id`,
      [f.tenantId],
    )
  ).rows;

const recordedState = async () =>
  (
    await f.admin.query<{ entries: number; recorded: number }>(
      `SELECT (SELECT count(*)::int FROM app.journal_entry WHERE tenant_id = $1) AS entries,
              (SELECT count(*)::int FROM app.stripe_refund WHERE tenant_id = $1) AS recorded`,
      [f.tenantId],
    )
  ).rows[0];

async function seedDoc(prefix: string, profiles: Awaited<ReturnType<typeof seedBillingCompany>>) {
  const [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: `Job${prefix}`,
    billDate: '2026-11-01',
  });
  const credit = await seedStripePaidCredit(f, {
    professionalServicesProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: f.acct['1210'] ?? '',
  });
  const r = await f.inTenant((trx) =>
    createCustomerRefund(
      trx,
      {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: credit.partyId,
        refundDate: '2026-11-24',
        amount: '220.00',
        method: 'stripe',
      },
      { stripeCheck: assertStripeRefundable },
    ),
  );
  Object.assign(stub.vars, {
    [`${prefix}RefundId`]: r.refundId,
    [`${prefix}RefundNo`]: r.refundNo,
    [`${prefix}CreditNoteId`]: credit.creditNoteId,
    [`${prefix}CreditNoteNo`]: credit.creditNoteNo,
    [`${prefix}PaymentIntentId`]: credit.paymentIntentId,
    [`${prefix}StripeRefundId`]: `re_1SQbT0208Job${prefix}`,
  });
  return r;
}

beforeAll(async () => {
  stub = await startRecordedStripe(loadCassette(REFUND_SWEEP_FIXTURE));
  client = new StripeClient({ secretKey: 'sk_test_dummy', mode: 'test', baseUrl: stub.url });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020811');
  h = await createOutboxHarness(f.tdb);
  suspended = randomUUID();
  await f.admin.query(
    `INSERT INTO app.tenant (id, name, status) VALUES ($1, 'Gone Pty Ltd', 'suspended')`,
    [suspended],
  );
  const profiles = await seedBillingCompany(f);
  Object.assign(stub.vars, { tenantId: f.tenantId, companyId: f.companyId });
  const stray = await seedDoc('unapproved', profiles);
  strayId = stray.refundId;
  strayNo = stray.refundNo;
  cleanId = (await seedDoc('clean', profiles)).refundId;
}, 240_000);

afterAll(async () => {
  for (const b of [...running]) await b.stop({ graceful: false });
  await (h as OutboxHarness | undefined)?.close();
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-17 the nightly Stripe refund sweep runs per tenant and lands strays in Sync issues', () => {
  it('SS-UC11-17 the owner installs the nightly schedule idempotently; fan-out sends one job per active tenant and UTC day', async () => {
    await installStripeRefundSweepSchedule(h.owner);
    await installStripeRefundSweepSchedule(h.owner);
    const schedules = await h.owner.getSchedules();
    expect(schedules.filter((s) => s.name === STRIPE_REFUND_SWEEP_FANOUT_QUEUE)).toEqual([
      expect.objectContaining({ cron: STRIPE_REFUND_SWEEP_CRON, timezone: 'UTC' }),
    ]);
    expect(await h.owner.getQueue(STRIPE_REFUND_SWEEP_QUEUE)).toBeTruthy();
    const url = f.tdb.url('lf_migrator');
    const first = await fanOutStripeRefundSweep(h.owner, url, new Date('2026-11-23T15:35:00Z'));
    const again = await fanOutStripeRefundSweep(h.owner, url, new Date('2026-11-23T20:00:00Z'));
    const next = await fanOutStripeRefundSweep(h.owner, url, new Date('2026-11-24T15:35:00Z'));
    expect(first.tenants).toContain(f.tenantId);
    expect(first.tenants).not.toContain(suspended);
    expect(first.sent).toBe(first.tenants.length);
    expect(again.sent).toBe(0);
    expect(next.sent).toBe(next.tenants.length);
    const { rows } = await f.admin.query<{ tenant: string; n: number; keys: string }>(
      `SELECT data->>'tenantId' AS tenant, count(*)::int AS n,
              string_agg(DISTINCT (SELECT string_agg(k, ',') FROM jsonb_object_keys(data) k), ',') AS keys
         FROM pgboss.job WHERE name = $1 GROUP BY 1`,
      [STRIPE_REFUND_SWEEP_QUEUE],
    );
    expect(rows.find((r) => r.tenant === f.tenantId)?.n).toBe(2);
    expect(rows.map((r) => r.tenant)).not.toContain(suspended);
    // pg-boss tables have no RLS: the job carries the tenant id only.
    expect(rows.map((r) => r.keys)).toEqual(rows.map(() => 'tenantId'));
  });

  it('SS-UC11-17 the tenant job reports the stray once through the outbox; the read-only handler dead-letters it into one open Sync issue; a second run adds nothing; nothing recorded or created', async () => {
    const before = await recordedState();
    const boss = await runtime();
    const outbox: DocumentOutbox = {
      publish: async (trx, e) => {
        await enqueue(trx, boss, e);
      },
    };
    const run = await runTenantStripeRefundSweep(h.app, { client, outbox }, f.tenantId);
    // Every company of the tenant is swept; the fixture's other company has no Stripe documents.
    expect(run.companies.map((c) => c.companyId)).toContain(f.companyId);
    expect(run.companies.filter((c) => c.companyId !== f.companyId)).toEqual(
      run.companies
        .filter((c) => c.companyId !== f.companyId)
        .map((c) => ({ companyId: c.companyId, swept: 0, reported: [], failed: 0 })),
    );
    expect(run.companies.find((c) => c.companyId === f.companyId)).toEqual({
      companyId: f.companyId,
      swept: 2,
      reported: [{ refundId: strayId, finding: 'held_unapproved' }],
      failed: 0,
    });
    const evs = await events();
    expect(evs.map((e) => e.aggregate_id)).toEqual([strayId]);
    expect(evs.map((e) => e.aggregate_id)).not.toContain(cleanId);
    const eventId = evs[0]?.id ?? '';

    const r = await outboxPass(eventId);
    expect(r.status).toBe('deadletter');
    const issue = await deadLetterPass(eventId);
    expect(issue).toMatchObject({ handler: STRIPE_REFUND_UNRECORDED_HANDLER, status: 'open' });
    const stored = await f.inTenant((trx) => getSyncIssue(trx, issue.id));
    expect(stored).toMatchObject({ status: 'open', connector: 'stripe' });
    expect(JSON.stringify(stored)).toContain('HELD_AT_STRIPE');
    expect(JSON.stringify(stored)).toContain(`refund ${strayNo}, which is not approved`);

    // The next night (or a retried job): no second event, no second issue.
    const again = await runTenantStripeRefundSweep(h.app, { client, outbox }, f.tenantId);
    expect(again.companies.flatMap((c) => c.reported)).toEqual([]);
    await stop(boss);
    expect(await events()).toHaveLength(1);
    expect(await issues()).toEqual([
      { id: issue.id, handler: STRIPE_REFUND_UNRECORDED_HANDLER, status: 'open' },
    ]);
    expect(await recordedState()).toEqual(before);
    expect(stub.received.filter((x) => x.method !== 'GET')).toEqual([]);
    expect(stub.mismatches).toEqual([]);
    expect(h.errors).toEqual([]);
    await expect(
      runTenantStripeRefundSweep(h.app, { client, outbox }, 'not-a-tenant'),
    ).rejects.toThrow(/tenantId/);
  });
});
