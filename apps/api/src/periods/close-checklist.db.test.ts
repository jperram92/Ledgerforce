/**
 * Close checklist and period list over HTTP (T-0148, UC-10, SS-UC10-01 via the API) against a real
 * PostgreSQL as lf_app.
 * - The GET routes need reports.run.
 * - Completing a step needs period.lock and an Idempotency-Key, is audited, and returns who, when
 *   and the resulting period status.
 * - A replay by the same user answers 200. Refusals are 409 (already done by someone else) or 422
 *   (out of order).
 * - Another tenant's period is 404.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { findPeriod } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let october = '';
let foreignOctober = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[]; name: string }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'], name: 'Fran Admin' },
  fa2: { id: randomUUID(), roles: ['finance_admin'], name: 'Gus Admin' },
  accountant: { id: randomUUID(), roles: ['accountant'], name: 'Ada Count' },
  clerk: { id: randomUUID(), roles: ['ar_clerk'], name: 'Cal Clerk' },
};

function call(path: string, who: string, init: { method?: string; key?: string } = {}) {
  const c = cookies.get(who);
  return fetch(`${api.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(c ? { cookie: `lf_session=${c}` } : {}),
      ...(init.key ? { 'idempotency-key': init.key } : {}),
    },
    ...(init.method === 'POST' ? { body: JSON.stringify({ company_id: f.companyId }) } : {}),
  });
}
const complete = (step: string, who = 'fa', key = `k-${step}-${who}`) =>
  call(`/periods/${october}/close-checklist/${step}`, who, { method: 'POST', key });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014801');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000014802');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@close.test`, p.name],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  await f.inTenant(async (trx) => {
    october = (await findPeriod(trx, f.companyId, '2026-10-15'))?.id ?? '';
  });
  await other.inTenant(async (trx) => {
    foreignOctober = (await findPeriod(trx, other.companyId, '2026-10-15'))?.id ?? '';
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0148: periods and the close checklist over HTTP', () => {
  it('lists the periods in a date range with their status (reports.run)', async () => {
    const r = await call(
      `/periods?company_id=${f.companyId}&from=2026-10-01&to=2026-11-30`,
      'accountant',
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { periods: Record<string, unknown>[] };
    expect(body.periods.map((p) => [p['start_date'], p['end_date'], p['status']])).toEqual([
      ['2026-10-01', '2026-10-31', 'open'],
      ['2026-11-01', '2026-11-30', 'open'],
    ]);
    expect(body.periods[0]).toMatchObject({ id: october });
    expect(
      (await call(`/periods?company_id=${f.companyId}&from=2026-10-01&to=2026-11-30`, 'clerk'))
        .status,
    ).toBe(403);
  });

  it('shows the seven steps, none done; 403 without reports.run; 404 for another tenant', async () => {
    const r = await call(`/periods/${october}/close-checklist?company_id=${f.companyId}`, 'fa');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { period: Record<string, unknown>; steps: unknown[] };
    expect(body.period).toMatchObject({ id: october, status: 'open', end_date: '2026-10-31' });
    expect(body.steps).toEqual(
      ['ar_lock', 'ap_lock', 'bank_recs', 'accruals', 'tb_review', 'soft_close', 'hard_lock'].map(
        (step) => ({
          step,
          completed_by: null,
          completed_by_name: null,
          completed_at: null,
          period_status: null,
        }),
      ),
    );
    expect(
      (await call(`/periods/${october}/close-checklist?company_id=${f.companyId}`, 'clerk')).status,
    ).toBe(403);
    expect(
      (await call(`/periods/${foreignOctober}/close-checklist?company_id=${f.companyId}`, 'fa'))
        .status,
    ).toBe(404);
  });

  it('completing a step needs period.lock and an Idempotency-Key; order is enforced', async () => {
    expect((await complete('ar_lock', 'accountant')).status).toBe(403);
    expect(
      (
        await call(`/periods/${october}/close-checklist/ar_lock`, 'fa', {
          method: 'POST',
        })
      ).status,
    ).toBe(400);
    const r = await complete('bank_recs');
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'OUT_OF_ORDER' });
    expect((await complete('not_a_step')).status).toBe(400);
  });

  it('SS-UC10-01 the Finance Admin completes the steps; each returns user, time and period status; replay is 200', async () => {
    const first = await complete('ar_lock');
    expect(first.status).toBe(201);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      step: 'ar_lock',
      completed_by: people['fa']?.id,
      period_status: 'ar_locked',
      replayed: false,
    });
    expect(typeof body['completed_at']).toBe('string');
    const replay = await complete('ar_lock');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      step: 'ar_lock',
      completed_at: body['completed_at'],
      replayed: true,
    });
    expect((await complete('ar_lock', 'fa2')).status).toBe(409);
    for (const step of ['ap_lock', 'bank_recs', 'accruals', 'tb_review', 'soft_close']) {
      expect((await complete(step)).status, step).toBe(201);
    }
    const list = await call(`/periods/${october}/close-checklist?company_id=${f.companyId}`, 'fa');
    const view = (await list.json()) as {
      period: { status: string };
      steps: { step: string; completed_by_name: string | null; period_status: string | null }[];
    };
    expect(view.period.status).toBe('soft_closed');
    expect(view.steps.map((s) => [s.step, s.completed_by_name, s.period_status])).toEqual([
      ['ar_lock', 'Fran Admin', 'ar_locked'],
      ['ap_lock', 'Fran Admin', 'ap_locked'],
      ['bank_recs', 'Fran Admin', 'ap_locked'],
      ['accruals', 'Fran Admin', 'ap_locked'],
      ['tb_review', 'Fran Admin', 'ap_locked'],
      ['soft_close', 'Fran Admin', 'soft_closed'],
      ['hard_lock', null, null],
    ]);
    const audits = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'close_checklist_step'`,
      [f.tenantId],
    );
    expect(audits.rows[0]?.n).toBe(6);
  });
});
