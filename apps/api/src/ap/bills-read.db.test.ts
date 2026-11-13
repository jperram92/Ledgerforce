/**
 * Bill read routes for the bills screens (T-0086, UC-05, SS-UC05-08, DL-0440): the coding choices
 * an AP Clerk needs (suppliers, expense/asset accounts, tax codes in force), the bills list, one
 * bill with its coding, the people involved and whether the caller may approve it (SoD evaluated
 * on the server, design §6.5 rule 3), and its journal — the posting engine's preview while it is a
 * draft (writes nothing) and the posted entry once approved (same lines, GP-008).
 * Real PostgreSQL as lf_app, real sessions.
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
let customer = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; name: string; roles: string[] }> = {
  clerk: { id: randomUUID(), name: 'Lena Ortiz', roles: ['ap_clerk'] },
  clerkApprover: { id: randomUUID(), name: 'Mei Tan', roles: ['ap_clerk', 'approver'] },
  approver: { id: randomUUID(), name: 'Sam Nguyen', roles: ['approver'] },
  arClerk: { id: randomUUID(), name: 'Ari Cole', roles: ['ar_clerk'] },
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

async function journalCount(): Promise<number> {
  const { rows } = await f.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
    [f.tenantId],
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000008601');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@bills-read.test`, p.name],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  await seedBillingCompany(f);
  [supplier, customer] = await f.inTenant(async (trx) => {
    const ids: string[] = [];
    for (const [name, role] of [
      ['Paper Supplies Pty Ltd', 'supplier'],
      ['Acme Customer Pty Ltd', 'customer'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: name, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: f.companyId, party_id: p.id, role })
        .execute();
      ids.push(p.id);
    }
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ap_bill_document', prefix: 'BILL-' })
      .execute();
    return ids as [string, string];
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

const q = () => `company_id=${f.companyId}`;
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

interface JournalBody {
  posted: boolean;
  entry_no: string | null;
  entry_date: string;
  base_currency: string;
  total: string;
  lines: {
    line_no: number;
    account_code: string;
    account_name: string;
    account_type: string;
    debit: string;
    credit: string;
  }[];
}
const amounts = (j: JournalBody) =>
  j.lines.map((l) => `${l.account_code} ${l.debit} ${l.credit}`).sort();

describe('SS-UC05-08 (API, T-0086): bill coding choices', () => {
  it('lists active suppliers, postable expense/asset accounts and tax codes in force; needs ap.bill.enter', async () => {
    const res = await call('GET', `/ap/bill-coding?${q()}&date=2026-11-03`, 'clerk');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suppliers: { id: string; name: string }[];
      accounts: { id: string; code: string; name: string; type: string }[];
      tax_codes: { code: string; name: string; rate: string }[];
    };
    expect(body.suppliers).toEqual([{ id: supplier, name: 'Paper Supplies Pty Ltd' }]);
    expect(body.suppliers.map((s) => s.id)).not.toContain(customer);
    const codes = body.accounts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['6230', '1500']));
    expect(codes).not.toContain('2100');
    expect(body.accounts.every((a) => a.type === 'expense' || a.type === 'asset')).toBe(true);
    expect(body.tax_codes.map((t) => t.code)).toEqual(expect.arrayContaining(['GST', 'GST-CAP']));
    expect(body.tax_codes.find((t) => t.code === 'GST')?.rate).toMatch(/^0\.1/);

    expect((await call('GET', `/ap/bill-coding?${q()}`, 'approver')).status).toBe(403);
    expect((await call('GET', `/ap/bill-coding?company_id=nope`, 'clerk')).status).toBe(400);
  });
});

describe('SS-UC05-08 (API, T-0086): bills list and one bill', () => {
  it('lists every bill with supplier, dates and state; shows one bill with its coding and the people involved', async () => {
    const id = randomUUID();
    expect((await enter(id, 'clerk', 'SUP-R-1')).status).toBe(201);

    const list = await call('GET', `/ap/bills?${q()}`, 'clerk');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      bills: expect.arrayContaining([
        {
          id,
          bill_no: null,
          status: 'draft',
          awaiting_approval: false,
          party_id: supplier,
          supplier_name: 'Paper Supplies Pty Ltd',
          supplier_ref: 'SUP-R-1',
          bill_date: '2026-11-03',
          due_date: '2026-11-30',
          gross: '2750.0000',
        },
      ]),
    });
    expect((await call('GET', `/ap/bills?${q()}`, 'arClerk')).status).toBe(403);
    expect((await call('GET', `/ap/bills?${q()}&queue=other`, 'clerk')).status).toBe(400);

    const one = await call('GET', `/ap/bills/${id}?${q()}`, 'clerk');
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({
      id,
      status: 'draft',
      awaiting_approval: false,
      supplier_name: 'Paper Supplies Pty Ltd',
      supplier_ref: 'SUP-R-1',
      net: '2500.0000',
      tax: '250.0000',
      gross: '2750.0000',
      currency: 'AUD',
      lines: [
        {
          line_no: 1,
          description: 'Stationery and consumables',
          account_code: '6230',
          account_name: expect.any(String),
          tax_code: 'GST',
          amount: '500.0000',
        },
        {
          line_no: 2,
          description: 'Laptop',
          account_code: '1500',
          account_name: expect.any(String),
          tax_code: 'GST-CAP',
          amount: '2000.0000',
        },
      ],
      entered: { by: 'Lena Ortiz', you: true, at: expect.any(String) },
      submitted: null,
      approved: null,
    });
    expect((await call('GET', `/ap/bills/${randomUUID()}?${q()}`, 'clerk')).status).toBe(404);
  });
});

describe('SS-UC05-08 (API, T-0086): approval decision for the caller (SoD on the server)', () => {
  it('a person who entered a 2,750.00 bill is told they may not approve it; another approver may', async () => {
    const id = randomUUID();
    expect((await enter(id, 'clerkApprover', 'SUP-R-2')).status).toBe(201);
    expect((await call('POST', `/ap/bills/${id}/submit?${q()}`, 'clerkApprover')).status).toBe(200);
    const own = await call('GET', `/ap/bills/${id}?${q()}`, 'clerkApprover');
    expect(await own.json()).toMatchObject({
      awaiting_approval: true,
      entered: { by: 'Mei Tan', you: true },
      submitted: { by: 'Mei Tan', you: true },
      approval: {
        allowed: false,
        rule: 'SOD_BILL_SELF_APPROVAL',
        self_approval_threshold: '1000.0000',
      },
    });
    const other = await call('GET', `/ap/bills/${id}?${q()}`, 'approver');
    expect(await other.json()).toMatchObject({
      entered: { by: 'Mei Tan', you: false },
      approval: { allowed: true, rule: null, self_approval_threshold: '1000.0000' },
    });
  });
});

describe('SS-UC05-08 (API, T-0086): the journal of a bill', () => {
  it('previews GP-008 for a draft without writing, and shows the same posted entry after approval', async () => {
    const id = randomUUID();
    expect((await enter(id, 'clerk', 'SUP-R-3')).status).toBe(201);
    const before = await journalCount();

    const pre = await call('GET', `/ap/bills/${id}/journal?${q()}`, 'clerk');
    expect(pre.status).toBe(200);
    const preview = (await pre.json()) as JournalBody;
    expect(preview).toMatchObject({
      posted: false,
      entry_no: null,
      entry_date: '2026-11-03',
      base_currency: 'AUD',
      total: '2750.0000',
    });
    expect(preview.lines).toHaveLength(4);
    expect(preview.lines.map((l) => l.account_type)).toEqual(
      expect.arrayContaining(['expense', 'asset', 'liability']),
    );
    expect(await journalCount()).toBe(before);

    expect((await call('POST', `/ap/bills/${id}/submit?${q()}`, 'clerk')).status).toBe(200);
    expect((await call('POST', `/ap/bills/${id}/approve?${q()}`, 'approver')).status).toBe(200);
    expect(await journalCount()).toBe(before + 1);

    const res = await call('GET', `/ap/bills/${id}/journal?${q()}`, 'clerk');
    expect(res.status).toBe(200);
    const posted = (await res.json()) as JournalBody;
    expect(posted).toMatchObject({ posted: true, entry_date: '2026-11-03', total: '2750.0000' });
    expect(posted.entry_no).toEqual(expect.any(String));
    expect(amounts(posted)).toEqual(amounts(preview));

    const detail = await call('GET', `/ap/bills/${id}?${q()}`, 'clerk');
    expect(await detail.json()).toMatchObject({
      status: 'posted',
      bill_no: expect.stringMatching(/^BILL-/),
      entered: { by: 'Lena Ortiz', you: true },
      submitted: { by: 'Lena Ortiz' },
      approved: { by: 'Sam Nguyen', you: false, at: expect.any(String) },
    });
    expect((await call('GET', `/ap/bills/${id}/journal?${q()}`, 'arClerk')).status).toBe(403);
  });
});
