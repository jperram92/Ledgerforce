/**
 * Posting preview with the production outbox wired in (T-0026, SS-PLAT-15, RQ-0035), against a
 * real PostgreSQL with pg-boss installed and a runtime started (as T-0030's outbox tests).
 *
 * SS-PLAT-15 — preview writes no outbox event and no pg-boss job: the whole-database fingerprint
 *   (every table in every non-system schema, including pgboss.job and app.outbox_event, and every
 *   sequence) is unchanged by preview. post() with ledgerOutbox then writes the previewed journal
 *   plus exactly one event and one job.
 *
 * Commands are raw journals (no event posting rule: every golden posting is still Draft).
 */
import { withTenant } from '@ledgerforce/db';
import { post, preview, type PostingCommand } from '@ledgerforce/ledger';
import {
  createLedgerFixture,
  databaseFingerprint,
  expectedJournal,
  storedJournal,
  type LedgerFixture,
} from '@ledgerforce/ledger/testing';
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerOutbox } from './outbox.ts';
import { OUTBOX_QUEUE } from './queue.ts';
import { createOutboxHarness, type OutboxHarness } from './testing/harness.ts';

let f: LedgerFixture;
let h: OutboxHarness;
let boss: PgBoss;

const rent = (): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines: [
    { account: { id: f.acct['6200'] ?? '' }, debit: '1000.0000', memo: 'Rent October' },
    { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
  ],
});

const rows = (table: string, fp: Awaited<ReturnType<typeof databaseFingerprint>>) =>
  Number((fp.tables[table] ?? '').split(':')[0]);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002603');
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

describe('SS-PLAT-15 preview writes no outbox event or job [T-0026]', () => {
  it('SS-PLAT-15 preview leaves every table (incl. outbox_event and pgboss.job) and sequence unchanged; post then writes the previewed journal, one event and one job [T-0026]', async () => {
    const command = rent();
    const before = await databaseFingerprint(f.admin);
    expect(Object.keys(before.tables)).toEqual(
      expect.arrayContaining(['app.outbox_event', 'pgboss.job', 'app.account_balance']),
    );
    const built = await withTenant(h.app, f.tenantId, (trx) => preview(trx, command));
    expect(await databaseFingerprint(f.admin)).toEqual(before);

    const r = await withTenant(h.app, f.tenantId, (trx) =>
      post(trx, command, { outbox: ledgerOutbox(boss) }),
    );
    expect(await f.inTenant((trx) => storedJournal(trx, r.entryId))).toEqual(
      expectedJournal(built),
    );
    const after = await databaseFingerprint(f.admin);
    expect(rows('app.outbox_event', after)).toBe(rows('app.outbox_event', before) + 1);
    const jobs = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1`,
      [OUTBOX_QUEUE],
    );
    expect(jobs.rows[0]?.n).toBe(1);
    expect(h.errors).toEqual([]);
  });
});
