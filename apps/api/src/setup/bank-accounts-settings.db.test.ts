/**
 * SS-PLAT-130 — company bank accounts over HTTP for setup wizard step 4 (T-0185, ADR-0084,
 * RQ-0166) against a real PostgreSQL as lf_app, with real sessions and a local key ring.
 * - `GET /setup/bank-accounts` (settings.read): accounts masked to the last 3 characters, and the
 *   bank GL accounts that can take one.
 * - `POST /setup/bank-accounts` (settings.setup.manage + step-up 300 s, Idempotency-Key, audited
 *   masked): the GL account's active bank account is the replay record (DL-0700): the same request
 *   again is 200 `replayed:true`, a different one 409 GL_ACCOUNT_IN_USE. No KMS → 503.
 * - The clear number appears in no response and no audit row; another tenant's company is 404.
 * - After adding an account with ABA details, wizard step 4 has nothing missing.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const NUMBER = '12345678';
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let noKms: Api;
let c = '';
const gl: Record<string, string> = {};
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
  clerk: { id: randomUUID(), roles: ['ar_clerk'] },
};

function call(
  method: string,
  path: string,
  who: string,
  init: { key?: string | null; body?: unknown; via?: Api } = {},
) {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
  const cookie = cookies.get(who);
  if (cookie) h.cookie = `lf_session=${cookie}`;
  if (init.body !== undefined) h['content-type'] = 'application/json';
  const key = init.key === undefined ? `k-${randomUUID()}` : init.key;
  if (key !== null && method !== 'GET') h['idempotency-key'] = key;
  return fetch(`${(init.via ?? api).url}${path}`, {
    method,
    headers: h,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
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

const post = (body: Record<string, unknown>, init: { key?: string | null; via?: Api } = {}) =>
  call('POST', '/setup/bank-accounts', 'fa', { ...init, body });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const bankAudits = async () =>
  (
    await f.admin.query<{ after: unknown }>(
      `SELECT after FROM audit.audit_log WHERE tenant_id = $1 AND entity_type = 'bank_account' ORDER BY id`,
      [f.tenantId],
    )
  ).rows;
const rows = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.bank_account WHERE company_id = $1',
      [c],
    )
  ).rows[0]?.n ?? 0;
const wizardMissing = async () => {
  const r = await call('GET', `/setup/wizard?company_id=${c}&as_of=2026-11-15`, 'fa');
  const w = (await r.json()) as { steps: { step: number; missing: string[] }[] };
  return w.steps.find((s) => s.step === 4)?.missing;
};

const operating = () => ({
  company_id: c,
  gl_account_id: gl['1010'],
  name: 'Operating',
  bsb: '062 000',
  account_number: NUMBER,
  account_name: 'Bay Street Studio Pty Ltd',
  currency: 'AUD',
  apca_user_id: '123456',
  aba_user_name: 'BAY STREET STUDIO',
  aba_fi_mnemonic: 'CBA',
});

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018501');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000018502');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@bank-settings.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  c = await f.inTenant(async (trx) => {
    const co = await trx
      .insertInto('app.company')
      .values({ name: 'Bay Street Studio', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const accounts = [
      ['1010', 'Operating account', 'bank', 'AUD'],
      ['1020', 'Payroll account', 'bank', null],
      ['1030', 'USD account', 'bank', 'USD'],
      ['1200', 'Prepaid expenses', 'current_asset', null],
    ] as const;
    for (const [code, name, subtype, currency] of accounts) {
      const a = await trx
        .insertInto('app.account')
        .values({
          company_id: co.id,
          code,
          name,
          type: 'asset',
          subtype,
          normal_balance: 'debit',
          currency,
          default_tax_code: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      gl[code] = a.id;
    }
    return co.id;
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {}, kms });
  noKms = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
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
  await (noKms as Api | undefined)?.close();
  await (api as Api | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-130: company bank accounts over HTTP (wizard step 4)', () => {
  it('SS-PLAT-130 GET /setup/bank-accounts lists no accounts yet and the bank GL accounts that can take one [T-0185]', async () => {
    const r = await call('GET', `/setup/bank-accounts?company_id=${c}`, 'accountant');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      company_id: c,
      base_currency: 'AUD',
      kms_configured: true,
      accounts: [],
      gl_accounts: [
        { id: gl['1010'], code: '1010', name: 'Operating account', currency: 'AUD', in_use: false },
        { id: gl['1020'], code: '1020', name: 'Payroll account', currency: null, in_use: false },
        { id: gl['1030'], code: '1030', name: 'USD account', currency: 'USD', in_use: false },
      ],
    });
    const plain = await call('GET', `/setup/bank-accounts?company_id=${c}`, 'fa', { via: noKms });
    expect((await json(plain))['kms_configured']).toBe(false);
    expect(await wizardMissing()).toEqual([
      'No bank account has been added',
      'No bank account has an APCA user id and ABA user name (batch payments)',
    ]);
  });

  it('SS-PLAT-130 adding needs settings.setup.manage and a fresh step-up; reading needs settings.read [T-0185]', async () => {
    const stale = await post(operating());
    expect(stale.status).toBe(401);
    expect(await json(stale)).toEqual({ error: 'step_up_required', max_age: 300 });
    const accountant = await call('POST', '/setup/bank-accounts', 'accountant', {
      body: operating(),
    });
    expect(accountant.status).toBe(403);
    expect(await json(accountant)).toMatchObject({ permission: 'settings.setup.manage' });
    const clerk = await call('GET', `/setup/bank-accounts?company_id=${c}`, 'clerk');
    expect(clerk.status).toBe(403);
    expect(await json(clerk)).toMatchObject({ permission: 'settings.read' });
    expect(await rows()).toBe(0);
  });

  it('SS-PLAT-130 POST adds the account sealed, answers and audits it masked, and step 4 empties [T-0185]', async () => {
    await stepUp('fa');
    const before = (await bankAudits()).length;
    const r = await post(operating());
    expect(r.status).toBe(201);
    const text = await r.text();
    expect(text).not.toContain(NUMBER);
    const body = JSON.parse(text) as { account: Record<string, unknown>; replayed: boolean };
    expect(body).toEqual({
      replayed: false,
      account: {
        id: expect.any(String) as unknown,
        name: 'Operating',
        gl_account_id: gl['1010'],
        gl_account_code: '1010',
        gl_account_name: 'Operating account',
        currency: 'AUD',
        bsb: '062-000',
        account_name: 'Bay Street Studio Pty Ltd',
        account_number: '***678',
        apca_user_id: '123456',
        aba_user_name: 'BAY STREET STUDIO',
        aba_fi_mnemonic: 'CBA',
        status: 'active',
      },
    });
    const audits = await bankAudits();
    expect(audits).toHaveLength(before + 1);
    expect(JSON.stringify(audits.at(-1)?.after)).toContain('***678');
    expect(JSON.stringify(audits)).not.toContain(NUMBER);
    const stored = await f.admin.query<{ ct: Buffer; last3: string }>(
      'SELECT account_number_ct AS ct, account_number_last3 AS last3 FROM app.bank_account WHERE id = $1',
      [body.account['id']],
    );
    expect(stored.rows[0]?.last3).toBe('678');
    expect(stored.rows[0]?.ct.toString('latin1')).not.toContain(NUMBER);

    const list = await json(
      await call('GET', `/setup/bank-accounts?company_id=${c}`, 'accountant'),
    );
    expect(list['accounts']).toEqual([body.account]);
    expect(list['gl_accounts']).toContainEqual(
      expect.objectContaining({ code: '1010', in_use: true }),
    );
    expect(await wizardMissing()).toEqual([]);
  });

  it('SS-PLAT-130 the same request again is a replay that writes nothing; a different one on the same GL account is 409 [T-0185]', async () => {
    const audits = (await bankAudits()).length;
    const again = await post(operating());
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({
      replayed: true,
      account: { name: 'Operating', account_number: '***678' },
    });
    expect(await rows()).toBe(1);
    expect((await bankAudits()).length).toBe(audits);

    const clash = await post({ ...operating(), name: 'Main', account_number: '99999999' });
    expect(clash.status).toBe(409);
    const text = await clash.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'GL_ACCOUNT_IN_USE' });
    expect(text).not.toContain('99999999');
    expect(await rows()).toBe(1);
  });

  it('SS-PLAT-130 two first requests racing on one GL account: one is added, the other is 409 [T-0185]', async () => {
    const base = {
      ...operating(),
      gl_account_id: gl['1020'],
      apca_user_id: undefined,
      aba_user_name: undefined,
      aba_fi_mnemonic: undefined,
    };
    const answers = await Promise.all([
      post({ ...base, name: 'Payroll A', account_number: '11111111' }),
      post({ ...base, name: 'Payroll B', account_number: '22222222' }),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    const refused = answers.find((a) => a.status === 409);
    expect(await refused?.json()).toMatchObject({ error: 'GL_ACCOUNT_IN_USE' });
    expect(await rows()).toBe(2);
  });

  it('SS-PLAT-130 refusals: no key 400, malformed 400, unknown GL account 404, not a bank account or another currency 422, another tenant 404 [T-0185]', async () => {
    const noKey = await post(operating(), { key: null });
    expect(noKey.status).toBe(400);
    expect((await json(noKey))['error']).toBe('idempotency_key_required');

    const badBsb = await post({ ...operating(), gl_account_id: gl['1030'], bsb: '06200' });
    expect(badBsb.status).toBe(400);
    expect(await json(badBsb)).toMatchObject({ error: 'invalid_request' });
    const badNumber = await post({ ...operating(), account_number: '1234567890' });
    expect(badNumber.status).toBe(400);
    const noName = await post({ ...operating(), name: undefined });
    expect(noName.status).toBe(400);

    const unknownGl = await post({ ...operating(), gl_account_id: randomUUID() });
    expect(unknownGl.status).toBe(404);
    expect((await json(unknownGl))['error']).toBe('UNKNOWN_GL_ACCOUNT');
    const otherCompanyGl = await post({ ...operating(), gl_account_id: f.acct['1010'] });
    expect(otherCompanyGl.status).toBe(404);

    const notBank = await post({ ...operating(), gl_account_id: gl['1200'] });
    expect(notBank.status).toBe(422);
    const nb = await notBank.text();
    expect(JSON.parse(nb)).toMatchObject({ error: 'GL_ACCOUNT_NOT_BANK' });
    expect(nb).not.toContain('1200 is'); // a fixed message, not the database's text
    const wrongCurrency = await post({ ...operating(), gl_account_id: gl['1030'] });
    expect(wrongCurrency.status).toBe(422);
    expect((await json(wrongCurrency))['error']).toBe('GL_ACCOUNT_NOT_BANK');

    const foreign = await post({ ...operating(), company_id: other.companyId });
    expect(foreign.status).toBe(404);
    expect((await json(foreign))['error']).toBe('UNKNOWN_COMPANY');
    const foreignRead = await call(
      'GET',
      `/setup/bank-accounts?company_id=${other.companyId}`,
      'fa',
    );
    expect(foreignRead.status).toBe(404);
    expect(await rows()).toBe(2);
  });

  it('SS-PLAT-130 without a key service the add is 503 kms_not_configured and nothing is written [T-0185]', async () => {
    const r = await post(
      { ...operating(), gl_account_id: gl['1030'], currency: 'USD' },
      { via: noKms },
    );
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ error: 'kms_not_configured' });
    expect(await rows()).toBe(2);
  });
});
