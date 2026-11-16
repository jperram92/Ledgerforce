/**
 * SS-UC01-19 over HTTP (T-0191 AC-3, ADR-0086, RQ-0168): a remittance account change approved
 * through the real routes notifies the Owners and Finance Admins of its own tenant only. Another
 * tenant's change produces no notice here, and this tenant's change produces none there. Real
 * PostgreSQL as lf_app, real sessions; step-up is recorded on the session as the IdP callback
 * does. The superuser only inspects.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { withTenant } from '@ledgerforce/db';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const TENANT = '01900000-0000-7000-8000-000000019121';
const OTHER_TENANT = '01900000-0000-7000-8000-000000019122';

let f: LedgerFixture;
let api: Api;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
/** Per tenant: its company and bank account. */
const books: Record<string, { companyId: string; bankAccountId: string }> = {};
const cookies = new Map<string, string>();
const people: Record<string, { id: string; tenant: string; role: string }> = {
  faA: { id: randomUUID(), tenant: TENANT, role: 'finance_admin' },
  ownerA: { id: randomUUID(), tenant: TENANT, role: 'owner' },
  faB: { id: randomUUID(), tenant: OTHER_TENANT, role: 'finance_admin' },
  ownerB: { id: randomUUID(), tenant: OTHER_TENANT, role: 'owner' },
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

async function stepUp(who: string) {
  const sessionId = cookies.get(who)?.split('.')[1] ?? '';
  await withTenant(
    f.db,
    people[who]?.tenant ?? '',
    (trx) =>
      api.sessions?.reauthenticateInTx(trx, sessionId, {
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }) ?? Promise.resolve(),
  );
}

/** Maker requests and checker approves a change to the tenant's bank account over HTTP. */
async function changeOverHttp(tenant: string, maker: string, checker: string): Promise<string> {
  const book = books[tenant];
  if (!book) throw new Error('no books');
  const id = randomUUID();
  await stepUp(maker);
  const req = await call('PUT', `/setup/remittance-account/changes/${id}`, maker, {
    company_id: book.companyId,
    bank_account_id: book.bankAccountId,
  });
  expect(req.status).toBe(201);
  await stepUp(checker);
  const ok = await call('POST', `/setup/remittance-account/changes/${id}/approve`, checker, {
    company_id: book.companyId,
  });
  expect(ok.status).toBe(200);
  return id;
}

/** Notices of a tenant as the superuser sees them: recipient and change ids. */
const noticesOf = async (tenant: string) =>
  (
    await f.admin.query<{ recipient_user_id: string | null; change_id: string }>(
      `SELECT recipient_user_id, change_id FROM app.remittance_account_notice WHERE tenant_id = $1
        ORDER BY recipient_user_id`,
      [tenant],
    )
  ).rows;

/** What lf_app sees in a tenant's context: count and the changes they belong to. */
const visibleIn = (tenant: string) =>
  withTenant(f.db, tenant, async (trx) => {
    const r = await sql<{
      change_id: string;
    }>`SELECT change_id FROM app.remittance_account_notice`.execute(trx);
    return r.rows.map((x) => x.change_id);
  });

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  const bankA = await f.inTenant((trx) =>
    createCompanyBankAccount(trx, kms, f.companyId, {
      glAccountId: f.acct['1010'] ?? '',
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
    }),
  );
  books[TENANT] = { companyId: f.companyId, bankAccountId: bankA };
  books[OTHER_TENANT] = await withTenant(f.db, OTHER_TENANT, async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: OTHER_TENANT, name: 'Other Pty Ltd' })
      .execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
    const bankAccountId = await createCompanyBankAccount(trx, kms, c.id, {
      glAccountId: chart.accounts.get('1010') ?? '',
      name: 'Other Operating',
      bsb: '083004',
      accountNumber: '99887766',
      accountName: 'Other Pty Ltd',
      currency: 'AUD',
    });
    return { companyId: c.id, bankAccountId };
  });
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, p.tenant, `${who.toLowerCase()}@notice.test`, who],
    );
    await f.admin.query(
      'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [p.tenant, p.id, p.role],
    );
  }
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  for (const [who, p] of Object.entries(people)) {
    if (!api.sessions) throw new Error('sessions not configured');
    cookies.set(
      who,
      await api.sessions.create(p.tenant, {
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

describe('SS-UC01-19: remittance change notices stay inside their tenant (HTTP)', () => {
  it("SS-UC01-19 another tenant's approved change notifies its own Owners and Finance Admins and nobody here [T-0191]", async () => {
    const changeB = await changeOverHttp(OTHER_TENANT, 'faB', 'ownerB');
    expect(await noticesOf(OTHER_TENANT)).toEqual(
      [people.faB?.id, people.ownerB?.id]
        .sort()
        .map((recipient_user_id) => ({ recipient_user_id, change_id: changeB })),
    );
    expect(await noticesOf(TENANT)).toEqual([]);
    expect(await visibleIn(TENANT)).toEqual([]);
  });

  it('SS-UC01-19 this tenant’s approved change notifies only this tenant’s people; the other tenant sees no new notice [T-0191]', async () => {
    const before = await visibleIn(OTHER_TENANT);
    const changeA = await changeOverHttp(TENANT, 'faA', 'ownerA');
    expect(await noticesOf(TENANT)).toEqual(
      [people.faA?.id, people.ownerA?.id]
        .sort()
        .map((recipient_user_id) => ({ recipient_user_id, change_id: changeA })),
    );
    expect(await visibleIn(TENANT)).toEqual([changeA, changeA]);
    expect(await visibleIn(OTHER_TENANT)).toEqual(before);
    // No notice anywhere carries a clear account number.
    const leaked = await f.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.remittance_account_notice
        WHERE payload::text LIKE '%12345678%' OR payload::text LIKE '%99887766%'`,
    );
    expect(leaked.rows[0]?.n).toBe('0');
  });
});
