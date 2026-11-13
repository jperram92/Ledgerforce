/**
 * SS-UC10-06 — reopening a hard-locked period over HTTP (T-0079, UC-10, design §3.5, §6.2,
 * §6.5 rule 6, ADR-0056). October is hard-locked; Finance Admin A asks to reopen it to soft close
 * with a written reason, Finance Admin B approves. Both routes need period.reopen and a fresh
 * step-up; the approver must be a different person (SoD SOD_PERIOD_REOPEN_SELF_APPROVAL, and
 * migration 0018 again); one approval leaves the period hard-locked; after two it reopens and the
 * audit log holds both people. Real PostgreSQL as lf_app, real sessions; step-up is recorded on
 * the session as the IdP callback does (the IdP round trip is proven in mfa-step-up.db.test.ts).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@ledgerforce/db';
import { generateFiscalYear, setPeriodStatus } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const TENANT = '01900000-0000-7000-8000-000000007901';
const OTHER_TENANT = '01900000-0000-7000-8000-000000007902';

let f: LedgerFixture;
let api: Api;
let october = '';
let otherTenantPeriod = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  faA: { id: randomUUID(), roles: ['finance_admin'] },
  faB: { id: randomUUID(), roles: ['finance_admin'] },
  owner: { id: randomUUID(), roles: ['owner'] },
  acc: { id: randomUUID(), roles: ['accountant'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A session whose last (MFA) authentication was `ageMinutes` ago. */
async function login(who: string, ageMinutes: number) {
  if (!api.sessions) throw new Error('sessions not configured');
  cookies.set(
    who,
    await api.sessions.create(f.tenantId, {
      userId: people[who]?.id ?? '',
      amr: ['pwd', 'otp'],
      acr: null,
      authTime: new Date(Date.now() - ageMinutes * 60 * 1000),
    }),
  );
}

/** Step-up: a new MFA authentication recorded on the same session (as the IdP callback does). */
async function stepUp(who: string) {
  const sessionId = cookies.get(who)?.split('.')[1] ?? '';
  await f.inTenant(
    (trx) =>
      api.sessions?.reauthenticateInTx(trx, sessionId, {
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }) ?? Promise.resolve(),
  );
}

async function periodStatus(id: string): Promise<string> {
  const r = await f.admin.query<{ status: string }>(
    'SELECT status FROM app.fiscal_period WHERE id = $1',
    [id],
  );
  return r.rows[0]?.status ?? 'missing';
}

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@reopen.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  // October 2026 (FY2027 period 4) of the main company, hard-locked after BAS by Finance Admin A.
  const p = await f.admin.query<{ id: string }>(
    `SELECT id FROM app.fiscal_period WHERE company_id = $1 AND start_date = '2026-10-01'`,
    [f.companyId],
  );
  october = p.rows[0]?.id ?? '';
  await f.inTenant((trx) =>
    setPeriodStatus(trx, {
      periodId: october,
      status: 'hard_locked',
      actorId: people.faA?.id ?? '',
    }),
  );
  // A second tenant's period, for isolation.
  otherTenantPeriod = await withTenant(f.db, OTHER_TENANT, async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: OTHER_TENANT, name: 'Other Pty Ltd' })
      .execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const fy = await generateFiscalYear(trx, {
      companyId: c.id,
      convention: 'AU',
      startYear: 2026,
    });
    return fy.periods[3]?.id ?? '';
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  await login('faA', 30);
  await login('faB', 30);
  await login('owner', 30);
  await login('acc', 1);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const REASON = 'BAS amendment: supplier invoice SI-2210 was missed in October';
const requestReopen = (who: string, body: unknown, period = october) =>
  call('POST', `/periods/${period}/reopen-requests`, who, body);
const approve = (who: string, id: string) =>
  call('POST', `/periods/reopen-requests/${id}/approve`, who);

describe('SS-UC10-06: Reopen needs two approvers and a reason', () => {
  let requestId = '';

  it('SS-UC10-06 without a fresh step-up the request is refused with step_up_required (audited)', async () => {
    const res = await requestReopen('faA', { to_status: 'soft_closed', reason: REASON });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const a = await f.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'step_up_required' AND actor_user_id = $2`,
      [f.tenantId, people.faA?.id],
    );
    expect(a.rows[0]?.n).toBe('1');
    expect(await periodStatus(october)).toBe('hard_locked');
  });

  it('SS-UC10-06 a missing or blank reason is refused; nothing is requested', async () => {
    await stepUp('faA');
    for (const body of [
      { to_status: 'soft_closed' },
      { to_status: 'soft_closed', reason: '   ' },
      { to_status: 'soft_closed', reason: 42 },
    ]) {
      const res = await requestReopen('faA', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'reason_required' });
    }
    const bad = await requestReopen('faA', { to_status: 'hard_locked', reason: REASON });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_reopen_request' });
    const r = await f.admin.query('SELECT 1 FROM app.period_reopen_request WHERE period_id = $1', [
      october,
    ]);
    expect(r.rowCount).toBe(0);
  });

  it('SS-UC10-06 a user without period.reopen is refused', async () => {
    const res = await requestReopen('acc', { to_status: 'soft_closed', reason: REASON });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden', permission: 'period.reopen' });
  });

  it('SS-UC10-06 one approver requests: the request is pending and the period stays hard-locked; a replay returns the same request', async () => {
    const res = await requestReopen('faA', { to_status: 'soft_closed', reason: `  ${REASON} ` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      period_id: october,
      to_status: 'soft_closed',
      reason: REASON,
      status: 'pending',
      requested_by: people.faA?.id,
      approved_by: null,
      period_status: 'hard_locked',
    });
    requestId = String(body.id);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await periodStatus(october)).toBe('hard_locked'); // a single approval is not enough

    const replay = await requestReopen('faA', { to_status: 'soft_closed', reason: REASON });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: requestId, status: 'pending' });

    const other = await requestReopen('owner', { to_status: 'open', reason: 'Different idea' });
    expect(other.status).toBe(401); // owner has not stepped up yet
    await stepUp('owner');
    const conflict = await requestReopen('owner', { to_status: 'open', reason: 'Different idea' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'reopen_request_pending' });
  });

  it('SS-UC10-06 the same person cannot approve their own request', async () => {
    const res = await approve('faA', requestId);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_PERIOD_REOPEN_SELF_APPROVAL',
    });
    expect(await periodStatus(october)).toBe('hard_locked');
  });

  it('SS-UC10-06 the second approver needs a fresh step-up too', async () => {
    const res = await approve('faB', requestId);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(await periodStatus(october)).toBe('hard_locked');
  });

  it('SS-UC10-06 after a second, distinct approver the period reopens and the audit log has both', async () => {
    await stepUp('faB');
    const res = await approve('faB', requestId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: requestId,
      period_id: october,
      status: 'approved',
      requested_by: people.faA?.id,
      approved_by: people.faB?.id,
      reason: REASON,
      period_status: 'soft_closed',
    });
    expect(await periodStatus(october)).toBe('soft_closed');

    const audit = await f.admin.query<{
      action: string;
      actor_user_id: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT action, actor_user_id, entity_type, entity_id FROM audit.audit_log
        WHERE tenant_id = $1 AND (entity_id = $2 OR entity_id = $3)
        ORDER BY occurred_at, id`,
      [f.tenantId, requestId, october],
    );
    const rows = audit.rows.map((r) => [r.action, r.actor_user_id, r.entity_type]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['period.reopen_requested', people.faA?.id, 'period_reopen_request'],
        ['POST /periods/:periodId/reopen-requests', people.faA?.id, 'period_reopen_request'],
        ['period.reopen_approved', people.faB?.id, 'period_reopen_request'],
        ['period.status_changed', people.faB?.id, 'fiscal_period'],
        [
          'POST /periods/reopen-requests/:requestId/approve',
          people.faB?.id,
          'period_reopen_request',
        ],
      ]),
    );
    const change = await f.admin.query<{ reason: string; reopen_request_id: string }>(
      `SELECT reason, reopen_request_id FROM app.period_status_change
        WHERE period_id = $1 AND from_status = 'hard_locked'`,
      [october],
    );
    expect(change.rows).toEqual([{ reason: REASON, reopen_request_id: requestId }]);
    const sod = await f.admin.query<{ step: string; actor_user_id: string }>(
      `SELECT DISTINCT step, actor_user_id FROM app.sod_action
        WHERE subject_type = 'period_reopen_request' AND subject_id = $1 ORDER BY step DESC`,
      [requestId],
    );
    // Distinct: the SoD engine records the step again on a replayed request (as for batches).
    expect(sod.rows).toEqual([
      { step: 'period_reopen_request.request', actor_user_id: people.faA?.id },
      { step: 'period_reopen_request.approve', actor_user_id: people.faB?.id },
    ]);
  });

  it('SS-UC10-06 a replayed approval returns the same result; a third approver gets 409', async () => {
    const replay = await approve('faB', requestId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: requestId, status: 'approved' });
    const late = await approve('owner', requestId);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'reopen_request_not_pending' });
    expect(await periodStatus(october)).toBe('soft_closed');
  });

  it('SS-UC10-06 the period lists its reopen requests with both approvers', async () => {
    const res = await call('GET', `/periods/${october}/reopen-requests`, 'acc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      period_id: october,
      period_status: 'soft_closed',
      requests: [
        expect.objectContaining({
          id: requestId,
          status: 'approved',
          requested_by: people.faA?.id,
          approved_by: people.faB?.id,
          reason: REASON,
          to_status: 'soft_closed',
        }),
      ],
    });
  });

  it('SS-UC10-06 a period that is not hard-locked cannot take a reopen request', async () => {
    const res = await requestReopen('owner', { to_status: 'open', reason: REASON });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'period_not_hard_locked' });
  });

  it("SS-UC10-06 another tenant's period and unknown ids answer 404", async () => {
    const res = await requestReopen(
      'owner',
      { to_status: 'open', reason: REASON },
      otherTenantPeriod,
    );
    expect(res.status).toBe(404);
    expect((await call('GET', `/periods/${otherTenantPeriod}/reopen-requests`, 'acc')).status).toBe(
      404,
    );
    expect((await approve('owner', randomUUID())).status).toBe(404);
    expect((await approve('owner', 'not-a-uuid')).status).toBe(400);
  });
});
