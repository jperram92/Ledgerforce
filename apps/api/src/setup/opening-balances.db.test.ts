/**
 * Opening balances over HTTP (T-0080, SS-PLAT-117, GP-037, DL-0314): a Finance Admin previews
 * (nothing written) and posts the conversion files once (idempotency key: 201, then 200 replay);
 * refusals are 422 with the code and CSV row; an Accountant (no settings.chart.manage) is
 * refused; another tenant's company is not visible.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  financeAdmin: { id: randomUUID(), roles: ['finance_admin'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
};

const TB = [
  'account_code,debit,credit',
  '1010,12400.00,',
  '1200,1925.00,',
  '1500,3000.00,',
  '1820,120.00,',
  '6230,2515.00,',
  '2000,,660.00',
  '2310,,300.00',
  '3200,,10000.00',
  '4110,,9000.00',
].join('\n');
const AR = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Acme Pty Ltd,INV-0991,2026-09-15,2026-10-15,1375.00,125.00',
  'Acme Pty Ltd,INV-1004,2026-10-15,2026-11-14,550.00,50.00',
].join('\n');
const AP = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Supplier Pty Ltd,B-77,2026-10-08,2026-11-07,-660.00,-60.00',
].join('\n');

async function call(method: string, path: string, who: string, body?: unknown, key?: string) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key) h['idempotency-key'] = key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const body = (over: Record<string, unknown> = {}) => ({
  company_id: f.companyId,
  conversion_date: '2026-11-01',
  trial_balance_csv: TB,
  ar_items_csv: AR,
  ap_items_csv: AP,
  ...over,
});

const entries = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE company_id = $1',
      [f.companyId],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000008002');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000008003');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@opening.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  await f.inTenant(async (trx) => {
    for (const [i, code] of [
      ...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s))),
    ].entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `O${String(i)}-` })
        .execute();
    }
    for (const [name, role] of [
      ['Acme', 'customer'],
      ['Supplier', 'supplier'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: f.companyId, party_id: p.id, role })
        .execute();
    }
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
  await (other as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-117: opening balances over HTTP', () => {
  it('preview returns the GP-037 journal dated the balance date and writes nothing', async () => {
    const before = await entries();
    const r = await call('POST', '/setup/opening-balances/preview', 'financeAdmin', body());
    expect(r.status).toBe(200);
    const p = (await r.json()) as {
      balance_date: string;
      total: string;
      lines: { account_code: string; debit: string; credit: string; due_date: string | null }[];
    };
    expect(p.balance_date).toBe('2026-10-31');
    expect(p.total).toBe('19960.0000');
    expect(p.lines.map((l) => l.account_code)).toEqual([
      '1010',
      '1200',
      '1200',
      '1500',
      '1820',
      '6230',
      '2000',
      '2310',
      '3200',
      '4110',
    ]);
    expect(p.lines[1]).toMatchObject({ debit: '1375.0000', due_date: '2026-10-15' });
    expect(await entries()).toBe(before);
  });

  it('refusals are 422 with the code (and the CSV row), writing nothing', async () => {
    const before = await entries();
    const unbalanced = await call(
      'POST',
      '/setup/opening-balances',
      'financeAdmin',
      body({ trial_balance_csv: TB.replace('1010,12400.00,', '1010,12400.01,') }),
      'k-unbalanced',
    );
    expect(unbalanced.status).toBe(422);
    expect(await unbalanced.json()).toMatchObject({ error: 'UNBALANCED' });
    const badRow = await call(
      'POST',
      '/setup/opening-balances/preview',
      'financeAdmin',
      body({ ar_items_csv: AR.replace('1375.00,125.00', '1375.00,1400.00') }),
    );
    expect(badRow.status).toBe(422);
    expect(await badRow.json()).toMatchObject({ error: 'INVALID_CSV', row: 2 });
    const noKey = await call('POST', '/setup/opening-balances', 'financeAdmin', body());
    expect(noKey.status).toBe(400);
    const noDate = await call(
      'POST',
      '/setup/opening-balances/preview',
      'financeAdmin',
      body({ conversion_date: '1 Nov 2026' }),
    );
    expect(noDate.status).toBe(400);
    expect(await entries()).toBe(before);
  });

  it('an Accountant without settings.chart.manage is refused', async () => {
    const r = await call('POST', '/setup/opening-balances', 'accountant', body(), 'k-acct');
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toMatch(/settings\.chart\.manage/);
  });

  it('posts once: 201 with the opening balance, 200 on replay, readable by GET', async () => {
    const first = await call('POST', '/setup/opening-balances', 'financeAdmin', body(), 'k-open-1');
    expect(first.status).toBe(201);
    const a = (await first.json()) as {
      id: string;
      entry_id: string;
      balance_date: string;
      replayed: boolean;
      items: { document_no: string; line_no: number; amount: string; gst_amount: string }[];
    };
    expect(a).toMatchObject({ balance_date: '2026-10-31', replayed: false });
    expect(a.items.map((i) => [i.document_no, i.line_no, i.amount, i.gst_amount])).toEqual([
      ['INV-0991', 2, '1375.0000', '125.0000'],
      ['INV-1004', 3, '550.0000', '50.0000'],
      ['B-77', 7, '-660.0000', '-60.0000'],
    ]);
    const count = await entries();
    const again = await call('POST', '/setup/opening-balances', 'financeAdmin', body(), 'k-open-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: a.id, entry_id: a.entry_id, replayed: true });
    expect(await entries()).toBe(count);

    const second = await call(
      'POST',
      '/setup/opening-balances',
      'financeAdmin',
      body(),
      'k-open-2',
    );
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({ error: 'OPENING_EXISTS' });

    const got = await call(
      'GET',
      `/setup/opening-balances?company_id=${f.companyId}`,
      'financeAdmin',
    );
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: a.id, entry_id: a.entry_id });
    const audit = await f.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log WHERE entity_type = 'opening_balance' AND entity_id = $1`,
      [a.id],
    );
    expect(audit.rows[0]?.n).toBe('1');
  });

  it('another tenant sees no opening balance and cannot post to this company', async () => {
    const got = await call(
      'GET',
      `/setup/opening-balances?company_id=${other.companyId}`,
      'financeAdmin',
    );
    expect(got.status).toBe(404);
    const r = await call(
      'POST',
      '/setup/opening-balances/preview',
      'financeAdmin',
      body({ company_id: other.companyId }),
    );
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'UNKNOWN_ACCOUNT' });
  });
});
