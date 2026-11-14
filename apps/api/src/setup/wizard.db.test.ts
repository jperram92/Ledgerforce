/**
 * Setup wizard over HTTP (T-0157, SS-PLAT-120, ADR-0067 rule 6, ADR-0072, ADR-0075) against a real
 * PostgreSQL as lf_app.
 * - `GET /setup/wizard?company_id=` returns the ten derived steps and `complete` (settings.read).
 * - `POST /setup/wizard/steps/:n/complete {company_id, as_of?, no_history_reason?}` needs
 *   settings.setup.manage and an Idempotency-Key; 201 new (audited), 200 replay, 409 STEP_LOCKED,
 *   422 STEP_INVALID with `missing`, 422 NO_HISTORY_NOT_ALLOWED; step 9 takes a no-history reason.
 * - Another tenant's company is 404 on both routes.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateFiscalYear } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const AS_OF = '2026-11-14';
const VALID_ABN = '51824753556';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let c = ''; // a new, empty company walked through the wizard
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  owner: { id: randomUUID(), roles: ['owner'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
  clerk: { id: randomUUID(), roles: ['ar_clerk'] },
};

interface StepBody {
  step: number;
  title: string;
  status: string;
  locked: boolean;
  valid: boolean;
  missing: string[];
  outcome: string | null;
  reason: string | null;
  completed_at: string | null;
  completed_by: string | null;
  replayed?: boolean;
}

function call(
  method: string,
  path: string,
  who: string,
  init: { key?: string; body?: unknown } = {},
) {
  const h: Record<string, string> = {};
  const cookie = cookies.get(who);
  if (cookie) h.cookie = `lf_session=${cookie}`;
  if (init.body !== undefined) h['content-type'] = 'application/json';
  if (init.key) h['idempotency-key'] = init.key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const read = (who = 'fa', company = c, asOf: string | null = AS_OF) =>
  call('GET', `/setup/wizard?company_id=${company}${asOf === null ? '' : `&as_of=${asOf}`}`, who);
const complete = (
  step: number | string,
  who = 'fa',
  extra: Record<string, unknown> = {},
  key: string | null = `k-${String(step)}-${who}-${randomUUID()}`,
) =>
  call('POST', `/setup/wizard/steps/${String(step)}/complete`, who, {
    ...(key === null ? {} : { key }),
    body: { company_id: c, as_of: AS_OF, ...extra },
  });
const records = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.setup_wizard_step WHERE company_id = $1',
      [c],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000015701');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000015702');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@wizard.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  c = await f.inTenant(async (trx) => {
    const row = await trx
      .insertInto('app.company')
      .values({ name: 'Bay Street Studio', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
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
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-120: the setup wizard over HTTP', () => {
  it('SS-PLAT-120 AC-1 GET /setup/wizard returns the ten steps (status, locked, valid, missing) and complete [T-0157]', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    const w = (await r.json()) as { company_id: string; complete: boolean; steps: StepBody[] };
    expect(w.company_id).toBe(c);
    expect(w.complete).toBe(false);
    expect(w.steps.map((s) => [s.step, s.status, s.locked])).toEqual([
      [1, 'in_progress', false],
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, 'not_started', true]),
    ]);
    expect(w.steps[0]).toEqual({
      step: 1,
      title: 'Company details',
      status: 'in_progress',
      locked: false,
      valid: false,
      missing: [
        'The legal name is missing',
        'The ABN is missing',
        'No fiscal year has been set up (fiscal year start)',
      ],
      outcome: null,
      reason: null,
      completed_at: null,
      completed_by: null,
    });
    // as_of defaults to today in the tenant's report time zone.
    const today = await read('fa', c, null);
    expect(today.status).toBe(200);
    expect(((await today.json()) as { steps: unknown[] }).steps).toHaveLength(10);
    expect((await read('fa', c, '14/11/2026')).status).toBe(400);
    expect((await read('fa', 'not-a-uuid')).status).toBe(400);
  });

  it('SS-PLAT-120 AC-3 reading needs settings.read; completing needs settings.setup.manage (403 otherwise) [T-0157]', async () => {
    expect((await read('accountant')).status).toBe(200);
    const clerkRead = await read('clerk');
    expect(clerkRead.status).toBe(403);
    expect(await clerkRead.json()).toMatchObject({ permission: 'settings.read' });
    // The Accountant may read the wizard but not complete a step.
    const denied = await complete(1, 'accountant');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: 'forbidden',
      permission: 'settings.setup.manage',
    });
    expect(await records()).toBe(0);
  });

  it('SS-PLAT-120 AC-2 a locked step is 409 STEP_LOCKED; an invalid one 422 STEP_INVALID with missing; nothing is written [T-0157]', async () => {
    const locked = await complete(2);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({
      error: 'STEP_LOCKED',
      message: 'step 2 is locked: complete step 1 (Company details) first',
    });
    const invalid = await complete(1);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: 'STEP_INVALID',
      missing: [
        'The legal name is missing',
        'The ABN is missing',
        'No fiscal year has been set up (fiscal year start)',
      ],
    });
    expect(await records()).toBe(0);
  });

  it('SS-PLAT-120 AC-2 bad requests are 400: no Idempotency-Key, a step outside 1–10, a bad body [T-0157]', async () => {
    const noKey = await complete(1, 'fa', {}, null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: 'idempotency_key_required' });
    for (const step of ['0', '11', 'one', '1.5']) {
      expect((await complete(step)).status).toBe(400);
    }
    expect((await complete(1, 'fa', { company_id: 'nope' })).status).toBe(400);
    expect((await complete(1, 'fa', { as_of: '2026-13-45x' })).status).toBe(400);
    expect((await complete(1, 'fa', { no_history_reason: 42 })).status).toBe(400);
    expect(await records()).toBe(0);
  });

  it('SS-PLAT-120 AC-2 completes a valid unlocked step once: 201 audited, then 200 replay; step 2 unlocks [T-0157]', async () => {
    await f.inTenant(async (trx) => {
      await trx
        .updateTable('app.company')
        .set({ legal_name: 'Bay Street Studio Pty Ltd', abn: VALID_ABN })
        .where('id', '=', c)
        .execute();
      await generateFiscalYear(trx, { companyId: c, convention: 'AU', startYear: 2026 });
    });
    const first = await complete(1, 'fa', {}, 'k-step-1');
    expect(first.status).toBe(201);
    const done = (await first.json()) as StepBody;
    expect(done).toMatchObject({
      step: 1,
      title: 'Company details',
      status: 'complete',
      valid: true,
      missing: [],
      outcome: 'validated',
      reason: null,
      completed_by: people.fa?.id,
      replayed: false,
    });
    expect(typeof done.completed_at).toBe('string');

    const audit = await f.admin.query<{ actor_user_id: string; entity_id: string; after: unknown }>(
      `SELECT actor_user_id, entity_id, after FROM audit.audit_log
        WHERE entity_type = 'setup_wizard_step' ORDER BY id`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: people.fa?.id,
      entity_id: `${c}:1`,
      after: { step: 1, outcome: 'validated', company_id: c },
    });

    const replay = await complete(1, 'fa', {}, 'k-step-1');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      step: 1,
      status: 'complete',
      completed_at: done.completed_at,
      completed_by: people.fa?.id,
      replayed: true,
    });
    expect(await records()).toBe(1);
    const auditAfter = await f.admin.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_type = 'setup_wizard_step'`,
    );
    expect(auditAfter.rows).toHaveLength(1);

    const w = (await (await read()).json()) as { steps: StepBody[] };
    expect(w.steps.slice(0, 3).map((s) => [s.step, s.status, s.locked])).toEqual([
      [1, 'complete', false],
      [2, 'in_progress', false],
      [3, 'not_started', true],
    ]);
  });

  it('SS-PLAT-120 AC-2 step 9 accepts { no_history_reason }; another step with a reason is 422 NO_HISTORY_NOT_ALLOWED [T-0157]', async () => {
    // Fixture: steps 2–8 recorded directly, so step 9 is the open step (their validators are
    // covered by SS-PLAT-119 in @ledgerforce/setup).
    for (let step = 2; step <= 8; step += 1) {
      await f.admin.query(
        `INSERT INTO app.setup_wizard_step (tenant_id, company_id, step, outcome, completed_by)
         VALUES ($1, $2, $3, 'validated', $4)`,
        [f.tenantId, c, step, people.fa?.id],
      );
    }
    const wrongStep = await complete(10, 'owner', { no_history_reason: 'New business' });
    expect(wrongStep.status).toBe(422);
    expect(await wrongStep.json()).toMatchObject({ error: 'NO_HISTORY_NOT_ALLOWED' });

    const r = await complete(9, 'owner', { no_history_reason: '  New business, no history  ' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({
      step: 9,
      title: 'Opening balances',
      status: 'complete',
      outcome: 'no_history',
      reason: 'New business, no history',
      completed_by: people.owner?.id,
      replayed: false,
    });
    const w = (await (await read('owner')).json()) as { steps: StepBody[]; complete: boolean };
    expect(w.steps[9]).toMatchObject({ step: 10, status: 'in_progress', locked: false });
    expect(w.complete).toBe(false);
  });

  it("SS-PLAT-120 AC-3 another tenant's company is 404 on both routes and nothing is written [T-0157]", async () => {
    const r = await read('fa', other.companyId);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'UNKNOWN_COMPANY' });
    const p = await complete(1, 'fa', { company_id: other.companyId });
    expect(p.status).toBe(404);
    const foreign = await other.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.setup_wizard_step WHERE company_id = $1',
      [other.companyId],
    );
    expect(foreign.rows[0]?.n).toBe(0);
  });
});
