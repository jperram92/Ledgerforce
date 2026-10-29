/**
 * Transactional outbox against a real PostgreSQL as lf_app (T-0030, ADR-0008, RQ-0033).
 *
 * SS-PLAT-68 — the outbox event and its delivery job commit atomically with the posting: a
 *   committed post has exactly one event and one job (job id = event id, payload = tenant + event
 *   ids only); a rolled-back post leaves neither; a replayed post adds nothing.
 * SS-PLAT-69 — role model: outbox rows are append-only for every role; pg-boss lives in schema
 *   `pgboss` owned by lf_migrator, where lf_app has DML (queue state) but no DDL, TRUNCATE or
 *   TRIGGER.
 *
 * Commands are raw journals (no event posting rule: every golden posting is still Draft).
 */
import { withTenant } from '@ledgerforce/db';
import { post, type PostingCommand } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerOutbox } from './outbox.ts';
import { OUTBOX_QUEUE } from './queue.ts';
import { createOutboxHarness, type OutboxHarness } from './testing/harness.ts';

let f: LedgerFixture;
let h: OutboxHarness;
let boss: PgBoss;

const rent = (key = randomUUID()): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: key,
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines: [
    { account: { id: f.acct['6200'] ?? '' }, debit: '1000.0000', memo: 'Rent October' },
    { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
  ],
});

const postWithOutbox = (command: PostingCommand) =>
  withTenant(h.app, f.tenantId, (trx) => post(trx, command, { outbox: ledgerOutbox(boss) }));

const eventsFor = async (entryId: string) =>
  (
    await f.admin.query<{ id: string; topic: string; aggregate_type: string; payload: unknown }>(
      `SELECT id, topic, aggregate_type, payload FROM app.outbox_event
        WHERE tenant_id = $1 AND aggregate_id = $2`,
      [f.tenantId, entryId],
    )
  ).rows;

const counts = async () =>
  (
    await f.admin.query<{ events: number; jobs: number }>(
      `SELECT (SELECT count(*) FROM app.outbox_event)::int AS events,
              (SELECT count(*) FROM pgboss.job WHERE name = $1)::int AS jobs`,
      [OUTBOX_QUEUE],
    )
  ).rows[0];

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003001');
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute(),
  );
  h = await createOutboxHarness(f.tdb);
  boss = await h.startRuntime();
});

afterAll(async () => {
  await h?.close();
  await f?.close();
});

describe('SS-PLAT-68 outbox event and job commit atomically with the posting', () => {
  it('SS-PLAT-68 a committed post writes one event and one job keyed by the event id', async () => {
    const r = await postWithOutbox(rent());
    const events = await eventsFor(r.entryId);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.topic).toBe('ledger.entry.posted');
    expect(event?.aggregate_type).toBe('journal_entry');
    expect(event?.payload).toMatchObject({ entryId: r.entryId, entryNo: r.entryNo });

    const job = await boss.getJobById<Record<string, unknown>>(OUTBOX_QUEUE, event?.id ?? '');
    expect(job?.state).toBe('created');
    // Only identifiers cross into the (non-RLS) pg-boss tables.
    expect(job?.data).toEqual({ tenantId: f.tenantId, eventId: event?.id });
  });

  it('SS-PLAT-68 a post rolled back by its caller leaves no event and no job', async () => {
    const before = await counts();
    const err = await withTenant(h.app, f.tenantId, async (trx) => {
      await post(trx, rent(), { outbox: ledgerOutbox(boss) });
      throw new Error('caller aborts');
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/caller aborts/);
    expect(await counts()).toEqual(before);
  });

  it('SS-PLAT-68 a replayed post (same idempotency key) adds no second event or job', async () => {
    const key = randomUUID();
    const first = await postWithOutbox(rent(key));
    const before = await counts();
    const again = await postWithOutbox(rent(key));
    expect(again).toMatchObject({ entryId: first.entryId, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await eventsFor(first.entryId)).toHaveLength(1);
  });

  it('SS-PLAT-68 a job that cannot be inserted undoes the entry and the event', async () => {
    const before = await counts();
    const entries = await f.countEntries();
    await f.admin.query('REVOKE INSERT ON pgboss.job, pgboss.job_common FROM lf_app');
    try {
      const err = await postWithOutbox(rent()).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('42501');
    } finally {
      await f.admin.query('GRANT INSERT ON pgboss.job, pgboss.job_common TO lf_app');
    }
    expect(await f.countEntries()).toBe(entries);
    expect(await counts()).toEqual(before);
  });
});

describe('SS-PLAT-69 outbox and queue privileges', () => {
  it('SS-PLAT-69 outbox events are append-only, also for their owner', async () => {
    const r = await postWithOutbox(rent());
    const id = (await eventsFor(r.entryId))[0]?.id ?? '';
    const asApp = (q: string) =>
      withTenant(f.db, f.tenantId, (trx) => sql.raw(q).execute(trx)).catch(
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(await asApp(`UPDATE app.outbox_event SET topic = 'x.y' WHERE id = '${id}'`)).toBe(
      '42501',
    );
    expect(await asApp(`DELETE FROM app.outbox_event WHERE id = '${id}'`)).toBe('42501');
    const owner = await f.admin.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('SET LOCAL ROLE lf_migrator');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [f.tenantId]);
      const upd = await owner
        .query(`UPDATE app.outbox_event SET topic = 'x.y' WHERE id = $1`, [id])
        .catch((e: unknown) => e as Error);
      expect(String(upd)).toMatch(/cannot change/);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });

  it('SS-PLAT-69 schema pgboss is owned by lf_migrator; lf_app has DML only, no DDL', async () => {
    const { rows } = await f.admin.query<{
      owner: string;
      app_create: boolean;
      app_usage: boolean;
    }>(
      `SELECT pg_get_userbyid(nspowner) AS owner,
              has_schema_privilege('lf_app', 'pgboss', 'CREATE') AS app_create,
              has_schema_privilege('lf_app', 'pgboss', 'USAGE') AS app_usage
         FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(rows[0]).toEqual({ owner: 'lf_migrator', app_create: false, app_usage: true });

    const tables = await f.admin.query<{ t: string; owner: string; privs: string[] }>(
      `SELECT c.relname AS t, pg_get_userbyid(c.relowner) AS owner,
              array(SELECT p FROM unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) p
                     WHERE has_table_privilege('lf_app', c.oid, p) ORDER BY p) AS privs
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p')`,
    );
    expect(tables.rows.length).toBeGreaterThan(5);
    for (const t of tables.rows) {
      expect(t.owner, t.t).toBe('lf_migrator');
      expect(t.privs, t.t).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('SS-PLAT-69 no pg-boss instance reported an error', () => {
    expect(h.errors).toEqual([]);
  });
});
