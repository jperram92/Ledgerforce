/**
 * ABA file of a released payment batch over HTTP (T-0056, UC-06 step 3, SS-UC06-06, DL-0292):
 * POST /ap/payment-batches/:id/aba?company_id= returns the file as an attachment for a holder of
 * ap.payment_batch.release, writes one audit row (the file unseals account numbers), refuses a
 * draft batch with NOT_RELEASED and an AP Clerk (no release permission) with 403. The byte-exact
 * content is proven against the fixture in packages/modules/ap/src/aba-export.db.test.ts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { payablesKms, seedPayablesCompany, type PayablesFixture } from '@ledgerforce/ap/testing';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let api: Api;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  apClerk: { id: randomUUID(), roles: ['ap_clerk'] },
  releaser: { id: randomUUID(), roles: ['approver'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  h['sec-fetch-site'] = 'same-origin';
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005602');
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@aba.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  p = await seedPayablesCompany(f);
  await f.inTenant((trx) =>
    createCompanyBankAccount(trx, payablesKms, f.companyId, {
      glAccountId: f.acct['1010'] ?? '',
      name: 'Operating',
      bsb: '062-000',
      accountNumber: '10203040',
      accountName: 'LedgerForce Operating',
      currency: 'AUD',
      apcaUserId: '301500',
      abaUserName: 'LEDGERFORCE TEST',
      abaFiMnemonic: 'CBA',
    }),
  );
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {}, kms: payablesKms });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const who of Object.keys(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: people[who]?.id ?? '',
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC06-06: ABA file is byte-exact', () => {
  it('SS-UC06-06 a releaser downloads the ABA file of a released batch (audited); a draft batch and an AP Clerk are refused', async () => {
    const s = await p.addSupplier('Harbour Paper Co', 72);
    await p.postBill(s, 'HP-1', '250.00', '2026-11-06');
    const id = randomUUID();
    const built = await call('PUT', `/ap/payment-batches/${id}`, 'apClerk', {
      company_id: f.companyId,
      payment_date: '2026-11-06',
      due_by: '2026-11-06',
      account_id: f.acct['1010'],
    });
    expect(built.status).toBe(201);
    const aba = (who: string) =>
      call('POST', `/ap/payment-batches/${id}/aba?company_id=${f.companyId}`, who);

    const draft = await aba('releaser');
    expect(draft.status).toBe(422);
    expect(await draft.json()).toMatchObject({ error: 'NOT_RELEASED' });

    const released = await call(
      'POST',
      `/ap/payment-batches/${id}/release?company_id=${f.companyId}`,
      'releaser',
    );
    expect(released.status).toBe(200);

    expect((await aba('apClerk')).status).toBe(403);

    const res = await aba('releaser');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="PB-000001-20261106.aba"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = Buffer.from(await res.arrayBuffer()).toString('ascii');
    const records = body.split('\r\n');
    expect(records).toHaveLength(4);
    expect(records.slice(0, 3).map((r) => r.length)).toEqual([120, 120, 120]);
    expect(records[1]).toMatch(
      /^1062-000 {3}100001 500000025000Harbour Paper Co {16}HP-1 {14}062-000 10203040LEDGERFORCE TEST00000000$/,
    );

    const audit = await f.admin.query<{ action: string; entity_id: string; after: unknown }>(
      `SELECT action, entity_id::text, after FROM audit.audit_log
        WHERE tenant_id = $1 AND action LIKE 'POST %/aba' ORDER BY occurred_at`,
      [f.tenantId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'POST /ap/payment-batches/:id/aba',
        entity_id: id,
        after: {
          aba_file: 'PB-000001-20261106.aba',
          payment_count: 1,
          total: '250.0000',
        },
      },
    ]);
  });
});
