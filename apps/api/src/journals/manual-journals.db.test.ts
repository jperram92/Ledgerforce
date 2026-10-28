/**
 * SS-PLAT-90 (API layer) — manual journal routes (T-0029, design §6.4, §6.5 rule 4, RQ-0043,
 * ADR-0039): real routes, real sessions (MFA sign-in), RBAC (ADR-0023), the real SoD engine
 * (ADR-0026) and the posting engine, lf_app only. The module and database rules are proven in
 * packages/modules/journals; the engine boundary in packages/ledger (SS-PLAT-07).
 *
 * Also SS-PLAT-07 through the API: a journal with an AR_CONTROL line is refused with
 * CONTROL_ACCOUNT (422) and never posts.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { generateFiscalYear } from '@ledgerforce/ledger';
import { ledgerOutbox, OUTBOX_QUEUE } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000029a1';
const SMALL = '01900000-0000-7000-8000-0000000029c1';
const X = '01900000-0000-7000-8000-0000000029b1';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PEOPLE = {
  accountant: { tenant: A, id: uid(0x29a1), roles: ['accountant'] },
  approver: { tenant: A, id: uid(0x29a2), roles: ['approver'] },
  owner: { tenant: A, id: uid(0x29a3), roles: ['owner'] },
  arClerk: { tenant: A, id: uid(0x29a4), roles: ['ar_clerk'] },
  soloOwner: { tenant: SMALL, id: uid(0x29c1), roles: ['owner'] },
  other: { tenant: X, id: uid(0x29b1), roles: ['owner'] },
} as const;

let tdb: TestDatabase;
let api: Api;
let outboxHarness: OutboxHarness;
const companies: Record<string, { id: string; acct: Record<string, string> }> = {};
const cookies = new Map<string, string>();
let keyNo = 0;

async function call(
  method: string,
  path: string,
  who: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h: Record<string, string> = { ...headers };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const tenantOf = (who: keyof typeof PEOPLE) => PEOPLE[who].tenant;
const co = (who: keyof typeof PEOPLE) => companies[tenantOf(who)] ?? { id: '', acct: {} };

/** A balanced two-line journal: debit `dr`, credit bank, by account id or system role. */
function journal(who: keyof typeof PEOPLE, amount: string, dr: { code?: string; role?: string }) {
  const c = co(who);
  return {
    company_id: c.id,
    entry_date: '2026-10-24',
    memo: 'Accrued rent',
    lines: [
      dr.role
        ? { account_role: dr.role, debit: amount, memo: 'accrual' }
        : { account_id: c.acct[dr.code ?? ''], debit: amount, memo: 'accrual' },
      { account_id: c.acct['1010'], credit: amount },
    ],
  };
}

async function create(who: keyof typeof PEOPLE, body: unknown) {
  keyNo += 1;
  const res = await call('POST', '/manual-journals', who, body, {
    'idempotency-key': `mj-test-${String(keyNo)}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function rows<T = Record<string, unknown>>(q: string, params: unknown[]): Promise<T[]> {
  return (await tdb.admin.query(q, params)).rows as T[];
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  for (const [tenant, name] of [
    [A, 'Harbour & Co Pty Ltd'],
    [SMALL, 'Solo Pty Ltd'],
    [X, 'Other Pty Ltd'],
  ] as const) {
    await tdb.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [tenant, name]);
  }
  for (const [who, p] of Object.entries(PEOPLE)) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, p.tenant, `${who}@journals.test`, who],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [p.tenant, p.id, role],
      );
    }
  }
  const seed = createDb(tdb.url('lf_app'), 1);
  for (const tenant of [A, SMALL, X]) {
    companies[tenant] = await withTenant(seed, tenant, async (trx) => {
      const c = await trx
        .insertInto('app.company')
        .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
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
  // Small-team mode for the one-person tenant (design §6.5).
  await tdb.admin.query(
    `INSERT INTO app.sod_settings (tenant_id, small_team_mode, set_by, reason)
     VALUES ($1, true, $2, 'One-person company')`,
    [SMALL, PEOPLE.soloOwner.id],
  );
  outboxHarness = await createOutboxHarness(tdb);
  const boss = await outboxHarness.startRuntime();
  const options = {
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    postingOutbox: ledgerOutbox(boss),
  };
  api = await createApi(options);
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE)) {
    // Signed in with MFA 30 minutes ago: no fresh step-up (none is needed for journals).
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
  await (api as Api | undefined)?.close();
  await (outboxHarness as OutboxHarness | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-PLAT-90: Manual journal routes enforce permission, approval and SoD', () => {
  let id: string;

  it('SS-PLAT-68 [T-0112] missing outbox configuration refuses posting without writing a journal', async () => {
    const draft = await create('accountant', journal('accountant', '100.0000', { code: '6200' }));
    expect((await call('POST', `/manual-journals/${draft}/submit`, 'accountant', {})).status).toBe(
      200,
    );
    const unconfigured = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
    try {
      const response = await fetch(`${unconfigured.url}/manual-journals/${draft}/post`, {
        method: 'POST',
        headers: { cookie: `lf_session=${cookies.get('accountant')}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'queue_not_configured' });
      expect(await rows('SELECT id FROM app.journal_entry WHERE source_id = $1', [draft])).toEqual(
        [],
      );
    } finally {
      await unconfigured.close();
    }
  });

  it('SS-PLAT-68 [T-0112] real queue insert failure rolls back posting and its outbox event', async () => {
    const draft = await create('accountant', journal('accountant', '100.0000', { code: '6200' }));
    expect((await call('POST', `/manual-journals/${draft}/submit`, 'accountant', {})).status).toBe(
      200,
    );
    const before = await rows('SELECT id FROM app.outbox_event ORDER BY id', []);
    // pg-boss sends directly to the queue's partition, not only the parent job table.
    await tdb.admin.query('REVOKE INSERT ON ALL TABLES IN SCHEMA pgboss FROM lf_app');
    try {
      expect((await call('POST', `/manual-journals/${draft}/post`, 'accountant', {})).status).toBe(
        500,
      );
      expect(await rows('SELECT id FROM app.journal_entry WHERE source_id = $1', [draft])).toEqual(
        [],
      );
      expect(await rows('SELECT id FROM app.outbox_event ORDER BY id', [])).toEqual(before);
      expect(await rows('SELECT status FROM app.manual_journal WHERE id = $1', [draft])).toEqual([
        { status: 'submitted' },
      ]);
    } finally {
      await tdb.admin.query('GRANT INSERT ON ALL TABLES IN SCHEMA pgboss TO lf_app');
    }
  });

  it('SS-PLAT-90 creating needs gl.journal.post and an Idempotency-Key; a repeat returns the same draft', async () => {
    const clerk = await call(
      'POST',
      '/manual-journals',
      'arClerk',
      journal('arClerk', '1.0000', { code: '6200' }),
      {
        'idempotency-key': 'clerk-1',
      },
    );
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'gl.journal.post' });
    const noKey = await call(
      'POST',
      '/manual-journals',
      'accountant',
      journal('accountant', '1.0000', { code: '6200' }),
    );
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual({ error: 'idempotency_key_required' });

    const body = journal('accountant', '7500.0000', { code: '6200' });
    const first = await call('POST', '/manual-journals', 'accountant', body, {
      'idempotency-key': 'rent-accrual-oct',
    });
    expect(first.status).toBe(201);
    const doc = (await first.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      status: 'draft',
      company_id: co('accountant').id,
      entry_date: '2026-10-24',
      created_by: PEOPLE.accountant.id,
      total: null,
      replayed: false,
    });
    id = String(doc.id);
    const again = await call('POST', '/manual-journals', 'accountant', body, {
      'idempotency-key': 'rent-accrual-oct',
    });
    expect(await again.json()).toMatchObject({ id, replayed: true });
    const badLine = await call(
      'POST',
      '/manual-journals',
      'accountant',
      {
        ...body,
        lines: [
          { debit: '1.0000' },
          { account_id: co('accountant').acct['1010'], credit: '1.0000' },
        ],
      },
      { 'idempotency-key': 'bad-1' },
    );
    expect(badLine.status).toBe(400);
    const floaty = await call(
      'POST',
      '/manual-journals',
      'accountant',
      {
        ...body,
        lines: [
          { account_id: co('accountant').acct['6200'], debit: 10.5 },
          { account_id: co('accountant').acct['1010'], credit: '10.5' },
        ],
      },
      { 'idempotency-key': 'bad-2' },
    );
    expect(floaty.status).toBe(400);
  });

  it('SS-PLAT-90 submit above the threshold needs approval; posting before it is 409 approval_required', async () => {
    const s = await call('POST', `/manual-journals/${id}/submit`, 'accountant', {});
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({
      id,
      status: 'submitted',
      total: '7500.0000',
      approval_required: true,
      sensitive_accounts: false,
    });
    const early = await call('POST', `/manual-journals/${id}/post`, 'accountant', {});
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: 'approval_required' });
    // The accountant may not approve at all (§6.4).
    const self = await call('POST', `/manual-journals/${id}/approve`, 'accountant', {});
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({ error: 'forbidden', permission: 'gl.journal.approve' });
  });

  it('SS-PLAT-90 an Approver approves without step-up; the entry posts once with approved_by; a repeat replays', async () => {
    const a = await call('POST', `/manual-journals/${id}/approve`, 'approver', {});
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ id, status: 'approved' });
    const p = await call('POST', `/manual-journals/${id}/post`, 'accountant', {});
    expect(p.status).toBe(200);
    const posted = (await p.json()) as { entry_id: string; entry_no: string };
    expect(posted).toMatchObject({
      id,
      status: 'posted',
      entry_date: '2026-10-24',
      replayed: false,
    });
    expect(posted.entry_no).toMatch(/^MJ-/);
    const again = await call('POST', `/manual-journals/${id}/post`, 'accountant', {});
    expect(await again.json()).toMatchObject({ entry_id: posted.entry_id, replayed: true });
    const events = await rows<{ id: string }>(
      `SELECT id FROM app.outbox_event WHERE tenant_id = $1 AND aggregate_id = $2 AND topic = 'ledger.entry.posted'`,
      [A, posted.entry_id],
    );
    expect(
      events,
      'SS-PLAT-68 [T-0112]: API post and replay produce exactly one event',
    ).toHaveLength(1);
    expect(
      await rows(`SELECT data FROM pgboss.job WHERE id = $1 AND name = $2`, [
        events[0]?.id,
        OUTBOX_QUEUE,
      ]),
    ).toEqual([{ data: { tenantId: A, eventId: events[0]?.id } }]);
    expect(
      await rows(
        `SELECT source_type, source_id, created_by::text, approved_by::text
           FROM app.journal_entry WHERE tenant_id = $1`,
        [A],
      ),
    ).toEqual([
      {
        source_type: 'manual_journal',
        source_id: id,
        created_by: PEOPLE.accountant.id,
        approved_by: PEOPLE.approver.id,
      },
    ]);
    expect(
      await rows(
        `SELECT step, actor_user_id::text AS actor FROM app.sod_action
          WHERE subject_type = 'manual_journal' AND subject_id = $1 ORDER BY occurred_at, id`,
        [id],
      ),
    ).toEqual([
      { step: 'manual_journal.post', actor: PEOPLE.accountant.id },
      { step: 'manual_journal.approve', actor: PEOPLE.approver.id },
    ]);
    const view = await call('GET', `/manual-journals/${id}`, 'approver');
    expect(await view.json()).toMatchObject({ status: 'posted', approved_by: PEOPLE.approver.id });
  });

  it('SS-PLAT-90 an Owner who submitted a journal needing approval cannot approve it: SOD_JOURNAL_SELF_APPROVAL', async () => {
    const own = await create('owner', journal('owner', '100.0000', { code: '3100' })); // equity
    const s = await call('POST', `/manual-journals/${own}/submit`, 'owner', {});
    expect(await s.json()).toMatchObject({ approval_required: true, sensitive_accounts: true });
    const denied = await call('POST', `/manual-journals/${own}/approve`, 'owner', {});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_JOURNAL_SELF_APPROVAL',
      small_team_exception_required: false,
    });
    expect(await rows(`SELECT status FROM app.manual_journal WHERE id = $1`, [own])).toEqual([
      { status: 'submitted' },
    ]);
    // Rejection needs a reason and returns the journal to draft.
    const noReason = await call('POST', `/manual-journals/${own}/reject`, 'approver', {});
    expect(noReason.status).toBe(400);
    const r = await call('POST', `/manual-journals/${own}/reject`, 'approver', {
      reason: 'Drawings go through the owner loan account',
    });
    expect(await r.json()).toEqual({ id: own, status: 'draft' });
    const edit = await call(
      'PUT',
      `/manual-journals/${own}`,
      'owner',
      journal('owner', '90.0000', { code: '3100' }),
    );
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ status: 'draft', rejected_by: PEOPLE.approver.id });
  });

  it('SS-PLAT-90 below the threshold on ordinary accounts the preparer posts without approval', async () => {
    const small = await create('accountant', journal('accountant', '120.0000', { code: '6220' }));
    const s = await call('POST', `/manual-journals/${small}/submit`, 'accountant', {});
    expect(await s.json()).toMatchObject({ approval_required: false });
    const p = await call('POST', `/manual-journals/${small}/post`, 'accountant', {});
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ status: 'posted' });
  });

  it('SS-PLAT-90 small-team mode: the only user approves their own journal with a recorded exception', async () => {
    const solo = await create('soloOwner', journal('soloOwner', '6000.0000', { code: '6200' }));
    await call('POST', `/manual-journals/${solo}/submit`, 'soloOwner', {});
    const plain = await call('POST', `/manual-journals/${solo}/approve`, 'soloOwner', {});
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({
      rule: 'SOD_JOURNAL_SELF_APPROVAL',
      small_team_exception_required: true,
    });
    const ok = await call('POST', `/manual-journals/${solo}/approve`, 'soloOwner', {
      sod_exception: { reason: 'Sole director; reviewed by the outside accountant monthly' },
    });
    expect(ok.status).toBe(200);
    expect(
      await rows(
        `SELECT rule, kind FROM app.sod_exception WHERE subject_type = 'manual_journal' AND subject_id = $1`,
        [solo],
      ),
    ).toEqual([{ rule: 'SOD_JOURNAL_SELF_APPROVAL', kind: 'recorded_exception' }]);
    const p = await call('POST', `/manual-journals/${solo}/post`, 'soloOwner', {});
    expect(await p.json()).toMatchObject({ status: 'posted' });
  });

  it('SS-PLAT-90 another tenant cannot see or act on the journal', async () => {
    for (const [method, path] of [
      ['GET', `/manual-journals/${id}`],
      ['POST', `/manual-journals/${id}/post`],
      ['POST', `/manual-journals/${id}/submit`],
    ] as const) {
      const res = await call(method, path, 'other', method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('SS-PLAT-07: Control accounts reject manual journals, imports and rule lines (API)', () => {
  it('SS-PLAT-07 a manual journal with an AR_CONTROL line is refused with CONTROL_ACCOUNT at submit and never posts', async () => {
    const before = await rows(
      `SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1`,
      [A],
    );
    for (const dr of [
      { role: 'AR_CONTROL' },
      { code: '1200' },
      { code: '2000' },
      { code: '2350' },
    ]) {
      const mj = await create('accountant', journal('accountant', '50.0000', dr));
      const s = await call('POST', `/manual-journals/${mj}/submit`, 'accountant', {});
      expect(s.status).toBe(422);
      expect(await s.json()).toMatchObject({
        error: 'posting_refused',
        code: 'CONTROL_ACCOUNT',
        line: 1,
      });
      const p = await call('POST', `/manual-journals/${mj}/post`, 'accountant', {});
      expect(p.status).toBe(409);
      expect(await rows(`SELECT status FROM app.manual_journal WHERE id = $1`, [mj])).toEqual([
        { status: 'draft' },
      ]);
    }
    expect(
      await rows(`SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1`, [A]),
    ).toEqual(before);
  });
});
