/**
 * SS-PLAT-27 / SS-PLAT-74 — the CDC subscriber commits each batch's effects, idempotency keys and
 * replay id in one tenant transaction (design §5.3, §5.6; RQ-0036; migration 0027), so a restart
 * resumes from the stored replay id R with nothing lost and nothing applied twice. An invalid or
 * expired replay id, a gap event and an overflow event become resync requests for the reconcile
 * job. Salesforce is the local fake Pub/Sub server built from the vendored proto (no org).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DecodedEvent } from './avro.ts';
import { createPubSubClient, type PubSubClient } from './client.ts';
import {
  advanceReplayCursor,
  getReplayCursor,
  listResyncRequests,
  ReplayCursorConflict,
} from './replay-store.ts';
import { runSubscription, type SubscriptionOutcome } from './subscriber.ts';
import {
  ACCOUNT_CHANGE_SCHEMA_ID,
  accountChangeSchemaJson,
  encodeAccountChange,
} from '../testing/cdc-events.ts';
import { startFakePubSub, type FakePubSub } from '../testing/fake-pubsub-server.ts';

const TA = '01900000-0000-7000-8000-00000000064a';
const TB = '01900000-0000-7000-8000-00000000064b';
const TOPIC = '/data/AccountChangeEvent';
const AUTH = {
  accessToken: '00DTEST000000000!FAKE',
  instanceUrl: 'https://harbour-dev-ed.develop.my.salesforce.com',
  tenantId: '00DTEST000000000AAA',
};
const acc = (n: number) => `001TEST${String(n).padStart(8, '0')}AAA`;

let tdb: TestDatabase;
let db: Kysely<Database>;
let companyA: string;
let companyB: string;
let companyA2: string;
let fake: FakePubSub;
let client: PubSubClient;
let commit = 1_000n;

async function seedTenant(id: string, name: string): Promise<string> {
  return withTenant(db, id, async (trx) => {
    await trx.insertInto('app.tenant').values({ id, name }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name, base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
}

/** The handler's effect: one row per (tenant, record, commit) applied, in the batch transaction. */
function recordingHandler(opts: { failOn?: string } = {}) {
  let failed = false;
  return async (trx: Transaction<Database>, event: DecodedEvent, recordIds: readonly string[]) => {
    for (const id of recordIds) {
      if (id === opts.failOn && !failed) {
        failed = true;
        throw new Error(`simulated crash while applying ${id}`);
      }
      await sql`INSERT INTO lf_test_effect (tenant, record_id, commit_number, change_type)
                VALUES (current_setting('app.tenant_id'), ${id},
                        ${String(event.header?.commitNumber)}, ${event.header?.changeType})`.execute(
        trx,
      );
    }
  };
}

async function effects(tenant: string) {
  const { rows } = await tdb.admin.query<{ record_id: string; commit_number: string }>(
    `SELECT record_id, commit_number FROM lf_test_effect WHERE tenant = $1 ORDER BY id`,
    [tenant],
  );
  return rows.map((r) => `${r.record_id}@${r.commit_number}`);
}

function publish(...records: { id: string; type?: string }[]): Buffer[] {
  return fake.publish(
    TOPIC,
    records.map((r) => ({
      eventId: crypto.randomUUID(),
      schemaId: ACCOUNT_CHANGE_SCHEMA_ID,
      payload: encodeAccountChange({
        recordIds: [r.id],
        changeType: r.type ?? 'UPDATE',
        commitNumber: (commit += 1n),
        fields: { Name: `Account ${r.id}` },
      }),
    })),
  );
}

/** Start a subscriber; resolve `committed(n)` once n batches have committed. */
function start(
  tenantId: string,
  companyId: string,
  handler = recordingHandler(),
  extra: { batchSize?: number } = {},
) {
  const ac = new AbortController();
  const waiters: { n: number; resolve: () => void }[] = [];
  let batches = 0;
  const outcome: Promise<SubscriptionOutcome> = runSubscription({
    db,
    tenantId,
    companyId,
    channel: TOPIC,
    client,
    auth: () => Promise.resolve(AUTH),
    handler,
    signal: ac.signal,
    ...extra,
    onCommitted: () => {
      batches += 1;
      for (const w of waiters.filter((x) => x.n <= batches)) w.resolve();
    },
  });
  outcome.catch(() => undefined);
  return {
    outcome,
    stop: async () => {
      ac.abort();
      return outcome;
    },
    /** Resolves after n committed batches; rejects if the subscription ends first. */
    committed: (n: number) =>
      Promise.race([
        new Promise<void>((resolve) => {
          if (batches >= n) resolve();
          else waiters.push({ n, resolve });
        }),
        outcome.then(
          (o) => {
            if (batches < n)
              throw new Error(`subscription ended (${o.status}) after ${String(batches)} batches`);
          },
          (e: unknown) => {
            throw e;
          },
        ),
      ]),
  };
}

const cursor = (tenant: string, companyId: string) =>
  withTenant(db, tenant, (trx) => getReplayCursor(trx, companyId, TOPIC));

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 4);
  await tdb.admin.query(`
    CREATE TABLE lf_test_effect (id bigserial PRIMARY KEY, tenant text NOT NULL,
      record_id text NOT NULL, commit_number text NOT NULL, change_type text NOT NULL);
    GRANT SELECT, INSERT ON lf_test_effect TO lf_app;
    GRANT USAGE ON SEQUENCE lf_test_effect_id_seq TO lf_app;`);
  companyA = await seedTenant(TA, 'Harbour & Co Pty Ltd');
  companyB = await seedTenant(TB, 'Other Tenant Pty Ltd');
  companyA2 = await withTenant(db, TA, async (trx) => {
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour Trading Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  // One Salesforce for the whole file: replay ids stay valid from test to test.
  fake = await startFakePubSub({ auth: AUTH, maxBatch: 3 });
  fake.registerSchema(ACCOUNT_CHANGE_SCHEMA_ID, accountChangeSchemaJson);
  client = createPubSubClient(fake.address, { insecure: true });
});

afterAll(async () => {
  client.close();
  await fake.close();
  await db.destroy();
  await tdb.close();
});

/** Index of the next stream the fake will see; wait for it with waitForStreams(i + 1). */
const nextStream = () => fake.streams.length;

describe('SS-PLAT-27: Replay id resume after restart', () => {
  it('resumes from the committed replay id R with no lost or duplicated effects', async () => {
    fake.setMaxBatch(3);
    // First run starts at the tip (no stored replay id).
    const s1 = nextStream();
    const run1 = start(TA, companyA, recordingHandler({ failOn: acc(5) }));
    await fake.waitForStreams(s1 + 1);
    expect(fake.streams[s1]?.requests[0]).toMatchObject({
      replayPreset: 'LATEST',
      topicName: TOPIC,
    });
    const ids = publish(...[1, 2, 3, 4, 5].map((n) => ({ id: acc(n) })));
    // Batch 1 = events 1..3 commits; batch 2 (4, 5) crashes on record 5 and rolls back whole.
    await expect(run1.outcome).rejects.toThrow(/simulated crash/);
    const r = await cursor(TA, companyA);
    expect(r?.replayId?.equals(ids[2] as Buffer)).toBe(true);
    expect(await effects(TA)).toEqual([1, 2, 3].map((n) => `${acc(n)}@${String(1000 + n)}`));

    // Restart: the first FetchRequest asks for CUSTOM after R; 4 and 5 arrive again, then 6.
    const s2 = nextStream();
    const run2 = start(TA, companyA);
    await fake.waitForStreams(s2 + 1);
    expect(fake.streams[s2]?.requests[0]).toMatchObject({
      topicName: TOPIC,
      replayPreset: 'CUSTOM',
      replayId: (ids[2] as Buffer).toString('hex'),
    });
    await run2.committed(1);
    const [id6] = publish({ id: acc(6) });
    await run2.committed(2);
    await expect(run2.stop()).resolves.toMatchObject({ status: 'aborted' });
    expect(await effects(TA)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `${acc(n)}@${String(1000 + n)}`),
    );
    expect((await cursor(TA, companyA))?.replayId?.equals(id6 as Buffer)).toBe(true);
  });

  it('drops a redelivered event by its idempotency key but still advances the cursor', async () => {
    const s = nextStream();
    const run = start(TA, companyA);
    await fake.waitForStreams(s + 1);
    const before = (await effects(TA)).length;
    const [a] = publish({ id: acc(7) });
    await run.committed(1);
    fake.redeliver(TOPIC, a as Buffer);
    await run.committed(2);
    await run.stop();
    const after = await effects(TA);
    expect(after.length - before).toBe(1);
    expect(after.filter((e) => e.startsWith(acc(7)))).toHaveLength(1);
    expect((await cursor(TA, companyA))?.eventsCommitted).toBeGreaterThanOrEqual(8);
  });

  it('asks for at most 100 events, and more only after a batch commits (flow control)', async () => {
    fake.setMaxBatch(2);
    const s = nextStream();
    const run = start(TA, companyA, recordingHandler(), { batchSize: 500 });
    await fake.waitForStreams(s + 1);
    expect(fake.streams[s]?.requests[0]?.numRequested).toBe(100);
    publish({ id: acc(8) }, { id: acc(9) }, { id: acc(10) });
    await run.committed(2);
    // The follow-up FetchRequests go out after each commit; wait for the fake to receive them.
    await vi.waitFor(() => {
      expect(fake.streams[s]?.requests.slice(1).map((q) => q.numRequested)).toEqual([2, 1]);
    });
    await run.stop();
    fake.setMaxBatch(3);
  });

  it('a keepalive with nothing in flight stores latest_replay_id, and a restart resumes there', async () => {
    const s = nextStream();
    const run = start(TA, companyA2);
    await fake.waitForStreams(s + 1);
    const tip = fake.keepalive(TOPIC);
    await run.committed(1);
    await run.stop();
    expect((await cursor(TA, companyA2))?.replayId?.equals(tip)).toBe(true);
    const run2 = start(TA, companyA2);
    await fake.waitForStreams(s + 2);
    expect(fake.streams[s + 1]?.requests[0]).toMatchObject({
      replayPreset: 'CUSTOM',
      replayId: tip.toString('hex'),
    });
    await run2.stop();
  });

  it('a stale cursor (another subscriber moved it) aborts the batch: compare-and-set', async () => {
    const before = await cursor(TA, companyA);
    await expect(
      withTenant(db, TA, (trx) =>
        advanceReplayCursor(trx, companyA, TOPIC, {
          expected: Buffer.from('00000000000000ff', 'hex'),
          next: Buffer.from('0000000000000fff', 'hex'),
          events: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(ReplayCursorConflict);
    expect((await cursor(TA, companyA))?.replayId?.equals(before?.replayId as Buffer)).toBe(true);
  });
});

describe('SS-PLAT-74: invalid replay id, gap and overflow events become resync requests', () => {
  it('an expired replay id resets the cursor, signals reconcile since the last commit, then LATEST', async () => {
    const last = await cursor(TA, companyA);
    expect(last?.replayId).not.toBeNull();
    fake.expireAll(TOPIC);
    const s = nextStream();
    const run = start(TA, companyA);
    await expect(run.outcome).resolves.toMatchObject({ status: 'replay_reset' });
    expect((await cursor(TA, companyA))?.replayId).toBeNull();
    const resync = await withTenant(db, TA, (trx) => listResyncRequests(trx, companyA, TOPIC));
    expect(resync.at(-1)).toMatchObject({
      reason: 'replay_id_invalid',
      entityName: null,
      recordIds: [],
      since: last?.committedAt,
      errorCode: 'sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted',
    });
    const run2 = start(TA, companyA);
    await fake.waitForStreams(s + 2);
    expect(fake.streams[s + 1]?.requests[0]?.replayPreset).toBe('LATEST');
    await run2.stop();
  });

  it('gap and overflow events are not applied: they request a resync of records / the entity', async () => {
    fake.setMaxBatch(5);
    const s = nextStream();
    const run = start(TA, companyA);
    await fake.waitForStreams(s + 1);
    const before = (await effects(TA)).length;
    publish(
      { id: acc(20), type: 'GAP_UPDATE' },
      { id: '000000000000000AAA', type: 'GAP_OVERFLOW' },
      { id: acc(21) },
    );
    await run.committed(1);
    await run.stop();
    expect((await effects(TA)).slice(before)).toEqual([`${acc(21)}@${String(commit)}`]);
    const resync = await withTenant(db, TA, (trx) => listResyncRequests(trx, companyA, TOPIC));
    expect(resync.slice(-2)).toMatchObject([
      {
        reason: 'gap_event',
        entityName: 'Account',
        recordIds: [acc(20)],
        changeType: 'GAP_UPDATE',
      },
      { reason: 'overflow', entityName: 'Account', recordIds: [], changeType: 'GAP_OVERFLOW' },
    ]);
    fake.setMaxBatch(3);
  });

  it('cursors, inbox and resync requests are per tenant: tenant B starts at its own tip', async () => {
    expect(await cursor(TB, companyB)).toBeNull();
    const s = nextStream();
    const run = start(TB, companyB);
    await fake.waitForStreams(s + 1);
    expect(fake.streams[s]?.requests[0]?.replayPreset).toBe('LATEST');
    // The same record and commit tenant A already applied is new for tenant B.
    const [r] = fake.publish(TOPIC, [
      {
        eventId: crypto.randomUUID(),
        schemaId: ACCOUNT_CHANGE_SCHEMA_ID,
        payload: encodeAccountChange({
          recordIds: [acc(1)],
          changeType: 'UPDATE',
          commitNumber: 1001n,
          fields: {},
        }),
      },
    ]);
    await run.committed(1);
    await run.stop();
    expect(await effects(TB)).toEqual([`${acc(1)}@1001`]);
    expect((await cursor(TB, companyB))?.replayId?.equals(r as Buffer)).toBe(true);
    // Under tenant B, tenant A's cursor and resync requests do not exist.
    expect(await withTenant(db, TB, (trx) => getReplayCursor(trx, companyA, TOPIC))).toBeNull();
    expect(await withTenant(db, TB, (trx) => listResyncRequests(trx, companyA, TOPIC))).toEqual([]);
  });

  it('the inbox is append-only and lf_app cannot rewrite a cursor key', async () => {
    await expect(
      withTenant(db, TA, (trx) => sql`DELETE FROM app.salesforce_event_inbox`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, TA, (trx) =>
        sql`UPDATE app.salesforce_replay_cursor SET channel = '/data/X'`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      tdb.admin.query(`UPDATE app.salesforce_event_inbox SET idempotency_key = 'x'`),
    ).rejects.toThrow();
  });
});
