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
 * SS-PLAT-152 — T-0193 (ADR-0094, RQ-0176): `PUT /setup/bank-accounts/:id/aba` and
 *   `POST /setup/bank-accounts/:id/archive` (settings.setup.manage + step-up 300 s,
 *   Idempotency-Key, masked before/after audit; the same state again 200 `changed:false`).
 *   Archiving the designated remittance account releases it (`remittance_released`, migration
 *   0072); an archived account's ABA details are 409; another company's or tenant's account 404.
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
  // T-0193: a Finance Admin who never confirms their sign-in (step-up refusals).
  stale: { id: randomUUID(), roles: ['finance_admin'] },
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

describe('SS-PLAT-152: change the ABA details of a company bank account, or archive it (T-0193)', () => {
  const abaBody = (extra: Record<string, unknown> = {}) => ({
    company_id: c,
    apca_user_id: '654321',
    aba_user_name: 'BAY ST PAYROLL',
    aba_fi_mnemonic: 'WBC',
    ...extra,
  });
  const put = (id: string, body: unknown, who = 'fa', init: { key?: string | null } = {}) =>
    call('PUT', `/setup/bank-accounts/${id}/aba`, who, { ...init, body });
  const archive = (id: string, body: unknown, who = 'fa', init: { key?: string | null } = {}) =>
    call('POST', `/setup/bank-accounts/${id}/archive`, who, { ...init, body });
  const listed = async () =>
    (await json(await call('GET', `/setup/bank-accounts?company_id=${c}`, 'fa')))[
      'accounts'
    ] as Record<string, unknown>[];
  const idOf = async (name: RegExp) => {
    const a = (await listed()).find(
      (x) => name.test(String(x['name'])) && x['status'] === 'active',
    );
    if (!a) throw new Error(`no active account ${String(name)}`);
    return String(a['id']);
  };
  const remittance = async () =>
    (
      await f.admin.query<{ id: string | null }>(
        'SELECT remittance_bank_account_id AS id FROM app.ar_settings WHERE tenant_id = $1 AND company_id = $2',
        [f.tenantId, c],
      )
    ).rows[0]?.id ?? null;
  const bankAuditRows = async () =>
    (
      await f.admin.query<{ action: string; entity_id: string; before: unknown; after: unknown }>(
        `SELECT action, entity_id, before, after FROM audit.audit_log
          WHERE tenant_id = $1 AND entity_type = 'bank_account' ORDER BY id`,
        [f.tenantId],
      )
    ).rows;

  it('SS-PLAT-152 both routes need settings.setup.manage and a fresh step-up; nothing changes [T-0193]', async () => {
    const payroll = await idOf(/^Payroll/);
    const operating = await idOf(/^Operating/);
    for (const r of [
      await put(payroll, abaBody(), 'stale'),
      await archive(operating, { company_id: c }, 'stale'),
    ]) {
      expect(r.status).toBe(401);
      expect(await json(r)).toEqual({ error: 'step_up_required', max_age: 300 });
    }
    for (const r of [
      await put(payroll, abaBody(), 'accountant'),
      await archive(operating, { company_id: c }, 'accountant'),
    ]) {
      expect(r.status).toBe(403);
      expect(await json(r)).toMatchObject({ permission: 'settings.setup.manage' });
    }
    expect((await listed()).find((x) => x['id'] === payroll)).toMatchObject({
      apca_user_id: null,
      status: 'active',
    });
    expect((await listed()).find((x) => x['id'] === operating)).toMatchObject({
      status: 'active',
    });
  });

  it('SS-PLAT-152 refusals: no key 400, malformed 400, unknown or another company’s or tenant’s account 404 [T-0193]', async () => {
    await stepUp('fa');
    const payroll = await idOf(/^Payroll/);
    const noKey = await put(payroll, abaBody(), 'fa', { key: null });
    expect(noKey.status).toBe(400);
    expect((await json(noKey))['error']).toBe('idempotency_key_required');
    const noKeyArchive = await archive(payroll, { company_id: c }, 'fa', { key: null });
    expect(noKeyArchive.status).toBe(400);

    for (const bad of [
      { apca_user_id: '12345' },
      { apca_user_id: undefined },
      { aba_user_name: 'Name with | pipe' },
      { aba_user_name: 'X'.repeat(27) },
      { aba_user_name: '' },
      { aba_fi_mnemonic: 'cba' },
      { aba_fi_mnemonic: null },
    ]) {
      const r = await put(payroll, abaBody(bad), 'fa');
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await json(r)).toMatchObject({ error: 'invalid_request' });
    }
    const notUuid = await put('not-a-uuid', abaBody());
    expect(notUuid.status).toBe(400);

    const unknown = await put(randomUUID(), abaBody());
    expect(unknown.status).toBe(404);
    expect((await json(unknown))['error']).toBe('UNKNOWN_BANK_ACCOUNT');
    const unknownArchive = await archive(randomUUID(), { company_id: c });
    expect(unknownArchive.status).toBe(404);
    expect((await json(unknownArchive))['error']).toBe('UNKNOWN_BANK_ACCOUNT');

    // The account exists, but under another company of this tenant: 404, not changed.
    const elsewhere = await put(payroll, abaBody({ company_id: f.companyId }));
    expect(elsewhere.status).toBe(404);
    expect((await json(elsewhere))['error']).toBe('UNKNOWN_BANK_ACCOUNT');
    // Another tenant's company and another tenant's account: RLS hides both.
    const foreign = await put(payroll, abaBody({ company_id: other.companyId }));
    expect(foreign.status).toBe(404);
    const theirGl = randomUUID();
    await other.admin.query(
      `INSERT INTO app.account (id, tenant_id, company_id, code, name, type, subtype, normal_balance)
       VALUES ($1, $2, $3, '1090', 'Their bank', 'asset', 'bank', 'debit')`,
      [theirGl, other.tenantId, other.companyId],
    );
    const theirAccount = randomUUID();
    await other.admin.query(
      `INSERT INTO app.bank_account (id, tenant_id, company_id, gl_account_id, name, currency, bsb,
         account_name, account_number_last3, account_number_ct, account_number_iv,
         account_number_tag, dek_wrapped, kek_id, enc_version)
       VALUES ($1, $2, $3, $4, 'Theirs', 'AUD', '062-000', 'Them', '111', '\\x00',
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         decode(repeat('00', 60), 'hex'), 'k1', 1)`,
      [theirAccount, other.tenantId, other.companyId, theirGl],
    );
    expect((await put(theirAccount, abaBody())).status).toBe(404);
    expect((await archive(theirAccount, { company_id: c })).status).toBe(404);
    const stillTheirs = await other.admin.query<{ apca: string | null; status: string }>(
      'SELECT apca_user_id AS apca, status FROM app.bank_account WHERE id = $1',
      [theirAccount],
    );
    expect(stillTheirs.rows[0]).toEqual({ apca: null, status: 'active' });
    expect((await listed()).find((x) => x['id'] === payroll)).toMatchObject({
      apca_user_id: null,
    });
  });

  it('SS-PLAT-152 archiving the designated remittance account releases it, audits masked, and step 4 asks for ABA details again [T-0193]', async () => {
    await stepUp('fa');
    const operating = await idOf(/^Operating/);
    await f.admin.query(
      `INSERT INTO app.ar_settings (tenant_id, company_id, remittance_bank_account_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, company_id) DO UPDATE SET remittance_bank_account_id = EXCLUDED.remittance_bank_account_id`,
      [f.tenantId, c, operating],
    );
    expect(await remittance()).toBe(operating);
    const audits = (await bankAuditRows()).length;

    const r = await archive(operating, { company_id: c });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(NUMBER);
    expect(JSON.parse(text)).toEqual({
      changed: true,
      remittance_released: true,
      account: expect.objectContaining({
        id: operating,
        name: 'Operating',
        account_number: '***678',
        status: 'archived',
      }) as unknown,
    });
    expect(await remittance()).toBeNull();
    const rows = await bankAuditRows();
    expect(rows).toHaveLength(audits + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'POST /setup/bank-accounts/:id/archive',
      entity_id: operating,
      before: expect.objectContaining({ status: 'active', account_number: '***678' }) as unknown,
      after: expect.objectContaining({
        status: 'archived',
        account_number: '***678',
        remittance_released: true,
      }) as unknown,
    });
    expect(JSON.stringify(rows)).not.toContain(NUMBER);
    const released = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'remittance_account.released' AND entity_id = $2`,
      [f.tenantId, c],
    );
    expect(released.rows[0]?.n).toBe(1);
    expect(await wizardMissing()).toEqual([
      'No bank account has an APCA user id and ABA user name (batch payments)',
    ]);
    // The GL account is free again: a replacement can be added on it.
    const list = await json(await call('GET', `/setup/bank-accounts?company_id=${c}`, 'fa'));
    expect(list['gl_accounts']).toContainEqual(
      expect.objectContaining({ code: '1010', in_use: false }),
    );

    // Again: nothing to do, no bank_account audit, nothing released.
    const again = await archive(operating, { company_id: c });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({
      changed: false,
      remittance_released: false,
      account: { id: operating, status: 'archived' },
    });
    expect(await bankAuditRows()).toHaveLength(audits + 1);
  });

  it('SS-PLAT-152 PUT sets the ABA details, audits before/after masked, empties step 4; the same values again change nothing [T-0193]', async () => {
    await stepUp('fa');
    const payroll = await idOf(/^Payroll/);
    const audits = (await bankAuditRows()).length;
    const r = await put(payroll, abaBody());
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text) as { account: Record<string, unknown>; changed: boolean };
    expect(body.changed).toBe(true);
    expect(body.account).toMatchObject({
      id: payroll,
      apca_user_id: '654321',
      aba_user_name: 'BAY ST PAYROLL',
      aba_fi_mnemonic: 'WBC',
      status: 'active',
      bsb: '062-000',
    });
    expect(String(body.account['account_number'])).toMatch(/^\*\*\*\d{3}$/);
    expect(text).not.toMatch(/11111111|22222222/);
    const rows = await bankAuditRows();
    expect(rows).toHaveLength(audits + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'PUT /setup/bank-accounts/:id/aba',
      entity_id: payroll,
      before: expect.objectContaining({
        apca_user_id: null,
        aba_user_name: null,
        aba_fi_mnemonic: null,
      }) as unknown,
      after: expect.objectContaining({
        apca_user_id: '654321',
        aba_user_name: 'BAY ST PAYROLL',
        aba_fi_mnemonic: 'WBC',
      }) as unknown,
    });
    expect(JSON.stringify(rows)).not.toMatch(/11111111|22222222/);
    expect(await wizardMissing()).toEqual([]);

    const again = await put(payroll, abaBody());
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({
      changed: false,
      account: { apca_user_id: '654321' },
    });
    expect(await bankAuditRows()).toHaveLength(audits + 1);

    // A correction is a change again.
    const fix = await put(payroll, abaBody({ aba_fi_mnemonic: 'CBA' }));
    expect(await json(fix)).toMatchObject({ changed: true, account: { aba_fi_mnemonic: 'CBA' } });
    expect(await bankAuditRows()).toHaveLength(audits + 2);
  });

  it('SS-PLAT-152 an archived account’s ABA details cannot change: 409 BANK_ACCOUNT_ARCHIVED [T-0193]', async () => {
    await stepUp('fa');
    const archived = (await listed()).find(
      (x) => x['name'] === 'Operating' && x['status'] === 'archived',
    );
    const id = String(archived?.['id']);
    const audits = (await bankAuditRows()).length;
    const r = await put(id, abaBody());
    expect(r.status).toBe(409);
    expect((await json(r))['error']).toBe('BANK_ACCOUNT_ARCHIVED');
    expect((await listed()).find((x) => x['id'] === id)).toMatchObject({
      apca_user_id: '123456',
      aba_user_name: 'BAY STREET STUDIO',
    });
    expect(await bankAuditRows()).toHaveLength(audits);
  });
});
