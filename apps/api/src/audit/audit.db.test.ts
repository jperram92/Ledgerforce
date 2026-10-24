/**
 * SS-PLAT-30 — every successful API mutation leaves one audit row (T-0014, design §6.8).
 * lf_app can only INSERT into audit.audit_log, so the test reads rows as the superuser.
 */
import 'reflect-metadata';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000002aa';
const USER = '01900000-0000-7000-8000-00000000c001';

let tdb: TestDatabase;
let api: Api;

function login(): Promise<string> {
  if (!api.sessions) throw new Error('createApi did not configure sessions');
  return api.sessions.create(A, { userId: USER, amr: [], acr: null });
}

interface AuditRow {
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
  tenant_id: string;
}

async function auditRows(): Promise<AuditRow[]> {
  const r = await tdb.admin.query<AuditRow>(
    'SELECT tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, before, after, host(ip) AS ip, user_agent, request_id FROM audit.audit_log ORDER BY id',
  );
  return r.rows;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  const seed = createDb(tdb.url('lf_app'), 1);
  await withTenant(seed, A, async (trx) => {
    await trx.insertInto('app.tenant').values({ id: A, name: 'Harbour & Co Pty Ltd' }).execute();
    await trx
      .insertInto('app.app_user')
      .values({
        id: USER,
        email: 'priya@harbour.example',
        display_name: 'Priya Shah',
        status: 'active',
      })
      .execute();
  });
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
});

afterAll(async () => {
  await api.close();
  await tdb.close();
});

describe('SS-PLAT-30: Every successful API mutation leaves one audit row', () => {
  it('a successful mutation writes exactly one row with actor, action, ip, user agent and request id', async () => {
    const before = (await auditRows()).length;
    const cookie = await login();
    const res = await fetch(`${api.url}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `lf_session=${cookie}`,
        'user-agent': 'ledgerforce-test/1.0',
        'x-request-id': 'req-123e4567',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-request-id')).toBe('req-123e4567');
    const rows = await auditRows();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({
      tenant_id: A,
      actor_type: 'user',
      actor_user_id: USER,
      action: 'POST /auth/logout',
      entity_type: 'session',
      ip: '127.0.0.1',
      user_agent: 'ledgerforce-test/1.0',
      request_id: 'req-123e4567',
    });
  });

  it('the handler-supplied entity and before/after are recorded', async () => {
    const cookie = await login();
    const sessionId = cookie.split('.')[1];
    await fetch(`${api.url}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `lf_session=${cookie}` },
    });
    const row = (await auditRows()).at(-1);
    expect(row).toMatchObject({ entity_type: 'session', entity_id: sessionId });
    expect(row?.before).toMatchObject({ revoked: false });
    expect(row?.after).toMatchObject({ revoked: true, reason: 'logout' });
  });

  it('generates a request id when the client sends none, and echoes it', async () => {
    const cookie = await login();
    const res = await fetch(`${api.url}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `lf_session=${cookie}` },
    });
    const rid = res.headers.get('x-request-id');
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);
    expect((await auditRows()).at(-1)?.request_id).toBe(rid);
  });

  it('reads and refused requests write no audit rows', async () => {
    const before = (await auditRows()).length;
    const cookie = await login();
    expect(
      (await fetch(`${api.url}/auth/me`, { headers: { cookie: `lf_session=${cookie}` } })).status,
    ).toBe(200);
    expect((await fetch(`${api.url}/auth/logout`, { method: 'POST' })).status).toBe(401);
    expect((await auditRows()).length).toBe(before);
  });
});
