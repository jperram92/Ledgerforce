/**
 * Listing bank-detail changes for the verification screen (T-0153, for T-0087; UC-06, design §6.5
 * rule 2, §6.6): what awaits verification, with party name, masked new and previous account and
 * who asked; decided ones on request with when they become payable. Read-only,
 * `parties.bank_account.read`, RLS-scoped. Real routes and sessions, lf_app only.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { createParty } from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000153c1';
const X = '01900000-0000-7000-8000-0000000153d1';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PEOPLE = {
  owner: { tenant: A, id: uid(0x153c1), roles: ['owner'], name: 'Olivia Owner' },
  clerk: { tenant: A, id: uid(0x153c2), roles: ['ap_clerk'], name: 'Casey Clerk' },
  arClerk: { tenant: A, id: uid(0x153c3), roles: ['ar_clerk'], name: 'Avery AR' },
  other: { tenant: X, id: uid(0x153d1), roles: ['owner'], name: 'Other Owner' },
} as const;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let tdb: TestDatabase;
let api: Api;
let companyId: string;
let paper: string;
let ink: string;
let paperChange: string;
let inkChange: string;
const cookies = new Map<string, string>();

async function call(method: string, path: string, who: string, body?: unknown) {
  const headers: Record<string, string> = {
    cookie: `lf_session=${cookies.get(who) ?? ''}`,
    'sec-fetch-site': 'same-origin',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  for (const [tenant, name] of [
    [A, 'Harbour & Co Pty Ltd'],
    [X, 'Other Pty Ltd'],
  ] as const) {
    await tdb.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [tenant, name]);
  }
  for (const [who, p] of Object.entries(PEOPLE)) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, p.tenant, `${who}@changes.test`, p.name],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [p.tenant, p.id, role],
      );
    }
  }
  const seed = createDb(tdb.url('lf_app'), 1);
  await withTenant(seed, A, async (trx) => {
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    companyId = c.id;
    paper = await createParty(trx, c.id, { legalName: 'Paper Co Pty Ltd', roles: ['supplier'] });
    ink = await createParty(trx, c.id, { legalName: 'Ink Supplies Pty Ltd', roles: ['supplier'] });
  });
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {}, kms });
  const sessions = api.sessions;
  if (!sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE)) {
    cookies.set(
      who,
      await sessions.create(p.tenant, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
  const ask = async (party: string, accountNumber: string, name: string) => {
    const res = await call('POST', `/parties/${party}/bank-accounts`, 'clerk', {
      bsb: '062-000',
      account_number: accountNumber,
      account_name: name,
    });
    if (res.status !== 201) throw new Error(`change not requested: ${String(res.status)}`);
    return ((await res.json()) as { id: string }).id;
  };
  paperChange = await ask(paper, '987654321', 'Paper Co');
  inkChange = await ask(ink, '555444333', 'Ink Supplies');
  const verified = await call('POST', `/bank-detail-changes/${inkChange}/verify`, 'owner', {
    confirmation_note: 'Called Ink Supplies on the number in the 2025 contract.',
  });
  if (verified.status !== 200) throw new Error(`not verified: ${String(verified.status)}`);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('T-0153 AC-2: bank-detail changes listed for verification', () => {
  it('AC-2 lists the change awaiting verification with names and the account masked [T-0153]', async () => {
    const res = await call('GET', `/bank-detail-changes?company_id=${companyId}`, 'owner');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('987654321');
    expect(JSON.parse(text)).toEqual({
      changes: [
        {
          id: paperChange,
          party_id: paper,
          party_name: 'Paper Co Pty Ltd',
          status: 'requested',
          bank_account: { bsb: '062-000', account_name: 'Paper Co', account_number: '***321' },
          previous_bank_account: null,
          requested_by: PEOPLE.clerk.id,
          requested_by_name: 'Casey Clerk',
          requested_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          decided_by_name: null,
          decided_at: null,
          payable_from: null,
        },
      ],
    });
  });

  it('AC-2 status=verified lists the verified change with when it becomes payable [T-0153]', async () => {
    const res = await call(
      'GET',
      `/bank-detail-changes?company_id=${companyId}&status=verified`,
      'clerk',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      changes: [
        {
          id: inkChange,
          party_name: 'Ink Supplies Pty Ltd',
          status: 'verified',
          bank_account: { account_number: '***333' },
          decided_by_name: 'Olivia Owner',
          payable_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ],
    });
  });

  it('AC-2 needs parties.bank_account.read; another tenant sees nothing; bad input is 400 [T-0153]', async () => {
    const denied = await call('GET', `/bank-detail-changes?company_id=${companyId}`, 'arClerk');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ permission: 'parties.bank_account.read' });
    const other = await call('GET', `/bank-detail-changes?company_id=${companyId}`, 'other');
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ changes: [] });
    expect((await call('GET', '/bank-detail-changes?company_id=x', 'owner')).status).toBe(400);
    expect(
      (await call('GET', `/bank-detail-changes?company_id=${companyId}&status=all`, 'owner'))
        .status,
    ).toBe(400);
  });
});
