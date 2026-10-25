/**
 * SS-PLAT-80 (API part) — GET /audit-log (T-0093, ADR-0034, RQ-0038): read-only, needs
 * audit_log.read, reads through audit.read_log (migration 0029), filters by actor, action,
 * entity and calendar dates in the tenant's report time zone, newest first, keyset pages with an
 * exact "more" signal. Real sessions, real database, lf_app only.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-000000093c0a';
const B = '01900000-0000-7000-8000-000000093c0b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = id(0x93c1);
const FA = id(0x93c2);
const AUDITOR = id(0x93c3);
const CLERK = id(0x93c4);
const OWNER_B = id(0x93cb);

interface Entry {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  api_token_id: string | null;
}
interface Page {
  entries: Entry[];
  next_before: string | null;
}

let tdb: TestDatabase;
let api: Api;
const cookies = new Map<string, string>();

function call(path: string, who?: string, method = 'GET'): Promise<Response> {
  const c = who === undefined ? undefined : cookies.get(who);
  return fetch(`${api.url}${path}`, {
    method,
    headers: c === undefined ? {} : { cookie: `lf_session=${c}` },
  });
}
async function page(query: string, who = OWNER): Promise<Page> {
  const res = await call(`/audit-log${query}`, who);
  expect(res.status, query).toBe(200);
  return (await res.json()) as Page;
}
/** Only this file's seeded rows (entity type `test_doc`), whatever else the setup audited. */
const actions = async (query: string) =>
  (await page(`?entity_type=test_doc${query}`)).entries.map((e) => e.action);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  const people: [string, string, string[]][] = [
    [A, OWNER, ['owner']],
    [A, FA, ['finance_admin']],
    [A, AUDITOR, ['auditor']],
    [A, CLERK, ['ar_clerk']],
    [B, OWNER_B, ['owner']],
  ];
  for (const tenant of [A, B]) {
    await withTenant(seed, tenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: tenant, name: `T ${tenant}` })
        .execute();
      for (const [t, u, roles] of people) {
        if (t !== tenant) continue;
        await trx
          .insertInto('app.app_user')
          .values({ id: u, email: `${u}@audit.test`, display_name: 'U', status: 'active' })
          .execute();
        for (const role of roles) {
          await trx.insertInto('app.user_role').values({ user_id: u, role }).execute();
        }
      }
    });
  }
  await seed.destroy();
  // Tenant A's report time zone is the default, Australia/Sydney (UTC+11 in late October).
  const rows: [string, string, string, string, string][] = [
    [A, '2026-10-20T03:00:00Z', OWNER, 'doc.created', 'D-1'],
    [A, '2026-10-21T03:00:00Z', FA, 'doc.approved', 'D-1'],
    // 22 Oct 00:30 in Sydney, still 21 Oct in UTC.
    [A, '2026-10-21T13:30:00Z', OWNER, 'POST /docs/:id/void', 'D-2'],
    [A, '2026-10-22T03:00:00Z', CLERK, 'doc.created', 'D-3'],
    // 24 Oct 10:30 in Sydney.
    [A, '2026-10-23T23:30:00Z', OWNER, 'doc.approved', 'D-3'],
    [B, '2026-10-22T03:00:00Z', OWNER_B, 'doc.created', 'B-1'],
  ];
  for (const [t, at, actor, action, eid] of rows) {
    await tdb.admin.query(
      `INSERT INTO audit.audit_log (tenant_id, occurred_at, actor_type, actor_user_id, action,
                                    entity_type, entity_id, before, after, ip, user_agent, request_id)
       VALUES ($1, $2, 'user', $3, $4, 'test_doc', $5, '{"status":"draft"}', '{"status":"approved"}',
               '198.51.100.7', 'Firefox', 'req-9')`,
      [t, at, actor, action, eid],
    );
  }
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
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
  await (tdb as TestDatabase | undefined)?.close();
});

describe('SS-PLAT-80: GET /audit-log reads the tenant audit trail, read-only', () => {
  it("returns the tenant's rows newest first with every field, and none of another tenant's", async () => {
    const p = await page('?entity_type=test_doc');
    expect(p.entries.map((e) => [e.action, e.entity_id])).toEqual([
      ['doc.approved', 'D-3'],
      ['doc.created', 'D-3'],
      ['POST /docs/:id/void', 'D-2'],
      ['doc.approved', 'D-1'],
      ['doc.created', 'D-1'],
    ]);
    expect(p.next_before).toBeNull();
    expect(p.entries[0]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      occurred_at: '2026-10-23T23:30:00.000Z',
      actor_type: 'user',
      actor_user_id: OWNER,
      action: 'doc.approved',
      entity_type: 'test_doc',
      entity_id: 'D-3',
      before: { status: 'draft' },
      after: { status: 'approved' },
      ip: '198.51.100.7',
      user_agent: 'Firefox',
      request_id: 'req-9',
      api_token_id: null,
    });
    const b = await page('?entity_type=test_doc', OWNER_B);
    expect(b.entries.map((e) => e.entity_id)).toEqual(['B-1']);
  });

  it('keyset pages: limit and before, with next_before null exactly on the last page', async () => {
    const all = (await page('?entity_type=test_doc')).entries.map((e) => e.id);
    const p1 = await page('?entity_type=test_doc&limit=2');
    expect(p1.entries.map((e) => e.id)).toEqual(all.slice(0, 2));
    expect(p1.next_before).toBe(all[1]);
    const p2 = await page(`?entity_type=test_doc&limit=2&before=${p1.next_before ?? ''}`);
    expect(p2.entries.map((e) => e.id)).toEqual(all.slice(2, 4));
    expect(p2.next_before).toBe(all[3]);
    const p3 = await page(`?entity_type=test_doc&limit=2&before=${p2.next_before ?? ''}`);
    expect(p3.entries.map((e) => e.id)).toEqual(all.slice(4));
    expect(p3.next_before).toBeNull();
    // Exactly a full last page: no phantom "older entries".
    const full = await page(`?entity_type=test_doc&limit=5`);
    expect(full.entries).toHaveLength(5);
    expect(full.next_before).toBeNull();
  });

  it('filters by actor, action (case-insensitive part), entity id and dates in the report time zone', async () => {
    expect(await actions(`&actor=${FA}`)).toEqual(['doc.approved']);
    expect(await actions('&action=APPROVED')).toEqual(['doc.approved', 'doc.approved']);
    expect(await actions('&entity_id=D-1')).toEqual(['doc.approved', 'doc.created']);
    // 22 Oct in Sydney starts at 21 Oct 13:00 UTC: the void at 13:30 UTC is on the 22nd.
    expect(await actions('&from=2026-10-22&to=2026-10-22')).toEqual([
      'doc.created',
      'POST /docs/:id/void',
    ]);
    // `to` is inclusive of that whole day: 24 Oct 10:30 Sydney.
    expect(await actions('&from=2026-10-24&to=2026-10-24')).toEqual(['doc.approved']);
    expect(await actions('&to=2026-10-21')).toEqual(['doc.approved', 'doc.created']);
    expect(await actions(`&actor=${OWNER}&from=2026-10-21`)).toEqual([
      'doc.approved',
      'POST /docs/:id/void',
    ]);
  });

  it('the Finance Admin and the Auditor may read; a clerk gets 403; no session gets 401', async () => {
    expect((await page('?entity_type=test_doc', FA)).entries).toHaveLength(5);
    expect((await page('?entity_type=test_doc', AUDITOR)).entries).toHaveLength(5);
    const denied = await call('/audit-log', CLERK);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', permission: 'audit_log.read' });
    expect((await call('/audit-log')).status).toBe(401);
  });

  it('refuses malformed filters with 400 invalid_filter', async () => {
    for (const q of [
      '?actor=not-a-uuid',
      '?from=2026-13-01',
      '?to=2026-02-30',
      '?from=2026-10-23&to=2026-10-22',
      '?before=12a',
      '?before=0',
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      `?action=${'x'.repeat(201)}`,
      `?entity_type=${'x'.repeat(101)}`,
      `?entity_id=${'x'.repeat(201)}`,
    ]) {
      const res = await call(`/audit-log${q}`, OWNER);
      expect(res.status, q).toBe(400);
      expect(await res.json(), q).toEqual({ error: 'invalid_filter' });
    }
  });

  it('nothing can change it: no write method exists on /audit-log', async () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call('/audit-log', OWNER, m)).status, m).toBe(404);
    }
  });
});
