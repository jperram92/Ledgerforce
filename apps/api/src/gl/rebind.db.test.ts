/**
 * PUT /accounts/system-roles/:role (T-0146, AC-3) against a real PostgreSQL as lf_app.
 * - Needs settings.chart.manage (Owner, Finance Admin) and an Idempotency-Key.
 * - Moves the role's binding (design §3.2) and writes one audit row.
 * - A replay, meaning the role is already on that account, answers 200 with changed:false.
 * - A refused binding is 422 with the database message.
 * - An account that is not in the company is 404.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let api: Api;
let spare = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; role: string }> = {
  fa: { id: randomUUID(), role: 'finance_admin' },
  accountant: { id: randomUUID(), role: 'accountant' },
};

function put(who: string, role: string, body: unknown, key: string | null = randomUUID()) {
  return fetch(`${api.url}/accounts/system-roles/${role}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: `lf_session=${cookies.get(who) ?? ''}`,
      'sec-fetch-site': 'same-origin',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}
const audits = async () =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'system_role_binding'`,
      [f.tenantId],
    )
  ).rows[0]?.n ?? 0;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014602');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@rebind.test`, who],
    );
    await f.admin.query(
      'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [f.tenantId, p.id, p.role],
    );
  }
  spare =
    (
      await f.admin.query<{ id: string }>(
        `INSERT INTO app.account (tenant_id, company_id, code, name, type, subtype, normal_balance)
         VALUES ($1, $2, '6990', 'Rounding (new)', 'expense', 'operating_expense', 'debit') RETURNING id`,
        [f.tenantId, f.companyId],
      )
    ).rows[0]?.id ?? '';
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
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0146 AC-3: re-bind a system role over HTTP', () => {
  it('needs settings.chart.manage (403) and an Idempotency-Key (400)', async () => {
    const body = { company_id: f.companyId, account_id: spare };
    expect((await put('accountant', 'ROUNDING', body)).status).toBe(403);
    expect((await put('fa', 'ROUNDING', body, null)).status).toBe(400);
    expect(await audits()).toBe(0);
  });

  it('the Finance Admin moves ROUNDING to another account; one audit row; a replay changes nothing', async () => {
    const body = { company_id: f.companyId, account_id: spare };
    const r = await put('fa', 'ROUNDING', body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ role: 'ROUNDING', account_id: spare, changed: true });
    expect(await audits()).toBe(1);
    const again = await put('fa', 'ROUNDING', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ changed: false });
    expect(await audits()).toBe(1);
  });

  it('a binding the database refuses is 422 with its message; an account outside the company is 404', async () => {
    const asset = f.acct['1500'] ?? '';
    const refused = await put('fa', 'ROUNDING', { company_id: f.companyId, account_id: asset });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: 'REBIND_REFUSED',
      message: expect.stringMatching(/not allowed/),
    });
    const foreign = await put('fa', 'ROUNDING', {
      company_id: f.companyId,
      account_id: f.otherAcct['6230'] ?? randomUUID(),
    });
    expect(foreign.status).toBe(404);
    expect(
      (await put('fa', 'NOT_A_ROLE', { company_id: f.companyId, account_id: spare })).status,
    ).toBe(404);
  });
});
