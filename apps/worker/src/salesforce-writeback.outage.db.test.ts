/**
 * SS-UC01-09 — a Salesforce outage does not block accounting (T-0067, design §5.6 rule 4,
 * ADR-0008, ADR-0036, RQ-0040). Real PostgreSQL; the worker runs as lf_app; pg-boss time moves
 * only through the harness's TestClock. Salesforce is the local fake REST server (documented
 * shapes, fields checked against the SFDX package) and the fake token endpoint (T-0063); no org.
 *
 * The invoice's journal is a raw manual journal: every golden posting is Draft, so no invoice
 * posting rule exists yet (packages/outbox AGENTS.md). The `invoice.posted` event with its
 * `writeBack` snapshot is enqueued in the same transaction, as the invoice module (T-0040+)
 * will do (DL-0191).
 *
 * Determinism (DL-0205): the clock is moved to each retry's own `startAfter` and no further.
 * `TestClock.tick` fires every due timer in order, so a blanket 6-hour tick costs seconds of CPU
 * and timed out under load. Each test has its own invoice, Account and Opportunity, and it asserts
 * only on the fake's requests for those records. Every worker a test starts is stopped
 * afterwards, whatever the outcome.
 */
import {
  createJwtConnection,
  getAccessToken,
  salesforceWriteBackHandler,
  SalesforceApiError,
  type WriteBackReport,
} from '@ledgerforce/connector-salesforce';
import {
  generateTestKeyPair,
  selfSignedCertificate,
  startFakeSalesforceRest,
  startFakeTokenEndpoint,
  type FakeSalesforceRest,
  type FakeTokenEndpoint,
} from '@ledgerforce/connector-salesforce/testing';
import { withTenant } from '@ledgerforce/db';
import { post, type PostingCommand } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import {
  deliver,
  enqueue,
  HandlerRegistry,
  ledgerOutbox,
  OUTBOX_QUEUE,
  OUTBOX_QUEUE_OPTIONS,
  type DeliveryJob,
  type DeliveryResult,
} from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';

const T = '01900000-0000-7000-8000-000000006709';
const AUD = 'https://test.salesforce.com';
const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const KEY = '3MVG9TEST.consumer.key';
const USER = 'integration@harbour.example';
const DAY = 86_400_000;
const UPSERT_PATH = '/services/data/v67.0/composite/sobjects/LF_Invoice__c/LF_Id__c';
const UPDATE_PATH = '/services/data/v67.0/composite/sobjects';
const HANDLER = 'salesforce.writeback';

let f: LedgerFixture;
let h: OutboxHarness;
let tokens: FakeTokenEndpoint;
let rest: FakeSalesforceRest;
let connectionId: string;
const revoked = new Set<string>();
const written = new Map<string, WriteBackReport>();
/** pg-boss instances a test started; stopped in afterEach even when the test fails. */
const running: PgBoss[] = [];
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

const registry = () =>
  new HandlerRegistry().register(
    salesforceWriteBackHandler({
      kms,
      tokenHttp: tokens.http,
      http: rest.http,
      onWritten: (e, r) => written.set(e.id, r),
    }),
  );

/** An 18-character Salesforce id of the given key prefix, unique per call. */
const sfId = (prefix: '001' | '006') =>
  `${prefix}TEST${randomBytes(8).toString('hex').slice(0, 11).toUpperCase()}`;

/** The invoice's journal (GP-001 is Draft: represented by a balanced manual journal). */
const invoiceJournal = (company: string): PostingCommand => ({
  companyId: company,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-27',
  sourceType: 'manual_journal',
  lines: [
    {
      account: { id: (company === f.companyId ? f.acct : f.otherAcct)['6200'] ?? '' },
      debit: '1375.0000',
      memo: 'INV-000123 (stand-in journal)',
    },
    { account: { role: 'SUSPENSE' }, credit: '1375.0000' },
  ],
});

interface Invoice {
  entryId: string;
  eventId: string;
  invoiceId: string;
  account: string;
  opportunity: string;
}

const invoicePosted = (i: Omit<Invoice, 'entryId' | 'eventId'>) => ({
  writeBack: {
    version: 1,
    invoices: [
      {
        id: i.invoiceId,
        number: 'INV-000123',
        status: 'posted',
        issueDate: '2026-10-27',
        dueDate: '2026-11-26',
        total: '1375.0000',
        amountDue: '1375.0000',
        accountSfId: i.account,
        opportunitySfId: i.opportunity,
      },
    ],
    opportunities: [{ sfId: i.opportunity, invoiceStatus: 'posted', amountInvoiced: '1375.0000' }],
    accounts: [{ sfId: i.account, balanceDue: '1375.0000' }],
  },
});

/** Post the journal and enqueue the write-back event in one tenant transaction. */
async function postInvoice(company = f.companyId): Promise<Invoice> {
  const boss = await h.startRuntime();
  const ref = { invoiceId: randomUUID(), account: sfId('001'), opportunity: sfId('006') };
  rest.seed('Account', ref.account, { LF_Balance_Due__c: '0.00' });
  rest.seed('Opportunity', ref.opportunity);
  const ids = await withTenant(h.app, f.tenantId, async (trx) => {
    const r = await post(trx, invoiceJournal(company), { outbox: ledgerOutbox(boss) });
    const eventId = await enqueue(trx, boss, {
      companyId: company,
      topic: 'invoice.posted',
      aggregateType: 'sales_invoice',
      aggregateId: ref.invoiceId,
      payload: invoicePosted(ref),
    });
    return { entryId: r.entryId, eventId };
  });
  await boss.stop({ graceful: true, timeout: 5_000 });
  return { ...ids, ...ref };
}

/** The fake's requests that carried this invoice's records (the invoice or its Opportunity). */
const requestsFor = (i: Invoice) =>
  rest.requests.filter((r) => r.rawBody.includes(i.invoiceId) || r.rawBody.includes(i.opportunity));

const journalCount = async (entryId: string) =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE id = $1',
      [entryId],
    )
  ).rows[0]?.n;

const inbox = async (eventId: string) =>
  (
    await f.admin.query<{ handler: string }>(
      'SELECT handler FROM app.outbox_inbox WHERE event_id = $1',
      [eventId],
    )
  ).rows.map((r) => r.handler);

const jobState = async (id: string) => (await h.owner.getJobById(OUTBOX_QUEUE, id))?.state;

async function runtime(): Promise<PgBoss> {
  const b = await h.startRuntime();
  running.push(b);
  return b;
}

/**
 * Move the test clock to the moment this job's retry is due (its own backoff, read from pg-boss)
 * and no further, so the tick only fires the timers of that span.
 */
async function untilRetryDue(id: string): Promise<void> {
  const job = await h.owner.getJobById(OUTBOX_QUEUE, id);
  const wait = (job?.startAfter.getTime() ?? 0) - h.clock.now();
  expect(wait).toBeGreaterThan(0); // the failed attempt is really backing off
  expect(wait).toBeLessThanOrEqual(OUTBOX_QUEUE_OPTIONS.retryDelayMax * 1000);
  await h.clock.tick(wait + 1_000);
}

/** One worker pass over every due job, as the outbox worker does: deliver, then complete/fail. */
async function workerPass(): Promise<Map<string, unknown>> {
  const w = await runtime();
  const outcome = new Map<string, unknown>();
  const jobs = await w.fetch<DeliveryJob>(OUTBOX_QUEUE, { batchSize: 10 });
  for (const job of jobs) {
    try {
      outcome.set(job.id, await deliver(h.app, registry(), job.data));
      await w.complete(OUTBOX_QUEUE, job.id);
    } catch (e) {
      outcome.set(job.id, e);
      await w.fail(OUTBOX_QUEUE, job.id);
    }
  }
  return outcome;
}

beforeAll(async () => {
  f = await createLedgerFixture(T);
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values([
        { company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' },
        { company_id: f.otherCompanyId, code: 'je_manual_journal', prefix: 'MJ-' },
      ])
      .execute(),
  );
  h = await createOutboxHarness(f.tdb);
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
    acceptToken: (t) => tokens.issued.includes(t) && !revoked.has(t),
  });
  // Only the main company is connected to Salesforce.
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
});

afterEach(async () => {
  for (const b of running.splice(0)) await b.stop({ graceful: false });
});

afterAll(async () => {
  await h?.close();
  await rest?.close();
  await tokens?.close();
  await f?.close();
});

describe('SS-UC01-09 Salesforce outage', () => {
  it('SS-UC01-09: Salesforce outage does not block accounting', async () => {
    // Salesforce is down.
    rest.outage = {
      status: 503,
      body: [{ message: 'Server unavailable', errorCode: 'SERVER_UNAVAILABLE' }],
      retryAfter: '60',
    };
    const inv = await postInvoice();

    // The journal is committed although Salesforce is unreachable.
    expect(await journalCount(inv.entryId)).toBe(1);

    // The worker tries the write-back: it fails retryably and stays queued (no inbox row).
    const first = await workerPass();
    const err = first.get(inv.eventId);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).toMatchObject({
      kind: 'unavailable',
      status: 503,
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(await jobState(inv.eventId)).toBe('retry');
    expect(await inbox(inv.eventId)).toEqual([]);
    expect(requestsFor(inv).map((r) => r.status)).toEqual([503]);

    // Still down at the next attempt: still queued; accounting unaffected.
    await untilRetryDue(inv.eventId);
    expect((await workerPass()).get(inv.eventId)).toBeInstanceOf(SalesforceApiError);
    expect(await jobState(inv.eventId)).toBe('retry');
    expect(await journalCount(inv.entryId)).toBe(1);
    expect(rest.store.get('LF_Invoice__c')?.get(inv.invoiceId)).toBeUndefined();

    // Salesforce recovers; the queued write-back succeeds with one upsert, through the worker.
    rest.outage = null;
    await untilRetryDue(inv.eventId);
    let resolve: (r: DeliveryResult) => void = () => {};
    const delivered = new Promise<DeliveryResult>((r) => {
      resolve = r;
    });
    const w = await runtime();
    await startOutboxWorker({
      boss: w,
      db: h.app,
      registry: registry(),
      onDelivered: (job, result) => {
        if (job.id === inv.eventId) resolve(result);
      },
    });
    // The worker fetches at once; the tick only settles its poll (no real waiting).
    await h.clock.tick(5_000);
    expect(await delivered).toEqual({ handled: [HANDLER], skipped: [] });
    // onDelivered runs before pg-boss completes the job: a graceful stop waits for that.
    await w.stop({ graceful: true, timeout: 5_000 });

    const ok = requestsFor(inv).filter((r) => r.status === 200);
    expect(ok.filter((r) => r.path === UPSERT_PATH)).toHaveLength(1);
    expect(ok.map((r) => r.path)).toEqual([UPSERT_PATH, UPDATE_PATH]);
    expect(rest.store.get('LF_Invoice__c')?.get(inv.invoiceId)).toMatchObject({
      Name: 'INV-000123',
      LF_Status__c: 'Posted',
      LF_Total__c: '1375.00',
      LF_Account__c: inv.account,
      LF_Opportunity__c: inv.opportunity,
    });
    expect(rest.store.get('Opportunity')?.get(inv.opportunity)).toMatchObject({
      LF_Invoice_Status__c: 'Posted',
      LF_Amount_Invoiced__c: '1375.00',
    });
    expect(await inbox(inv.eventId)).toEqual([HANDLER]);
    expect(await jobState(inv.eventId)).toBe('completed');
    expect(written.get(inv.eventId)).toEqual({ requests: 2, records: 3, created: 1, updated: 2 });

    // A redelivery of the same event (at least once) is recognised: no second upsert.
    const before = requestsFor(inv).length;
    expect(
      await deliver(h.app, registry(), { tenantId: f.tenantId, eventId: inv.eventId }),
    ).toEqual({ handled: [], skipped: [HANDLER] });
    expect(requestsFor(inv)).toHaveLength(before);
    expect(await journalCount(inv.entryId)).toBe(1);
  });

  it('SS-UC01-09 an expired token is re-signed once and the write-back goes through', async () => {
    const inv = await postInvoice();
    // A cached session exists (whatever ran before)...
    const cached = await f.inTenant((trx) =>
      getAccessToken(trx, kms, connectionId, { http: tokens.http }),
    );
    // ...and Salesforce has revoked it.
    revoked.add(cached.accessToken);
    const issuedBefore = tokens.issued.length;
    expect(
      await deliver(h.app, registry(), { tenantId: f.tenantId, eventId: inv.eventId }),
    ).toEqual({ handled: [HANDLER], skipped: [] });
    expect(requestsFor(inv).map((r) => r.status)).toEqual([401, 200, 200]);
    expect(tokens.issued).toHaveLength(issuedBefore + 1);
    expect(rest.store.get('LF_Invoice__c')?.get(inv.invoiceId)?.LF_Status__c).toBe('Posted');
  });

  it('SS-UC01-09 a company without a Salesforce connection posts and has nothing to write back', async () => {
    const inv = await postInvoice(f.otherCompanyId);
    const start = rest.requests.length;
    expect(
      await deliver(h.app, registry(), { tenantId: f.tenantId, eventId: inv.eventId }),
    ).toEqual({ handled: [HANDLER], skipped: [] });
    expect(rest.requests).toHaveLength(start);
    expect(await journalCount(inv.entryId)).toBe(1);
  });

  it('SS-UC01-09 no pg-boss instance reported an error', () => {
    expect(h.errors).toEqual([]);
  });
});
