/**
 * Failed security notices API (T-0209, ADR-0097, RQ-0179). Real PostgreSQL as lf_app, real
 * sessions; the notices fail through the real dispatcher (T-0197) with a refusing sender. The
 * superuser only seeds users and inspects.
 *
 * SS-PLAT-161 (API) — GET /security-notices/failed lists the tenant's failed notices for holders
 *   of security_notices.read (Owner, Finance Admin, Auditor); the Accountant and clerks get 403;
 *   another tenant sees none. Recipients are masked.
 * SS-PLAT-163 (API) — POST /security-notices/:kind/:id/retry needs security_notices.retry and an
 *   Idempotency-Key; 201 appends a retry request, a replay answers 200 and adds nothing, a notice
 *   that is not failed is 409, an unknown one 404; each request is audited.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { approveRemittanceAccountChange, requestRemittanceAccountChange } from '@ledgerforce/ar';
import { withTenant } from '@ledgerforce/db';
import { dispatchSecurityNotices, type EmailMessage, type EmailSender } from '@ledgerforce/email';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const TENANT = '01900000-0000-7000-8000-000000020911';
const OTHER = '01900000-0000-7000-8000-000000020912';

const refusing: EmailSender = {
  send(m: EmailMessage): Promise<string> {
    const e = new Error(`421 4.7.0 <${m.to.join(',')}> try again later`) as Error & {
      code: string;
      responseCode: number;
    };
    e.code = 'EENVELOPE';
    e.responseCode = 421;
    return Promise.reject(e);
  },
};
const accepting: EmailSender = { send: () => Promise.resolve('<ok@sink.test>') };

let f: LedgerFixture;
let api: Api;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; tenant: string; role: string }> = {
  owner: { id: randomUUID(), tenant: TENANT, role: 'owner' },
  fa: { id: randomUUID(), tenant: TENANT, role: 'finance_admin' },
  auditor: { id: randomUUID(), tenant: TENANT, role: 'auditor' },
  accountant: { id: randomUUID(), tenant: TENANT, role: 'accountant' },
  clerk: { id: randomUUID(), tenant: TENANT, role: 'ap_clerk' },
  ownerB: { id: randomUUID(), tenant: OTHER, role: 'owner' },
};

function call(
  method: string,
  path: string,
  who: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin', ...headers };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  return fetch(`${api.url}${path}`, { method, headers: h });
}

interface Item {
  kind: string;
  id: string;
  context: string;
  account_last3: string | null;
  recipient: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string;
  last_smtp_code: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: string;
  retry_requested: boolean;
}

let failedIds: string[] = [];
let sentId = '';

async function bankAccount(companyId: string, glAccountId: string, last3: string) {
  const id = randomUUID();
  await f.inTenant((trx) =>
    trx
      .insertInto('app.bank_account')
      .values({
        id,
        company_id: companyId,
        gl_account_id: glAccountId,
        name: `Account ${last3}`,
        currency: 'AUD',
        bsb: '062-000',
        account_name: 'Harbour',
        account_number_last3: last3,
        account_number_ct: randomBytes(8),
        account_number_iv: randomBytes(12),
        account_number_tag: randomBytes(16),
        dek_wrapped: randomBytes(60),
        kek_id: 'k1',
        enc_version: 1,
      })
      .execute(),
  );
  return id;
}

async function change(bankAccountId: string): Promise<string> {
  const changeId = randomUUID();
  const companyId = f.companyId;
  await f.inTenant((trx) =>
    requestRemittanceAccountChange(trx, {
      companyId,
      changeId,
      bankAccountId,
      requestedBy: people.fa?.id ?? '',
    }),
  );
  await f.inTenant((trx) =>
    approveRemittanceAccountChange(trx, {
      companyId,
      changeId,
      approvedBy: people.owner?.id ?? '',
    }),
  );
  return changeId;
}

const noticeIds = async (changeId: string) =>
  (
    await f.admin.query<{ id: string }>(
      `SELECT id FROM app.remittance_account_notice WHERE change_id = $1 ORDER BY id`,
      [changeId],
    )
  ).rows.map((r) => r.id);

const audits = async (noticeId: string) =>
  (
    await f.admin.query<{ action: string; actor_user_id: string; after: Record<string, unknown> }>(
      `SELECT action, actor_user_id, after FROM audit.audit_log
        WHERE entity_type = 'security_notice_retry' AND entity_id = $1 ORDER BY id`,
      [noticeId],
    )
  ).rows;

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Other Pty Ltd')`, [OTHER]);
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, p.tenant, `${who.toLowerCase()}@notices.test`, who],
    );
    await f.admin.query(
      'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [p.tenant, p.id, p.role],
    );
  }
  const a1 = await bankAccount(f.companyId, f.acct['1010'] ?? '', '678');
  const a2 = await bankAccount(f.companyId, f.acct['1020'] ?? '', '321');
  const sentChange = await change(a1);
  await dispatchSecurityNotices(f.db, f.tenantId, { sender: accepting, now: new Date() });
  sentId = (await noticeIds(sentChange))[0] ?? '';
  const failedChange = await change(a2);
  const t0 = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await dispatchSecurityNotices(f.db, f.tenantId, {
      sender: refusing,
      now: new Date(t0 + i * 10 * 60 * 1000),
    });
  }
  failedIds = await noticeIds(failedChange);
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  for (const [who, p] of Object.entries(people)) {
    if (!api.sessions) throw new Error('sessions not configured');
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
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-161: failed security notices are listed for administrators of their tenant', () => {
  it('SS-PLAT-161 Owner, Finance Admin and Auditor see the failed notices with attempts, SMTP code and next attempt [T-0209]', async () => {
    for (const who of ['owner', 'fa', 'auditor']) {
      const res = await call('GET', '/security-notices/failed', who);
      expect(res.status, who).toBe(200);
      const body = (await res.json()) as { notices: Item[] };
      expect(body.notices.map((n) => n.id).sort()).toEqual([...failedIds].sort());
      for (const n of body.notices) {
        expect(n).toMatchObject({
          kind: 'remittance_account_changed',
          context: 'Harbour & Co Pty Ltd',
          account_last3: '321',
          attempts: 3,
          last_smtp_code: 421,
          last_error_code: 'EENVELOPE',
          retry_requested: false,
        });
        expect(n.recipient).toMatch(/^[a-z]•••@notices\.test$/);
        expect(Date.parse(n.next_attempt_at)).toBeGreaterThan(Date.parse(n.last_attempt_at));
      }
      expect(JSON.stringify(body)).not.toMatch(/(owner|fa)@notices\.test/);
    }
  });

  it('SS-PLAT-161 the Accountant and a clerk are refused; another tenant sees none [T-0209]', async () => {
    for (const who of ['accountant', 'clerk']) {
      expect((await call('GET', '/security-notices/failed', who)).status, who).toBe(403);
    }
    const other = await call('GET', '/security-notices/failed', 'ownerB');
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ notices: [] });
  });
});

describe('SS-PLAT-163: retry-now over HTTP is keyed, idempotent by state and audited', () => {
  const path = (id: string) => `/security-notices/remittance_account_changed/${id}/retry`;

  it('SS-PLAT-163 needs security_notices.retry and an Idempotency-Key [T-0209]', async () => {
    const id = failedIds[0] ?? '';
    for (const who of ['auditor', 'accountant']) {
      expect((await call('POST', path(id), who, { 'idempotency-key': 'k1' })).status, who).toBe(
        403,
      );
    }
    const res = await call('POST', path(id), 'fa');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'idempotency_key_required' });
    expect(await audits(id)).toEqual([]);
  });

  it('SS-PLAT-163 201 appends the request; a replay answers 200 and adds nothing; each call audited [T-0209]', async () => {
    const id = failedIds[0] ?? '';
    const first = await call('POST', path(id), 'fa', { 'idempotency-key': `retry-${id}-1` });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id, attempts: 3, retry_requested: true });
    const again = await call('POST', path(id), 'owner', { 'idempotency-key': `retry-${id}-2` });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, retry_requested: true });
    const rows = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.security_notice_retry WHERE remittance_notice_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(1);
    expect(await audits(id)).toEqual([
      {
        action: 'POST /security-notices/:kind/:id/retry',
        actor_user_id: people.fa?.id,
        after: expect.objectContaining({
          after_attempt: 3,
          kind: 'remittance_account_changed',
          created: true,
        }) as unknown,
      },
      {
        action: 'POST /security-notices/:kind/:id/retry',
        actor_user_id: people.owner?.id,
        after: expect.objectContaining({ after_attempt: 3, created: false }) as unknown,
      },
    ]);
    const list = (await (await call('GET', '/security-notices/failed', 'fa')).json()) as {
      notices: Item[];
    };
    expect(list.notices.find((n) => n.id === id)?.retry_requested).toBe(true);
  });

  it('SS-PLAT-163 a sent notice is 409, an unknown or other-tenant one 404, a bad kind 404 [T-0209]', async () => {
    const key = { 'idempotency-key': 'k-x' };
    const sent = await call('POST', path(sentId), 'owner', key);
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ error: 'security_notice_not_failed' });
    expect((await call('POST', path(randomUUID()), 'owner', key)).status).toBe(404);
    expect((await call('POST', path(failedIds[1] ?? ''), 'ownerB', key)).status).toBe(404);
    expect(
      (await call('POST', `/security-notices/nope/${failedIds[1] ?? ''}/retry`, 'owner', key))
        .status,
    ).toBe(404);
    expect((await call('POST', path('not-a-uuid'), 'owner', key)).status).toBe(404);
  });

  it('SS-PLAT-163 tenants never see each other: the other tenant cannot list or retry here [T-0209]', async () => {
    const seen = await withTenant(f.db, OTHER, (trx) =>
      trx.selectFrom('app.security_notice_delivery').select('id').execute(),
    );
    expect(seen).toEqual([]);
  });
});
