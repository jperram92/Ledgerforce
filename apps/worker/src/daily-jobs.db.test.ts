/**
 * Daily overdue-reminder run for every company (T-0147, UC-04, ADR-0062 option 1, RQ-0144,
 * SS-UC04-08) against a real PostgreSQL.
 * - Only lf_migrator can list active tenants (`app.active_tenant_ids()`). lf_app cannot.
 * - The owner instance installs the daily schedule and fans out one `ar.reminders.run` job per
 *   active tenant and day. A second fan-out on the same day adds nothing.
 * - The lf_app worker runs each tenant's companies in that tenant's transaction. The run date is
 *   the date in the tenant's report time zone. A re-run on the same day queues nothing.
 * Time is injected (`now`); there are no sleeps.
 */
import { randomUUID } from 'node:crypto';
import {
  approveInvoice,
  createDraftInvoice,
  seedReminderSchedule,
  type DocumentEvent,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { ownerBossOptions } from '@ledgerforce/outbox';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AR_REMINDERS_QUEUE,
  DAILY_FANOUT_CRON,
  DAILY_FANOUT_QUEUE,
  fanOutDailyJobs,
  installDailySchedules,
  localDate,
  parseTenantJob,
  runTenantReminders,
} from './daily-jobs.ts';
import { installQueue } from './queue-admin.ts';

let f: LedgerFixture;
let owner: PgBoss;
let other = '';
let suspended = '';
const published: DocumentEvent[] = [];
const outbox = {
  publish: async (_t: unknown, e: DocumentEvent) => {
    published.push(e);
  },
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014701');
  other = randomUUID();
  suspended = randomUUID();
  await f.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Other Pty Ltd')`, [other]);
  await f.admin.query(
    `INSERT INTO app.tenant (id, name, status) VALUES ($1, 'Gone Pty Ltd', 'suspended')`,
    [suspended],
  );
  const profiles = await seedBillingCompany(f);
  const [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Daily',
    billDate: '2026-11-05',
  });
  await f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: party,
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '800.00',
          },
        ],
      },
      { outbox },
    );
    await approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
    // Default schedule (step 1 at 7 days); production seeds it at company setup (T-0123 AC-6).
    await seedReminderSchedule(trx, f.companyId);
  });
  published.length = 0;
  await installQueue(f.tdb.url('lf_migrator'));
  owner = new PgBoss(ownerBossOptions(f.tdb.url('lf_migrator'), { migrate: false }));
  await owner.start();
}, 180_000);

afterAll(async () => {
  await (owner as PgBoss | undefined)?.stop({ graceful: false });
  await (f as LedgerFixture | undefined)?.close();
});

const asRole = async <T>(role: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: f.tdb.url(role) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

describe('T-0147: tenant enumeration stays with the owner role (ADR-0062)', () => {
  it('lf_app cannot call app.active_tenant_ids()', async () => {
    await expect(
      asRole('lf_app', (c) => c.query('SELECT * FROM app.active_tenant_ids()')),
    ).rejects.toThrow(/permission denied/);
  });

  it('lf_migrator gets the ids of active tenants only, and nothing else', async () => {
    const rows = await asRole('lf_migrator', async (c) => {
      const r = await c.query<Record<string, unknown>>('SELECT * FROM app.active_tenant_ids()');
      return r.rows;
    });
    const ids = rows.map((r) => r['tenant_id']);
    expect(ids).toEqual(expect.arrayContaining([f.tenantId, other]));
    expect(ids).not.toContain(suspended);
    expect(Object.keys(rows[0] ?? {})).toEqual(['tenant_id']);
  });
});

describe('T-0147: owner schedule and fan-out', () => {
  it('installs the daily schedule idempotently', async () => {
    await installDailySchedules(owner);
    await installDailySchedules(owner);
    const schedules = await owner.getSchedules();
    expect(schedules.filter((s) => s.name === DAILY_FANOUT_QUEUE)).toEqual([
      expect.objectContaining({
        name: DAILY_FANOUT_QUEUE,
        cron: DAILY_FANOUT_CRON,
        timezone: 'UTC',
      }),
    ]);
  });

  it('fans out one reminder job per active tenant and day; a second fan-out adds nothing', async () => {
    const now = new Date('2026-11-26T14:05:00Z');
    const first = await fanOutDailyJobs(owner, f.tdb.url('lf_migrator'), now);
    const again = await fanOutDailyJobs(owner, f.tdb.url('lf_migrator'), now);
    expect(first.tenants).toEqual(expect.arrayContaining([f.tenantId, other]));
    expect(first.tenants).not.toContain(suspended);
    expect(again.sent).toBe(0);
    const { rows } = await f.admin.query<{ tenant: string; n: number }>(
      `SELECT data->>'tenantId' AS tenant, count(*)::int AS n FROM pgboss.job
        WHERE name = $1 GROUP BY 1 ORDER BY 1`,
      [AR_REMINDERS_QUEUE],
    );
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(rows.map((r) => r.tenant)).not.toContain(suspended);
  });
});

describe('SS-UC04-08: the daily run for one tenant', () => {
  it('the run date is the date in the tenant report time zone', () => {
    const now = new Date('2026-11-26T13:30:00Z');
    expect(localDate(now, 'Australia/Sydney')).toBe('2026-11-27');
    expect(localDate(now, 'UTC')).toBe('2026-11-26');
    expect(() => localDate(now, 'Not/AZone')).toThrow();
  });

  it('job data must name a tenant id', () => {
    expect(parseTenantJob({ tenantId: f.tenantId })).toEqual({ tenantId: f.tenantId });
    expect(() => parseTenantJob({ tenantId: 'x' })).toThrow();
    expect(() => parseTenantJob(null)).toThrow();
  });

  it('SS-UC04-08 runs every company of the tenant on its local date; a re-run that day queues nothing', async () => {
    const now = new Date('2026-11-26T13:30:00Z'); // 2026-11-27 00:30 in Sydney (default zone)
    const run = await runTenantReminders(f.db, { outbox }, f.tenantId, now);
    expect(run.runDate).toBe('2026-11-27');
    expect(run.companies).toEqual(
      expect.arrayContaining([expect.objectContaining({ companyId: f.companyId, queued: 1 })]),
    );
    expect(published.filter((e) => e.topic === 'ar.reminder.queued')).toHaveLength(1);
    const again = await runTenantReminders(f.db, { outbox }, f.tenantId, now);
    expect(again.companies.every((c) => c.queued === 0)).toBe(true);
    expect(published.filter((e) => e.topic === 'ar.reminder.queued')).toHaveLength(1);
  });

  it("a tenant job sees only its own tenant's companies", async () => {
    const run = await runTenantReminders(f.db, { outbox }, other, new Date('2026-11-26T13:30:00Z'));
    expect(run.companies).toEqual([]);
  });
});
