/**
 * SS-PLAT-62 — the segregation-of-duties store (migration 0021, T-0015, ADR-0026): the action
 * ledger, settings history, small-team exceptions and the Owner's weekly acknowledgements are
 * tenant-scoped, append-only (no UPDATE/DELETE for lf_app, and a trigger refuses them for every
 * role), checked and audited; the weekly exception report cuts weeks in the tenant's time zone.
 * Run as lf_app inside tenant transactions (withTenant); the superuser only inspects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { DEFAULT_SOD_SETTINGS, SOD_RULES, SOD_STEPS } from '@ledgerforce/shared/sod';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const T = '01900000-0000-7000-8000-000000062a1a';
const OTHER = '01900000-0000-7000-8000-000000062a1b';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = uid(0x6201);
const FA = uid(0x6202);
const CLERK = uid(0x6203);
const REVIEWER = uid(0x6204);
const GONE = uid(0x6205); // disabled user
const OTHER_OWNER = uid(0x6206);

let tdb: TestDatabase;
let db: Kysely<Database>;
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>, tenant = T) =>
  withTenant(db, tenant, fn);

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? 'no-code';
  }
}

const action = (v: Record<string, unknown>, tenant = T) =>
  inTenant(
    (trx) =>
      sql`INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, amount)
          VALUES (${v.subject_type ?? 'bill'}, ${v.subject_id ?? 'b-1'}, ${v.step ?? 'bill.enter'},
                  ${v.actor ?? CLERK}, ${v.amount ?? null})`.execute(trx),
    tenant,
  );

const settings = (v: Record<string, unknown>) =>
  inTenant((trx) =>
    sql`INSERT INTO app.sod_settings (small_team_mode, bill_self_approval_threshold, report_timezone, set_by, reason)
          VALUES (${v.small ?? false}, ${v.bill ?? '1000'}, ${v.tz ?? 'Australia/Sydney'},
                  ${v.by ?? OWNER}, ${v.reason ?? 'placeholder confirmed'})`.execute(trx),
  );

const exception = (v: Record<string, unknown>, tenant = T) =>
  inTenant(
    (trx) =>
      sql`INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind, reviewer_user_id, reason, occurred_at)
          VALUES (${v.rule ?? 'SOD_BILL_SELF_APPROVAL'}, 'bill', ${v.subject_id ?? 'b-1'}, 'bill.approve',
                  ${v.actor ?? OWNER}, ${v.kind ?? 'recorded_exception'}, ${v.reviewer ?? null},
                  ${v.reason ?? 'sole trader'}, ${v.at ?? sql`clock_timestamp()`})`.execute(trx),
    tenant,
  );

/** Test data at a chosen time: only the superuser can set occurred_at (lf_app gets "now"). */
const exceptionAt = (v: Record<string, unknown>, tenant = T) =>
  tdb.admin.query(
    `INSERT INTO app.sod_exception (tenant_id, rule, subject_type, subject_id, step, actor_user_id, kind, reviewer_user_id, reason, occurred_at)
     VALUES ($1, 'SOD_BILL_SELF_APPROVAL', 'bill', $2, 'bill.approve', $3, $4, $5, 'sole trader', $6)`,
    [
      tenant,
      v.subject_id,
      v.actor ?? OWNER,
      v.kind ?? 'recorded_exception',
      v.reviewer ?? null,
      v.at,
    ],
  );

const ack = (v: Record<string, unknown>) =>
  inTenant((trx) =>
    sql`INSERT INTO app.sod_exception_ack (week_start, acknowledged_by, note, acknowledged_at)
          VALUES (${v.week ?? '2026-10-19'}, ${v.by ?? OWNER}, ${v.note ?? null},
                  ${v.at ?? sql`clock_timestamp()`})`.execute(trx),
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 1);
  const people: [string, string, string | null, string][] = [
    [T, OWNER, 'owner', 'active'],
    [T, FA, 'finance_admin', 'active'],
    [T, CLERK, 'ap_clerk', 'active'],
    [T, REVIEWER, 'auditor', 'active'],
    [T, GONE, 'approver', 'disabled'],
    [OTHER, OTHER_OWNER, 'owner', 'active'],
  ];
  for (const tenant of [T, OTHER]) {
    await tdb.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, $2)`, [tenant, 'SoD']);
  }
  for (const [tenant, id, role, status] of people) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, 'U', $4)`,
      [id, tenant, `${id}@sod.test`, status],
    );
    if (role) {
      await tdb.admin.query(
        `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
        [tenant, id, role],
      );
    }
  }
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

async function auditActions(tenant = T): Promise<string[]> {
  const { rows } = await tdb.admin.query<{ action: string }>(
    `SELECT action FROM audit.audit_log WHERE tenant_id = $1 ORDER BY id`,
    [tenant],
  );
  return rows.map((r) => r.action);
}

describe('SS-PLAT-62: SoD action ledger, settings, exceptions and acknowledgements are append-only, checked and audited', () => {
  it('the step and rule lists in SQL mirror the TypeScript rules; settings.sod.manage mirrors the catalogue', async () => {
    for (const s of SOD_STEPS) {
      const { rows } = await tdb.admin.query<{ ok: boolean }>(
        'SELECT app.sod_step_known($1) AS ok',
        [s],
      );
      expect(rows[0]?.ok, s).toBe(true);
    }
    for (const r of SOD_RULES) {
      const { rows } = await tdb.admin.query<{ ok: boolean }>(
        'SELECT app.sod_rule_known($1) AS ok',
        [r.id],
      );
      expect(rows[0]?.ok, r.id).toBe(true);
    }
    const unknown = await tdb.admin.query<{ s: boolean; r: boolean }>(
      `SELECT app.sod_step_known('bill.pay') AS s, app.sod_rule_known('SOD_NOPE') AS r`,
    );
    expect(unknown.rows[0]).toEqual({ s: false, r: false });
    for (const role of ROLE_IDS) {
      const { rows } = await tdb.admin.query<{ ok: boolean }>(
        'SELECT app.role_allows_sod_manage($1) AS ok',
        [role],
      );
      expect(rows[0]?.ok, role).toBe(
        (ROLE_TEMPLATES[role].permissions as readonly string[]).includes('settings.sod.manage'),
      );
    }
  });

  it('lf_app records steps; the ledger refuses unknown steps and steps of another subject type', async () => {
    await action({ subject_id: 'bill-62-1', amount: '2750.0000' });
    const { rows } = await tdb.admin.query(
      `SELECT subject_type, subject_id, step, actor_user_id, amount::text FROM app.sod_action WHERE subject_id = 'bill-62-1'`,
    );
    expect(rows).toEqual([
      {
        subject_type: 'bill',
        subject_id: 'bill-62-1',
        step: 'bill.enter',
        actor_user_id: CLERK,
        amount: '2750.0000',
      },
    ]);
    expect(await sqlState(action({ step: 'bill.pay' }))).toBe('23514');
    expect(await sqlState(action({ subject_type: 'credit_note', step: 'bill.enter' }))).toBe(
      '23514',
    );
    expect(await sqlState(action({ amount: '-1' }))).toBe('23514');
  });

  it('no UPDATE or DELETE: lf_app lacks the privilege, and the trigger refuses even the owner of the tables', async () => {
    await action({ subject_id: 'bill-62-2' });
    for (const t of ['sod_action', 'sod_settings', 'sod_exception', 'sod_exception_ack']) {
      expect(
        await sqlState(
          inTenant((trx) =>
            sql`UPDATE ${sql.table(`app.${t}`)} SET tenant_id = tenant_id`.execute(trx),
          ),
        ),
        t,
      ).toBe('42501');
      expect(
        await sqlState(inTenant((trx) => sql`DELETE FROM ${sql.table(`app.${t}`)}`.execute(trx))),
        t,
      ).toBe('42501');
    }
    expect(await sqlState(tdb.admin.query(`UPDATE app.sod_action SET step = step`))).toBe('23514');
    expect(await sqlState(tdb.admin.query(`DELETE FROM app.sod_action`))).toBe('23514');
    const { rows } = await tdb.admin.query(
      `SELECT 1 FROM app.sod_action WHERE subject_id = 'bill-62-2'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('settings: only an active Owner (settings.sod.manage) with a reason; defaults equal the TypeScript placeholders; audited', async () => {
    const before = (await auditActions()).filter((a) => a === 'sod.settings_changed').length;
    expect(await sqlState(settings({ by: FA }))).toBe('42501');
    expect(await sqlState(settings({ by: CLERK }))).toBe('42501');
    expect(await sqlState(settings({ reason: '  ' }))).toBe('23514');
    expect(await sqlState(settings({ bill: '-0.0001' }))).toBe('23514');
    expect(await sqlState(settings({ tz: 'Mars/Olympus_Mons' }))).toBe('23514');
    await inTenant((trx) =>
      sql`INSERT INTO app.sod_settings (set_by, reason) VALUES (${OWNER}, 'defaults')`.execute(trx),
    );
    const { rows } = await tdb.admin.query(
      `SELECT small_team_mode, bill_self_approval_threshold::text AS bill,
              credit_note_self_approval_threshold::text AS credit_note,
              journal_approval_threshold::text AS journal,
              batch_two_releasers_threshold::text AS batch, report_timezone
         FROM app.sod_settings WHERE tenant_id = $1 AND reason = 'defaults'`,
      [T],
    );
    expect(rows[0]).toEqual({
      small_team_mode: DEFAULT_SOD_SETTINGS.smallTeamMode,
      bill: DEFAULT_SOD_SETTINGS.thresholds.bill_self_approval,
      credit_note: DEFAULT_SOD_SETTINGS.thresholds.credit_note_self_approval,
      journal: DEFAULT_SOD_SETTINGS.thresholds.journal_approval,
      batch: DEFAULT_SOD_SETTINGS.thresholds.batch_two_releasers,
      report_timezone: DEFAULT_SOD_SETTINGS.reportTimezone,
    });
    const after = (await auditActions()).filter((a) => a === 'sod.settings_changed').length;
    expect(after).toBe(before + 1);
  });

  it('exceptions: reason required; an external reviewer is another active user; audited', async () => {
    const before = (await auditActions()).filter((a) => a === 'sod.exception_recorded').length;
    expect(await sqlState(exception({ reason: ' ' }))).toBe('23514');
    expect(await sqlState(exception({ kind: 'external_reviewer' }))).toBe('23514'); // no reviewer
    expect(await sqlState(exception({ kind: 'external_reviewer', reviewer: OWNER }))).toBe('23514'); // self
    expect(await sqlState(exception({ kind: 'external_reviewer', reviewer: GONE }))).toBe('23514'); // disabled
    expect(await sqlState(exception({ rule: 'SOD_NOPE' }))).toBe('23514');
    expect(await sqlState(exception({ kind: 'recorded_exception', reviewer: REVIEWER }))).toBe(
      '23514',
    );
    await exception({ subject_id: 'bill-62-x', kind: 'external_reviewer', reviewer: REVIEWER });
    await exception({ subject_id: 'bill-62-y' });
    const after = (await auditActions()).filter((a) => a === 'sod.exception_recorded').length;
    expect(after).toBe(before + 2);
  });

  it('acknowledgements: only the Owner, only for a Monday week start; audited', async () => {
    expect(await sqlState(ack({ by: FA }))).toBe('42501');
    expect(await sqlState(ack({ week: '2026-10-20' }))).toBe('23514'); // a Tuesday
    await ack({ week: '2026-10-12', note: 'reviewed' });
    expect(await auditActions()).toContain('sod.exceptions_acknowledged');
  });

  it('lf_app cannot back-date: occurred_at and acknowledged_at are the database clock', async () => {
    await exception({ subject_id: 'bill-62-backdated', at: '2020-01-01T00:00:00Z' });
    await inTenant((trx) =>
      sql`INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, occurred_at)
            VALUES ('bill', 'bill-62-backdated', 'bill.enter', ${CLERK}, '2020-01-01T00:00:00Z')`.execute(
        trx,
      ),
    );
    await ack({ week: '2026-10-05', at: '2020-01-01T00:00:00Z' });
    const { rows } = await tdb.admin.query<{ old: number }>(
      `SELECT (SELECT count(*) FROM app.sod_exception WHERE occurred_at < '2026-01-01')::int
            + (SELECT count(*) FROM app.sod_action WHERE occurred_at < '2026-01-01')::int
            + (SELECT count(*) FROM app.sod_exception_ack WHERE acknowledged_at < '2026-01-01')::int AS old`,
    );
    expect(rows[0]?.old).toBe(0);
  });

  it("a row for another tenant is refused by RLS (42501), not by the trigger's checks", async () => {
    expect(
      await sqlState(
        inTenant((trx) =>
          sql`INSERT INTO app.sod_exception (tenant_id, rule, subject_type, subject_id, step, actor_user_id, kind, reason)
              VALUES (${OTHER}, 'SOD_BILL_SELF_APPROVAL', 'bill', 'b', 'bill.approve', ${OTHER_OWNER}, 'recorded_exception', 'r')`.execute(
            trx,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('weekly report: Monday-to-Monday in the tenant time zone, with acknowledgement status; other tenants invisible', async () => {
    // Week of Monday 2026-09-07 in Australia/Sydney (UTC+10): 2026-09-06T14:00Z … 2026-09-13T14:00Z.
    await exceptionAt({ subject_id: 'w-before', at: '2026-09-06T13:59:59Z' });
    await exceptionAt({ subject_id: 'w-first', at: '2026-09-06T14:00:00Z' });
    await exceptionAt({
      subject_id: 'w-last',
      at: '2026-09-13T13:59:59Z',
      kind: 'external_reviewer',
      reviewer: REVIEWER,
    });
    await exceptionAt({ subject_id: 'w-after', at: '2026-09-13T14:00:00Z' });
    await exceptionAt(
      { subject_id: 'w-foreign', actor: OTHER_OWNER, at: '2026-09-08T00:00:00Z' },
      OTHER,
    );
    // acknowledged after w-first, before w-last
    await tdb.admin.query(
      `INSERT INTO app.sod_exception_ack (tenant_id, week_start, acknowledged_by, acknowledged_at)
       VALUES ($1, '2026-09-07', $2, '2026-09-13T13:00:00Z')`,
      [T, OWNER],
    );

    const report = await inTenant((trx) =>
      sql<{
        subject_id: string;
        rule: string;
        kind: string;
        actor_user_id: string;
        reviewer_user_id: string | null;
        reason: string;
        acknowledged: boolean;
      }>`SELECT subject_id, rule, kind, actor_user_id, reviewer_user_id, reason, acknowledged
           FROM app.sod_exception_report(${'2026-09-07'}::date)`.execute(trx),
    );
    expect(report.rows.map((r) => [r.subject_id, r.acknowledged])).toEqual([
      ['w-first', true],
      ['w-last', false],
    ]);
    expect(report.rows[1]).toMatchObject({
      rule: 'SOD_BILL_SELF_APPROVAL',
      kind: 'external_reviewer',
      actor_user_id: OWNER,
      reviewer_user_id: REVIEWER,
      reason: 'sole trader',
    });
    expect(
      await sqlState(
        inTenant((trx) =>
          sql`SELECT * FROM app.sod_exception_report(${'2026-09-08'}::date)`.execute(trx),
        ),
      ),
    ).toBe('22023'); // not a Monday
  });
});
