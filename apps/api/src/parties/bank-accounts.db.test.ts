/**
 * SS-PLAT-22 (API part) — bank details read via the API are masked to the last 3 characters
 * (T-0037, design §6.6, ADR-0018). The response body never contains the account number.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { addBankAccount, createParty } from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-000000000bba';
const B = '01900000-0000-7000-8000-000000000bbb';
const USER_A = '01900000-0000-7000-8000-00000000ba01';
const USER_B = '01900000-0000-7000-8000-00000000bb01';
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let tdb: TestDatabase;
let api: Api;
let supplier: string;
let cookieA: string;
let cookieB: string;

const get = (path: string, cookie?: string) =>
  fetch(`${api.url}${path}`, { headers: cookie ? { cookie: `lf_session=${cookie}` } : {} });

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const [tenant, user] of [
    [A, USER_A],
    [B, USER_B],
  ] as const) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `Tenant ${tenant.slice(-3)}` })
        .execute();
      const c = await trx
        .insertInto('app.company')
        .values({ name: 'Co', base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.app_user')
        .values({ id: user, email: `${user}@example.test`, display_name: 'User', status: 'active' })
        .execute();
      // T-0012: reading bank details needs parties.bank_account.read (Accountant holds it).
      await trx.insertInto('app.user_role').values({ user_id: user, role: 'accountant' }).execute();
      if (tenant === A) {
        supplier = await createParty(trx, c.id, {
          legalName: 'Office Supplies Pty Ltd',
          roles: ['supplier'],
        });
        await addBankAccount(trx, kms, c.id, supplier, {
          bsb: '062-000',
          accountNumber: '123456789',
          accountName: 'Office Supplies',
          source: 'ui',
        });
      }
    });
  }
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  // The Accountant role requires MFA since T-0013 (DL-0123).
  cookieA = await api.sessions.create(A, { userId: USER_A, amr: ['pwd', 'otp'], acr: null });
  cookieB = await api.sessions.create(B, { userId: USER_B, amr: ['pwd', 'otp'], acr: null });
});

afterAll(async () => {
  await api.close();
  await tdb.close();
});

describe('SS-PLAT-22: Bank details encrypted and masked (read via API)', () => {
  it('returns the bank accounts masked to the last 3 characters, never the number', async () => {
    const res = await get(`/parties/${supplier}/bank-accounts`, cookieA);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('123456789');
    expect(JSON.parse(text)).toEqual([
      {
        id: expect.any(String),
        bsb: '062-000',
        account_name: 'Office Supplies',
        account_number: '***789',
        status: 'pending_verification',
      },
    ]);
  });

  it('needs a session, and another tenant sees nothing', async () => {
    expect((await get(`/parties/${supplier}/bank-accounts`)).status).toBe(401);
    const other = await get(`/parties/${supplier}/bank-accounts`, cookieB);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual([]);
  });

  it('rejects a malformed party id', async () => {
    expect((await get('/parties/not-a-uuid/bank-accounts', cookieA)).status).toBe(400);
  });
});
