/**
 * SS-UC06-09 (API layer) — a bank-detail change needs a different verifier with step-up and
 * notifies the old contact (T-0053, design §6.2, §6.5 rule 2, ADR-0030). Real routes, real
 * sessions (signed in with MFA), the real SoD engine (ADR-0026) and step-up (ADR-0025), lf_app
 * only. The database rules themselves are proven in
 * packages/modules/parties/src/bank-change.workflow.db.test.ts.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { addContact, createParty, setContactRole } from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000053a1';
const X = '01900000-0000-7000-8000-0000000053b1';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PEOPLE = {
  ownerA: { tenant: A, id: uid(0x53a1), roles: ['owner'] },
  ownerB: { tenant: A, id: uid(0x53a2), roles: ['owner'] },
  clerk: { tenant: A, id: uid(0x53a3), roles: ['ap_clerk'] },
  other: { tenant: X, id: uid(0x53b1), roles: ['owner'] },
} as const;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const NOTE = 'Called the supplier on the number in our 2025 contract; Jo confirmed the change.';

let tdb: TestDatabase;
let api: Api;
let supplier: string;
const cookies = new Map<string, string>();

async function call(method: string, path: string, who?: string, body?: unknown, on = api) {
  const headers: Record<string, string> = {};
  const c = who ? cookies.get(who) : undefined;
  if (c) headers.cookie = `lf_session=${c}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${on.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const newAccount = (accountNumber: string) => ({
  bsb: '062-000',
  account_number: accountNumber,
  account_name: 'Office Supplies Pty Ltd',
});

async function rows<T = Record<string, unknown>>(q: string, params: unknown[]): Promise<T[]> {
  return (await tdb.admin.query(q, params)).rows as T[];
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
      [p.id, p.tenant, `${who}@bank.test`, who],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [p.tenant, p.id, role],
      );
    }
  }
  const seed = createDb(tdb.url('lf_app'), 1);
  supplier = await withTenant(seed, A, async (trx) => {
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const p = await createParty(trx, c.id, {
      legalName: 'Office Supplies Pty Ltd',
      roles: ['supplier'],
    });
    const contact = await addContact(trx, c.id, p, {
      name: 'Jo Smith',
      email: 'accounts@office-supplies.test',
    });
    await setContactRole(trx, contact, 'remittance', true);
    return p;
  });
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {}, kms });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE)) {
    // Signed in with MFA just now: a fresh step-up.
    cookies.set(
      who,
      await api.sessions.create(p.tenant, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
  // ownerB signed in with MFA 10 minutes ago: no fresh step-up.
  cookies.set(
    'ownerB-stale',
    await api.sessions.create(A, {
      userId: PEOPLE.ownerB.id,
      amr: ['pwd', 'otp'],
      acr: null,
      authTime: new Date(Date.now() - 10 * 60 * 1000),
    }),
  );
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-UC06-09: Bank-detail change needs a different verifier and notifies the old contact', () => {
  let first: string;
  let changeId: string;

  it('the first bank details are requested by the AP clerk and verified by an Owner', async () => {
    const res = await call(
      'POST',
      `/parties/${supplier}/bank-accounts`,
      'clerk',
      newAccount('111222333'),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('111222333');
    const body = JSON.parse(text) as { id: string; bank_account: { account_number: string } };
    expect(body).toMatchObject({
      status: 'requested',
      party_id: supplier,
      bank_account: { bsb: '062-000', account_number: '***333', status: 'pending_verification' },
    });
    first = body.id;
    const v = await call('POST', `/bank-detail-changes/${first}/verify`, 'ownerB', {
      confirmation_note: NOTE,
    });
    expect(v.status).toBe(200);
  });

  it('A requests a change; A verifying it is denied with SOD_BANK_DETAIL_SELF_VERIFY', async () => {
    const res = await call(
      'POST',
      `/parties/${supplier}/bank-accounts`,
      'ownerA',
      newAccount('987654321'),
    );
    expect(res.status).toBe(201);
    changeId = ((await res.json()) as { id: string }).id;

    const denied = await call('POST', `/bank-detail-changes/${changeId}/verify`, 'ownerA', {
      confirmation_note: NOTE,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_BANK_DETAIL_SELF_VERIFY',
      small_team_exception_required: false,
    });
    expect(
      await rows(`SELECT status FROM app.bank_detail_change WHERE id = $1`, [changeId]),
    ).toEqual([{ status: 'requested' }]);
  });

  it('B without a fresh step-up gets step_up_required; an AP clerk may not verify at all', async () => {
    const stale = await call('POST', `/bank-detail-changes/${changeId}/verify`, 'ownerB-stale', {
      confirmation_note: NOTE,
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    const clerk = await call('POST', `/bank-detail-changes/${changeId}/verify`, 'clerk', {
      confirmation_note: NOTE,
    });
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({
      error: 'forbidden',
      permission: 'parties.bank_account.verify',
    });
    const noNote = await call('POST', `/bank-detail-changes/${changeId}/verify`, 'ownerB', {
      confirmation_note: '  ',
    });
    expect(noNote.status).toBe(400);
    expect(await noNote.json()).toEqual({ error: 'confirmation_note_required' });
  });

  it('B verifies with step-up: the previous remittance contact is notified and cooling-off starts', async () => {
    const res = await call('POST', `/bank-detail-changes/${changeId}/verify`, 'ownerB', {
      confirmation_note: NOTE,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; payable_from: string };
    expect(body).toMatchObject({ id: changeId, status: 'verified' });
    const [row] = await rows<{ decided_at: Date; payable_from: Date; decided_by: string }>(
      `SELECT decided_at, payable_from, decided_by FROM app.bank_detail_change WHERE id = $1`,
      [changeId],
    );
    expect(row?.decided_by).toBe(PEOPLE.ownerB.id);
    expect(new Date(body.payable_from).getTime()).toBe(row?.payable_from.getTime());
    expect((row?.payable_from.getTime() ?? 0) - (row?.decided_at.getTime() ?? 0)).toBe(
      24 * 3600 * 1000,
    );

    expect(
      await rows(
        `SELECT recipient_email, status FROM app.bank_detail_change_notice WHERE change_id = $1`,
        [changeId],
      ),
    ).toEqual([{ recipient_email: 'accounts@office-supplies.test', status: 'pending' }]);

    const [eligibility] = await rows(
      `SELECT * FROM (SELECT set_config('app.tenant_id', $1, true)) s,
                     app.party_payment_eligibility(ARRAY[$2::uuid])`,
      [A, supplier],
    );
    expect(eligibility).toMatchObject({ eligible: false, reason: 'BANK_DETAILS_COOLING_OFF' });

    // The SoD action ledger: the request by A, the verification by B.
    expect(
      await rows(
        `SELECT step, actor_user_id FROM app.sod_action WHERE subject_id = $1 ORDER BY occurred_at, id`,
        [changeId],
      ),
    ).toEqual([
      { step: 'bank_detail_change.request', actor_user_id: PEOPLE.ownerA.id },
      { step: 'bank_detail_change.verify', actor_user_id: PEOPLE.ownerB.id },
    ]);
    const accounts = await call('GET', `/parties/${supplier}/bank-accounts`, 'ownerB');
    const list = (await accounts.json()) as { account_number: string; status: string }[];
    expect(list.map((a) => [a.account_number, a.status])).toEqual([
      ['***333', 'superseded'],
      ['***321', 'active'],
    ]);
  });

  it('a change can be rejected; it is never verified afterwards', async () => {
    const res = await call(
      'POST',
      `/parties/${supplier}/bank-accounts`,
      'clerk',
      newAccount('555000111'),
    );
    const id = ((await res.json()) as { id: string }).id;
    const rej = await call('POST', `/bank-detail-changes/${id}/reject`, 'ownerB', {
      reason: 'The supplier says they did not ask for this',
    });
    expect(rej.status).toBe(200);
    expect(await rej.json()).toEqual({ id, status: 'rejected' });
    const again = await call('POST', `/bank-detail-changes/${id}/verify`, 'ownerA', {
      confirmation_note: NOTE,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'bank_detail_change_not_pending' });
  });

  it('refuses bad input, other tenants and a missing key service', async () => {
    const path = `/parties/${supplier}/bank-accounts`;
    expect((await call('POST', path, 'clerk', { ...newAccount('1'), bsb: '06200' })).status).toBe(
      400,
    );
    expect((await call('POST', path, 'clerk', { bsb: '062-000' })).status).toBe(400);
    expect((await call('POST', path, 'other', newAccount('123456'))).status).toBe(404);
    expect(
      (
        await call('POST', `/bank-detail-changes/not-a-uuid/verify`, 'ownerB', {
          confirmation_note: NOTE,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/bank-detail-changes/${uid(0xdead)}/verify`, 'ownerB', {
          confirmation_note: NOTE,
        })
      ).status,
    ).toBe(404);
    const noKms = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
    try {
      cookies.set(
        'clerk-noKms',
        await (noKms.sessions?.create(A, {
          userId: PEOPLE.clerk.id,
          amr: ['pwd', 'otp'],
          acr: null,
          authTime: new Date(),
        }) ?? Promise.resolve('')),
      );
      const res = await call('POST', path, 'clerk-noKms', newAccount('123456'), noKms);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'kms_not_configured' });
    } finally {
      await noKms.close();
    }
  });
});
