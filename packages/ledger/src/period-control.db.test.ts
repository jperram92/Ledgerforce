/**
 * Period control in the database (T-0023, RQ-0026), as lf_app:
 *  - SS-PLAT-06 (database part): the SQL mirror of the matrix agrees with the TypeScript data
 *    (fast-check), and the invariant-3 trigger enforces every status × source type cell, with and
 *    without an override.
 *  - SS-PLAT-56: period status changes only through the guarded functions, by holders of the
 *    period permissions; a hard-locked period reopens only with two different approvers and a
 *    reason; every change is history and audited; nothing is updated in place or deleted.
 *  - SS-PLAT-57 (database part): generated fiscal years, no overlapping periods.
 */
import { withTenant } from '@ledgerforce/db';
import { ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import fc from 'fast-check';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveReopen,
  findPeriod,
  generateFiscalYear,
  recordPeriodOverride,
  requestReopen,
  setPeriodStatus,
  toPeriodError,
} from './period.ts';
import {
  DEFAULT_PERIOD_SETTINGS,
  PERIOD_PERMISSIONS,
  PERIOD_STATUSES,
  SOURCE_TYPES,
  periodDecision,
  sourceClassOf,
  type PeriodStatus,
} from './period-matrix.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const u: Record<string, string> = {};
const FA = () => u.financeAdmin ?? '';

const LINES = [
  { code: '6200', debit: '10.0000' },
  { code: '1100', credit: '10.0000' },
];

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-00000000023b');
  for (const [name, role] of [
    ['financeAdmin', 'finance_admin'],
    ['owner', 'owner'],
    ['accountant', 'accountant'],
    ['approver', 'approver'],
  ] as const) {
    u[name] = await f.addUser(role);
  }
});

afterAll(async () => {
  await f.close();
});

const statusOf = (periodId: string) =>
  f.admin
    .query<{ status: string }>(`SELECT status FROM app.fiscal_period WHERE id = $1`, [periodId])
    .then((r) => r.rows[0]?.status);

describe('SS-PLAT-06: Period status matrix is enforced as data (database)', () => {
  it('property: app.period_decision(status, app.source_type_class(st), setting) equals the TypeScript matrix', async () => {
    const known = Object.keys(SOURCE_TYPES);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PERIOD_STATUSES),
        fc.oneof(fc.constantFrom(...known), fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/)),
        fc.constantFrom('override' as const, 'allow' as const),
        async (status, st, payoutUnderArLock) => {
          const r = await sql<{ cls: string | null; d: string }>`
            SELECT app.source_type_class(${st}) AS cls,
                   app.period_decision(${status}, app.source_type_class(${st}), ${payoutUnderArLock}) AS d`.execute(
            f.db,
          );
          expect(r.rows[0]?.cls ?? undefined).toBe(sourceClassOf(st));
          expect(r.rows[0]?.d).toBe(
            periodDecision(status, st, { ...DEFAULT_PERIOD_SETTINGS, payoutUnderArLock }),
          );
        },
      ),
    );
  });

  it('the trigger enforces every status × source type cell, with and without an override', async () => {
    // One company, five periods (Jul … Nov) in the five statuses.
    const company = await f.addCompany('Matrix Pty Ltd');
    const byStatus = new Map<PeriodStatus, { id: string; date: string }>();
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
    await f.inTenant(async (trx) => {
      for (const [i, status] of PERIOD_STATUSES.entries()) {
        const date = `${months[i] ?? ''}-15`;
        const p = await findPeriod(trx, company, date);
        if (!p) throw new Error(`no period ${date}`);
        if (status !== 'open') await setPeriodStatus(trx, { periodId: p.id, status, actorId: FA() });
        byStatus.set(status, { id: p.id, date });
      }
    });
    const rollback = new Error('rollback');
    const attempt = async (
      status: PeriodStatus,
      sourceType: string,
      override: boolean,
    ): Promise<'posted' | 'refused' | 'override refused'> => {
      const p = byStatus.get(status);
      if (!p) throw new Error(status);
      const key = randomUUID();
      try {
        await f.inTenant(async (trx) => {
          if (override) {
            try {
              await recordPeriodOverride(trx, {
                companyId: company,
                periodId: p.id,
                sourceType,
                idempotencyKey: key,
                grantedBy: FA(),
                reason: 'matrix test',
              });
            } catch {
              throw new Error('override refused');
            }
          }
          await f.insertEntry(trx, LINES, {
            company,
            entryDate: p.date,
            sourceType,
            createdBy: FA(),
            idempotencyKey: key,
          });
          throw rollback; // checked at INSERT; nothing is kept
        });
      } catch (error) {
        if (error === rollback) return 'posted';
        if (error instanceof Error && error.message === 'override refused') return 'override refused';
        if (toPeriodError(error)) return 'refused';
        throw error;
      }
      throw new Error('unreachable');
    };
    let cells = 0;
    for (const status of PERIOD_STATUSES) {
      for (const st of Object.keys(SOURCE_TYPES)) {
        const d = periodDecision(status, st, DEFAULT_PERIOD_SETTINGS);
        expect(await attempt(status, st, false), `${status} × ${st}`).toBe(
          d === 'allow' ? 'posted' : 'refused',
        );
        // An override can be recorded only where the cell says "override".
        expect(await attempt(status, st, true), `${status} × ${st} + override`).toBe(
          d === 'override' ? 'posted' : 'override refused',
        );
        cells++;
      }
    }
    expect(cells).toBe(PERIOD_STATUSES.length * Object.keys(SOURCE_TYPES).length);
  });
});

describe('SS-PLAT-56: Period status changes are guarded, audited history; hard-locked reopen needs two approvers and a reason', () => {
  it('app.role_allows_period_permission mirrors the role catalogue for every role × period permission', async () => {
    for (const role of ROLE_IDS) {
      for (const perm of PERIOD_PERMISSIONS) {
        const r = await sql<{ ok: boolean }>`
          SELECT app.role_allows_period_permission(${role}, ${perm}) AS ok`.execute(f.db);
        expect(r.rows[0]?.ok, `${role} ${perm}`).toBe(
          ROLE_TEMPLATES[role].permissions.includes(perm),
        );
      }
    }
  });

  it('lf_app cannot UPDATE or DELETE periods, history, overrides, settings or reopen requests', async () => {
    const company = await f.addCompany('Guard Pty Ltd');
    for (const stmt of [
      sql`UPDATE app.fiscal_period SET status = 'open' WHERE company_id = ${company}`,
      sql`DELETE FROM app.fiscal_period WHERE company_id = ${company}`,
      sql`UPDATE app.fiscal_year SET label = 'x' WHERE company_id = ${company}`,
      sql`DELETE FROM app.fiscal_year WHERE company_id = ${company}`,
      sql`UPDATE app.period_status_change SET reason = 'x'`,
      sql`DELETE FROM app.period_status_change`,
      sql`UPDATE app.period_reopen_request SET reason = 'x'`,
      sql`DELETE FROM app.period_override`,
      sql`DELETE FROM app.period_settings`,
    ]) {
      await expect(f.inTenant((trx) => stmt.execute(trx))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('even the table owner cannot change a period except its status, nor delete one', async () => {
    const company = await f.addCompany('Owner Guard Pty Ltd');
    const p = await f.inTenant((trx) => findPeriod(trx, company, '2026-09-10'));
    await expect(
      f.admin.query(`UPDATE app.fiscal_period SET end_date = '2026-09-29' WHERE id = $1`, [p?.id]),
    ).rejects.toThrow(/only the status of a fiscal period can change/);
    await expect(
      f.admin.query(`DELETE FROM app.fiscal_period WHERE id = $1`, [p?.id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('status changes need the period permission; each is history with user, time and reason, and audited', async () => {
    const company = await f.addCompany('Close Pty Ltd');
    const p = await f.inTenant((trx) => findPeriod(trx, company, '2026-10-10'));
    const periodId = p?.id ?? '';
    await expect(
      f.inTenant((trx) =>
        setPeriodStatus(trx, { periodId, status: 'ar_locked', actorId: u.accountant ?? '' }),
      ),
    ).rejects.toThrow(/period\.lock/);
    await expect(
      f.inTenant((trx) =>
        setPeriodStatus(trx, { periodId, status: 'ar_locked', actorId: u.approver ?? '' }),
      ),
    ).rejects.toThrow(/period\.lock/);
    for (const status of ['ar_locked', 'ap_locked', 'soft_closed'] as const) {
      await f.inTenant((trx) => setPeriodStatus(trx, { periodId, status, actorId: FA() }));
    }
    // Back from soft close needs period.reopen and a reason.
    await expect(
      f.inTenant((trx) => setPeriodStatus(trx, { periodId, status: 'ap_locked', actorId: FA() })),
    ).rejects.toThrow(/reason/);
    await f.inTenant((trx) =>
      setPeriodStatus(trx, {
        periodId,
        status: 'ap_locked',
        actorId: FA(),
        reason: 'missed accrual',
      }),
    );
    const hist = await f.admin.query<{
      from_status: string;
      to_status: string;
      changed_by: string;
      reason: string | null;
      changed_at: Date;
    }>(
      `SELECT from_status, to_status, changed_by, reason, changed_at FROM app.period_status_change
        WHERE period_id = $1 ORDER BY changed_at, id`,
      [periodId],
    );
    expect(hist.rows.map((r) => [r.from_status, r.to_status, r.reason])).toEqual([
      ['open', 'ar_locked', null],
      ['ar_locked', 'ap_locked', null],
      ['ap_locked', 'soft_closed', null],
      ['soft_closed', 'ap_locked', 'missed accrual'],
    ]);
    expect(new Set(hist.rows.map((r) => r.changed_by))).toEqual(new Set([FA()]));
    expect(hist.rows.every((r) => r.changed_at instanceof Date)).toBe(true);
    const audit = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1 AND action = 'period.status_changed'`,
      [periodId],
    );
    expect(audit.rows[0]?.n).toBe(4);
    await expect(
      f.inTenant((trx) => setPeriodStatus(trx, { periodId, status: 'ap_locked', actorId: FA() })),
    ).rejects.toThrow(/already/);
  });

  it('hard locked: no direct change; reopen needs a reason and a second, different approver holding period.reopen', async () => {
    const company = await f.addCompany('Reopen Pty Ltd');
    const p = await f.inTenant((trx) => findPeriod(trx, company, '2026-10-10'));
    const periodId = p?.id ?? '';
    await f.inTenant((trx) =>
      setPeriodStatus(trx, { periodId, status: 'hard_locked', actorId: FA() }),
    );
    await expect(
      f.inTenant((trx) =>
        setPeriodStatus(trx, { periodId, status: 'soft_closed', actorId: FA(), reason: 'oops' }),
      ),
    ).rejects.toThrow(/reopen/);
    await expect(
      f.inTenant((trx) =>
        requestReopen(trx, { periodId, toStatus: 'soft_closed', actorId: FA(), reason: '  ' }),
      ),
    ).rejects.toThrow(/reason/);
    await expect(
      f.inTenant((trx) =>
        requestReopen(trx, {
          periodId,
          toStatus: 'soft_closed',
          actorId: u.accountant ?? '',
          reason: 'BAS amendment',
        }),
      ),
    ).rejects.toThrow(/period\.reopen/);
    const requestId = await f.inTenant((trx) =>
      requestReopen(trx, {
        periodId,
        toStatus: 'soft_closed',
        actorId: FA(),
        reason: 'BAS amendment for a missed supplier credit',
      }),
    );
    expect(await statusOf(periodId)).toBe('hard_locked'); // a single approval is not enough
    await expect(
      f.inTenant((trx) => approveReopen(trx, { requestId, actorId: FA() })),
    ).rejects.toThrow(/different/);
    await expect(
      f.inTenant((trx) => approveReopen(trx, { requestId, actorId: u.approver ?? '' })),
    ).rejects.toThrow(/period\.reopen/);
    expect(await statusOf(periodId)).toBe('hard_locked');

    await f.inTenant((trx) => approveReopen(trx, { requestId, actorId: u.owner ?? '' }));
    expect(await statusOf(periodId)).toBe('soft_closed');
    await expect(
      f.inTenant((trx) => approveReopen(trx, { requestId, actorId: u.owner ?? '' })),
    ).rejects.toThrow(/not pending/);

    const req = await f.admin.query(
      `SELECT requested_by, approved_by, reason, status FROM app.period_reopen_request WHERE id = $1`,
      [requestId],
    );
    expect(req.rows[0]).toEqual({
      requested_by: FA(),
      approved_by: u.owner,
      reason: 'BAS amendment for a missed supplier credit',
      status: 'approved',
    });
    const hist = await f.admin.query(
      `SELECT from_status, to_status, changed_by, reason, reopen_request_id FROM app.period_status_change
        WHERE period_id = $1 ORDER BY changed_at, id`,
      [periodId],
    );
    expect(hist.rows.at(-1)).toEqual({
      from_status: 'hard_locked',
      to_status: 'soft_closed',
      changed_by: u.owner,
      reason: 'BAS amendment for a missed supplier credit',
      reopen_request_id: requestId,
    });
    const audit = await f.admin.query<{ action: string; actor_user_id: string }>(
      `SELECT action, actor_user_id FROM audit.audit_log WHERE entity_id = $1 ORDER BY id`,
      [requestId],
    );
    expect(audit.rows).toEqual([
      { action: 'period.reopen_requested', actor_user_id: FA() },
      { action: 'period.reopen_approved', actor_user_id: u.owner },
    ]);
  });

  it("another tenant's period is invisible to the guarded functions", async () => {
    const company = await f.addCompany('Hidden Pty Ltd');
    const p = await f.inTenant((trx) => findPeriod(trx, company, '2026-10-10'));
    const other = randomUUID();
    await f.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Other tenant')`, [other]);
    await expect(
      withTenant(f.db, other, (trx) =>
        setPeriodStatus(trx, { periodId: p?.id ?? '', status: 'ar_locked', actorId: FA() }),
      ),
    ).rejects.toThrow(/unknown fiscal period/);
    expect(await statusOf(p?.id ?? '')).toBe('open');
  });
});

describe('SS-PLAT-57: Fiscal years are generated from a convention held as data (database)', () => {
  it('generates FY2027 as 12 open periods; a second, overlapping year is refused', async () => {
    const company = await f.addCompany('Calendar Pty Ltd'); // fixture already generated FY2027
    const rows = await f.admin.query<{ name: string; start: string; end: string; status: string }>(
      `SELECT p.name, p.start_date::text AS start, p.end_date::text AS end, p.status
         FROM app.fiscal_period p JOIN app.fiscal_year y ON y.id = p.fiscal_year_id
        WHERE p.company_id = $1 AND y.label = 'FY2027' ORDER BY p.start_date`,
      [company],
    );
    expect(rows.rows).toHaveLength(12);
    expect(rows.rows[0]).toEqual({ name: '2026-07', start: '2026-07-01', end: '2026-07-31', status: 'open' });
    expect(rows.rows[11]?.end).toBe('2027-06-30');

    await expect(
      f.inTenant((trx) => generateFiscalYear(trx, { companyId: company, convention: 'calendar', startYear: 2027 })),
    ).rejects.toThrow(/overlap/);
    const next = await f.inTenant((trx) =>
      generateFiscalYear(trx, { companyId: company, convention: 'AU', startYear: 2027 }),
    );
    expect(next.label).toBe('FY2028');
    expect(next.periods).toHaveLength(12);
  });

  it('a period must lie inside its fiscal year and be inserted open', async () => {
    const company = await f.addCompany('Shape Pty Ltd');
    const fy = await f.admin.query<{ id: string }>(
      `SELECT id FROM app.fiscal_year WHERE company_id = $1`,
      [company],
    );
    const fyId = fy.rows[0]?.id ?? '';
    await expect(
      f.inTenant((trx) =>
        sql`INSERT INTO app.fiscal_period (company_id, fiscal_year_id, period_no, name, start_date, end_date)
            VALUES (${company}, ${fyId}, 13, 'adj', '2027-07-01', '2027-07-31')`.execute(trx),
      ),
    ).rejects.toThrow(/inside its fiscal year|overlap/);
    await expect(
      f.inTenant((trx) =>
        sql`INSERT INTO app.fiscal_period (company_id, fiscal_year_id, period_no, name, start_date, end_date, status)
            VALUES (${company}, ${fyId}, 13, 'adj', '2027-06-30', '2027-06-30', 'hard_locked')`.execute(trx),
      ),
    ).rejects.toThrow(/inserted open/);
  });
});
