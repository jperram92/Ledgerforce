/**
 * SS-PLAT-96 — the read routes the GL screens use (T-0082, RQ-0046): the chart of accounts
 * (`GET /accounts`), the manual-journal list (`GET /manual-journals`), "show me the journal" for
 * a stored journal (`GET /manual-journals/:id/preview`, the posting engine's preview, design
 * §3.9) and the people's names on `GET /manual-journals/:id`. Real routes, real sessions, RBAC
 * (ADR-0023), lf_app only, two tenants.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { generateFiscalYear } from '@ledgerforce/ledger';
import { ledgerOutbox } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000082a1';
const X = '01900000-0000-7000-8000-0000000082b1';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PEOPLE = {
  accountant: { tenant: A, id: uid(0x82a1), name: 'Priya Shah', roles: ['accountant'] },
  approver: { tenant: A, id: uid(0x82a2), name: 'Mei Tan', roles: ['approver'] },
  auditor: { tenant: A, id: uid(0x82a3), name: 'Ada Brooks', roles: ['auditor'] },
  arClerk: { tenant: A, id: uid(0x82a4), name: 'Lena Ortiz', roles: ['ar_clerk'] },
  other: { tenant: X, id: uid(0x82b1), name: 'Other Owner', roles: ['owner'] },
} as const;
type Who = keyof typeof PEOPLE;

let tdb: TestDatabase;
let api: Api;
let outboxHarness: OutboxHarness;
const companies: Record<string, { id: string; acct: Record<string, string> }> = {};
const cookies = new Map<string, string>();
let keyNo = 0;

async function call(method: string, path: string, who: Who, body?: unknown, key?: string) {
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

const co = (who: Who) => companies[PEOPLE[who].tenant] ?? { id: '', acct: {} };

function journal(who: Who, amount: string, drCode: string, memo = 'Accrued rent') {
  const c = co(who);
  return {
    company_id: c.id,
    entry_date: '2026-10-24',
    memo,
    lines: [
      { account_id: c.acct[drCode], debit: amount, memo: 'accrual' },
      { account_id: c.acct['1010'], credit: amount },
    ],
  };
}

async function create(who: Who, body: unknown): Promise<string> {
  keyNo += 1;
  const res = await call('POST', '/manual-journals', who, body, `gl-ui-${String(keyNo)}`);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
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
      [p.id, p.tenant, `${who}@gl-ui.test`, p.name],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [p.tenant, p.id, role],
      );
    }
  }
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const [tenant, name] of [
    [A, 'Harbour & Co Pty Ltd'],
    [X, 'Other Pty Ltd'],
  ] as const) {
    companies[tenant] = await withTenant(seed, tenant, async (trx) => {
      const c = await trx
        .insertInto('app.company')
        .values({ name, base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
      await generateFiscalYear(trx, { companyId: c.id, convention: 'AU', startYear: 2026 });
      await trx
        .insertInto('app.number_series')
        .values({ company_id: c.id, code: 'je_manual_journal', prefix: 'MJ-' })
        .execute();
      return { id: c.id, acct: Object.fromEntries(chart.accounts) };
    });
  }
  await seed.destroy();
  outboxHarness = await createOutboxHarness(tdb);
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    postingOutbox: ledgerOutbox(await outboxHarness.startRuntime()),
  });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE)) {
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
});

afterAll(async () => {
  await (outboxHarness as OutboxHarness | undefined)?.close();
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

interface AccountRow {
  id: string;
  company_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  currency: string | null;
  postable: boolean;
  is_control: boolean;
  status: string;
  system_roles: string[];
}

describe('SS-PLAT-96: GL screen read routes (chart, journal list, journal preview)', () => {
  it('SS-PLAT-96 GET /accounts lists the companies and their chart in code order, with system roles; needs gl.account.read', async () => {
    const res = await call('GET', '/accounts', 'accountant');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      companies: { id: string; name: string; base_currency: string }[];
      accounts: AccountRow[];
    };
    expect(body.companies).toEqual([
      { id: co('accountant').id, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
    ]);
    expect(body.accounts).toHaveLength(43);
    expect(body.accounts.map((a) => a.code)).toEqual([...body.accounts.map((a) => a.code)].sort());
    expect(body.accounts.find((a) => a.code === '1200')).toEqual({
      id: co('accountant').acct['1200'],
      company_id: co('accountant').id,
      code: '1200',
      name: 'Trade debtors',
      type: 'asset',
      subtype: 'receivable',
      normal_balance: 'debit',
      currency: null,
      postable: true,
      is_control: true,
      status: 'active',
      system_roles: ['AR_CONTROL'],
    });
    expect(body.accounts.find((a) => a.code === '6200')?.system_roles).toEqual([]);
    expect(body.accounts.find((a) => a.code === '3300')).toMatchObject({ postable: false });

    // Auditor and Approver read; an AR Clerk has no gl.account.read.
    expect((await call('GET', '/accounts', 'auditor')).status).toBe(200);
    expect((await call('GET', '/accounts', 'approver')).status).toBe(200);
    const clerk = await call('GET', '/accounts', 'arClerk');
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'gl.account.read' });
    // Another tenant sees only its own company and chart.
    const other = (await (await call('GET', '/accounts', 'other')).json()) as {
      companies: { id: string }[];
      accounts: AccountRow[];
    };
    expect(other.companies.map((c) => c.id)).toEqual([co('other').id]);
    expect(other.accounts.every((a) => a.company_id === co('other').id)).toBe(true);
  });

  it('SS-PLAT-96 GET /manual-journals lists newest first with amounts as decimal strings and names; filters by status; needs gl.journal.read', async () => {
    const first = await create('accountant', journal('accountant', '1250.5000', '6200'));
    const second = await create(
      'accountant',
      journal('accountant', '89.9000', '6110', 'Bank fee correction'),
    );
    const s = await call('POST', `/manual-journals/${first}/submit`, 'accountant', {});
    expect(s.status).toBe(200);

    const res = await call('GET', '/manual-journals', 'approver');
    expect(res.status).toBe(200);
    const { journals } = (await res.json()) as { journals: Record<string, unknown>[] };
    expect(journals.map((j) => j.id).slice(0, 2)).toEqual([second, first]);
    expect(journals[0]).toEqual({
      id: second,
      company_id: co('accountant').id,
      status: 'draft',
      entry_date: '2026-10-24',
      memo: 'Bank fee correction',
      line_count: 2,
      amount: '89.9000',
      total: null,
      approval_required: null,
      created_by: PEOPLE.accountant.id,
      created_by_name: 'Priya Shah',
      submitted_by_name: null,
      approved_by_name: null,
      posted_by_name: null,
      entry_no: null,
    });
    expect(journals[1]).toMatchObject({
      id: first,
      status: 'submitted',
      amount: '1250.5000',
      total: '1250.5000',
      approval_required: false,
      submitted_by_name: 'Priya Shah',
    });

    const drafts = (await (
      await call('GET', '/manual-journals?status=draft', 'auditor')
    ).json()) as { journals: { status: string }[] };
    expect(drafts.journals.length).toBeGreaterThan(0);
    expect(drafts.journals.every((j) => j.status === 'draft')).toBe(true);
    const bad = await call('GET', '/manual-journals?status=void', 'auditor');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_filter' });

    const clerk = await call('GET', '/manual-journals', 'arClerk');
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'gl.journal.read' });
    const other = (await (await call('GET', '/manual-journals', 'other')).json()) as {
      journals: unknown[];
    };
    expect(other.journals).toEqual([]);
  });

  it('SS-PLAT-96 GET /manual-journals/:id names the people involved', async () => {
    const id = await create('accountant', journal('accountant', '10.0000', '6200'));
    await call('POST', `/manual-journals/${id}/submit`, 'accountant', {});
    const res = await call('GET', `/manual-journals/${id}`, 'approver');
    expect(await res.json()).toMatchObject({
      created_by: PEOPLE.accountant.id,
      people: { [PEOPLE.accountant.id]: 'Priya Shah' },
    });
  });

  it('SS-PLAT-96 GET /manual-journals/:id/preview shows the journal the engine would post and writes nothing', async () => {
    const id = await create('accountant', journal('accountant', '1250.5000', '6200'));
    const before = await tdb.admin.query(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
      [A],
    );
    const res = await call('GET', `/manual-journals/${id}/preview`, 'auditor');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entry_date: '2026-10-24',
      requested_date: '2026-10-24',
      redirected: false,
      needs_override: false,
      base_currency: 'AUD',
      total: '1250.5000',
      lines: [
        {
          line_no: 1,
          account_id: co('accountant').acct['6200'],
          account_code: '6200',
          account_name: 'Rent',
          account_type: 'expense',
          debit: '1250.5000',
          credit: '0.0000',
          memo: 'accrual',
        },
        {
          line_no: 2,
          account_id: co('accountant').acct['1010'],
          account_code: '1010',
          account_name: 'Operating account',
          account_type: 'asset',
          debit: '0.0000',
          credit: '1250.5000',
          memo: null,
        },
      ],
    });
    const after = await tdb.admin.query(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
      [A],
    );
    expect(after.rows).toEqual(before.rows);
    const clerk = await call('GET', `/manual-journals/${id}/preview`, 'arClerk');
    expect(clerk.status).toBe(403);
    expect((await call('GET', `/manual-journals/${id}/preview`, 'other')).status).toBe(404);
  });

  it('SS-PLAT-96 a control-account line is refused by the preview with CONTROL_ACCOUNT and its line; a posted journal answers ALREADY_POSTED', async () => {
    const id = await create('accountant', {
      ...journal('accountant', '300.0000', '6200'),
      lines: [
        { account_id: co('accountant').acct['6500'], debit: '300.0000' },
        { account_id: co('accountant').acct['1200'], credit: '300.0000', memo: 'write off' },
      ],
    });
    const res = await call('GET', `/manual-journals/${id}/preview`, 'accountant');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: 'posting_refused',
      code: 'CONTROL_ACCOUNT',
      line: 2,
    });

    const ok = await create('accountant', journal('accountant', '20.0000', '6200'));
    await call('POST', `/manual-journals/${ok}/submit`, 'accountant', {});
    const posted = await call('POST', `/manual-journals/${ok}/post`, 'accountant', {});
    expect(posted.status).toBe(200);
    const entryNo = ((await posted.json()) as { entry_no: string }).entry_no;
    const again = await call('GET', `/manual-journals/${ok}/preview`, 'accountant');
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({
      error: 'posting_refused',
      code: 'ALREADY_POSTED',
      entry_no: entryNo,
    });
  });
});
