/**
 * Inbound mapping issues reach the Sync issues inbox (T-0065, design §5.6 rule 2, ADR-0006 rule
 * 2, DL-0295). Real PostgreSQL; outbox and dead-letter workers run as lf_app on pg-boss with the
 * harness's TestClock (no sleeps).
 *
 * SS-UC01-07 (issue path) — an unmappable change (a Contact whose Account is not a party yet) is
 *   reported as an outbox event in the mapping's transaction; the `salesforce.inbound` handler
 *   fails permanently, so it dead-letters at once and lands in the inbox with the error code and
 *   the change as payload. After the Account arrives, one-click retry maps the Contact and the
 *   issue resolves; the processed-change row is settled, and a redelivery of the same change is
 *   still only logged as a duplicate. An inbound edit of a LedgerForce-owned field stays an issue.
 */
import {
  applyInboundChange,
  inboundIssueMessage,
  listInboundChanges,
  salesforceInboundIssueHandler,
  type InboundChange,
  type InboundContext,
} from '@ledgerforce/connector-salesforce';
import { withTenant, type Database } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import {
  bossRequeue,
  enqueue,
  getSyncIssue,
  HandlerRegistry,
  OUTBOX_DEAD_LETTER_QUEUE,
  OUTBOX_QUEUE,
  retrySyncIssue,
  type DeliveryJob,
  type SyncIssue,
} from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { toSalesforceId18 } from '@ledgerforce/parties';
import type { Transaction } from 'kysely';
import type { JobResult, PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startOutboxWorker } from './outbox-worker.ts';
import { startSyncIssueWorker } from './sync-issue-worker.ts';

const T = '01900000-0000-7000-8000-000000006503';
const ACCOUNT = toSalesforceId18('001000000006501');
const CONTACT = toSalesforceId18('003000000006501');

let f: LedgerFixture;
let h: OutboxHarness;
let accountant: string;
const running: PgBoss[] = [];
let commit = 70_000n;

const registry = () => new HandlerRegistry().register(salesforceInboundIssueHandler());

async function runtime(): Promise<PgBoss> {
  const b = await h.startRuntime();
  running.push(b);
  return b;
}

async function stop(b: PgBoss): Promise<void> {
  await b.stop({ graceful: true, timeout: 5_000 });
  running.splice(running.indexOf(b), 1);
}

const inApp = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
  withTenant(h.app, f.tenantId, fn);

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

/** The production sink: the issue is an outbox event written in the mapping's transaction. */
const context = (boss: PgBoss): InboundContext => ({
  companyId: f.companyId,
  reportIssue: (trx, issue) => enqueue(trx, boss, inboundIssueMessage(f.companyId, issue)),
});

function change(
  entityName: string,
  recordId: string,
  fields: Record<string, unknown>,
  over: Partial<InboundChange> = {},
): InboundChange {
  return {
    source: `/data/${entityName}ChangeEvent`,
    entityName,
    recordId,
    changeType: 'CREATE',
    commitNumber: (commit += 1n),
    sequenceNumber: 1,
    transactionKey: `tx-${String(commit)}`,
    commitTimestamp: 1_761_350_000_000n,
    changedFields: [],
    nulledFields: [],
    fields,
    ...over,
  };
}

beforeAll(async () => {
  f = await createLedgerFixture(T);
  h = await createOutboxHarness(f.tdb);
  accountant = await f.addUser('accountant');
}, 120_000);

afterEach(async () => {
  for (const b of running.splice(0)) await b.stop({ graceful: false });
  for (const j of await h.owner.findJobs(OUTBOX_DEAD_LETTER_QUEUE, { queued: true })) {
    await h.owner.cancel(OUTBOX_DEAD_LETTER_QUEUE, j.id);
  }
});

afterAll(async () => {
  await h?.close();
  await f?.close();
});

describe('SS-UC01-07: inbound mapping issues in the Sync issues inbox', () => {
  it('SS-UC01-07: an unmappable change lands in the inbox at once and one-click retry maps it', async () => {
    const boss = await runtime();
    const contact = change('Contact', CONTACT, {
      AccountId: ACCOUNT,
      Name: { FirstName: 'Ava', LastName: 'Ng' },
      Email: 'ava@harbour.example',
    });
    const first = await inApp((trx) => applyInboundChange(trx, context(boss), contact));
    expect(first).toMatchObject({ outcome: 'issue', issue: { code: 'UNKNOWN_ACCOUNT' } });
    const [row] = await inApp((trx) => listInboundChanges(trx, f.companyId, { recordId: CONTACT }));
    const eventId = row?.issueEventId as string;
    expect(eventId).toBeTruthy();

    // Permanent: no retries, dead-lettered at once, then an open issue with code and payload.
    expect((await outboxPass(eventId)).status).toBe('deadletter');
    expect((await h.owner.getJobById<DeliveryJob>(OUTBOX_QUEUE, eventId))?.state).toBe('failed');
    const issue = await deadLetterPass(eventId);
    expect(issue).toMatchObject({
      status: 'open',
      handler: 'salesforce.inbound',
      connector: 'salesforce',
      retryable: false,
      errorName: 'SalesforceInboundIssue',
      errorKind: 'unmappable',
      errorCode: 'UNKNOWN_ACCOUNT',
      topic: 'salesforce.inbound.issue',
      aggregateType: 'salesforce_inbound_change',
      aggregateId: row?.id,
    });
    const detail = await f.inTenant((trx) => getSyncIssue(trx, issue.id));
    expect(detail?.payload).toMatchObject({
      kind: 'unmappable',
      code: 'UNKNOWN_ACCOUNT',
      change: {
        entityName: 'Contact',
        recordId: CONTACT,
        commitNumber: String(contact.commitNumber),
      },
    });

    // The Account arrives; one click re-delivers the issue and the Contact maps.
    await inApp((trx) =>
      applyInboundChange(
        trx,
        context(boss),
        change('Account', ACCOUNT, { Name: 'Harbour Freight Pty Ltd' }),
      ),
    );
    const retried = await inApp((trx) =>
      retrySyncIssue(trx, bossRequeue(boss), issue.id, accountant),
    );
    expect(retried.status).toBe('retried');
    expect((await outboxPass(retried.retryJobId as string)).status).toBe('completed');
    expect((await f.inTenant((trx) => getSyncIssue(trx, issue.id)))?.status).toBe('resolved');

    const contacts = await f.inTenant((trx) =>
      trx
        .selectFrom('app.party_contact')
        .select(['name', 'email'])
        .where('salesforce_contact_id', '=', CONTACT)
        .execute(),
    );
    expect(contacts).toEqual([{ name: 'Ava Ng', email: 'ava@harbour.example' }]);
    expect(
      await inApp((trx) => listInboundChanges(trx, f.companyId, { recordId: CONTACT })),
    ).toMatchObject([
      {
        outcome: 'applied',
        targetType: 'contact',
        issueCode: null,
        issueEventId: eventId,
        duplicateCount: 0,
      },
    ]);

    // The same change delivered again: logged as a duplicate, no second contact, no new issue.
    expect(await inApp((trx) => applyInboundChange(trx, context(boss), contact))).toMatchObject({
      outcome: 'duplicate',
    });
    expect(
      await inApp((trx) => listInboundChanges(trx, f.companyId, { recordId: CONTACT })),
    ).toMatchObject([{ outcome: 'applied', duplicateCount: 1 }]);
  });

  it('SS-UC01-07: an inbound edit of a LedgerForce-owned field stays an issue (the write-back restores it)', async () => {
    const boss = await runtime();
    const account = toSalesforceId18('001000000006502');
    await inApp((trx) =>
      applyInboundChange(
        trx,
        context(boss),
        change('Account', account, { Name: 'Bayside Cafe Pty Ltd' }),
      ),
    );
    const edit = change(
      'Account',
      account,
      { LF_Overdue_Amount__c: 0 },
      { changeType: 'UPDATE', changedFields: ['LF_Overdue_Amount__c', 'LastModifiedDate'] },
    );
    expect(await inApp((trx) => applyInboundChange(trx, context(boss), edit))).toMatchObject({
      outcome: 'applied',
      applied: [],
      conflicts: ['LF_Overdue_Amount__c'],
    });
    const rows = await inApp((trx) => listInboundChanges(trx, f.companyId, { recordId: account }));
    const eventId = rows[1]?.issueEventId as string;
    expect((await outboxPass(eventId)).status).toBe('deadletter');
    expect(await deadLetterPass(eventId)).toMatchObject({
      status: 'open',
      errorKind: 'conflict',
      errorCode: 'LF_OWNED_FIELD',
      retryable: false,
    });
  });
});
