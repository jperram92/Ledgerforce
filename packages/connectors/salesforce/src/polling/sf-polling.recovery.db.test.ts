/**
 * SS-PLAT-26 (inbound half) — polling fallback and reconciliation replay through the T-0065
 * mapping (T-0066; design §5.3; RQ-0103; migrations 0050, 0051). Real PostgreSQL as lf_app;
 * Salesforce is the local fake of the documented REST query resources (no org).
 *
 * "Replayed once" at this layer: every record changed while the connector was offline ends in
 * the state Salesforce holds, with exactly one applied processed-change row per change; re-reading
 * the same rows (overlap window, a second run) only logs duplicates; a late CDC event older than
 * an applied snapshot does not roll the record back. Re-pushing stale write-backs is the other
 * half of SS-PLAT-26 (T-0070).
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { toSalesforceId18 } from '@ledgerforce/parties';
import { seedPostingProfiles } from '@ledgerforce/products';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecodedEvent } from '../pubsub/avro.ts';
import {
  inboundCdcHandlers,
  inboundIssueMessage,
  listInboundChanges,
  type InboundIssue,
} from '../inbound/index.ts';
import {
  startFakeSalesforceQuery,
  type FakeSalesforceQuery,
} from '../testing/fake-salesforce-query.ts';
import {
  configureSyncObject,
  getSyncObject,
  pollObject,
  reconcileInbound,
  runPollingCycle,
  type QuerySession,
} from './index.ts';

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}

const TENANT = '01900000-0000-7000-8000-000000006601';
const OTHER_TENANT = '01900000-0000-7000-8000-000000006602';
const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const TOKEN = '00DTEST000000000!POLL';
const sfId = (prefix: string, n: number) =>
  toSalesforceId18(`${prefix}${String(n).padStart(12, '0')}`);
const acc = (n: number) => sfId('001', n);
const con = (n: number) => sfId('003', n);
const prd = (n: number) => sfId('01t', n);

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-26T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms);

let f: LedgerFixture;
let fake: FakeSalesforceQuery;
let session: QuerySession;
let commit = 50_000n;
const issues: InboundIssue[] = [];

async function recordIssue(trx: Transaction<Database>, issue: InboundIssue): Promise<string> {
  issues.push(issue);
  const m = inboundIssueMessage(f.companyId, issue);
  const { rows } = await sql<{ id: string }>`
    INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
    VALUES (${m.companyId}, ${m.topic}, ${m.aggregateType}, ${m.aggregateId},
            ${JSON.stringify(m.payload)}::jsonb)
    RETURNING id`.execute(trx);
  return must(rows[0]).id;
}

const q = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => f.inTenant(fn);
const base = () => ({
  db: f.db,
  tenantId: TENANT,
  companyId: f.companyId,
  session,
  reportIssue: recordIssue,
});

/** A CDC change as the subscriber's handler receives it (T-0065 path). */
function cdc(
  entityName: string,
  recordId: string,
  changeType: 'CREATE' | 'UPDATE' | 'DELETE',
  when: Date,
  fields: Record<string, unknown>,
  changedFields: string[] = [],
): DecodedEvent {
  return {
    replayId: Buffer.from([0]),
    eventId: crypto.randomUUID(),
    schemaId: 'test',
    header: {
      entityName,
      recordIds: [recordId],
      changeType,
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: `tx-${String(commit)}`,
      sequenceNumber: 1,
      commitTimestamp: BigInt(when.getTime()),
      commitNumber: (commit += 1n),
      commitUser: '005000000000001AAA',
      changedFields,
      nulledFields: [],
      diffFields: [],
    },
    fields,
  };
}
async function deliverCdc(e: DecodedEvent): Promise<void> {
  const h = inboundCdcHandlers({
    companyId: f.companyId,
    source: `/data/${must(e.header).entityName}ChangeEvent`,
    reportIssue: recordIssue,
  });
  await q((trx) => h.handler(trx, e, must(e.header).recordIds));
}

const party = (id: string) =>
  q((trx) =>
    trx
      .selectFrom('app.party')
      .select(['id', 'legal_name', 'status', 'customer_profile_id'])
      .where('salesforce_account_id', '=', id)
      .execute(),
  );
/** Processed changes of a record in processing order (CDC and snapshot keys are not comparable). */
const changesFor = async (recordId: string) =>
  (await q((trx) => listInboundChanges(trx, f.companyId, { recordId }))).sort(
    (a, b) => a.processedAt.getTime() - b.processedAt.getTime(),
  );
const syncObject = async (entity: string) =>
  must(await q((trx) => getSyncObject(trx, f.companyId, entity)));
const appliedCount = async () =>
  Number(
    (
      await q((trx) =>
        sql<{ n: string }>`SELECT count(*) AS n FROM app.salesforce_inbound_change
                            WHERE outcome IN ('applied', 'archived')`.execute(trx),
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.inTenant((trx) =>
    seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct))),
  );
  fake = await startFakeSalesforceQuery({
    instanceUrl: INSTANCE,
    acceptToken: (t) => t === TOKEN,
    pageSize: 3,
  });
  fake.define('Account', [
    'Name',
    'Type',
    'BillingStreet',
    'BillingCity',
    'BillingState',
    'BillingPostalCode',
  ]);
  fake.define('Contact', ['AccountId', 'FirstName', 'LastName', 'Email', 'Phone']);
  fake.define('Product2', ['Name', 'ProductCode', 'Description', 'Family', 'IsActive']);
  session = { http: fake.http, instanceUrl: INSTANCE, accessToken: TOKEN };
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-26: Missed Salesforce events recovered by nightly reconciliation', () => {
  it('SS-PLAT-26: Missed Salesforce events recovered by nightly reconciliation — a 3-day outage beyond CDC retention is replayed once through the inbound mapping', async () => {
    // Day 0: the connector is live; CDC applies two Accounts; a first reconcile sets watermarks.
    for (const entity of ['Account', 'Contact']) {
      await q((trx) => configureSyncObject(trx, f.companyId, entity, { mode: 'cdc' }));
    }
    const a1 = {
      Name: 'Harbour Freight Pty Ltd',
      Type: 'Customer - Direct',
      BillingCity: 'Sydney',
    };
    fake.upsert('Account', acc(1), a1, at(1000));
    await deliverCdc(cdc('Account', acc(1), 'CREATE', at(1000), a1));
    fake.upsert('Account', acc(3), { Name: 'Closing Down Pty Ltd' }, at(2000));
    await deliverCdc(cdc('Account', acc(3), 'CREATE', at(2000), { Name: 'Closing Down Pty Ltd' }));
    const day0 = await reconcileInbound({ ...base(), now: () => at(3600_000) });
    // Snapshots in the same second as the applied CDC change re-apply the same state (harmless);
    // only a CDC change in a later second makes a snapshot stale (RQ-0103 finding 7).
    expect(day0.map((r) => [r.entity, r.issues])).toEqual([
      ['Account', 0],
      ['Contact', 0],
      ['Product2', 0],
    ]);
    expect(await party(acc(1))).toMatchObject([{ legal_name: 'Harbour Freight Pty Ltd' }]);
    const before = await appliedCount();

    // Days 1–4: the connector is offline longer than CDC's 72-hour retention. Salesforce changes:
    fake.upsert('Account', acc(1), { Name: 'Harbour Freight Group Pty Ltd' }, at(1 * DAY));
    fake.upsert(
      'Account',
      acc(2),
      { Name: 'Bayside Cafe Pty Ltd', BillingCity: 'Manly' },
      at(1 * DAY + 5),
    );
    fake.upsert(
      'Contact',
      con(1),
      { AccountId: acc(2), FirstName: 'Mia', LastName: 'Chen', Email: 'mia@bayside.example' },
      at(2 * DAY),
    );
    fake.remove('Account', acc(3), at(2 * DAY + 10));
    fake.upsert(
      'Product2',
      prd(1),
      { Name: 'Onboarding workshop', ProductCode: 'ONB-1', Family: 'Training', IsActive: true },
      at(3 * DAY),
    );
    // Day 4 night: reconciliation runs.
    const night = await reconcileInbound({ ...base(), now: () => at(4 * DAY) });
    const by = Object.fromEntries(night.map((r) => [r.entity, r]));
    expect(by.Account).toMatchObject({ applied: 2, archived: 1, issues: 0 });
    expect(by.Contact).toMatchObject({ applied: 1, issues: 0 });
    expect(by.Product2).toMatchObject({ applied: 1, issues: 0 });

    expect(await party(acc(1))).toMatchObject([
      { legal_name: 'Harbour Freight Group Pty Ltd', status: 'active' },
    ]);
    expect(await party(acc(2))).toMatchObject([{ legal_name: 'Bayside Cafe Pty Ltd' }]);
    expect(await party(acc(3))).toMatchObject([{ status: 'archived' }]);
    const contact = await q((trx) =>
      trx
        .selectFrom('app.party_contact')
        .select(['party_id', 'name', 'email'])
        .where('salesforce_contact_id', '=', con(1))
        .execute(),
    );
    expect(contact).toEqual([
      {
        party_id: must((await party(acc(2)))[0]).id,
        name: 'Mia Chen',
        email: 'mia@bayside.example',
      },
    ]);
    // Each change replayed once: one applied row per change — CDC's create, day 0's same-second
    // snapshot of that state, and the one offline rename.
    expect(
      (await changesFor(acc(1)))
        .filter((r) => r.outcome === 'applied')
        .map((r) => [r.source, r.commitNumber]),
    ).toEqual([
      ['/data/AccountChangeEvent', expect.any(BigInt)],
      ['reconcile', BigInt(T0 + 1000)],
      ['reconcile', BigInt(T0 + DAY)],
    ]);
    expect(await appliedCount()).toBe(before + 5); // the 5 changes made while offline
    expect(issues).toEqual([]);

    // A second run (and the overlap window) re-reads rows: duplicates only, nothing re-applied.
    const again = await reconcileInbound({ ...base(), now: () => at(4 * DAY + 60_000) });
    expect(again.reduce((n, r) => n + r.applied + r.archived, 0)).toBe(0);
    expect(await appliedCount()).toBe(before + 5);
    expect(must((await changesFor(acc(3))).at(-1)).duplicateCount).toBeGreaterThanOrEqual(1);
    // The watermark is the highest SystemModstamp read (Salesforce's clock), not the run time.
    expect((await syncObject('Account')).watermark).toEqual(at(2 * DAY));

    // The subscriber comes back and a stale CDC event (older than the snapshot) arrives late.
    await deliverCdc(
      cdc('Account', acc(1), 'UPDATE', at(12 * 3600_000), { Name: 'Stale Name Pty Ltd' }, ['Name']),
    );
    expect(await party(acc(1))).toMatchObject([{ legal_name: 'Harbour Freight Group Pty Ltd' }]);
    expect((await changesFor(acc(1))).at(-1)).toMatchObject({
      source: '/data/AccountChangeEvent',
      outcome: 'ignored',
      issueCode: 'SUPERSEDED',
    });
    // A newer CDC event still applies.
    await deliverCdc(
      cdc('Account', acc(1), 'UPDATE', at(5 * DAY), { Name: 'Harbour Freight Holdings Pty Ltd' }, [
        'Name',
      ]),
    );
    expect(await party(acc(1))).toMatchObject([{ legal_name: 'Harbour Freight Holdings Pty Ltd' }]);
  });

  it('SS-PLAT-26: an undelete seen by polling re-activates the archived party', async () => {
    fake.upsert('Account', acc(3), { Name: 'Closing Down Pty Ltd' }, at(6 * DAY));
    await reconcileInbound({ ...base(), entities: ['Account'], now: () => at(6 * DAY + 1000) });
    expect(await party(acc(3))).toMatchObject([{ status: 'active' }]);
    expect((await changesFor(acc(3))).at(-1)).toMatchObject({
      changeType: 'UNDELETE',
      outcome: 'applied',
    });
  });
});

describe('Polling fallback per object (design §5.3, T-0066)', () => {
  it('the scheduler polls only objects in polling mode that are due, and sets the next run', async () => {
    await q((trx) =>
      configureSyncObject(trx, f.companyId, 'Product2', {
        mode: 'polling',
        pollIntervalSeconds: 900,
        overlapSeconds: 60,
      }),
    );
    fake.upsert(
      'Product2',
      prd(2),
      { Name: 'Support retainer', ProductCode: 'SUP-1', Family: 'Training', IsActive: true },
      at(7 * DAY),
    );
    fake.requests.length = 0;
    const first = await runPollingCycle({ ...base(), now: () => at(7 * DAY + 1000) });
    expect(first.failed).toEqual([]);
    expect(first.polled.map((r) => [r.entity, r.source, r.applied])).toEqual([
      ['Product2', 'poll:Product2', 1],
    ]);
    // Account and Contact are CDC objects: not polled (no request names them).
    expect(fake.requests.some((r) => /Account|Contact/.test(decodeURIComponent(r.path)))).toBe(
      false,
    );
    const cfg = await syncObject('Product2');
    expect(cfg).toMatchObject({ mode: 'polling', pollIntervalSeconds: 900, overlapSeconds: 60 });
    expect(cfg.nextPollAt).toEqual(new Date(T0 + 7 * DAY + 1000 + 900_000));
    expect(cfg.lastPollRecords).toBeGreaterThanOrEqual(1);

    const early = await runPollingCycle({ ...base(), now: () => at(7 * DAY + 60_000) });
    expect(early.polled).toEqual([]);
    const due = await runPollingCycle({ ...base(), now: () => at(7 * DAY + 1000 + 900_000) });
    expect(due.polled.map((r) => [r.entity, r.applied])).toEqual([['Product2', 0]]);
    // The overlap re-read the last stamp: a duplicate, not a second application.
    expect(must((await changesFor(prd(2)))[0]).duplicateCount).toBeGreaterThanOrEqual(1);
  });

  it('a failure mid-run keeps the pages already committed and records the error; the next run resumes', async () => {
    for (let n = 10; n < 17; n += 1) {
      fake.upsert(
        'Account',
        acc(n),
        { Name: `Batch ${String(n)} Pty Ltd` },
        at(8 * DAY + n * 1000),
      );
    }
    let calls = 0;
    const flaky: QuerySession = {
      ...session,
      http: (url, init) =>
        ++calls === 4 ? Promise.reject(new Error('reset')) : fake.http(url, init),
    };
    await expect(
      pollObject({ ...base(), session: flaky, entity: 'Account', now: () => at(8 * DAY + 60_000) }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const cfg = await syncObject('Account');
    expect(cfg.lastPollError).toMatch(/unavailable/);
    // describe, page 1, page 2 answered; page 3 failed. Pages 1–2 (acc 3 re-read in the overlap,
    // acc 10–14) committed; the watermark is the last committed stamp.
    expect(cfg.watermark).toEqual(at(8 * DAY + 14_000));
    expect(await party(acc(14))).toHaveLength(1);
    expect(await party(acc(15))).toEqual([]);

    const resumed = await pollObject({
      ...base(),
      entity: 'Account',
      now: () => at(8 * DAY + 120_000),
    });
    expect(resumed.applied).toBe(2);
    expect(await party(acc(16))).toHaveLength(1);
    expect((await syncObject('Account')).lastPollError).toBeNull();
  });

  it('two edits of one record within one second are two changes, both applied in order', async () => {
    fake.upsert('Account', acc(5), { Name: 'Quick Edit v1 Pty Ltd' }, at(9 * DAY + 100));
    await pollObject({ ...base(), entity: 'Account', now: () => at(9 * DAY + 200) });
    fake.upsert('Account', acc(5), { Name: 'Quick Edit v2 Pty Ltd' }, at(9 * DAY + 400));
    await pollObject({ ...base(), entity: 'Account', now: () => at(9 * DAY + 900) });
    expect(await party(acc(5))).toMatchObject([{ legal_name: 'Quick Edit v2 Pty Ltd' }]);
    const rows = await changesFor(acc(5));
    expect(rows.map((r) => [r.commitNumber, r.outcome])).toEqual([
      [BigInt(T0 + 9 * DAY), 'applied'],
      [BigInt(T0 + 9 * DAY), 'applied'],
    ]);
  });

  it('a snapshot older than an applied CDC change is skipped as ALREADY_CURRENT', async () => {
    // The poll read the row before a newer change, which CDC applied first (a race).
    fake.upsert('Account', acc(6), { Name: 'Old Read Pty Ltd' }, at(10 * DAY));
    await deliverCdc(
      cdc('Account', acc(6), 'CREATE', at(10 * DAY + 5000), { Name: 'Newer Via CDC Pty Ltd' }),
    );
    await pollObject({ ...base(), entity: 'Account', now: () => at(10 * DAY + 9000) });
    expect(await party(acc(6))).toMatchObject([{ legal_name: 'Newer Via CDC Pty Ltd' }]);
    expect((await changesFor(acc(6))).map((r) => [r.source, r.outcome, r.issueCode])).toEqual([
      ['/data/AccountChangeEvent', 'applied', null],
      ['poll:Account', 'ignored', 'ALREADY_CURRENT'],
    ]);
  });

  it('watermark never moves backward, mode and intervals are checked, and another tenant sees nothing', async () => {
    await expect(
      q((trx) =>
        sql`UPDATE app.salesforce_sync_object SET watermark = watermark - interval '1 day'
             WHERE entity_name = 'Account'`.execute(trx),
      ),
    ).rejects.toThrow(/watermark never moves backward/);
    await expect(
      q((trx) => configureSyncObject(trx, f.companyId, 'Account', { mode: 'sometimes' as 'cdc' })),
    ).rejects.toThrow();
    await expect(
      q((trx) =>
        configureSyncObject(trx, f.companyId, 'Account', {
          mode: 'polling',
          pollIntervalSeconds: 5,
        }),
      ),
    ).rejects.toThrow();
    const seen = await withTenant(f.db, OTHER_TENANT, (trx) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM app.salesforce_sync_object`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe('0');
  });
});
