/**
 * SS-UC01-07 — inbound mapping of CDC changes to parties, contacts and products with idempotency
 * (T-0065; design §5.5, §5.6 rule 1; ADR-0006; RQ-0101; migration 0050). Real PostgreSQL as
 * lf_app; Salesforce is the local fake Pub/Sub server (no org).
 *
 * At this task's layer (DL-0295) "processed once" means: one party/contact/product state, one
 * processed-change row per (record Id, commit number, sequence number), and every further
 * delivery of the same change logged on that row as a duplicate — whether the subscriber's
 * per-channel inbox caught it (redelivery) or the mapping caught it (the same change from another
 * channel or source). The draft invoice of UC-01 is T-0069.
 *
 * Unmappable changes and inbound edits of LedgerForce-owned fields are reported through the issue
 * sink (in production an outbox event that the `salesforce.inbound` handler turns into a Sync
 * issue — apps/worker salesforce-inbound.issues.db.test.ts); here the sink records the event.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { auServicesSmb } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { toSalesforceId18 } from '@ledgerforce/parties';
import { seedPostingProfiles } from '@ledgerforce/products';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeEventHeader, DecodedEvent } from '../pubsub/avro.ts';
import { createPubSubClient, type PubSubClient } from '../pubsub/client.ts';
import { runSubscription } from '../pubsub/subscriber.ts';
import {
  ACCOUNT_CHANGE_SCHEMA_ID,
  accountChangeSchemaJson,
  encodeAccountChange,
} from '../testing/cdc-events.ts';
import { startFakePubSub, type FakePubSub } from '../testing/fake-pubsub-server.ts';
import {
  inboundCdcHandlers,
  inboundIssueMessage,
  listInboundChanges,
  type InboundIssue,
} from './index.ts';

/** The value, or a test failure when it is missing. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}

const TENANT = '01900000-0000-7000-8000-000000006501';
const TOPIC = '/data/AccountChangeEvent';
const AUTH = {
  accessToken: '00DTEST000000000!FAKE',
  instanceUrl: 'https://harbour-dev-ed.develop.my.salesforce.com',
  tenantId: '00DTEST000000000AAA',
};
const sfId = (prefix: string, n: number) =>
  toSalesforceId18(`${prefix}${String(n).padStart(12, '0')}`);
const acc = (n: number) => sfId('001', n);
const con = (n: number) => sfId('003', n);
const prd = (n: number) => sfId('01t', n);

let f: LedgerFixture;
let fake: FakePubSub;
let client: PubSubClient;
let commit = 9_000n;
const issues: InboundIssue[] = [];

/** Test sink: writes the outbox event the production sink would (no pg-boss job here). */
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

const handlers = (source: string) =>
  inboundCdcHandlers({ companyId: f.companyId, source, reportIssue: recordIssue });

function change(
  header: Partial<ChangeEventHeader> & Pick<ChangeEventHeader, 'entityName' | 'recordIds'>,
  fields: Record<string, unknown>,
): DecodedEvent {
  return {
    replayId: Buffer.from([0]),
    eventId: crypto.randomUUID(),
    schemaId: 'test',
    header: {
      changeType: 'CREATE',
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: `tx-${String(commit)}`,
      sequenceNumber: 1,
      commitTimestamp: 1_761_350_000_000n,
      commitNumber: (commit += 1n),
      commitUser: '005000000000001AAA',
      changedFields: [],
      nulledFields: [],
      diffFields: [],
      ...header,
    },
    fields,
  };
}

/** Apply decoded events through the subscriber's handler, one tenant transaction each. */
async function deliver(source: string, ...events: DecodedEvent[]): Promise<void> {
  const h = handlers(source);
  for (const e of events) {
    await f.inTenant((trx) => h.handler(trx, e, e.header?.recordIds ?? []));
  }
}

const q = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => f.inTenant(fn);

const partyBySf = (id: string) =>
  q((trx) =>
    trx
      .selectFrom('app.party')
      .select([
        'id',
        'legal_name',
        'status',
        'currency',
        'customer_profile_id',
        'supplier_profile_id',
      ])
      .where('salesforce_account_id', '=', id)
      .execute(),
  );

const changesFor = (recordId: string) =>
  q((trx) => listInboundChanges(trx, f.companyId, { recordId }));

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.inTenant((trx) =>
    seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct))),
  );
  fake = await startFakePubSub({ auth: AUTH, maxBatch: 10 });
  fake.registerSchema(ACCOUNT_CHANGE_SCHEMA_ID, accountChangeSchemaJson);
  client = createPubSubClient(fake.address, { insecure: true });
}, 120_000);

afterAll(async () => {
  client?.close();
  await fake?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC01-07: Duplicate CDC event is idempotent', () => {
  it('SS-UC01-07: Duplicate CDC event is idempotent — a redelivered Account change is processed once and logged as duplicate', async () => {
    const id = acc(1);
    const ac = new AbortController();
    let committed = 0;
    const waiters: (() => void)[] = [];
    const h = handlers(TOPIC);
    let handled = 0;
    const run = runSubscription({
      db: f.db,
      tenantId: TENANT,
      companyId: f.companyId,
      channel: TOPIC,
      client,
      auth: () => Promise.resolve(AUTH),
      handler: async (trx, e, ids) => {
        handled += 1;
        await h.handler(trx, e, ids);
      },
      onDuplicate: h.onDuplicate,
      signal: ac.signal,
      onCommitted: () => {
        committed += 1;
        waiters.splice(0).forEach((w) => w());
      },
    });
    run.catch(() => undefined);
    const batches = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => (committed >= n ? resolve() : waiters.push(check));
        check();
      });
    await fake.waitForStreams(fake.streams.length + 1);

    const thisCommit = (commit += 1n);
    const [replayId] = fake.publish(TOPIC, [
      {
        eventId: crypto.randomUUID(),
        schemaId: ACCOUNT_CHANGE_SCHEMA_ID,
        payload: encodeAccountChange({
          recordIds: [id],
          changeType: 'CREATE',
          commitNumber: thisCommit,
          fields: {
            Name: 'Harbour Freight Pty Ltd',
            Type: 'Customer - Direct',
            BillingCity: 'Sydney',
          },
        }),
      },
    ]);
    await batches(1);
    fake.redeliver(TOPIC, replayId as Buffer);
    await batches(2);
    ac.abort();
    await run;

    // One state: one party, customer role, profile from Account.Type.
    const parties = await partyBySf(id);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ legal_name: 'Harbour Freight Pty Ltd', status: 'active' });
    expect(parties[0]?.customer_profile_id).not.toBeNull();
    // Processed once: the handler ran once, one processed-change row, the second logged as duplicate.
    expect(handled).toBe(1);
    const rows = await changesFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityName: 'Account',
      commitNumber: thisCommit,
      sequenceNumber: 1,
      changeType: 'CREATE',
      outcome: 'applied',
      targetType: 'party',
      targetId: parties[0]?.id,
      duplicateCount: 1,
      lastDuplicateSource: TOPIC,
    });
  });

  it('SS-UC01-07: the same change from another channel is caught by the mapping and logged as duplicate', async () => {
    const id = acc(2);
    const e = change({ entityName: 'Account', recordIds: [id] }, { Name: 'Bayside Cafe Pty Ltd' });
    await deliver('/data/AccountChangeEvent', e);
    await deliver('/data/ChangeEvents', { ...e, eventId: crypto.randomUUID() });
    await deliver('reconcile', e);
    expect(await partyBySf(id)).toHaveLength(1);
    const rows = await changesFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'applied',
      source: '/data/AccountChangeEvent',
      duplicateCount: 2,
      lastDuplicateSource: 'reconcile',
    });
  });

  it('SS-UC01-07: two changes of one record in one transaction (same commit, next sequence) both apply', async () => {
    const id = acc(3);
    const created = change({ entityName: 'Account', recordIds: [id] }, { Name: 'Draft name' });
    const updated = change(
      {
        entityName: 'Account',
        recordIds: [id],
        changeType: 'UPDATE',
        commitNumber: must(created.header).commitNumber,
        sequenceNumber: 2,
        changedFields: ['Name'],
      },
      { Name: 'Final name Pty Ltd' },
    );
    await deliver(TOPIC, created, updated);
    expect((await partyBySf(id))[0]?.legal_name).toBe('Final name Pty Ltd');
    expect(
      (await changesFor(id)).map((r) => [r.sequenceNumber, r.outcome, r.duplicateCount]),
    ).toEqual([
      [1, 'applied', 0],
      [2, 'applied', 0],
    ]);
  });
});

describe('Inbound mapping with field ownership (design §5.5, ADR-0006)', () => {
  it('UPDATE changes only the changed fields; an LF-owned field edit is ignored and reported once', async () => {
    const id = acc(4);
    await deliver(
      TOPIC,
      change(
        { entityName: 'Account', recordIds: [id] },
        {
          Name: 'Southern Tiles Pty Ltd',
          CurrencyIsoCode: 'AUD',
          BillingAddress: {
            Street: '1 Pier St',
            City: 'Hobart',
            PostalCode: '7000',
            CountryCode: 'AU',
          },
        },
      ),
    );
    issues.length = 0;
    const upd = change(
      {
        entityName: 'Account',
        recordIds: [id],
        changeType: 'UPDATE',
        changedFields: ['BillingAddress.City', 'LF_Balance_Due__c', 'LastModifiedDate'],
      },
      {
        Name: null,
        CurrencyIsoCode: null,
        BillingAddress: { City: 'Launceston' },
        LF_Balance_Due__c: 0,
      },
    );
    await deliver(TOPIC, upd, upd);
    const [party] = await partyBySf(id);
    expect(party).toMatchObject({ legal_name: 'Southern Tiles Pty Ltd', currency: 'AUD' });
    const address = await q((trx) =>
      trx
        .selectFrom('app.party_address')
        .select(['line1', 'city', 'postcode', 'country'])
        .where('party_id', '=', must(party).id)
        .execute(),
    );
    expect(address).toEqual([
      { line1: '1 Pier St', city: 'Launceston', postcode: '7000', country: 'AU' },
    ]);
    expect(issues.map((i) => [i.kind, i.code, i.conflicts])).toEqual([
      ['conflict', 'LF_OWNED_FIELD', ['LF_Balance_Due__c']],
    ]);
    const rows = await changesFor(id);
    expect(rows[1]).toMatchObject({
      outcome: 'applied',
      appliedFields: ['billing.city'],
      conflictFields: ['LF_Balance_Due__c'],
      duplicateCount: 1,
    });
    expect(rows[1]?.issueEventId).not.toBeNull();
  });

  it('Account.Type mapped to a supplier profile gives the supplier role', async () => {
    const id = acc(5);
    await deliver(
      TOPIC,
      change(
        { entityName: 'Account', recordIds: [id] },
        { Name: 'Paper Mill Pty Ltd', Type: 'Supplier' },
      ),
    );
    const [p] = await partyBySf(id);
    expect(p?.supplier_profile_id).not.toBeNull();
    const roles = await q((trx) =>
      trx.selectFrom('app.party_role').select('role').where('party_id', '=', must(p).id).execute(),
    );
    expect(roles.map((r) => r.role)).toEqual(['supplier']);
  });

  it('Contact maps to a contact of the Account’s party; an unknown Account is reported as unmappable', async () => {
    const id = acc(6);
    await deliver(
      TOPIC,
      change({ entityName: 'Account', recordIds: [id] }, { Name: 'Kestrel Labs Pty Ltd' }),
    );
    await deliver(
      '/data/ContactChangeEvent',
      change(
        { entityName: 'Contact', recordIds: [con(1)] },
        {
          AccountId: id,
          Name: { FirstName: 'Mia', LastName: 'Chen' },
          Email: 'mia@kestrel.example',
        },
      ),
    );
    const [party] = await partyBySf(id);
    const contacts = await q((trx) =>
      trx
        .selectFrom('app.party_contact')
        .select(['party_id', 'name', 'email', 'status'])
        .where('salesforce_contact_id', '=', con(1))
        .execute(),
    );
    expect(contacts).toEqual([
      {
        party_id: must(party).id,
        name: 'Mia Chen',
        email: 'mia@kestrel.example',
        status: 'active',
      },
    ]);

    issues.length = 0;
    const orphan = change(
      { entityName: 'Contact', recordIds: [con(2)] },
      { AccountId: acc(999), Name: { LastName: 'Nobody' } },
    );
    await deliver('/data/ContactChangeEvent', orphan, orphan);
    expect(issues.map((i) => [i.kind, i.code])).toEqual([['unmappable', 'UNKNOWN_ACCOUNT']]);
    expect(await changesFor(con(2))).toMatchObject([
      { outcome: 'issue', issueCode: 'UNKNOWN_ACCOUNT', duplicateCount: 1 },
    ]);
  });

  it('Product2 maps Family to a product profile; an unmapped Family is unmappable; DELETE archives', async () => {
    await deliver(
      '/data/Product2ChangeEvent',
      change(
        { entityName: 'Product2', recordIds: [prd(1)] },
        { Name: 'Onboarding workshop', ProductCode: 'ONB-1', Family: 'Training', IsActive: true },
      ),
    );
    const product = () =>
      q((trx) =>
        trx
          .selectFrom('app.product')
          .select(['sku', 'name', 'status', 'product_profile_id'])
          .where('salesforce_product2_id', '=', prd(1))
          .execute(),
      );
    expect(await product()).toMatchObject([
      { sku: 'ONB-1', name: 'Onboarding workshop', status: 'active' },
    ]);

    issues.length = 0;
    await deliver(
      '/data/Product2ChangeEvent',
      change(
        { entityName: 'Product2', recordIds: [prd(2)] },
        { Name: 'Mystery', ProductCode: 'MYS-1', Family: 'Unknown family' },
      ),
    );
    expect(issues.map((i) => i.code)).toEqual(['UNMAPPED_FAMILY']);
    expect(
      await q((trx) =>
        trx
          .selectFrom('app.product')
          .select('id')
          .where('salesforce_product2_id', '=', prd(2))
          .execute(),
      ),
    ).toEqual([]);

    await deliver(
      '/data/Product2ChangeEvent',
      change({ entityName: 'Product2', recordIds: [prd(1)], changeType: 'DELETE' }, {}),
    );
    expect(await product()).toMatchObject([{ status: 'archived' }]);
    expect((await changesFor(prd(1))).map((r) => r.outcome)).toEqual(['applied', 'archived']);
  });

  it('another tenant sees none of the processed changes (RLS)', async () => {
    const other = '01900000-0000-7000-8000-000000006502';
    await f.tdb.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Other')`, [other]);
    const seen = await withTenant(f.db, other, (trx) =>
      sql`SELECT id FROM app.salesforce_inbound_change`.execute(trx),
    );
    expect(seen.rows).toEqual([]);
    const mine = await f.inTenant((trx) =>
      sql`SELECT id FROM app.salesforce_inbound_change`.execute(trx),
    );
    expect(mine.rows.length).toBeGreaterThan(0);
  });
});
