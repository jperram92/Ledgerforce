/**
 * T-0065 — inbound idempotency and ordering (design §5.3, §5.6 rule 1; RQ-0098; migration 0034).
 * Runs as lf_app in tenant transactions against a real PostgreSQL; the Pub/Sub side is the local
 * fake server from T-0064 (no org).
 *
 * SS-UC01-07 (master-data layer): the same CDC event twice → one party; the replay is a no-op,
 * dropped by the T-0064 inbox key or counted as a duplicate by the record's version (CDC commit
 * number or SystemModstamp). SS-UC01-13: stale changes, delete / undelete.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPubSubClient, type PubSubClient } from '../pubsub/client.ts';
import { runSubscription } from '../pubsub/subscriber.ts';
import { startFakePubSub, type FakePubSub } from '../testing/fake-pubsub-server.ts';
import { cdc1, startInboundWorld, type InboundWorld } from '../testing/inbound-world.ts';
import {
  encodeMasterDataChange,
  MASTER_DATA_SCHEMA_IDS,
  MASTER_DATA_TOPICS,
  masterDataSchemaJson,
  sfId,
} from '../testing/master-data-events.ts';
import { getRecordSync, salesforceInboundHandler } from './apply.ts';
import { changeFromSnapshot } from './changes.ts';

const T = '01900000-0000-7000-8000-0000000065a1';
const AUTH = {
  accessToken: '00DTEST000000000!FAKE',
  instanceUrl: 'https://harbour-dev-ed.develop.my.salesforce.com',
  tenantId: '00DTEST000000000AAA',
};
let w: InboundWorld;
let fake: FakePubSub;
let client: PubSubClient;

const parties = (sfAccountId: string) =>
  w.inTenant((trx) =>
    trx
      .selectFrom('app.party')
      .select(['id', 'legal_name', 'status'])
      .where('company_id', '=', w.companyId)
      .where('salesforce_account_id', '=', sfAccountId)
      .execute(),
  );
const sync = (entity: 'Account' | 'Contact' | 'Product2', id: string) =>
  w.inTenant((trx) => getRecordSync(trx, w.companyId, entity, id));
const account = (n: number, commitNumber: bigint, name: string) =>
  cdc1({
    entity: 'Account',
    recordIds: [sfId('001', n)],
    changeType: 'CREATE',
    commitNumber,
    fields: { Name: name, Type: 'Customer - Direct' },
  });
const rename = (n: number, commitNumber: bigint, name: string, sequenceNumber = 1) =>
  cdc1({
    entity: 'Account',
    recordIds: [sfId('001', n)],
    changeType: 'UPDATE',
    commitNumber,
    sequenceNumber,
    fields: { Name: name },
    changed: ['Name'],
  });

beforeAll(async () => {
  w = await startInboundWorld(T);
  fake = await startFakePubSub({ auth: AUTH, maxBatch: 10 });
  fake.registerSchema(MASTER_DATA_SCHEMA_IDS.Account, masterDataSchemaJson('Account'));
  client = createPubSubClient(fake.address, { insecure: true });
});

afterAll(async () => {
  client.close();
  await fake.close();
  await w.close();
});

describe('SS-UC01-07: Duplicate CDC event is idempotent [T-0065]', () => {
  it('a redelivered Account CREATE through the subscriber gives one party; the replay applies nothing', async () => {
    const ACC = sfId('001', 1);
    const topic = MASTER_DATA_TOPICS.Account;
    const commits: number[] = [];
    let wake: (() => void) | null = null;
    const ac = new AbortController();
    const s = fake.streams.length;
    const outcome = runSubscription({
      db: w.db,
      tenantId: T,
      companyId: w.companyId,
      channel: topic,
      client,
      auth: () => Promise.resolve(AUTH),
      handler: salesforceInboundHandler(w.companyId),
      signal: ac.signal,
      onCommitted: (c) => {
        commits.push(c.applied);
        wake?.();
      },
    });
    const committed = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (commits.length >= n) resolve();
        };
        wake = check;
        check();
      });
    await fake.waitForStreams(s + 1);
    const payload = encodeMasterDataChange({
      entity: 'Account',
      recordIds: [ACC],
      changeType: 'CREATE',
      commitNumber: 1082985383811n,
      fields: { Name: 'Harbour Freight Pty Ltd', Type: 'Customer - Direct' },
    });
    const [first] = fake.publish(topic, [
      { eventId: crypto.randomUUID(), schemaId: MASTER_DATA_SCHEMA_IDS.Account, payload },
    ]);
    await committed(1);
    // At-least-once delivery: the same event again, then the same change as a new delivery.
    fake.redeliver(topic, first as Buffer);
    await committed(2);
    fake.publish(topic, [
      { eventId: crypto.randomUUID(), schemaId: MASTER_DATA_SCHEMA_IDS.Account, payload },
    ]);
    await committed(3);
    ac.abort();
    await outcome;

    expect(await parties(ACC)).toEqual([
      expect.objectContaining({ legal_name: 'Harbour Freight Pty Ltd', status: 'active' }),
    ]);
    expect(commits).toEqual([1, 0, 0]);
    const keys = await w.inTenant((trx) =>
      sql<{ idempotency_key: string }>`SELECT idempotency_key FROM app.salesforce_event_inbox
        WHERE company_id = ${w.companyId} AND channel = ${topic}`.execute(trx),
    );
    expect(keys.rows.map((r) => r.idempotency_key)).toEqual([`cdc:Account:${ACC}:1082985383811:1`]);
    expect(await sync('Account', ACC)).toMatchObject({
      state: 'applied',
      lastKey: `cdc:Account:${ACC}:1082985383811:1`,
    });
  });

  it('the same change applied twice (any path) is a no-op the second time and is logged as duplicate', async () => {
    const ACC = sfId('001', 2);
    const c = account(2, 2000n, 'Bondi Surf Co');
    expect((await w.apply(c)).outcome).toBe('applied');
    const again = await w.apply(c);
    expect(again.outcome).toBe('duplicate');
    expect(await parties(ACC)).toHaveLength(1);
    expect(await sync('Account', ACC)).toMatchObject({
      duplicates: 1,
      stale: 0,
      lastSkippedKey: c.key,
    });
  });

  it('a polled snapshot keyed on SystemModstamp is idempotent too', async () => {
    const ACC = sfId('001', 3);
    const at = new Date('2026-11-08T02:00:00.000Z');
    const snap = changeFromSnapshot('Account', ACC, { Name: 'Manly Ferries', Type: null }, at);
    expect((await w.apply(snap)).outcome).toBe('applied');
    expect((await w.apply({ ...snap })).outcome).toBe('duplicate');
    expect(await parties(ACC)).toHaveLength(1);
    expect(await sync('Account', ACC)).toMatchObject({ duplicates: 1, lastKey: snap.key });
  });
});

describe('SS-UC01-13: out-of-order, delete and undelete events [T-0065]', () => {
  it('an older UPDATE arriving after a newer one is ignored as stale', async () => {
    const ACC = sfId('001', 10);
    await w.apply(account(10, 3000n, 'Coogee Bakery'));
    expect((await w.apply(rename(10, 3002n, 'Coogee Bakery Group'))).outcome).toBe('applied');
    expect((await w.apply(rename(10, 3001n, 'Coogee Bakehouse'))).outcome).toBe('stale');
    expect((await w.apply(rename(10, 3002n, 'Coogee Bakehouse', 0))).outcome).toBe('stale');
    expect(await parties(ACC)).toEqual([
      expect.objectContaining({ legal_name: 'Coogee Bakery Group' }),
    ]);
    expect(await sync('Account', ACC)).toMatchObject({ stale: 2, duplicates: 0 });
  });

  it('a polled snapshot older than the last CDC commit is stale; a newer one applies', async () => {
    const ACC = sfId('001', 11);
    const created = account(11, 3100n, 'Glebe Books');
    await w.apply(created);
    const older = new Date(created.version.at.getTime() - 1000);
    const newer = new Date(created.version.at.getTime() + 1000);
    expect(
      (await w.apply(changeFromSnapshot('Account', ACC, { Name: 'Old Glebe' }, older))).outcome,
    ).toBe('stale');
    expect(
      (await w.apply(changeFromSnapshot('Account', ACC, { Name: 'Glebe Books & Co' }, newer)))
        .outcome,
    ).toBe('applied');
    expect((await parties(ACC))[0]?.legal_name).toBe('Glebe Books & Co');
  });

  it('DELETE archives, a stale CREATE does not resurrect, UNDELETE re-activates; nothing is deleted', async () => {
    const ACC = sfId('001', 12);
    await w.apply(account(12, 3200n, 'Rozelle Joinery'));
    const del = cdc1({
      entity: 'Account',
      recordIds: [ACC],
      changeType: 'DELETE',
      commitNumber: 3201n,
    });
    expect((await w.apply(del)).outcome).toBe('applied');
    expect(await parties(ACC)).toEqual([expect.objectContaining({ status: 'archived' })]);
    expect(await sync('Account', ACC)).toMatchObject({ state: 'deleted' });
    expect((await w.apply(account(12, 3200n, 'Rozelle Joinery'))).outcome).toBe('stale');
    expect((await w.apply(rename(12, 3199n, 'Rozelle Old'))).outcome).toBe('stale');
    const undelete = cdc1({
      entity: 'Account',
      recordIds: [ACC],
      changeType: 'UNDELETE',
      commitNumber: 3202n,
      fields: { Name: 'Rozelle Joinery', Type: 'Customer - Direct' },
    });
    expect((await w.apply(undelete)).outcome).toBe('applied');
    expect(await parties(ACC)).toEqual([
      expect.objectContaining({ status: 'active', legal_name: 'Rozelle Joinery' }),
    ]);
    expect(await sync('Account', ACC)).toMatchObject({ state: 'applied' });
  });

  it('a DELETE seen before its (older) CREATE leaves no party', async () => {
    const ACC = sfId('001', 13);
    const del = cdc1({
      entity: 'Account',
      recordIds: [ACC],
      changeType: 'DELETE',
      commitNumber: 3301n,
    });
    expect((await w.apply(del)).outcome).toBe('applied');
    expect((await w.apply(account(13, 3300n, 'Too Late Pty Ltd'))).outcome).toBe('stale');
    expect(await parties(ACC)).toEqual([]);
    expect(await sync('Account', ACC)).toMatchObject({ state: 'deleted', stale: 1 });
  });

  it('Contact and Product2 deletes archive the contact and the product', async () => {
    const ACC = sfId('001', 14);
    const CON = sfId('003', 14);
    const PRD = sfId('01t', 14);
    await w.apply(account(14, 3400n, 'Tamarama Studio'));
    await w.apply(
      cdc1({
        entity: 'Contact',
        recordIds: [CON],
        changeType: 'CREATE',
        commitNumber: 3401n,
        fields: { AccountId: ACC, Name: { LastName: 'Nguyen' }, Email: 'ap@tamarama.example' },
      }),
    );
    await w.apply(
      cdc1({
        entity: 'Product2',
        recordIds: [PRD],
        changeType: 'CREATE',
        commitNumber: 3402n,
        fields: { Name: 'Studio hire', Family: 'Professional Services', IsActive: true },
      }),
    );
    for (const [entity, id, n] of [
      ['Contact', CON, 3403n],
      ['Product2', PRD, 3404n],
    ] as const) {
      const r = await w.apply(
        cdc1({ entity, recordIds: [id], changeType: 'DELETE', commitNumber: n }),
      );
      expect(r.outcome).toBe('applied');
    }
    const statuses = await w.inTenant(async (trx) => [
      await trx
        .selectFrom('app.party_contact')
        .select('status')
        .where('salesforce_contact_id', '=', CON)
        .executeTakeFirstOrThrow(),
      await trx
        .selectFrom('app.product')
        .select('status')
        .where('salesforce_product_id', '=', PRD)
        .executeTakeFirstOrThrow(),
    ]);
    expect(statuses).toEqual([{ status: 'archived' }, { status: 'archived' }]);
  });
});
