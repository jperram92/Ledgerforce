/**
 * SS-PLAT-14 — same idempotency key posts once (T-0025, design §3.9 step 1, RQ-0030), against a
 * real PostgreSQL as lf_app: sequential repeats, concurrent repeats on separate connections, a
 * key inserted concurrently outside the engine's lock, key reuse for another document, and the
 * key's scope (per company).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostingError, type PostingCommand } from './posting-command.ts';
import { post, type PostResult, type PostingOutbox } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
let wide: Kysely<Database>;

const command = (key: string, over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: key,
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  sourceId: 'JNL-1',
  lines: [
    { account: { id: f.acct['6200'] ?? '' }, debit: '250.0000' },
    { account: { role: 'SUSPENSE' }, credit: '250.0000' },
  ],
  ...over,
});

const entriesWithKey = (key: string) =>
  f.admin
    .query<{ id: string; company_id: string }>(
      `SELECT id, company_id FROM app.journal_entry WHERE tenant_id = $1 AND idempotency_key = $2`,
      [f.tenantId, key],
    )
    .then((r) => r.rows);

const seriesNext = (company: string) =>
  f.admin
    .query<{ next_value: string }>(
      `SELECT next_value::text FROM app.number_series WHERE tenant_id = $1 AND company_id = $2 AND code = 'je_manual_journal'`,
      [f.tenantId, company],
    )
    .then((r) => r.rows[0]?.next_value);

/** Holds every post in its write step a little, so concurrent calls really overlap. */
const slow: PostingOutbox = {
  async enqueue(trx) {
    await sql`SELECT pg_sleep(0.05)`.execute(trx);
  },
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002514');
  wide = createDb(f.tdb.url('lf_app'), 10);
  for (const company of [f.companyId, f.otherCompanyId]) {
    await f.inTenant((trx) =>
      trx
        .insertInto('app.number_series')
        .values({ company_id: company, code: 'je_manual_journal', prefix: 'MJ-' })
        .execute(),
    );
  }
});

afterAll(async () => {
  await wide.destroy();
  await f.close();
});

describe('SS-PLAT-14 same idempotency key posts once [T-0025]', () => {
  it('SS-PLAT-14 Same idempotency key posts once: the second call returns the first result [T-0025]', async () => {
    const key = randomUUID();
    const seriesBefore = await seriesNext(f.companyId);
    const first = await f.inTenant((trx) => post(trx, command(key)));
    const second = await f.inTenant((trx) => post(trx, command(key)));
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await entriesWithKey(key)).toHaveLength(1);
    // The number was taken once.
    expect(BigInt((await seriesNext(f.companyId)) ?? '0') - BigInt(seriesBefore ?? '0')).toBe(1n);
  });

  it('SS-PLAT-14 a replay returns the first result even if the command would now be refused [T-0025]', async () => {
    const key = randomUUID();
    const first = await f.inTenant((trx) => post(trx, command(key)));
    // Same document, but a date with no period: a fresh post would be refused (NO_PERIOD).
    const again = await f.inTenant((trx) => post(trx, command(key, { entryDate: '2030-01-01' })));
    expect(again).toEqual({ ...first, replayed: true });
  });

  it('SS-PLAT-14 concurrent posts with one key on separate connections create one entry [T-0025]', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTenant(wide, f.tenantId, (trx) => post(trx, command(key), { outbox: slow })),
      ),
    );
    const rows = await entriesWithKey(key);
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.entryId))).toEqual(new Set([rows[0]?.id]));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const firstResult = results.find((r) => !r.replayed) as PostResult;
    for (const r of results) expect(r).toEqual({ ...firstResult, replayed: r.replayed });
  });

  it('SS-PLAT-14 a key committed concurrently outside the engine lock is replayed, not an error [T-0025]', async () => {
    const key = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => {
      inserted = r;
    });
    // T1 writes an entry with the key directly (no engine, no advisory lock) and holds it open.
    const t1 = withTenant(wide, f.tenantId, async (trx) => {
      const id = await f.insertEntry(
        trx,
        [
          { code: '6200', debit: '250.0000' },
          { code: '2900', credit: '250.0000' },
        ],
        { idempotencyKey: key, sourceId: 'JNL-1', entryNo: `T1-${key.slice(0, 8)}` },
      );
      inserted();
      await gate;
      return id;
    });
    await insertedP;
    // T2 posts: its lookup cannot see T1's row; its insert waits on the unique key.
    const t2 = withTenant(wide, f.tenantId, (trx) => post(trx, command(key)));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const t1Id = await t1;
    const r2 = await t2;
    expect(r2).toMatchObject({ entryId: t1Id, entryNo: `T1-${key.slice(0, 8)}`, replayed: true });
    expect(await entriesWithKey(key)).toHaveLength(1);
  });

  it('SS-PLAT-14 a key reused for another document is refused and writes nothing [T-0025]', async () => {
    const key = randomUUID();
    await f.inTenant((trx) => post(trx, command(key)));
    const before = await f.countEntries();
    for (const over of [
      command(key, { sourceId: 'JNL-2' }),
      command(key, { sourceType: 'ar_invoice' }),
      (({ sourceId: _dropped, ...rest }) => rest)(command(key)), // no source id at all
    ]) {
      const err = await f.inTenant((trx) => post(trx, over)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PostingError);
      expect((err as PostingError).code).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(await f.countEntries()).toBe(before);
  });

  it('SS-PLAT-14 the key is scoped per company [T-0025]', async () => {
    const key = randomUUID();
    const a = await f.inTenant((trx) => post(trx, command(key)));
    const b = await f.inTenant((trx) =>
      post(
        trx,
        command(key, {
          companyId: f.otherCompanyId,
          lines: [
            { account: { id: f.otherAcct['6200'] ?? '' }, debit: '250.0000' },
            { account: { role: 'SUSPENSE' }, credit: '250.0000' },
          ],
        }),
      ),
    );
    expect(b.replayed).toBe(false);
    expect(b.entryId).not.toBe(a.entryId);
    expect((await entriesWithKey(key)).map((r) => r.company_id).sort()).toEqual(
      [f.companyId, f.otherCompanyId].sort(),
    );
  });
});
