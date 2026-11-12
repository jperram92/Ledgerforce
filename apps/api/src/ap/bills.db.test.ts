/**
 * Bill approval on the real routes (T-0052, UC-05, design §6.5 rule 3, DL-0290): a submitted bill
 * waits in the Approver queue with no journal (SS-UC05-03); the AP Clerk who entered a 2,750.00
 * bill cannot approve it (SOD_BILL_SELF_APPROVAL, audited, SS-UC05-05) while another approver
 * posts it; in small-team mode a sole user approves their own bill only with a recorded exception
 * (SS-UC05-06). Real PostgreSQL as lf_app, real sessions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let api: Api;
let supplier = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  apClerk: { id: randomUUID(), roles: ['ap_clerk', 'approver'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  owner: { id: randomUUID(), roles: ['owner'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function journalsFor(billId: string): Promise<number> {
  const { rows } = await f.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.journal_entry e
       JOIN app.supplier_bill b ON b.tenant_id = e.tenant_id AND b.entry_id = e.id
      WHERE b.id = $1`,
    [billId],
  );
  return rows[0]?.n ?? 0;
}

async function auditMark(): Promise<string> {
  const { rows } = await f.admin.query<{ m: string }>(
    'SELECT coalesce(max(id), 0)::text AS m FROM audit.audit_log',
  );
  return rows[0]?.m ?? '0';
}
async function auditSince(mark: string) {
  const { rows } = await f.admin.query<{ action: string; actor_user_id: string | null }>(
    `SELECT action, actor_user_id FROM audit.audit_log
      WHERE tenant_id = $1 AND id > $2::bigint ORDER BY id`,
    [f.tenantId, mark],
  );
  return rows;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005201');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@bills.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  await seedBillingCompany(f);
  supplier = await f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Paper Supplies Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'supplier' })
      .execute();
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ap_bill_document', prefix: 'BILL-' })
      .execute();
    return p.id;
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
  await (f as LedgerFixture | undefined)?.close();
});

/** The GP-008 bill: 500.00 stationery (GST) + 2,000.00 laptop (GST-CAP) = 2,750.00 gross. */
const enter = (id: string, who: string, ref: string) =>
  call('PUT', `/ap/bills/${id}`, who, {
    company_id: f.companyId,
    party_id: supplier,
    supplier_ref: ref,
    bill_date: '2026-11-03',
    due_date: '2026-11-30',
    lines: [
      {
        account_id: f.acct['6230'],
        description: 'Stationery and consumables',
        amount: '500.00',
        tax_code: 'GST',
      },
      { account_id: f.acct['1500'], description: 'Laptop', amount: '2000.00', tax_code: 'GST-CAP' },
    ],
  });
const q = () => `company_id=${f.companyId}`;

describe('SS-UC05-03: Submitted bill waits for the Approver', () => {
  it('SS-UC05-03 a submitted bill is in the Approver queue, unposted, with no journal', async () => {
    const id = randomUUID();
    const created = await enter(id, 'apClerk', 'SUP-Q-1');
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id, status: 'draft', gross: '2750.0000' });
    expect((await enter(id, 'apClerk', 'SUP-Q-1')).status).toBe(200);

    const before = await call('GET', `/ap/bills?${q()}&queue=awaiting_approval`, 'approver');
    expect(
      ((await before.json()) as { items: { id: string }[] }).items.map((b) => b.id),
    ).not.toContain(id);
    const early = await call('POST', `/ap/bills/${id}/approve?${q()}`, 'approver');
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ error: 'NOT_SUBMITTED' });

    const sub = await call('POST', `/ap/bills/${id}/submit?${q()}`, 'apClerk');
    expect(sub.status).toBe(200);
    const queue = await call('GET', `/ap/bills?${q()}&queue=awaiting_approval`, 'approver');
    expect(queue.status).toBe(200);
    expect((await queue.json()) as unknown).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, status: 'draft', awaiting_approval: true, entry_id: null }),
      ]),
    });
    expect(await journalsFor(id)).toBe(0);
    expect((await call('POST', `/ap/bills/${id}/submit?${q()}`, 'apClerk')).status).toBe(422);
  });
});

describe('SS-UC05-05: AP Clerk cannot approve own bill', () => {
  it('SS-UC05-05 the Clerk who entered a 2,750.00 bill is refused (SOD_BILL_SELF_APPROVAL, audited); another approver posts it', async () => {
    const id = randomUUID();
    expect((await enter(id, 'apClerk', 'SUP-SOD-1')).status).toBe(201);
    expect((await call('POST', `/ap/bills/${id}/submit?${q()}`, 'apClerk')).status).toBe(200);
    const mark = await auditMark();
    const own = await call('POST', `/ap/bills/${id}/approve?${q()}`, 'apClerk');
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_BILL_SELF_APPROVAL',
    });
    expect(await journalsFor(id)).toBe(0);
    const audit = await auditSince(mark);
    expect(audit).toEqual([
      expect.objectContaining({ action: 'sod_violation', actor_user_id: people.apClerk?.id }),
    ]);
    const other = await call('POST', `/ap/bills/${id}/approve?${q()}`, 'approver');
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({
      id,
      status: 'posted',
      bill_no: expect.stringMatching(/^BILL-/),
    });
    expect(await journalsFor(id)).toBe(1);
  });
});

describe('SS-UC05-06: Small-team approval records an exception', () => {
  it('SS-UC05-06 in small-team mode the sole user approves their own bill only with a recorded exception', async () => {
    const on = await call('POST', '/sod/settings', 'owner', {
      small_team_mode: true,
      reason: 'one-person business (design §6.3)',
    });
    expect(on.status).toBe(201);
    // Nobody else can approve: the Approver leaves and the Owner's role is the only other grant.
    await f.admin.query(`UPDATE app.app_user SET status = 'disabled' WHERE id = ANY($1::uuid[])`, [
      [people.approver?.id, people.owner?.id],
    ]);
    const id = randomUUID();
    expect((await enter(id, 'apClerk', 'SUP-SOLO-1')).status).toBe(201);
    expect((await call('POST', `/ap/bills/${id}/submit?${q()}`, 'apClerk')).status).toBe(200);
    const denied = await call('POST', `/ap/bills/${id}/approve?${q()}`, 'apClerk');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      rule: 'SOD_BILL_SELF_APPROVAL',
      small_team_exception_required: true,
    });
    const ok = await call('POST', `/ap/bills/${id}/approve?${q()}`, 'apClerk', {
      sod_exception: { reason: 'sole trader; accountant reviews monthly' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id, status: 'posted' });
    const { rows } = await f.admin.query(
      `SELECT rule, kind, actor_user_id, reason FROM app.sod_exception WHERE subject_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        rule: 'SOD_BILL_SELF_APPROVAL',
        kind: 'recorded_exception',
        actor_user_id: people.apClerk?.id,
        reason: 'sole trader; accountant reviews monthly',
      },
    ]);
  });
});
