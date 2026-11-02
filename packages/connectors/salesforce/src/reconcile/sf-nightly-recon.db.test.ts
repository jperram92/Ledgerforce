/**
 * SS-PLAT-26 — the nightly reconciliation end to end (T-0070; design §5.3; RQ-0103, RQ-0110;
 * migrations 0050–0053). Real PostgreSQL as lf_app; Salesforce is the local fakes of the
 * documented REST query, Get Deleted and sObject Collections resources (no org).
 *
 * The connector is offline for 3 days, beyond CDC's 72-hour retention, and write-back deliveries
 * fail meanwhile. One nightly run then: replays every changed record once (inbound half, T-0066),
 * archives records purged from the Recycle Bin (invisible to queryAll), and re-pushes the stale
 * write-backs per record with the newest values — an old event is never replayed over a newer one,
 * and re-pushed events get their inbox row so a late outbox retry cannot roll Salesforce back.
 *
 * Outbound timestamps (outbox created_at / inbox processed_at) are on the database clock, so they
 * are laid out relative to the real clock; Salesforce timestamps use the scenario clock T0.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { toSalesforceId18 } from '@ledgerforce/parties';
import { seedPostingProfiles } from '@ledgerforce/products';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboundIssueMessage, listInboundChanges, type InboundIssue } from '../inbound/index.ts';
import { getSyncObject, type QuerySession } from '../polling/index.ts';
import {
  startFakeSalesforceQuery,
  type FakeSalesforceQuery,
} from '../testing/fake-salesforce-query.ts';
import {
  startFakeSalesforceRest,
  type FakeSalesforceRest,
} from '../testing/fake-salesforce-rest.ts';
import type { RestSession } from '../writeback/collections.ts';
import { SALESFORCE_WRITEBACK_HANDLER } from '../writeback/writeback.ts';
import {
  configureReconciliation,
  getReconciliation,
  listReconciliationRuns,
  runNightlyReconciliation,
} from './index.ts';

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}

const TENANT = '01900000-0000-7000-8000-000000007001';
const OTHER_TENANT = '01900000-0000-7000-8000-000000007002';
const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const TOKEN = '00DTEST000000000!RECON';
const sfId = (prefix: string, n: number) =>
  toSalesforceId18(`${prefix}${String(n).padStart(12, '0')}`);
const acc = (n: number) => sfId('001', n);
const con = (n: number) => sfId('003', n);
const OPP = sfId('006', 1);
const lf = (n: number) => `01900000-0000-7000-8000-0000000702${String(n).padStart(2, '0')}`;
const INV1 = lf(1);
const INV2 = lf(2);
const INV3 = lf(3);
const PAY1 = lf(11);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Scenario clock (Salesforce and the run's `now`). */
const T0 = Date.parse('2026-10-26T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
/** Database clock for outbox rows: the outage happened over the last few real days. */
const OB = Date.now() - 6 * DAY;
const ob = (ms: number) => new Date(OB + ms);

let f: LedgerFixture;
let fq: FakeSalesforceQuery;
let fr: FakeSalesforceRest;
let clock = at(0);
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
const query = (): QuerySession => ({ http: fq.http, instanceUrl: INSTANCE, accessToken: TOKEN });
const rest = (): RestSession => ({ http: fr.http, instanceUrl: INSTANCE, accessToken: TOKEN });
const nightly = (now: Date, extra: { force?: boolean } = {}) => {
  clock = now;
  return runNightlyReconciliation({
    db: f.db,
    tenantId: TENANT,
    companyId: f.companyId,
    query: query(),
    rest: rest(),
    reportIssue: recordIssue,
    now: () => now,
    ...extra,
  });
};

/** A write-back outbox event (as T-0067/T-0069 producers write it) at a database time. */
async function writeBackEvent(
  topic: string,
  createdAt: Date,
  writeBack: Record<string, unknown>,
  deliveredAt: Date | null,
): Promise<string> {
  return q(async (trx) => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload, created_at)
      VALUES (${f.companyId}, ${topic}, 'sales_invoice', ${crypto.randomUUID()},
              ${JSON.stringify({ writeBack: { version: 1, ...writeBack } })}::jsonb, ${createdAt})
      RETURNING id`.execute(trx);
    const id = must(rows[0]).id;
    if (deliveredAt) {
      await sql`INSERT INTO app.outbox_inbox (event_id, handler, processed_at)
                VALUES (${id}, ${SALESFORCE_WRITEBACK_HANDLER}, ${deliveredAt})`.execute(trx);
    }
    return id;
  });
}
const delivered = (eventId: string) =>
  q(async (trx) => {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM app.outbox_inbox
       WHERE event_id = ${eventId} AND handler = ${SALESFORCE_WRITEBACK_HANDLER}`.execute(trx);
    return Number(must(rows[0]).n) === 1;
  });
const lastChange = async (recordId: string) =>
  (await q((trx) => listInboundChanges(trx, f.companyId, { recordId })))
    .sort((a, b) => a.processedAt.getTime() - b.processedAt.getTime())
    .at(-1);
const party = (id: string) =>
  q((trx) =>
    trx
      .selectFrom('app.party')
      .select(['legal_name', 'status'])
      .where('salesforce_account_id', '=', id)
      .execute(),
  );
const stored = (type: string, key: string) => fr.store.get(type)?.get(key);
const fullCompares = (entity: string) =>
  fq.requests.filter((r) => {
    const p = decodeURIComponent(r.path);
    // The id-only comparison query (the inbound delta also selects the mapped fields).
    return p.includes(`SELECT Id, SystemModstamp, IsDeleted FROM ${entity} WHERE`);
  }).length;

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.inTenant((trx) =>
    seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct))),
  );
  fq = await startFakeSalesforceQuery({
    instanceUrl: INSTANCE,
    acceptToken: (t) => t === TOKEN,
    pageSize: 3,
  });
  fq.serverTime = () => clock;
  fq.define('Account', ['Name', 'Type', 'BillingCity']);
  fq.define('Contact', ['AccountId', 'FirstName', 'LastName', 'Email']);
  fq.define('Product2', ['Name', 'ProductCode', 'Family', 'IsActive']);
  fq.define('Opportunity', ['Name', 'AccountId', 'StageName', 'IsWon', 'CloseDate', 'Amount']);
  fq.define('Order', ['AccountId', 'Status', 'StatusCode', 'EffectiveDate', 'TotalAmount']);
  fq.define('OpportunityLineItem', ['OpportunityId', 'Product2Id', 'Quantity', 'TotalPrice']);
  fq.define('OrderItem', ['OrderId', 'Product2Id', 'Quantity', 'TotalPrice']);
  fr = await startFakeSalesforceRest({ instanceUrl: INSTANCE, acceptToken: (t) => t === TOKEN });
  fr.seed('Account', acc(1), { LF_Balance_Due__c: '1375.00' });
  fr.seed('Opportunity', OPP, { LF_Invoice_Status__c: 'Posted', LF_Amount_Paid__c: '0.00' });
}, 120_000);

afterAll(async () => {
  await fq?.close();
  await fr?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-26: Missed Salesforce events recovered by nightly reconciliation', () => {
  it('SS-PLAT-26: Missed Salesforce events recovered by nightly reconciliation — after a 3-day outage one nightly run replays changes once, archives purged records and re-pushes stale write-backs', async () => {
    // Day 0: the connector is live. The schedule is data; the first run is due at 01:00.
    await q((trx) => configureReconciliation(trx, f.companyId, { nextRunAt: at(HOUR) }));
    fq.upsert('Account', acc(1), { Name: 'Harbour Freight Pty Ltd' }, at(1000));
    fq.upsert('Account', acc(2), { Name: 'Closing Down Pty Ltd' }, at(2000));
    fq.upsert(
      'Contact',
      con(1),
      { AccountId: acc(1), FirstName: 'Ana', LastName: 'Reyes' },
      at(3000),
    );
    expect(await nightly(at(HOUR - 1000))).toBeNull(); // not due yet
    const first = must(await nightly(at(HOUR)));
    expect(first.outcome).toBe('succeeded');
    // The first purge check has no previous point: every object's ids are compared once.
    expect(first.purges.map((p) => [p.entity, p.fullCompare, p.archived])).toEqual([
      ['Account', true, 0],
      ['Contact', true, 0],
      ['Product2', true, 0],
      ['Opportunity', true, 0],
      ['Order', true, 0],
      ['OpportunityLineItem', true, 0],
      ['OrderItem', true, 0],
    ]);
    expect((await q((trx) => getReconciliation(trx, f.companyId)))?.nextRunAt).toEqual(
      at(HOUR + DAY),
    );
    expect(await nightly(at(2 * HOUR))).toBeNull(); // once a night

    // INV-1 was posted and its write-back delivered before the outage.
    await writeBackEvent(
      'invoice.posted',
      ob(0),
      {
        invoices: [
          {
            id: INV1,
            number: 'INV-000001',
            status: 'posted',
            total: '1375.0000',
            amountDue: '1375.0000',
            accountSfId: acc(1),
            opportunitySfId: OPP,
          },
        ],
        opportunities: [{ sfId: OPP, invoiceStatus: 'posted', amountInvoiced: '1375.0000' }],
      },
      ob(60_000),
    );
    fr.seed('LF_Invoice__c', INV1, {
      Name: 'INV-000001',
      LF_Status__c: 'Posted',
      LF_Amount_Due__c: '1375.00',
    });

    // Days 1–3: offline beyond CDC's 72 h retention. Salesforce changes …
    fq.upsert('Account', acc(1), { Name: 'Harbour Freight Group Pty Ltd' }, at(DAY));
    fq.remove('Account', acc(2), at(DAY + 60_000));
    fq.purge('Account', acc(2), at(2 * DAY)); // Recycle Bin emptied: gone from queryAll
    fq.upsert('Account', acc(4), { Name: 'Bayside Cafe Pty Ltd' }, at(2 * DAY + 5000));
    fq.purge('Contact', con(1), at(3 * DAY)); // hard delete: only the delete log knows
    // … and every write-back delivery fails (dead-lettered after the retries).
    const paid = await writeBackEvent(
      'invoice.paid',
      ob(DAY),
      {
        invoices: [
          { id: INV1, status: 'paid', amountDue: '0.0000', lastPaymentDate: '2026-10-27' },
        ],
        payments: [
          {
            id: PAY1,
            invoiceId: INV1,
            paymentDate: '2026-10-27',
            amount: '1375.0000',
            method: 'card',
            accountSfId: acc(1),
          },
        ],
        opportunities: [{ sfId: OPP, invoiceStatus: 'paid', amountPaid: '1375.0000' }],
        accounts: [{ sfId: acc(1), balanceDue: '0.0000', lastPaymentDate: '2026-10-27' }],
      },
      null,
    );
    // INV-2: "overdue" was retried with backoff and landed after the newer "paid" (out of order).
    await writeBackEvent(
      'invoice.overdue',
      ob(DAY + HOUR),
      { invoices: [{ id: INV2, status: 'overdue', daysOverdue: 3 }] },
      ob(3 * DAY),
    );
    await writeBackEvent(
      'invoice.paid',
      ob(DAY + 2 * HOUR),
      { invoices: [{ id: INV2, status: 'paid', daysOverdue: 0 }] },
      ob(DAY + 2 * HOUR + 60_000),
    );
    fr.seed('LF_Invoice__c', INV2, { LF_Status__c: 'Overdue', LF_Days_Overdue__c: '3' });
    // INV-3: the old "drafted" never arrived, but the newer "posted" did — nothing to re-push.
    const drafted = await writeBackEvent(
      'invoice.drafted',
      ob(2 * DAY),
      { invoices: [{ id: INV3, number: 'INV-000003', status: 'draft' }] },
      null,
    );
    await writeBackEvent(
      'invoice.posted',
      ob(2 * DAY + HOUR),
      { invoices: [{ id: INV3, number: 'INV-000003', status: 'posted' }] },
      ob(2 * DAY + HOUR + 60_000),
    );
    fr.seed('LF_Invoice__c', INV3, { Name: 'INV-000003', LF_Status__c: 'Posted' });

    // Night of day 4: the connector is back and the nightly run is due.
    fq.requests.length = 0;
    fr.requests.length = 0;
    const night = must(await nightly(at(4 * DAY)));
    expect(night.outcome).toBe('succeeded');
    expect(night.errors).toEqual([]);

    // Inbound: the changes made while offline are replayed once.
    const inbound = Object.fromEntries(night.inbound.map((r) => [r.entity, r]));
    expect(inbound.Account).toMatchObject({ applied: 2, issues: 0 });
    expect(await party(acc(1))).toEqual([
      { legal_name: 'Harbour Freight Group Pty Ltd', status: 'active' },
    ]);
    expect(await party(acc(4))).toEqual([{ legal_name: 'Bayside Cafe Pty Ltd', status: 'active' }]);

    // Purges: acc 2 was soft-deleted and purged — queryAll never showed the delete; the delete log
    // lost it too (earliestDateAvailable moved), so the ids were compared. Con 1's hard delete is in
    // the delete log, stamped with its deletedDate. Product2 had no gap: no full comparison.
    const purges = Object.fromEntries(night.purges.map((p) => [p.entity, p]));
    expect(purges.Account).toMatchObject({ fullCompare: true, archived: 1 });
    expect(purges.Contact).toMatchObject({ fullCompare: true, listed: 1, archived: 1 });
    expect(purges.Product2).toMatchObject({ fullCompare: false, archived: 0 });
    expect(fullCompares('Account')).toBe(1);
    expect(fullCompares('Product2')).toBe(0);
    expect(await party(acc(2))).toMatchObject([{ status: 'archived' }]);
    expect(await lastChange(acc(2))).toMatchObject({
      source: 'reconcile:purge',
      changeType: 'DELETE',
      outcome: 'archived',
      commitNumber: BigInt(T0 + 4 * DAY), // latestDateCovered: Salesforce's clock
    });
    expect(await lastChange(con(1))).toMatchObject({
      source: 'reconcile:purge',
      changeType: 'DELETE',
      commitNumber: BigInt(T0 + 3 * DAY), // its deletedDate
    });
    expect(issues).toEqual([]);

    // Write-back: stale records re-pushed with the newest values, per record.
    expect(night.writeBack).toMatchObject({ staleRecords: 5, pushed: 5, failed: 0, marked: 2 });
    expect(stored('LF_Invoice__c', INV1)).toMatchObject({
      LF_Status__c: 'Paid',
      LF_Amount_Due__c: '0.00',
    });
    expect(stored('LF_Payment__c', PAY1)).toMatchObject({ LF_Amount__c: '1375.00' });
    expect(stored('Opportunity', OPP)).toMatchObject({
      LF_Invoice_Status__c: 'Paid',
      LF_Amount_Paid__c: '1375.00',
    });
    expect(stored('Account', acc(1))).toMatchObject({ LF_Balance_Due__c: '0.00' });
    expect(stored('LF_Invoice__c', INV2)).toMatchObject({
      LF_Status__c: 'Paid',
      LF_Days_Overdue__c: '0',
    });
    expect(fr.requests.some((r) => r.rawBody.includes(INV3))).toBe(false);
    // The re-pushed (and the superseded) events now have their inbox row: a late outbox retry of
    // the old event finds it and skips, so it can never roll Salesforce back.
    expect(await delivered(paid)).toBe(true);
    expect(await delivered(drafted)).toBe(true);
    const retry = await q((trx) =>
      sql`INSERT INTO app.outbox_inbox (event_id, handler) VALUES (${drafted}, ${SALESFORCE_WRITEBACK_HANDLER})
          ON CONFLICT DO NOTHING RETURNING handler`.execute(trx),
    );
    expect(retry.rows).toEqual([]);

    // The next night: nothing changed, so nothing is re-applied, re-compared or re-pushed.
    fq.requests.length = 0;
    fr.requests.length = 0;
    const next = must(await nightly(at(5 * DAY)));
    expect(next.inbound.reduce((n, r) => n + r.applied + r.archived, 0)).toBe(0);
    expect(next.purges.every((p) => !p.fullCompare && p.archived === 0)).toBe(true);
    expect(next.writeBack).toMatchObject({ staleRecords: 0, pushed: 0 });
    expect(fr.requests).toEqual([]);

    const runs = await q((trx) => listReconciliationRuns(trx, f.companyId));
    expect(runs.map((r) => r.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(must(runs[1]).report).toMatchObject({ writeBack: { pushed: 5 } });
  });

  it('SS-PLAT-26: a Salesforce outage during the run is recorded, nothing is marked, and the run is retried within the hour', async () => {
    const pending = await writeBackEvent(
      'invoice.overdue',
      ob(4 * DAY),
      { invoices: [{ id: INV1, status: 'overdue', daysOverdue: 1 }] },
      null,
    );
    fr.outage = { status: 503 };
    const run = must(await nightly(at(6 * DAY)));
    fr.outage = null;
    expect(run.outcome).toBe('failed');
    expect(run.errors.join(' ')).toMatch(/unavailable/);
    expect(await delivered(pending)).toBe(false);
    expect((await q((trx) => getReconciliation(trx, f.companyId)))?.nextRunAt).toEqual(
      at(6 * DAY + HOUR),
    );
    const runs = await q((trx) => listReconciliationRuns(trx, f.companyId));
    expect(must(runs.at(-1))).toMatchObject({
      outcome: 'failed',
      error: expect.stringMatching(/unavailable/),
    });

    const retried = must(await nightly(at(6 * DAY + HOUR)));
    expect(retried.outcome).toBe('succeeded');
    expect(stored('LF_Invoice__c', INV1)).toMatchObject({
      LF_Status__c: 'Overdue',
      LF_Days_Overdue__c: '1',
    });
    expect(await delivered(pending)).toBe(true);
  });

  it('the run log is append-only, the purge check never moves backward, and another tenant sees nothing', async () => {
    await expect(
      q((trx) => sql`UPDATE app.salesforce_reconciliation_run SET outcome = 'failed'`.execute(trx)),
    ).rejects.toThrow();
    await expect(
      q((trx) =>
        sql`UPDATE app.salesforce_sync_object
               SET deletes_checked_until = deletes_checked_until - interval '1 day'
             WHERE entity_name = 'Account'`.execute(trx),
      ),
    ).rejects.toThrow(/never moves backward/);
    expect(must(await q((trx) => getSyncObject(trx, f.companyId, 'Account')))).toBeTruthy();
    const seen = await withTenant(f.db, OTHER_TENANT, (trx) =>
      sql<{ n: string }>`SELECT (SELECT count(*) FROM app.salesforce_reconciliation)
                              + (SELECT count(*) FROM app.salesforce_reconciliation_run) AS n`.execute(
        trx,
      ),
    );
    expect(seen.rows[0]?.n).toBe('0');
  });
});
