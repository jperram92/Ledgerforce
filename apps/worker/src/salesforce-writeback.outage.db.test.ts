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
 */
import {
  createJwtConnection,
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
} from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';

const T = '01900000-0000-7000-8000-000000006709';
const AUD = 'https://test.salesforce.com';
const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const KEY = '3MVG9TEST.consumer.key';
const USER = 'integration@harbour.example';
const ACCOUNT = '001TEST00000009AAA';
const OPPORTUNITY = '006TEST00000009AAA';
const DAY = 86_400_000;
const UPSERT_PATH = '/services/data/v67.0/composite/sobjects/LF_Invoice__c/LF_Id__c';
const HANDLER = 'salesforce.writeback';

let f: LedgerFixture;
let h: OutboxHarness;
let tokens: FakeTokenEndpoint;
let rest: FakeSalesforceRest;
const revoked = new Set<string>();
const written: WriteBackReport[] = [];
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

const registry = () =>
  new HandlerRegistry().register(
    salesforceWriteBackHandler({
      kms,
      tokenHttp: tokens.http,
      http: rest.http,
      onWritten: (_e, r) => written.push(r),
    }),
  );

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

const invoicePosted = (invoiceId: string) => ({
  writeBack: {
    version: 1,
    invoices: [
      {
        id: invoiceId,
        number: 'INV-000123',
        status: 'posted',
        issueDate: '2026-10-27',
        dueDate: '2026-11-26',
        total: '1375.0000',
        amountDue: '1375.0000',
        accountSfId: ACCOUNT,
        opportunitySfId: OPPORTUNITY,
      },
    ],
    opportunities: [{ sfId: OPPORTUNITY, invoiceStatus: 'posted', amountInvoiced: '1375.0000' }],
    accounts: [{ sfId: ACCOUNT, balanceDue: '1375.0000' }],
  },
});

/** Post the journal and enqueue the write-back event in one tenant transaction. */
async function postInvoice(company = f.companyId) {
  const boss = await h.startRuntime();
  const invoiceId = randomUUID();
  const ids = await withTenant(h.app, f.tenantId, async (trx) => {
    const r = await post(trx, invoiceJournal(company), { outbox: ledgerOutbox(boss) });
    const eventId = await enqueue(trx, boss, {
      companyId: company,
      topic: 'invoice.posted',
      aggregateType: 'sales_invoice',
      aggregateId: invoiceId,
      payload: invoicePosted(invoiceId),
    });
    return { entryId: r.entryId, eventId };
  });
  await boss.stop({ graceful: true, timeout: 5_000 });
  return { ...ids, invoiceId };
}

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

/** One worker pass over every due job, as the outbox worker does: deliver, then complete/fail. */
async function workerPass(): Promise<Map<string, unknown>> {
  const w = await h.startRuntime();
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
  await w.stop({ graceful: false });
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
  rest.seed('Account', ACCOUNT, { LF_Balance_Due__c: '0.00' });
  rest.seed('Opportunity', OPPORTUNITY);
  // Only the main company is connected to Salesforce.
  await f.inTenant((trx) =>
    createJwtConnection(trx, kms, f.companyId, {
      loginUrl: AUD,
      username: USER,
      consumerKey: KEY,
      privateKeyPem: keys.privateKeyPem,
      certificatePem: cert,
    }),
  );
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
    const { entryId, eventId, invoiceId } = await postInvoice();

    // The journal is committed although Salesforce is unreachable.
    expect(await journalCount(entryId)).toBe(1);

    // The worker tries the write-back: it fails retryably and stays queued (no inbox row).
    const first = await workerPass();
    const err = first.get(eventId);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).toMatchObject({
      kind: 'unavailable',
      status: 503,
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(await jobState(eventId)).toBe('retry');
    expect(await inbox(eventId)).toEqual([]);
    expect(rest.requests.map((r) => r.status)).toEqual([503]);

    // Still down at the next attempt: still queued; accounting unaffected.
    await h.clock.tick((OUTBOX_QUEUE_OPTIONS.retryDelayMax + 1) * 1000);
    expect((await workerPass()).get(eventId)).toBeInstanceOf(SalesforceApiError);
    expect(await jobState(eventId)).toBe('retry');
    expect(await journalCount(entryId)).toBe(1);
    expect(rest.store.get('LF_Invoice__c')?.get(invoiceId)).toBeUndefined();

    // Salesforce recovers; the queued write-back succeeds with one upsert.
    rest.outage = null;
    await h.clock.tick((OUTBOX_QUEUE_OPTIONS.retryDelayMax + 1) * 1000);
    const w = await h.startRuntime();
    const done = new Promise<void>((resolve) => {
      void startOutboxWorker({
        boss: w,
        db: h.app,
        registry: registry(),
        onDelivered: (job, result) => {
          if (job.id === eventId) {
            expect(result).toEqual({ handled: [HANDLER], skipped: [] });
            resolve();
          }
        },
      });
    });
    await h.clock.tick(5_000);
    await done;
    await w.stop({ graceful: true, timeout: 5_000 });

    const ok = rest.requests.filter((r) => r.status === 200);
    expect(ok.filter((r) => r.path === UPSERT_PATH)).toHaveLength(1);
    expect(ok.map((r) => r.path)).toEqual([UPSERT_PATH, '/services/data/v67.0/composite/sobjects']);
    expect(rest.store.get('LF_Invoice__c')?.get(invoiceId)).toMatchObject({
      Name: 'INV-000123',
      LF_Status__c: 'Posted',
      LF_Total__c: '1375.00',
      LF_Account__c: ACCOUNT,
      LF_Opportunity__c: OPPORTUNITY,
    });
    expect(rest.store.get('Opportunity')?.get(OPPORTUNITY)).toMatchObject({
      LF_Invoice_Status__c: 'Posted',
      LF_Amount_Invoiced__c: '1375.00',
    });
    expect(await inbox(eventId)).toEqual([HANDLER]);
    expect(await jobState(eventId)).toBe('completed');
    expect(written.at(-1)).toEqual({ requests: 2, records: 3, created: 1, updated: 2 });

    // A redelivery of the same event (at least once) is recognised: no second upsert.
    const before = rest.requests.length;
    expect(await deliver(h.app, registry(), { tenantId: f.tenantId, eventId })).toEqual({
      handled: [],
      skipped: [HANDLER],
    });
    expect(rest.requests).toHaveLength(before);
    expect(await journalCount(entryId)).toBe(1);
  });

  it('SS-UC01-09 an expired token is re-signed once and the write-back goes through', async () => {
    const { eventId, invoiceId } = await postInvoice();
    for (const t of tokens.issued) revoked.add(t); // Salesforce revoked the cached session
    const issuedBefore = tokens.issued.length;
    const start = rest.requests.length;
    expect(await deliver(h.app, registry(), { tenantId: f.tenantId, eventId })).toEqual({
      handled: [HANDLER],
      skipped: [],
    });
    expect(rest.requests.slice(start).map((r) => r.status)).toEqual([401, 200, 200]);
    expect(tokens.issued).toHaveLength(issuedBefore + 1);
    expect(rest.store.get('LF_Invoice__c')?.get(invoiceId)?.LF_Status__c).toBe('Posted');
  });

  it('SS-UC01-09 a company without a Salesforce connection posts and has nothing to write back', async () => {
    const { entryId, eventId } = await postInvoice(f.otherCompanyId);
    const start = rest.requests.length;
    expect(await deliver(h.app, registry(), { tenantId: f.tenantId, eventId })).toEqual({
      handled: [HANDLER],
      skipped: [],
    });
    expect(rest.requests).toHaveLength(start);
    expect(await journalCount(entryId)).toBe(1);
  });

  it('SS-UC01-09 no pg-boss instance reported an error', () => {
    expect(h.errors).toEqual([]);
  });
});
