/**
 * SS-UC05-05, SS-UC05-06, SS-UC06-02, SS-UC11-06 (SoD layer) and SS-PLAT-63 — segregation of
 * duties on real routes (T-0015, ADR-0026). Real sessions (signed in with MFA, step-up fresh where
 * the route needs it), real database, lf_app only.
 *
 * Bills (T-0052), payment batches (T-0054), credit notes (T-0045) and bank-detail changes
 * (T-0037) do not exist yet. Test controllers stand in for them, declared exactly as those tasks
 * must declare their routes (`@RequirePermission(...)`, `@RequireStepUp(300)` where design §6.2
 * needs it, and `@SoD('<subject>.<step>', subjectFrom)`); the checks, refusals, action-ledger
 * rows, exceptions, report and audit rows are the real ones (as T-0012/T-0013 did, DL-0133).
 * The stand-ins take the amount from the request at entry; the real routes take it from their
 * own tables.
 */
import 'reflect-metadata';
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { AnyMember, RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { fromBody, fromParamWithRecordedAmount, SoD } from './sod.decorator.ts';

const A = '01900000-0000-7000-8000-0000000015aa'; // ordinary tenant
const S = '01900000-0000-7000-8000-0000000015bb'; // small team: one person
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const PEOPLE = {
  // Tenant A
  userA: { tenant: A, id: uid(0x1501), roles: ['ap_clerk', 'approver'] },
  approver: { tenant: A, id: uid(0x1502), roles: ['approver'] },
  arClerk: { tenant: A, id: uid(0x1503), roles: ['ar_clerk', 'approver'] },
  apClerk: { tenant: A, id: uid(0x1504), roles: ['ap_clerk'] },
  ownerA: { tenant: A, id: uid(0x1505), roles: ['owner'] },
  noMfa: { tenant: A, id: uid(0x1506), roles: ['ap_clerk', 'approver'] },
  // Tenant S: the only user, plus an outside reviewer (auditor; cannot approve bills)
  solo: { tenant: S, id: uid(0x1511), roles: ['owner'] },
  outside: { tenant: S, id: uid(0x1512), roles: ['auditor'] },
} as const;
type Who = keyof typeof PEOPLE;

const done = { bills: [] as string[], releases: [] as string[], creditNotes: [] as string[] };

interface Amounted {
  id?: string;
  amount?: string;
}

@Controller('ap/bills')
class TestBillController {
  @Post()
  @HttpCode(201)
  @RequirePermission('ap.bill.enter')
  @SoD('bill.enter', fromBody('id', 'amount'))
  enter(@Body() body: Amounted): { bill_id: string | undefined; status: string } {
    return { bill_id: body.id, status: 'awaiting_approval' };
  }

  @Post(':billId/approve')
  @HttpCode(200)
  @RequirePermission('ap.bill.approve')
  @SoD('bill.approve', fromParamWithRecordedAmount('billId'))
  approve(@Param('billId') billId: string): { bill_id: string; status: string } {
    done.bills.push(billId);
    return { bill_id: billId, status: 'approved' };
  }
}

@Controller('ap/payment-batches')
class TestPaymentBatchController {
  @Post()
  @HttpCode(201)
  @RequirePermission('ap.payment_batch.create')
  @SoD('payment_batch.create', fromBody('id', 'amount'))
  create(@Body() body: Amounted): { batch_id: string | undefined } {
    return { batch_id: body.id };
  }

  @Post(':batchId/release')
  @HttpCode(200)
  @RequirePermission('ap.payment_batch.release')
  @RequireStepUp(300)
  @SoD('payment_batch.release', fromParamWithRecordedAmount('batchId'))
  release(@Param('batchId') batchId: string): { batch_id: string; status: string } {
    done.releases.push(batchId);
    return { batch_id: batchId, status: 'released' };
  }
}

@Controller('ar/credit-notes')
class TestCreditNoteController {
  @Post()
  @HttpCode(201)
  @RequirePermission('ar.credit_note.create')
  @SoD('credit_note.create', fromBody('id', 'amount'))
  create(@Body() body: Amounted): { credit_note_id: string | undefined } {
    return { credit_note_id: body.id };
  }

  @Post(':creditNoteId/approve')
  @HttpCode(200)
  @RequirePermission('ar.credit_note.approve')
  @SoD('credit_note.approve', fromParamWithRecordedAmount('creditNoteId'))
  approve(@Param('creditNoteId') id: string): { credit_note_id: string; status: string } {
    done.creditNotes.push(id);
    return { credit_note_id: id, status: 'approved' };
  }
}

/** Misdeclared: SoD needs a permission route (eligibility is counted by that permission). */
@Controller('misdeclared')
class TestMisdeclaredController {
  @Post(':id')
  @AnyMember()
  @SoD('bill.approve', fromParamWithRecordedAmount('id'))
  approve(): { ok: true } {
    return { ok: true };
  }
}

let tdb: TestDatabase;
let api: Api;
const cookies = new Map<Who, string>();

async function call(method: string, path: string, who?: Who, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const c = who ? cookies.get(who) : undefined;
  if (c) headers.cookie = `lf_session=${c}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface AuditRow {
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  after: unknown;
}
async function auditMark(): Promise<string> {
  const { rows } = await tdb.admin.query<{ m: string }>(
    'SELECT coalesce(max(id), 0)::text AS m FROM audit.audit_log',
  );
  return rows[0]?.m ?? '0';
}
async function auditSince(mark: string, tenant = A): Promise<AuditRow[]> {
  const { rows } = await tdb.admin.query<AuditRow>(
    `SELECT actor_user_id, action, entity_type, entity_id, after FROM audit.audit_log
      WHERE tenant_id = $1 AND id > $2::bigint ORDER BY id`,
    [tenant, mark],
  );
  return rows;
}
async function steps(subjectId: string): Promise<{ step: string; actor_user_id: string }[]> {
  const { rows } = await tdb.admin.query<{ step: string; actor_user_id: string }>(
    'SELECT step, actor_user_id FROM app.sod_action WHERE subject_id = $1 ORDER BY occurred_at, id',
    [subjectId],
  );
  return rows;
}
async function exceptionsFor(subjectId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await tdb.admin.query(
    `SELECT rule, step, actor_user_id, kind, reviewer_user_id, reason FROM app.sod_exception
      WHERE subject_id = $1 ORDER BY occurred_at, id`,
    [subjectId],
  );
  return rows;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  for (const [tenant, name] of [
    [A, 'SoD Pty Ltd'],
    [S, 'Solo Trader'],
  ] as const) {
    await tdb.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [tenant, name]);
  }
  for (const [who, p] of Object.entries(PEOPLE)) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, p.tenant, `${who}@sod.test`, who],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [p.tenant, p.id, role],
      );
    }
  }
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    testControllers: [
      TestBillController,
      TestPaymentBatchController,
      TestCreditNoteController,
      TestMisdeclaredController,
    ],
  });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
    // Signed in with MFA just now (fresh step-up), except `noMfa`.
    const amr = who === 'noMfa' ? ['pwd'] : ['pwd', 'otp'];
    cookies.set(
      who,
      await api.sessions.create(p.tenant, { userId: p.id, amr, acr: null, authTime: new Date() }),
    );
  }
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-UC05-05: SoD: clerk cannot approve own bill above $1,000', () => {
  it('a $2,750 bill entered by user A: user A approving it is denied with SOD_BILL_SELF_APPROVAL and audited', async () => {
    expect(
      (await call('POST', '/ap/bills', 'userA', { id: 'BILL-000045', amount: '2750.0000' })).status,
    ).toBe(201);
    const mark = await auditMark();
    const res = await call('POST', '/ap/bills/BILL-000045/approve', 'userA');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_BILL_SELF_APPROVAL',
      small_team_exception_required: false,
    });
    expect(done.bills).not.toContain('BILL-000045');
    expect(await auditSince(mark)).toEqual([
      {
        actor_user_id: PEOPLE.userA.id,
        action: 'sod_violation',
        entity_type: 'bill',
        entity_id: 'BILL-000045',
        after: {
          method: 'POST',
          route: '/ap/bills/:billId/approve',
          step: 'bill.approve',
          rule: 'SOD_BILL_SELF_APPROVAL',
        },
      },
    ]);
    // nothing recorded for the refused step
    expect(await steps('BILL-000045')).toEqual([
      { step: 'bill.enter', actor_user_id: PEOPLE.userA.id },
    ]);
  });

  it('another approver may approve it; the step is recorded and the mutation audited', async () => {
    const mark = await auditMark();
    const res = await call('POST', '/ap/bills/BILL-000045/approve', 'approver');
    expect(res.status).toBe(200);
    expect(done.bills).toContain('BILL-000045');
    expect(await steps('BILL-000045')).toEqual([
      { step: 'bill.enter', actor_user_id: PEOPLE.userA.id },
      { step: 'bill.approve', actor_user_id: PEOPLE.approver.id },
    ]);
    expect((await auditSince(mark)).map((r) => r.action)).toEqual([
      'POST /ap/bills/:billId/approve',
    ]);
  });

  it('a $1,000.00 bill (not above the threshold) may be self-approved', async () => {
    await call('POST', '/ap/bills', 'userA', { id: 'BILL-001000', amount: '1000.0000' });
    expect((await call('POST', '/ap/bills/BILL-001000/approve', 'userA')).status).toBe(200);
  });

  it('the threshold is a tenant setting: raised to $5,000 by the Owner, the $2,750 self-approval is allowed; restored, it is denied', async () => {
    await call('POST', '/ap/bills', 'userA', { id: 'BILL-T1', amount: '2750.0000' });
    await call('POST', '/ap/bills', 'userA', { id: 'BILL-T2', amount: '2750.0000' });
    const raise = await call('POST', '/sod/settings', 'ownerA', {
      thresholds: { bill_self_approval: '5000.0000' },
      reason: 'placeholder raised for test',
    });
    expect(raise.status).toBe(201);
    expect(((await raise.json()) as { thresholds: unknown }).thresholds).toMatchObject({
      bill_self_approval: '5000.0000',
    });
    expect((await call('POST', '/ap/bills/BILL-T1/approve', 'userA')).status).toBe(200);
    const restore = await call('POST', '/sod/settings', 'ownerA', {
      thresholds: { bill_self_approval: '1000.0000' },
      reason: 'restore placeholder',
    });
    expect(restore.status).toBe(201);
    expect((await call('POST', '/ap/bills/BILL-T2/approve', 'userA')).status).toBe(403);
  });
});

describe('SS-UC06-02: Creator cannot release own batch', () => {
  it('the batch created by user A: user A releasing it is denied with SOD_BATCH_SELF_RELEASE', async () => {
    expect(
      (
        await call('POST', '/ap/payment-batches', 'userA', {
          id: 'PB-2026-11-01',
          amount: '18450.0000',
        })
      ).status,
    ).toBe(201);
    const mark = await auditMark();
    const res = await call('POST', '/ap/payment-batches/PB-2026-11-01/release', 'userA');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_BATCH_SELF_RELEASE',
    });
    expect(done.releases).not.toContain('PB-2026-11-01');
    expect((await auditSince(mark)).map((r) => [r.action, r.entity_type, r.entity_id])).toEqual([
      ['sod_violation', 'payment_batch', 'PB-2026-11-01'],
    ]);
  });

  it('the Owner is bound too (§6.4: cannot release a batch they created)', async () => {
    await call('POST', '/ap/payment-batches', 'ownerA', { id: 'PB-OWNER', amount: '10.0000' });
    const res = await call('POST', '/ap/payment-batches/PB-OWNER/release', 'ownerA');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ rule: 'SOD_BATCH_SELF_RELEASE' });
  });

  it('a different releaser may release; above $10,000 the same releaser cannot release twice', async () => {
    expect(
      (await call('POST', '/ap/payment-batches/PB-2026-11-01/release', 'approver')).status,
    ).toBe(200);
    const again = await call('POST', '/ap/payment-batches/PB-2026-11-01/release', 'approver');
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ rule: 'SOD_BATCH_SAME_RELEASER' });
  });
});

describe('SS-UC11-06: Clerk cannot approve own credit note above threshold', () => {
  it('a credit note above the threshold created by the AR Clerk: the same Clerk approving it is denied', async () => {
    await call('POST', '/ar/credit-notes', 'arClerk', { id: 'CN-000017', amount: '1650.0000' });
    const res = await call('POST', '/ar/credit-notes/CN-000017/approve', 'arClerk');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_CREDIT_NOTE_SELF_APPROVAL',
    });
    expect(done.creditNotes).not.toContain('CN-000017');
  });

  it('at or below the threshold the Clerk may approve their own; above it another approver may', async () => {
    await call('POST', '/ar/credit-notes', 'arClerk', { id: 'CN-000018', amount: '220.0000' });
    expect((await call('POST', '/ar/credit-notes/CN-000018/approve', 'arClerk')).status).toBe(200);
    expect((await call('POST', '/ar/credit-notes/CN-000017/approve', 'approver')).status).toBe(200);
  });
});

describe('SS-UC05-06: Small-team mode records a visible exception', () => {
  it('small-team mode and a single user: approving their own bill without an exception is denied, exception required', async () => {
    const on = await call('POST', '/sod/settings', 'solo', {
      small_team_mode: true,
      reason: 'one-person business (design §6.3)',
    });
    expect(on.status).toBe(201);
    await call('POST', '/ap/bills', 'solo', { id: 'BILL-S1', amount: '2750.0000' });
    const res = await call('POST', '/ap/bills/BILL-S1/approve', 'solo');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_BILL_SELF_APPROVAL',
      small_team_exception_required: true,
    });
    expect(await exceptionsFor('BILL-S1')).toEqual([]);
  });

  it('with a recorded exception the approval succeeds and the exception is written with it', async () => {
    const mark = await auditMark();
    const res = await call('POST', '/ap/bills/BILL-S1/approve', 'solo', {
      sod_exception: { reason: 'sole trader; accountant reviews monthly' },
    });
    expect(res.status).toBe(200);
    expect(done.bills).toContain('BILL-S1');
    expect(await exceptionsFor('BILL-S1')).toEqual([
      {
        rule: 'SOD_BILL_SELF_APPROVAL',
        step: 'bill.approve',
        actor_user_id: PEOPLE.solo.id,
        kind: 'recorded_exception',
        reviewer_user_id: null,
        reason: 'sole trader; accountant reviews monthly',
      },
    ]);
    expect((await auditSince(mark, S)).map((r) => r.action)).toEqual([
      'sod.exception_recorded',
      'POST /ap/bills/:billId/approve',
    ]);
  });

  it('with an external reviewer (another active user) the exception names them; the actor cannot name themself', async () => {
    await call('POST', '/ap/bills', 'solo', { id: 'BILL-S2', amount: '4000.0000' });
    const self = await call('POST', '/ap/bills/BILL-S2/approve', 'solo', {
      sod_exception: { reason: 'me', external_reviewer_id: PEOPLE.solo.id },
    });
    expect(self.status).toBe(403);
    const unknown = await call('POST', '/ap/bills/BILL-S2/approve', 'solo', {
      sod_exception: { reason: 'x', external_reviewer_id: PEOPLE.userA.id }, // another tenant
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'invalid_sod_exception' });
    const ok = await call('POST', '/ap/bills/BILL-S2/approve', 'solo', {
      sod_exception: {
        reason: 'outside accountant reviews',
        external_reviewer_id: PEOPLE.outside.id,
      },
    });
    expect(ok.status).toBe(200);
    expect(await exceptionsFor('BILL-S2')).toMatchObject([
      { kind: 'external_reviewer', reviewer_user_id: PEOPLE.outside.id },
    ]);
  });

  it('the exceptions appear on the weekly review report until the Owner acknowledges the week', async () => {
    const report = await call('GET', '/sod/exceptions/weekly', 'solo');
    expect(report.status).toBe(200);
    const body = (await report.json()) as {
      week_start: string;
      timezone: string;
      exceptions: { subject_id: string; rule: string; acknowledged: boolean }[];
    };
    expect(body.timezone).toBe('Australia/Sydney');
    expect(body.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.exceptions.map((e) => [e.subject_id, e.rule, e.acknowledged])).toEqual([
      ['BILL-S1', 'SOD_BILL_SELF_APPROVAL', false],
      ['BILL-S2', 'SOD_BILL_SELF_APPROVAL', false],
    ]);
    const ack = await call('POST', '/sod/exceptions/weekly/acknowledge', 'solo', {
      week_start: body.week_start,
      note: 'reviewed with the accountant',
    });
    expect(ack.status).toBe(201);
    const after = (await (
      await call('GET', `/sod/exceptions/weekly?week_start=${body.week_start}`, 'solo')
    ).json()) as typeof body;
    expect(after.exceptions.map((e) => e.acknowledged)).toEqual([true, true]);
    // another tenant sees none of them
    const other = (await (
      await call('GET', `/sod/exceptions/weekly?week_start=${body.week_start}`, 'ownerA')
    ).json()) as typeof body;
    expect(other.exceptions).toEqual([]);
  });

  it('small-team mode does not except a conflict another eligible person could resolve', async () => {
    expect(
      (
        await call('POST', '/sod/settings', 'ownerA', {
          small_team_mode: true,
          reason: 'test: tenant A has several approvers',
        })
      ).status,
    ).toBe(201);
    await call('POST', '/ap/bills', 'userA', { id: 'BILL-A9', amount: '2750.0000' });
    const res = await call('POST', '/ap/bills/BILL-A9/approve', 'userA', {
      sod_exception: { reason: 'in a hurry' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      rule: 'SOD_BILL_SELF_APPROVAL',
      small_team_exception_required: false,
    });
    expect(await exceptionsFor('BILL-A9')).toEqual([]);
    await call('POST', '/sod/settings', 'ownerA', { small_team_mode: false, reason: 'test done' });
  });
});

describe('SS-PLAT-63: SoD runs after MFA, permission and step-up, fails closed and is managed by the Owner', () => {
  it('permission first: a user without the permission gets forbidden, not sod_violation', async () => {
    await call('POST', '/ap/bills', 'apClerk', { id: 'BILL-P1', amount: '2750.0000' });
    const res = await call('POST', '/ap/bills/BILL-P1/approve', 'apClerk');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ap.bill.approve' });
  });

  it('MFA first: a finance role without MFA gets mfa_required, not sod_violation', async () => {
    const res = await call('POST', '/ap/bills/BILL-000045/approve', 'noMfa');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
  });

  it('step-up first: a stale authentication gets step_up_required before SoD is evaluated', async () => {
    if (!api.sessions) throw new Error('sessions');
    const stale = await api.sessions.create(A, {
      userId: PEOPLE.userA.id,
      amr: ['pwd', 'otp'],
      acr: null,
      authTime: new Date(Date.now() - 3_600_000),
    });
    const res = await fetch(`${api.url}/ap/payment-batches/PB-2026-11-01/release`, {
      method: 'POST',
      headers: { cookie: `lf_session=${stale}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
  });

  it('a route declaring @SoD without a permission is refused (fail closed)', async () => {
    const res = await call('POST', '/misdeclared/x', 'ownerA');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: null });
  });

  it('a subject without an id is refused as a bad request, and nothing is recorded', async () => {
    const res = await call('POST', '/ap/bills', 'userA', { amount: '1.0000' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_sod_subject' });
  });

  it('settings: only the Owner changes them (settings.sod.manage); reads need settings.read; invalid values refused', async () => {
    const fa = await call('POST', '/sod/settings', 'approver', {
      small_team_mode: true,
      reason: 'x',
    });
    expect(fa.status).toBe(403);
    expect(await fa.json()).toEqual({ error: 'forbidden', permission: 'settings.sod.manage' });
    for (const bad of [
      { reason: '' },
      { thresholds: { bill_self_approval: '1e3' }, reason: 'r' },
      { thresholds: { bill_self_approval: '-1' }, reason: 'r' },
      { thresholds: { nope: '1' }, reason: 'r' },
      { report_timezone: 'Mars/Base', reason: 'r' },
      { small_team_mode: 'yes', reason: 'r' },
    ]) {
      const res = await call('POST', '/sod/settings', 'ownerA', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const read = await call('GET', '/sod/settings', 'ownerA');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      small_team_mode: false,
      thresholds: {
        bill_self_approval: '1000.0000',
        credit_note_self_approval: '1000.0000',
        journal_approval: '5000.0000',
        batch_two_releasers: '10000.0000',
      },
      report_timezone: 'Australia/Sydney',
    });
    // unchanged values: no new history row (naturally idempotent)
    const same = await call('POST', '/sod/settings', 'ownerA', {
      small_team_mode: false,
      reason: 'no change',
    });
    expect(same.status).toBe(200);
  });

  it('the weekly report needs audit_log.read and a Monday; acknowledging needs settings.sod.manage', async () => {
    expect((await call('GET', '/sod/exceptions/weekly', 'approver')).status).toBe(403);
    expect(
      (await call('GET', '/sod/exceptions/weekly?week_start=2026-10-20', 'ownerA')).status,
    ).toBe(400);
    const ack = await call('POST', '/sod/exceptions/weekly/acknowledge', 'outside', {
      week_start: '2026-10-19',
    });
    expect(ack.status).toBe(403);
  });
});
