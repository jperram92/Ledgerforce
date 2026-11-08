/**
 * Sync issues inbox API (T-0071, design §5.6 rule 2, ADR-0040, migration 0030). Real sessions,
 * real database, lf_app only; the one-click retry sends a real pg-boss job (outbox harness).
 *
 * SS-PLAT-25 (API part) — GET /sync-issues lists the tenant's issues with error, attempts and
 *   payload reference; GET /sync-issues/:id adds the payload; POST /sync-issues/:id/retry
 *   re-queues the delivery and marks the issue retried, idempotently.
 * SS-PLAT-91 (API part) — POST /sync-issues/:id/ignore parks an issue with a note; a resolved
 *   issue cannot be retried or ignored (409); every action is audited; who may act is the
 *   catalogue's sync.issues.manage; other tenants' issues are 404.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { bossRequeue, OUTBOX_QUEUE } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-00000007a10a';
const B = '01900000-0000-7000-8000-00000007a10b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ACCOUNTANT = id(0x7a11);
const AUDITOR = id(0x7a12);
const CLERK = id(0x7a13);
const OWNER_B = id(0x7a1b);

interface IssueView {
  id: string;
  company_id: string | null;
  event_id: string;
  handler: string;
  connector: string;
  status: string;
  attempts: number;
  error: {
    name: string;
    kind: string | null;
    code: string | null;
    http_status: number | null;
    retryable: boolean;
    message: string;
  };
  payload_ref: { topic: string; aggregate_type: string; aggregate_id: string };
  retry_job_id: string | null;
  note: string | null;
  status_changed_by: string | null;
  status_changed_at: string;
  first_failed_at: string;
  last_failed_at: string;
  payload?: unknown;
}

let tdb: TestDatabase;
let h: OutboxHarness;
let api: Api;
const cookies = new Map<string, string>();

function call(path: string, who?: string, method = 'GET', body?: unknown): Promise<Response> {
  const c = who === undefined ? undefined : cookies.get(who);
  return fetch(`${api.url}${path}`, {
    method,
    headers: {
      ...(c === undefined ? {} : { cookie: `lf_session=${c}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An outbox event and its dead-lettered Sync issue, seeded as the superuser. */
async function seedIssue(
  tenant: string,
  opts: { status?: string; lastFailedAt?: string } = {},
): Promise<{ issueId: string; eventId: string; aggregateId: string }> {
  const eventId = randomUUID();
  const aggregateId = randomUUID();
  await tdb.admin.query(
    `INSERT INTO app.outbox_event (id, tenant_id, topic, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, 'invoice.posted', 'sales_invoice', $3, $4)`,
    [eventId, tenant, aggregateId, JSON.stringify({ writeBack: { version: 1, invoices: [] } })],
  );
  const { rows } = await tdb.admin.query<{ id: string }>(
    `INSERT INTO app.sync_issue (tenant_id, event_id, handler, connector, status, attempts,
                                 error_name, error_kind, error_code, http_status, retryable,
                                 error_message, dead_letter_job_id, retry_job_id, last_failed_at)
     VALUES ($1, $2, 'salesforce.writeback', 'salesforce', $3, 11, 'SalesforceApiError',
             'unavailable', 'SERVER_UNAVAILABLE', 503, true,
             'salesforce write-back failed (unavailable 503 SERVER_UNAVAILABLE): Server unavailable',
             $4, CASE WHEN $3 IN ('retried', 'resolved') THEN $5::uuid END, $6)
     RETURNING id`,
    [
      tenant,
      eventId,
      opts.status ?? 'open',
      randomUUID(),
      randomUUID(),
      opts.lastFailedAt ?? new Date().toISOString(),
    ],
  );
  return { issueId: rows[0]?.id ?? '', eventId, aggregateId };
}

const audits = async (issueId: string) =>
  (
    await tdb.admin.query<{ action: string; actor_user_id: string; after: { status: string } }>(
      `SELECT action, actor_user_id, after FROM audit.audit_log
        WHERE entity_type = 'sync_issue' AND entity_id = $1 ORDER BY id`,
      [issueId],
    )
  ).rows;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  h = await createOutboxHarness(tdb);
  const seed = createDb(tdb.url('lf_app'), 1);
  const people: [string, string, string][] = [
    [A, ACCOUNTANT, 'accountant'],
    [A, AUDITOR, 'auditor'],
    [A, CLERK, 'ar_clerk'],
    [B, OWNER_B, 'owner'],
  ];
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, role] of people) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({ id: u, email: `${u}@sync.test`, display_name: 'U', status: 'active' })
          .execute();
        await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
      }
    });
  }
  await seed.destroy();
  const boss = await h.startRuntime();
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    syncRequeue: bossRequeue(boss),
  });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [t, u] of people) {
    cookies.set(
      u,
      await api.sessions.create(t, {
        userId: u,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }),
    );
  }
});

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (h as OutboxHarness | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-PLAT-25 Sync issues API', () => {
  it('SS-PLAT-25 GET /sync-issues lists the open issues with error, attempts and payload reference', async () => {
    const older = await seedIssue(A, { lastFailedAt: '2026-10-25T01:00:00Z' });
    const newer = await seedIssue(A, { lastFailedAt: '2026-10-25T02:00:00Z' });
    await seedIssue(B);
    const res = await call('/sync-issues?status=open', ACCOUNTANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: IssueView[]; next_after: string | null };
    const mine = body.issues.filter((i) => [older.issueId, newer.issueId].includes(i.id));
    expect(mine.map((i) => i.id)).toEqual([newer.issueId, older.issueId]); // newest failure first
    expect(body.issues.every((i) => i.status === 'open')).toBe(true);
    expect(mine[0]).toEqual({
      id: newer.issueId,
      company_id: null,
      event_id: newer.eventId,
      handler: 'salesforce.writeback',
      connector: 'salesforce',
      status: 'open',
      attempts: 11,
      error: {
        name: 'SalesforceApiError',
        kind: 'unavailable',
        code: 'SERVER_UNAVAILABLE',
        http_status: 503,
        retryable: true,
        message:
          'salesforce write-back failed (unavailable 503 SERVER_UNAVAILABLE): Server unavailable',
      },
      payload_ref: {
        topic: 'invoice.posted',
        aggregate_type: 'sales_invoice',
        aggregate_id: newer.aggregateId,
      },
      retry_job_id: null,
      note: null,
      status_changed_by: null,
      status_changed_at: expect.any(String) as string,
      first_failed_at: expect.any(String) as string,
      last_failed_at: '2026-10-25T02:00:00.000Z',
    });
    // Another tenant sees none of these.
    const b = (await (await call('/sync-issues', OWNER_B)).json()) as { issues: IssueView[] };
    expect(b.issues.some((i) => [older.issueId, newer.issueId].includes(i.id))).toBe(false);
    // Keyset paging.
    const p1 = (await (await call('/sync-issues?limit=1', ACCOUNTANT)).json()) as {
      issues: IssueView[];
      next_after: string | null;
    };
    expect(p1.issues).toHaveLength(1);
    expect(p1.next_after).toBe(p1.issues[0]?.id);
    const p2 = (await (
      await call(`/sync-issues?limit=1&after=${p1.next_after ?? ''}`, ACCOUNTANT)
    ).json()) as { issues: IssueView[] };
    expect(p2.issues[0]?.id).not.toBe(p1.issues[0]?.id);
    expect((await call('/sync-issues?status=lost', ACCOUNTANT)).status).toBe(400);
  });

  it('SS-PLAT-25 GET /sync-issues/:id shows the payload; another tenant gets 404', async () => {
    const s = await seedIssue(A);
    const res = await call(`/sync-issues/${s.issueId}`, AUDITOR);
    expect(res.status).toBe(200);
    expect(((await res.json()) as IssueView).payload).toEqual({
      writeBack: { version: 1, invoices: [] },
    });
    expect((await call(`/sync-issues/${s.issueId}`, OWNER_B)).status).toBe(404);
    expect((await call('/sync-issues/not-a-uuid', ACCOUNTANT)).status).toBe(404);
  });

  it('SS-PLAT-25 POST /sync-issues/:id/retry re-queues the delivery once and is audited', async () => {
    const s = await seedIssue(A);
    const res = await call(`/sync-issues/${s.issueId}/retry`, ACCOUNTANT, 'POST');
    expect(res.status).toBe(200);
    const v = (await res.json()) as IssueView;
    expect(v).toMatchObject({ status: 'retried', status_changed_by: ACCOUNTANT });
    const job = await h.owner.getJobById(OUTBOX_QUEUE, v.retry_job_id ?? '');
    expect(job).toMatchObject({ state: 'created', data: { tenantId: A, eventId: s.eventId } });
    // Replay: the same answer, no second job.
    const again = (await (
      await call(`/sync-issues/${s.issueId}/retry`, ACCOUNTANT, 'POST')
    ).json()) as IssueView;
    expect(again.retry_job_id).toBe(v.retry_job_id);
    expect(await h.owner.findJobs(OUTBOX_QUEUE, { data: { eventId: s.eventId } })).toHaveLength(1);
    expect(await audits(s.issueId)).toEqual([
      {
        action: 'POST /sync-issues/:id/retry',
        actor_user_id: ACCOUNTANT,
        after: expect.objectContaining({ status: 'retried' }) as unknown,
      },
      {
        action: 'POST /sync-issues/:id/retry',
        actor_user_id: ACCOUNTANT,
        after: expect.objectContaining({ status: 'retried' }) as unknown,
      },
    ]);
    // Another tenant cannot touch it.
    expect((await call(`/sync-issues/${s.issueId}/retry`, OWNER_B, 'POST')).status).toBe(404);
  });
});

describe('SS-PLAT-91 Sync issues API: ignore, refusals, permissions', () => {
  it('SS-PLAT-91 POST /sync-issues/:id/ignore parks an issue with a note', async () => {
    const s = await seedIssue(A);
    const res = await call(`/sync-issues/${s.issueId}/ignore`, ACCOUNTANT, 'POST', {
      note: 'record deleted in Salesforce',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ignored',
      note: 'record deleted in Salesforce',
      status_changed_by: ACCOUNTANT,
    });
    expect((await audits(s.issueId)).map((a) => a.action)).toEqual([
      'POST /sync-issues/:id/ignore',
    ]);
    expect(
      (await call(`/sync-issues/${s.issueId}/ignore`, ACCOUNTANT, 'POST', { note: 7 })).status,
    ).toBe(400);
  });

  it('SS-PLAT-91 a resolved issue can be neither retried nor ignored (409)', async () => {
    const s = await seedIssue(A, { status: 'resolved' });
    const r = await call(`/sync-issues/${s.issueId}/retry`, ACCOUNTANT, 'POST');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'sync_issue_not_retryable' });
    const i = await call(`/sync-issues/${s.issueId}/ignore`, ACCOUNTANT, 'POST', {});
    expect(i.status).toBe(409);
    expect(await i.json()).toEqual({ error: 'sync_issue_not_ignorable' });
  });

  it('SS-PLAT-91 the Auditor may read but not act; a clerk may not read; no session is 401', async () => {
    const s = await seedIssue(A);
    expect((await call('/sync-issues', AUDITOR)).status).toBe(200);
    const denied = await call(`/sync-issues/${s.issueId}/retry`, AUDITOR, 'POST');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', permission: 'sync.issues.manage' });
    expect((await call('/sync-issues', CLERK)).status).toBe(403);
    expect((await call('/sync-issues')).status).toBe(401);
    expect(
      (await tdb.admin.query(`SELECT status FROM app.sync_issue WHERE id = $1`, [s.issueId]))
        .rows[0],
    ).toEqual({ status: 'open' });
  });
});
