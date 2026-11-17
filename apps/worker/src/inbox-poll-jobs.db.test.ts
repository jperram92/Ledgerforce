/**
 * Bills inbox poll schedule (T-0127, ADR-0095 rule 6, DL-0814) against a real PostgreSQL.
 * - The owner instance installs a 5-minute schedule and fans out one `ap.inbox.poll` job per
 *   active tenant and 5-minute slot; a second fan-out in the same slot adds nothing.
 * - The lf_app worker polls the tenant's active mailboxes inside that tenant's transactions; a
 *   job for another tenant polls nothing of this one.
 * Time is injected; the IMAP server is the in-process fake. No sleeps, no network.
 */
import { randomUUID } from 'node:crypto';
import { saveBillsMailbox } from '@ledgerforce/ap';
import { FakeImapServer } from '@ledgerforce/ap/testing/imap';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { ownerBossOptions } from '@ledgerforce/outbox';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fanOutInboxPolls,
  INBOX_FANOUT_CRON,
  INBOX_FANOUT_QUEUE,
  INBOX_POLL_QUEUE,
  installInboxPollSchedule,
  runTenantInboxPoll,
} from './inbox-poll-jobs.ts';
import { installQueue } from './queue-admin.ts';

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: Buffer.alloc(32, 9).toString('base64') } }),
);
const RAW = [
  'From: Paper Co <accounts@paperco.example>',
  'To: bills@harbour.example',
  'Subject: Invoice 77',
  'Message-ID: <inv-77@paperco.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'Invoice attached.',
  '--b1',
  'Content-Type: application/pdf; name="inv-77.pdf"',
  'Content-Disposition: attachment; filename="inv-77.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

let f: LedgerFixture;
let owner: PgBoss;
let other = '';
let suspended = '';
const server = new FakeImapServer({
  user: 'bills@harbour.example',
  pass: 'pw-1',
  folders: { INBOX: { uidValidity: 5, messages: [] } },
});

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012702');
  other = randomUUID();
  suspended = randomUUID();
  await f.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Other Pty Ltd')`, [other]);
  await f.admin.query(
    `INSERT INTO app.tenant (id, name, status) VALUES ($1, 'Gone Pty Ltd', 'suspended')`,
    [suspended],
  );
  await f.inTenant((trx) =>
    saveBillsMailbox(trx, kms, f.companyId, {
      host: 'imap.harbour.example',
      username: 'bills@harbour.example',
      password: 'pw-1',
    }),
  );
  await installQueue(f.tdb.url('lf_migrator'));
  owner = new PgBoss(ownerBossOptions(f.tdb.url('lf_migrator'), { migrate: false }));
  await owner.start();
}, 180_000);

afterAll(async () => {
  await (owner as PgBoss | undefined)?.stop({ graceful: false });
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-154: bills mailboxes are polled every 5 minutes, per tenant', () => {
  it('SS-PLAT-154 installs the 5-minute schedule idempotently', async () => {
    await installInboxPollSchedule(owner);
    await installInboxPollSchedule(owner);
    const schedules = await owner.getSchedules();
    expect(schedules.filter((s) => s.name === INBOX_FANOUT_QUEUE)).toEqual([
      expect.objectContaining({
        name: INBOX_FANOUT_QUEUE,
        cron: INBOX_FANOUT_CRON,
        timezone: 'UTC',
      }),
    ]);
    expect(INBOX_FANOUT_CRON).toBe('*/5 * * * *');
  });

  it('SS-PLAT-154 fans out one poll job per active tenant and slot; the same slot adds nothing', async () => {
    const t = new Date('2026-11-17T05:01:00Z');
    const first = await fanOutInboxPolls(owner, f.tdb.url('lf_migrator'), t);
    const same = await fanOutInboxPolls(
      owner,
      f.tdb.url('lf_migrator'),
      new Date('2026-11-17T05:04:59Z'),
    );
    const next = await fanOutInboxPolls(
      owner,
      f.tdb.url('lf_migrator'),
      new Date('2026-11-17T05:05:00Z'),
    );
    expect(first.tenants).toEqual(expect.arrayContaining([f.tenantId, other]));
    expect(first.tenants).not.toContain(suspended);
    expect(first.sent).toBe(first.tenants.length);
    expect(same.sent).toBe(0);
    expect(next.sent).toBe(next.tenants.length);
    const { rows } = await f.admin.query<{ tenant: string; n: number }>(
      `SELECT data->>'tenantId' AS tenant, count(*)::int AS n FROM pgboss.job
        WHERE name = $1 GROUP BY 1 ORDER BY 1`,
      [INBOX_POLL_QUEUE],
    );
    expect(rows.every((r) => r.n === 2)).toBe(true);
    expect(rows.map((r) => r.tenant)).not.toContain(suspended);
  });

  it('SS-PLAT-154 the worker polls the tenant mailbox into one inbox item; another tenant job polls nothing here', async () => {
    server.deliver('INBOX', RAW);
    const connector = () => () => server.connect();
    const none = await runTenantInboxPoll(f.db, { kms, connector }, other);
    expect(none).toEqual([]);
    const run = await runTenantInboxPoll(f.db, { kms, connector }, f.tenantId);
    expect(run).toEqual([expect.objectContaining({ status: 'ok', ingested: 1 })]);
    const again = await runTenantInboxPoll(f.db, { kms, connector }, f.tenantId);
    expect(again).toEqual([expect.objectContaining({ status: 'ok', ingested: 0 })]);
    const { rows } = await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.bill_inbox_item WHERE company_id = $1',
      [f.companyId],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
