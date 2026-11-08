/**
 * Sync issues inbox (T-0071, design §5.6 rules 2–3, RQ-0044). Real PostgreSQL; the workers run as
 * lf_app on runtime pg-boss instances; pg-boss time moves only through the harness's TestClock,
 * by `setTime` jumps to each retry's own `startAfter` (no timer storm, no sleeps — DL-0205).
 * Salesforce is the local fake REST server and fake token endpoint (T-0063, T-0067); no org.
 *
 * SS-PLAT-25 — a write-back failing on every attempt backs off 1 min → 6 h (ten retries, each
 *   inside the pg-boss bounds of RQ-0044), dead-letters, and lands in the inbox with its error,
 *   attempts and payload; one-click retry re-queues it and a good delivery resolves it.
 * SS-PLAT-91 — a permanent failure (Salesforce 400) skips the retries and lands at once; it can
 *   be ignored, and retried from ignored. The pg-boss job carries no tenant data.
 * SS-PLAT-92 — the write-back throttles at the company connection's configured share of the
 *   daily API allocation (data, default 25 %); a throttled delivery stays queued, no issue.
 *
 * Independence: each test has its own events, Account and Opportunity, and asserts only on the
 * fake's requests for those records; every job a test leaves pending is cancelled and every
 * worker it starts is stopped in afterEach.
 */
import {
  createJwtConnection,
  getApiBudgetShare,
  salesforceWriteBackHandler,
  setApiBudgetShare,
  SalesforceApiError,
} from '@ledgerforce/connector-salesforce';
import {
  generateTestKeyPair,
  selfSignedCertificate,
  startFakeSalesforceRest,
  startFakeTokenEndpoint,
  type FakeSalesforceRest,
  type FakeTokenEndpoint,
} from '@ledgerforce/connector-salesforce/testing';
import { withTenant, type Database } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import {
  bossRequeue,
  deliver,
  enqueue,
  getSyncIssue,
  HandlerRegistry,
  ignoreSyncIssue,
  OUTBOX_DEAD_LETTER_QUEUE,
  OUTBOX_QUEUE,
  OUTBOX_QUEUE_OPTIONS,
  recordSyncIssue,
  retryBounds,
  retrySyncIssue,
  type DeliveryJob,
  type SyncIssue,
} from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { JobResult, PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';
import { startSyncIssueWorker } from './sync-issue-worker.ts';

const T = '01900000-0000-7000-8000-000000007101';
const AUD = 'https://test.salesforce.com';
const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const KEY = '3MVG9TEST.consumer.key';
const USER = 'integration@harbour.example';
const DAY = 86_400_000;
const HANDLER = 'salesforce.writeback';

let f: LedgerFixture;
let h: OutboxHarness;
let tokens: FakeTokenEndpoint;
let rest: FakeSalesforceRest;
let connectionId: string;
let accountant: string;
const running: PgBoss[] = [];
/** Jobs a test created; anything not settled is cancelled afterwards. */
const created: string[] = [];
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

const registry = () =>
  new HandlerRegistry().register(
    salesforceWriteBackHandler({ kms, tokenHttp: tokens.http, http: rest.http }),
  );

const sfId = (prefix: '001' | '006') =>
  `${prefix}TEST${randomBytes(8).toString('hex').slice(0, 11).toUpperCase()}`;

interface Invoice {
  eventId: string;
  invoiceId: string;
  account: string;
  opportunity: string;
  payload: Record<string, unknown>;
}

/** Enqueue an `invoice.posted` write-back event (the invoice module's job, T-0040+). */
async function invoiceEvent(): Promise<Invoice> {
  const boss = await runtime();
  const ref = { invoiceId: randomUUID(), account: sfId('001'), opportunity: sfId('006') };
  rest.seed('Account', ref.account, { LF_Balance_Due__c: '0.00' });
  rest.seed('Opportunity', ref.opportunity);
  const payload = {
    writeBack: {
      version: 1,
      invoices: [
        {
          id: ref.invoiceId,
          number: 'INV-000777',
          status: 'posted',
          issueDate: '2026-10-27',
          dueDate: '2026-11-26',
          total: '550.0000',
          amountDue: '550.0000',
          accountSfId: ref.account,
          opportunitySfId: ref.opportunity,
        },
      ],
      opportunities: [
        { sfId: ref.opportunity, invoiceStatus: 'posted', amountInvoiced: '550.0000' },
      ],
      accounts: [{ sfId: ref.account, balanceDue: '550.0000' }],
    },
  };
  const eventId = await withTenant(h.app, f.tenantId, (trx) =>
    enqueue(trx, boss, {
      companyId: f.companyId,
      topic: 'invoice.posted',
      aggregateType: 'sales_invoice',
      aggregateId: ref.invoiceId,
      payload,
    }),
  );
  created.push(eventId);
  return { eventId, payload, ...ref };
}

const requestsFor = (i: Invoice) =>
  rest.requests.filter((r) => r.rawBody.includes(i.invoiceId) || r.rawBody.includes(i.opportunity));

async function runtime(): Promise<PgBoss> {
  const b = await h.startRuntime();
  running.push(b);
  return b;
}

async function stop(b: PgBoss): Promise<void> {
  await b.stop({ graceful: true, timeout: 5_000 });
  running.splice(running.indexOf(b), 1);
}

const job = (id: string) => h.owner.getJobById<DeliveryJob>(OUTBOX_QUEUE, id);

/** One outbox worker pass that ends when `jobId` is settled; returns the worker's disposition. */
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
  await stop(w); // a graceful stop waits for pg-boss to settle the job
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

/** Jump the clock to this job's retry time (its own backoff) without firing any timer. */
async function untilRetryDue(id: string): Promise<number> {
  const j = await job(id);
  const wait = (j?.startAfter.getTime() ?? 0) - h.clock.now();
  await h.clock.setTime(h.clock.now() + wait + 1_000);
  return wait;
}

const deadLetters = async (eventId: string) =>
  (await h.owner.findJobs<DeliveryJob>(OUTBOX_DEAD_LETTER_QUEUE, { data: { eventId } })).map(
    (j) => ({
      id: j.id,
      state: j.state,
      sourceId: j.sourceId,
      sourceRetryCount: j.sourceRetryCount,
      sourceOutput: j.sourceOutput,
      data: j.data,
    }),
  );

const failures = async (eventId: string) =>
  (
    await f.admin.query<{ attempt: number; error_kind: string | null; http_status: number | null }>(
      `SELECT attempt, error_kind, http_status FROM app.outbox_delivery_failure
        WHERE event_id = $1 ORDER BY attempt`,
      [eventId],
    )
  ).rows;

/**
 * A tenant transaction on the harness's lf_app pool, whose sessions read the pg-boss test clock:
 * jobs sent in it are stamped with the simulated time the workers poll with.
 */
const inApp = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
  withTenant(h.app, f.tenantId, fn);

const issueOf = (id: string) => f.inTenant((trx) => getSyncIssue(trx, id));

beforeAll(async () => {
  f = await createLedgerFixture(T);
  h = await createOutboxHarness(f.tdb);
  accountant = await f.addUser('accountant');
  const keys = generateTestKeyPair();
  const now = Date.now();
  const cert = selfSignedCertificate(keys, new Date(now - DAY), new Date(now + 365 * DAY));
  tokens = await startFakeTokenEndpoint({
    certificatePem: cert,
    consumerKey: KEY,
    audience: AUD,
    users: { [USER]: { preauthorized: true } },
  });
  rest = await startFakeSalesforceRest({
    instanceUrl: INSTANCE,
    acceptToken: (t) => tokens.issued.includes(t),
  });
  connectionId = await f.inTenant((trx) =>
    createJwtConnection(trx, kms, f.companyId, {
      loginUrl: AUD,
      username: USER,
      consumerKey: KEY,
      privateKeyPem: keys.privateKeyPem,
      certificatePem: cert,
    }),
  );
});

beforeEach(() => {
  rest.outage = null;
  rest.apiUsage = { used: 0, max: 100_000 };
});

afterEach(async () => {
  for (const b of running.splice(0)) await b.stop({ graceful: false });
  for (const id of created.splice(0)) {
    const j = await job(id);
    if (j && (j.state === 'created' || j.state === 'retry')) {
      await h.owner.cancel(OUTBOX_QUEUE, id);
    }
  }
  for (const j of await h.owner.findJobs(OUTBOX_DEAD_LETTER_QUEUE, { queued: true })) {
    await h.owner.cancel(OUTBOX_DEAD_LETTER_QUEUE, j.id);
  }
});

afterAll(async () => {
  await h?.close();
  await rest?.close();
  await tokens?.close();
  await f?.close();
});

describe('SS-PLAT-25 Sync issues inbox', () => {
  it('SS-PLAT-25: Sync failures back off then land in the Sync issues inbox', async () => {
    rest.outage = {
      status: 503,
      body: [{ message: 'Server unavailable', errorCode: 'SERVER_UNAVAILABLE' }],
    };
    const inv = await invoiceEvent();

    // Eleven attempts: each retryable failure backs off within pg-boss's bounds (RQ-0044).
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt++) {
      const r = await outboxPass(inv.eventId);
      expect(r.status, `attempt ${String(attempt)}`).toBe('failed');
      const j = await job(inv.eventId);
      if (attempt <= OUTBOX_QUEUE_OPTIONS.retryLimit) {
        expect(j?.state).toBe('retry');
        const wait = await untilRetryDue(inv.eventId);
        const b = retryBounds(OUTBOX_QUEUE_OPTIONS, attempt - 1);
        expect(wait).toBeGreaterThanOrEqual(b.minSeconds * 1000);
        expect(wait).toBeLessThanOrEqual(b.maxSeconds * 1000);
        waits.push(wait);
      } else {
        expect(j?.state).toBe('failed');
      }
      // Nothing in the inbox while pg-boss still retries.
      expect(
        (await f.admin.query('SELECT 1 FROM app.sync_issue WHERE event_id = $1', [inv.eventId]))
          .rowCount,
      ).toBe(0);
    }
    expect(waits[0]).toBeLessThanOrEqual(120_000); // first retry: 1–2 minutes
    expect(waits.at(-1)).toBe(6 * 3600_000); // last retry: the 6-hour cap
    expect(requestsFor(inv).map((r) => r.status)).toEqual(Array<number>(11).fill(503));
    expect(await failures(inv.eventId)).toEqual(
      Array.from({ length: 11 }, (_, i) => ({
        attempt: i + 1,
        error_kind: 'unavailable',
        http_status: 503,
      })),
    );

    // The exhausted job is in the dead-letter queue with its last failure as source output.
    const [dl] = await deadLetters(inv.eventId);
    expect(dl).toMatchObject({
      sourceId: inv.eventId,
      sourceRetryCount: 10,
      data: { tenantId: f.tenantId, eventId: inv.eventId },
    });

    // The dead-letter worker turns it into one open Sync issue with error, attempts and payload.
    const issue = await deadLetterPass(inv.eventId);
    expect(issue).toMatchObject({
      eventId: inv.eventId,
      companyId: f.companyId,
      handler: HANDLER,
      connector: 'salesforce',
      status: 'open',
      attempts: 11,
      errorName: 'SalesforceApiError',
      errorKind: 'unavailable',
      errorCode: 'SERVER_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      topic: 'invoice.posted',
      aggregateType: 'sales_invoice',
      aggregateId: inv.invoiceId,
    });
    expect(issue.errorMessage).toContain('Server unavailable');
    expect((await issueOf(issue.id))?.payload).toEqual(inv.payload);
    expect((await deadLetters(inv.eventId))[0]?.state).toBe('completed');

    // A redelivered dead letter (at-least-once) changes nothing.
    const again = await f.inTenant((trx) =>
      recordSyncIssue(trx, {
        eventId: inv.eventId,
        attempts: 11,
        deadLetterJobId: dl?.id ?? '',
        output: dl?.sourceOutput ?? null,
      }),
    );
    expect(again).toMatchObject({ id: issue.id, status: 'open', attempts: 11 });

    // One-click retry re-queues the delivery in the same transaction; Salesforce has recovered.
    rest.outage = null;
    const boss = await runtime();
    const retried = await inApp((trx) =>
      retrySyncIssue(trx, bossRequeue(boss), issue.id, accountant),
    );
    expect(retried).toMatchObject({ status: 'retried', statusChangedBy: accountant });
    expect(retried.retryJobId).toMatch(/^[0-9a-f-]{36}$/);
    created.push(retried.retryJobId ?? '');
    const requeued = await job(retried.retryJobId ?? '');
    expect(requeued).toMatchObject({
      state: 'created',
      data: { tenantId: f.tenantId, eventId: inv.eventId },
    });

    expect((await outboxPass(retried.retryJobId ?? '')).status).toBe('completed');
    expect(rest.store.get('LF_Invoice__c')?.get(inv.invoiceId)).toMatchObject({
      Name: 'INV-000777',
      LF_Status__c: 'Posted',
    });
    expect(await issueOf(issue.id)).toMatchObject({ status: 'resolved', attempts: 11 });
    expect((await job(retried.retryJobId ?? ''))?.state).toBe('completed');
  });
});

describe('SS-PLAT-91 permanent connector failures', () => {
  it('SS-PLAT-91: a permanent failure skips the retries and lands in the inbox at once', async () => {
    rest.outage = {
      status: 400,
      body: [{ message: "No such column 'LF_Status__c'", errorCode: 'INVALID_FIELD' }],
    };
    const inv = await invoiceEvent();
    const r = await outboxPass(inv.eventId);
    expect(r.status).toBe('deadletter');
    expect((await job(inv.eventId))?.state).toBe('failed'); // no retry scheduled
    expect(requestsFor(inv)).toHaveLength(1);

    // pg-boss tables have no RLS: the job output names the handler and a failure row id only.
    const [dl] = await deadLetters(inv.eventId);
    expect(dl?.sourceRetryCount).toBe(0);
    expect(Object.keys(dl?.sourceOutput ?? {}).sort()).toEqual(['failureId', 'handler']);
    expect(JSON.stringify(dl?.sourceOutput)).not.toContain('LF_Status__c');

    const issue = await deadLetterPass(inv.eventId);
    expect(issue).toMatchObject({
      status: 'open',
      attempts: 1,
      retryable: false,
      errorKind: 'rejected',
      errorCode: 'INVALID_FIELD',
      httpStatus: 400,
    });

    // Ignore it; retrying an ignored issue is still allowed; resolving by hand is not.
    const ignored = await f.inTenant((trx) =>
      ignoreSyncIssue(trx, issue.id, accountant, 'field removed on purpose'),
    );
    expect(ignored).toMatchObject({ status: 'ignored', note: 'field removed on purpose' });
    // Ignoring again is a no-op (naturally idempotent).
    expect(
      await f.inTenant((trx) => ignoreSyncIssue(trx, issue.id, accountant, 'again')),
    ).toMatchObject({ status: 'ignored', note: 'field removed on purpose' });
    const boss = await runtime();
    const retried = await inApp((trx) =>
      retrySyncIssue(trx, bossRequeue(boss), issue.id, accountant),
    );
    expect(retried.status).toBe('retried');
    created.push(retried.retryJobId ?? '');
    // A second click while the retry is queued sends nothing new.
    const twice = await inApp((trx) =>
      retrySyncIssue(trx, bossRequeue(boss), issue.id, accountant),
    );
    expect(twice.retryJobId).toBe(retried.retryJobId);
    // The database guards the status model: the system may resolve a retried issue, but a
    // resolved one cannot be ignored afterwards.
    const setStatus = (status: string) =>
      f.inTenant((trx) =>
        sql`UPDATE app.sync_issue SET status = ${status} WHERE id = ${issue.id}`.execute(trx),
      );
    await setStatus('resolved');
    await expect(setStatus('ignored')).rejects.toThrow(/sync issue/);
  });
});

describe('SS-PLAT-92 API budget share as data', () => {
  it('SS-PLAT-92: the write-back throttles at the connection share of the daily API allocation', async () => {
    // The share is data on the connection: 25 % unless configured.
    expect(await f.inTenant((trx) => getApiBudgetShare(trx, connectionId))).toBe('0.2500');
    await f.inTenant((trx) => setApiBudgetShare(trx, connectionId, '0.1000'));
    expect(await f.inTenant((trx) => getApiBudgetShare(trx, connectionId))).toBe('0.1000');
    await expect(
      f.inTenant((trx) => setApiBudgetShare(trx, connectionId, '1.5000')),
    ).rejects.toThrow();

    const reg = registry(); // one worker process: one gate, readings shared across deliveries
    rest.apiUsage = { used: 10_500, max: 100_000 }; // 10.5 % used today
    const first = await invoiceEvent();
    const err = await deliver(h.app, reg, { tenantId: f.tenantId, eventId: first.eventId }).catch(
      (e: unknown) => e,
    );
    // The upsert went out and reported 10.5 %: the update is refused before it leaves.
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).toMatchObject({ kind: 'throttled', retryable: true });
    expect(requestsFor(first)).toHaveLength(1);
    const second = await invoiceEvent();
    await expect(
      deliver(h.app, reg, { tenantId: f.tenantId, eventId: second.eventId }),
    ).rejects.toMatchObject({ kind: 'throttled' });
    expect(requestsFor(second)).toHaveLength(0); // nothing left the process

    // Through the worker a throttled delivery is an ordinary retry: queued, no Sync issue. (The
    // first event's job is cancelled so the single-job pass picks the second.)
    await h.owner.cancel(OUTBOX_QUEUE, first.eventId);
    const r = await outboxPass(second.eventId);
    expect(r.status).toBe('failed');
    expect((await job(second.eventId))?.state).toBe('retry');
    expect(
      (await f.admin.query('SELECT 1 FROM app.sync_issue WHERE event_id = $1', [second.eventId]))
        .rowCount,
    ).toBe(0);

    // Back at the default 25 %, the same usage is within budget.
    await f.inTenant((trx) => setApiBudgetShare(trx, connectionId, '0.2500'));
    await expect(
      deliver(h.app, reg, { tenantId: f.tenantId, eventId: first.eventId }),
    ).resolves.toEqual({ handled: [HANDLER], skipped: [] });
  });

  it('SS-PLAT-92 no pg-boss instance reported an error', () => {
    expect(h.errors).toEqual([]);
  });
});
