/**
 * SS-UC01-17 — changing the bank account printed on invoices over HTTP is maker-checker (T-0180,
 * ADR-0079 control 2, ADR-0080, RQ-0150). Both steps need settings.setup.manage and a fresh
 * step-up; the approver must be a different person (SOD_REMITTANCE_SELF_APPROVAL, repeated by
 * migration 0071 at COMMIT); every change is audited with the account masked to the last 3 digits,
 * and the clear number appears in no response and no audit row. Real PostgreSQL as lf_app, real
 * sessions; step-up is recorded on the session as the IdP callback does.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { withTenant } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const TENANT = '01900000-0000-7000-8000-000000018021';
const OTHER_TENANT = '01900000-0000-7000-8000-000000018022';
const NUMBER = '12345678';

let f: LedgerFixture;
let api: Api;
let operating = '';
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  owner: { id: randomUUID(), roles: ['owner'] },
  clerk: { id: randomUUID(), roles: ['accountant'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

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

const current = async (): Promise<string | null> => {
  const r = await f.admin.query<{ id: string | null }>(
    'SELECT remittance_bank_account_id AS id FROM app.ar_settings WHERE company_id = $1',
    [f.companyId],
  );
  return r.rows[0]?.id ?? null;
};

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@remit.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  operating = await f.inTenant((trx) =>
    createCompanyBankAccount(trx, kms, f.companyId, {
      glAccountId: f.acct['1010'] ?? '',
      name: 'Operating',
      bsb: '062000',
      accountNumber: NUMBER,
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
    }),
  );
  await withTenant(f.db, OTHER_TENANT, (trx) =>
    trx.insertInto('app.tenant').values({ id: OTHER_TENANT, name: 'Other Pty Ltd' }).execute(),
  );
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  await login('fa', 30);
  await login('owner', 30);
  await login('clerk', 1);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const change = (id: string) => `/setup/remittance-account/changes/${id}`;

describe('SS-UC01-17: changing the invoice remittance account needs a second person', () => {
  const id = randomUUID();

  it('SS-UC01-17 without a fresh step-up the request is refused; without the permission it is forbidden [T-0180]', async () => {
    const body = { company_id: f.companyId, bank_account_id: operating };
    const res = await call('PUT', change(id), 'fa', body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const clerk = await call('PUT', change(id), 'clerk', body);
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toMatchObject({
      error: 'forbidden',
      permission: 'settings.setup.manage',
    });
    expect(await current()).toBeNull();
  });

  it('SS-UC01-17 a malformed request is refused; an account of no company is 404 [T-0180]', async () => {
    await stepUp('fa');
    const bad = await call('PUT', change(id), 'fa', { company_id: f.companyId });
    expect(bad.status).toBe(400);
    const missing = await call('PUT', change(randomUUID()), 'fa', {
      company_id: f.companyId,
      bank_account_id: randomUUID(),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'BANK_ACCOUNT_NOT_FOUND' });
  });

  it('SS-UC01-17 the maker requests: 201 pending with masked details, nothing set; a replay is 200 [T-0180]', async () => {
    const body = { company_id: f.companyId, bank_account_id: operating };
    const res = await call('PUT', change(id), 'fa', body);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(NUMBER);
    expect(JSON.parse(text)).toMatchObject({
      id,
      status: 'requested',
      replayed: false,
      requested_by: people.fa?.id,
      bank_account: { id: operating, bsb: '062-000', account_number: '***678' },
      previous_bank_account: null,
    });
    expect(await current()).toBeNull();
    const again = await call('PUT', change(id), 'fa', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, replayed: true });
  });

  it('SS-UC01-17 the maker cannot approve their own change (sod_violation); nothing is set [T-0180]', async () => {
    const res = await call('POST', `${change(id)}/approve`, 'fa', { company_id: f.companyId });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_REMITTANCE_SELF_APPROVAL',
    });
    expect(await current()).toBeNull();
  });

  it('SS-UC01-17 the checker needs a step-up, then approves: the account is in force and GET shows it masked [T-0180]', async () => {
    const early = await call('POST', `${change(id)}/approve`, 'owner', {
      company_id: f.companyId,
    });
    expect(early.status).toBe(401);
    await stepUp('owner');
    const res = await call('POST', `${change(id)}/approve`, 'owner', { company_id: f.companyId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      status: 'approved',
      decided_by: people.owner?.id,
    });
    expect(await current()).toBe(operating);
    const replay = await call('POST', `${change(id)}/approve`, 'owner', {
      company_id: f.companyId,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    const got = await call('GET', `/setup/remittance-account?company_id=${f.companyId}`, 'clerk');
    expect(got.status).toBe(200);
    const text = await got.text();
    expect(text).not.toContain(NUMBER);
    expect(JSON.parse(text)).toMatchObject({
      account: { id: operating, account_name: 'Harbour & Co Pty Ltd', account_number: '***678' },
      pending: null,
    });
  });

  it('SS-UC01-17 a removal request can be rejected with a reason; the account stays [T-0180]', async () => {
    const removal = randomUUID();
    const req = await call('PUT', change(removal), 'fa', {
      company_id: f.companyId,
      bank_account_id: null,
    });
    expect(req.status).toBe(201);
    const noReason = await call('POST', `${change(removal)}/reject`, 'owner', {
      company_id: f.companyId,
    });
    expect(noReason.status).toBe(400);
    const res = await call('POST', `${change(removal)}/reject`, 'owner', {
      company_id: f.companyId,
      reason: 'Not agreed',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'rejected', reason: 'Not agreed' });
    expect(await current()).toBe(operating);
    const late = await call('POST', `${change(removal)}/approve`, 'owner', {
      company_id: f.companyId,
    });
    expect(late.status).toBe(409);
  });

  it('SS-UC01-17 every change is audited with the account masked; the clear number is in no audit row [T-0180]', async () => {
    const a = await f.admin.query<{ actor: string; after: string }>(
      `SELECT actor_user_id AS actor, to_jsonb(t)::text AS after FROM audit.audit_log t
        WHERE tenant_id = $1 AND entity_type = 'remittance_account_change' AND entity_id = $2
        ORDER BY occurred_at, id`,
      [f.tenantId, id],
    );
    expect(a.rows.map((r) => r.actor)).toEqual(
      expect.arrayContaining([people.fa?.id, people.owner?.id]),
    );
    expect(a.rows.every((r) => r.after.includes('***678'))).toBe(true);
    const leaked = await f.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log t
        WHERE tenant_id = $1 AND to_jsonb(t)::text LIKE $2`,
      [f.tenantId, `%${NUMBER}%`],
    );
    expect(leaked.rows[0]?.n).toBe('0');
  });

  it('SS-UC01-17 another tenant cannot read this company: 404 [T-0180]', async () => {
    const other = randomUUID();
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'o@remit.test', 'o', 'active')`,
      [other, OTHER_TENANT],
    );
    await f.admin.query(
      `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [OTHER_TENANT, other],
    );
    if (!api.sessions) throw new Error('sessions not configured');
    cookies.set(
      'other',
      await api.sessions.create(OTHER_TENANT, {
        userId: other,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
    const res = await call('GET', `/setup/remittance-account?company_id=${f.companyId}`, 'other');
    expect(res.status).toBe(404);
  });
});
