/**
 * Security notice delivery jobs (T-0197, ADR-0092, RQ-0174) against a real PostgreSQL.
 * - The owner instance (lf_migrator) installs the every-minute schedule and fans out one
 *   `security.notices.dispatch` job per active tenant and UTC minute; a second fan-out in the same
 *   minute adds nothing.
 * - The lf_app worker job dispatches that tenant's due notices through SMTP (SmtpSink); without a
 *   sender the notices stay pending.
 * Time is injected; there are no sleeps.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { approveRemittanceAccountChange, requestRemittanceAccountChange } from '@ledgerforce/ar';
import { SmtpSender } from '@ledgerforce/email';
import { SmtpSink } from '@ledgerforce/email/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { ownerBossOptions } from '@ledgerforce/outbox';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installQueue } from './queue-admin.ts';
import {
  fanOutSecurityNotices,
  installSecurityNoticeSchedule,
  runSecurityNoticeJob,
  SECURITY_NOTICES_CRON,
  SECURITY_NOTICES_FANOUT_QUEUE,
  SECURITY_NOTICES_QUEUE,
} from './security-notices.ts';

let f: LedgerFixture;
let owner: PgBoss;
const sink = new SmtpSink();
let suspended = '';
let changeId = '';

beforeAll(async () => {
  await sink.start();
  f = await createLedgerFixture('01900000-0000-7000-8000-000000019711');
  suspended = randomUUID();
  await f.admin.query(
    `INSERT INTO app.tenant (id, name, status) VALUES ($1, 'Gone Pty Ltd', 'suspended')`,
    [suspended],
  );
  const ownerId = await f.addUser('owner');
  const faId = await f.addUser('finance_admin');
  changeId = randomUUID();
  await f.inTenant(async (trx) => {
    const account = randomUUID();
    await trx
      .insertInto('app.bank_account')
      .values({
        id: account,
        company_id: f.companyId,
        gl_account_id: f.acct['1010'] ?? '',
        name: 'Operating',
        currency: 'AUD',
        bsb: '062-000',
        account_name: 'Harbour Operating',
        account_number_last3: '678',
        account_number_ct: randomBytes(8),
        account_number_iv: randomBytes(12),
        account_number_tag: randomBytes(16),
        dek_wrapped: randomBytes(60),
        kek_id: 'k1',
        enc_version: 1,
      })
      .execute();
    await requestRemittanceAccountChange(trx, {
      companyId: f.companyId,
      changeId,
      bankAccountId: account,
      requestedBy: faId,
    });
  });
  await f.inTenant((trx) =>
    approveRemittanceAccountChange(trx, { companyId: f.companyId, changeId, approvedBy: ownerId }),
  );
  await installQueue(f.tdb.url('lf_migrator'));
  owner = new PgBoss(ownerBossOptions(f.tdb.url('lf_migrator'), { migrate: false }));
  await owner.start();
}, 180_000);

afterAll(async () => {
  await (owner as PgBoss | undefined)?.stop({ graceful: false });
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

const statuses = async (): Promise<string[]> =>
  (
    await f.admin.query<{ status: string }>(
      'SELECT status FROM app.remittance_account_notice WHERE change_id = $1 ORDER BY id',
      [changeId],
    )
  ).rows.map((r) => r.status);

describe('SS-PLAT-145: security notices are delivered by a per-tenant job every minute', () => {
  it('SS-PLAT-145 the owner installs the every-minute schedule and both queues idempotently [T-0197]', async () => {
    await installSecurityNoticeSchedule(owner);
    await installSecurityNoticeSchedule(owner);
    const schedules = await owner.getSchedules();
    expect(schedules.filter((s) => s.name === SECURITY_NOTICES_FANOUT_QUEUE)).toEqual([
      expect.objectContaining({ cron: SECURITY_NOTICES_CRON, timezone: 'UTC' }),
    ]);
    expect(await owner.getQueue(SECURITY_NOTICES_QUEUE)).toMatchObject({ retryLimit: 0 });
  });

  it('SS-PLAT-145 fan-out sends one job per active tenant and minute; a repeat in that minute adds nothing [T-0197]', async () => {
    const now = new Date('2026-11-17T09:30:10Z');
    const first = await fanOutSecurityNotices(owner, f.tdb.url('lf_migrator'), now);
    const again = await fanOutSecurityNotices(
      owner,
      f.tdb.url('lf_migrator'),
      new Date('2026-11-17T09:30:50Z'),
    );
    const next = await fanOutSecurityNotices(
      owner,
      f.tdb.url('lf_migrator'),
      new Date('2026-11-17T09:31:00Z'),
    );
    expect(first.tenants).toContain(f.tenantId);
    expect(first.tenants).not.toContain(suspended);
    expect(first.sent).toBe(first.tenants.length);
    expect(again.sent).toBe(0);
    expect(next.sent).toBe(next.tenants.length);
    const { rows } = await f.admin.query<{ tenant: string; n: number }>(
      `SELECT data->>'tenantId' AS tenant, count(*)::int AS n FROM pgboss.job
        WHERE name = $1 GROUP BY 1`,
      [SECURITY_NOTICES_QUEUE],
    );
    expect(rows.find((r) => r.tenant === f.tenantId)?.n).toBe(2);
    expect(rows.map((r) => r.tenant)).not.toContain(suspended);
  });

  it('SS-PLAT-145 without SMTP the job sends nothing and the notices stay pending [T-0197]', async () => {
    expect(await runSecurityNoticeJob(f.db, null, { tenantId: f.tenantId }, new Date())).toBeNull();
    expect(await statuses()).toEqual(['pending', 'pending']);
    await expect(runSecurityNoticeJob(f.db, null, { tenantId: 'x' }, new Date())).rejects.toThrow(
      /tenantId/,
    );
  });

  it("SS-PLAT-145 the worker job sends the tenant's due notices once [T-0197]", async () => {
    const sender = new SmtpSender({ url: sink.url, from: 'LedgerForce <security@lf.example>' });
    const data = { tenantId: f.tenantId };
    expect(await runSecurityNoticeJob(f.db, sender, data, new Date())).toEqual({
      sent: 2,
      failed: 0,
    });
    expect(sink.messages).toHaveLength(2);
    expect(await statuses()).toEqual(['sent', 'sent']);
    expect(await runSecurityNoticeJob(f.db, sender, data, new Date())).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sink.messages).toHaveLength(2);
  });
});
