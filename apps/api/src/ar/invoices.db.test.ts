/**
 * GET /ar/invoices, GET /ar/invoices/:id, GET /ar/invoices/:id/journal (T-0131, SS-UC01-10 data
 * layer, DL-0406) against a real PostgreSQL as lf_app: ar.read is required, money is a decimal
 * string, other tenants' invoices are not found, and "Show me the journal" writes nothing.
 * POST /ar/invoices/:id/approve (T-0132, SS-UC01-12, ADR-0073): ar.invoice.approve, the
 * SOD_INVOICE_SELF_APPROVAL rule (creator from app.sales_invoice), Idempotency-Key, replay, audit,
 * and the journal posted equals the preview and GP-001.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDraftInvoice } from '@ledgerforce/ar';
import { NO_OUTBOX } from '@ledgerforce/ledger';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let bare: Api;
let soloApi: Api;
let draftId = '';
let foreignId = '';
let ownDraftId = '';
let soloDraftId = '';
const TENANT_B = '01900000-0000-7000-8000-000000013203';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  sales: { id: randomUUID(), roles: ['sales_user'] },
  maker: { id: randomUUID(), roles: ['finance_admin'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  owner: { id: randomUUID(), roles: ['owner'] },
};
const soloId = randomUUID();
const outsiderId = randomUUID();

async function call(path: string, who: string) {
  const c = cookies.get(who);
  return fetch(`${api.url}${path}`, { headers: c ? { cookie: `lf_session=${c}` } : {} });
}

/** POST …/approve as `who`; `key` null sends no Idempotency-Key. */
async function approve(
  id: string,
  who: string,
  opts: { key?: string | null; body?: unknown; on?: Api; companyId?: string } = {},
) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (opts.key !== null) h['idempotency-key'] = opts.key ?? randomUUID();
  return fetch(
    `${(opts.on ?? api).url}/ar/invoices/${id}/approve?company_id=${opts.companyId ?? f.companyId}`,
    { method: 'POST', headers: h, body: JSON.stringify(opts.body ?? {}) },
  );
}

const seeded = new Map<LedgerFixture, Awaited<ReturnType<typeof seedBillingCompany>>>();

async function draftFor(fx: LedgerFixture, prefix: string, createdBy?: string): Promise<string> {
  const profiles = seeded.get(fx) ?? (await seedBillingCompany(fx));
  seeded.set(fx, profiles);
  const [party] = await seedBillableCustomers(fx, profiles, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return fx.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: fx.companyId,
        partyId: party ?? '',
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        ...(createdBy ? { createdBy } : {}),
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '250.00',
          },
        ],
      },
      { outbox: { publish: async () => {} } },
    );
    return d.invoiceId;
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000013101');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000013102');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@inv.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  draftId = await draftFor(f, 'Acme');
  ownDraftId = await draftFor(f, 'Maker', people['maker']?.id);
  // A second tenant in the same database, with an approver of its own (RLS isolation).
  await f.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [TENANT_B, 'Other Pty']);
  await f.admin.query(
    `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'b@inv.test', 'B', 'active')`,
    [outsiderId, TENANT_B],
  );
  await f.admin.query(
    `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'approver')`,
    [TENANT_B, outsiderId],
  );
  // A one-person business (the Owner alone) in its own database.
  await other.admin.query(
    `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'solo@inv.test', 'Solo', 'active')`,
    [soloId, other.tenantId],
  );
  await other.admin.query(
    `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [other.tenantId, soloId],
  );
  foreignId = await draftFor(other, 'Elsewhere');
  soloDraftId = await draftFor(other, 'Solo', soloId);
  const outboxes = {
    documentOutbox: { publish: async () => {} },
    postingOutbox: NO_OUTBOX,
  };
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {}, ...outboxes });
  bare = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  soloApi = await createApi({ databaseUrl: other.tdb.url('lf_app'), sessions: {}, ...outboxes });
  if (!api.sessions || !bare.sessions || !soloApi.sessions)
    throw new Error('sessions not configured');
  const signedIn = { amr: ['pwd', 'otp'], acr: null, authTime: new Date(Date.now() - 60_000) };
  cookies.set('outsider', await api.sessions.create(TENANT_B, { userId: outsiderId, ...signedIn }));
  cookies.set(
    'solo',
    await soloApi.sessions.create(other.tenantId, { userId: soloId, ...signedIn }),
  );
  cookies.set(
    'bareApprover',
    await bare.sessions.create(f.tenantId, { userId: people['approver']?.id ?? '', ...signedIn }),
  );
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
  await (soloApi as Api | undefined)?.close();
  await (bare as Api | undefined)?.close();
  await (api as Api | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0131: invoice read routes', () => {
  it('lists the company invoices for ar.read, newest first, money as decimal strings', async () => {
    const r = await call(`/ar/invoices?company_id=${f.companyId}&status=draft`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { invoices: Record<string, unknown>[] };
    // Two drafts on the same issue date: Acme's, and the one T-0132's tests approve (Maker).
    const byParty = [...body.invoices].sort((a, b) =>
      String(a['party_name']).localeCompare(String(b['party_name'])),
    );
    expect(byParty).toEqual([
      expect.objectContaining({
        id: draftId,
        invoice_no: null,
        status: 'draft',
        party_name: 'Acme 01 Pty Ltd',
        issue_date: '2026-11-05',
        due_date: '2026-11-19',
      }),
      expect.objectContaining({
        id: ownDraftId,
        invoice_no: null,
        status: 'draft',
        party_name: 'Maker 01 Pty Ltd',
        issue_date: '2026-11-05',
        due_date: '2026-11-19',
      }),
    ]);
  });

  it('shows one invoice with its lines', async () => {
    const r = await call(`/ar/invoices/${draftId}?company_id=${f.companyId}`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { lines: Record<string, unknown>[] };
    expect(body).toMatchObject({ id: draftId, status: 'draft', pricing: 'exclusive' });
    expect(body.lines).toEqual([
      expect.objectContaining({
        line_no: 1,
        description: 'Professional services',
        quantity: '1.0000',
        unit_price: '1000.0000',
      }),
      expect.objectContaining({
        line_no: 2,
        description: 'Subscription',
        quantity: '1.0000',
        unit_price: '250.0000',
      }),
    ]);
  });

  it('SS-UC01-10 "Show me the journal" returns the engine preview (GP-001 totals) and writes nothing', async () => {
    const entries = async () =>
      (
        await f.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
          [f.tenantId],
        )
      ).rows[0]?.n;
    const before = await entries();
    const r = await call(`/ar/invoices/${draftId}/journal?company_id=${f.companyId}`, 'arClerk');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      entry_date: string;
      total: string;
      lines: { debit: string; credit: string; account_name: string }[];
    };
    expect(body.entry_date).toBe('2026-11-05');
    expect(body.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['1375.0000', '0.0000'],
      ['0.0000', '1000.0000'],
      ['0.0000', '250.0000'],
      ['0.0000', '125.0000'],
    ]);
    expect(body.lines.every((l) => l.account_name.length > 0)).toBe(true);
    expect(await entries()).toBe(before);
  });

  it("refuses without ar.read (403) and hides another tenant's invoice (404)", async () => {
    expect((await call(`/ar/invoices?company_id=${f.companyId}`, 'sales')).status).toBe(403);
    expect(
      (await call(`/ar/invoices/${foreignId}?company_id=${f.companyId}`, 'arClerk')).status,
    ).toBe(404);
    expect(
      (await call(`/ar/invoices/${foreignId}/journal?company_id=${f.companyId}`, 'arClerk')).status,
    ).toBe(404);
    expect((await call(`/ar/invoices?company_id=not-a-uuid`, 'arClerk')).status).toBe(400);
  });
});

interface Approved {
  id: string;
  status: string;
  invoice_no: string | null;
  entry_id: string | null;
  gross_total: string | null;
  replayed: boolean;
}

const statusOf = async (fx: LedgerFixture, id: string) =>
  (
    await fx.admin.query<{ status: string }>('SELECT status FROM app.sales_invoice WHERE id = $1', [
      id,
    ])
  ).rows[0]?.status;
const entryCount = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
      [f.tenantId],
    )
  ).rows[0]?.n;
const auditFor = async (id: string) =>
  (
    await f.admin.query<{ action: string; actor_user_id: string | null; entity_type: string }>(
      `SELECT action, actor_user_id, entity_type FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, id],
    )
  ).rows;

describe('SS-UC01-12: approve one draft invoice over HTTP (T-0132, ADR-0073)', () => {
  it('SS-UC01-12 a user without ar.invoice.approve is refused (403) and nothing posts', async () => {
    for (const who of ['arClerk', 'sales']) {
      const r = await approve(ownDraftId, who);
      expect(r.status, who).toBe(403);
      expect(await r.json()).toEqual({ error: 'forbidden', permission: 'ar.invoice.approve' });
    }
    expect(await statusOf(f, ownDraftId)).toBe('draft');
  });

  it("SS-UC01-12 the draft's creator is refused by SOD_INVOICE_SELF_APPROVAL, audited, and the screen is told beforehand", async () => {
    const before = await call(`/ar/invoices/${ownDraftId}?company_id=${f.companyId}`, 'maker');
    expect(await before.json()).toMatchObject({
      approval: {
        allowed: false,
        rule: 'SOD_INVOICE_SELF_APPROVAL',
        small_team_exception_required: false,
      },
    });
    const r = await approve(ownDraftId, 'maker');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_INVOICE_SELF_APPROVAL',
      small_team_exception_required: false,
    });
    expect(await statusOf(f, ownDraftId)).toBe('draft');
    expect(await auditFor(ownDraftId)).toEqual([
      { action: 'sod_violation', actor_user_id: people['maker']?.id, entity_type: 'invoice' },
    ]);
    const other = await call(`/ar/invoices/${ownDraftId}?company_id=${f.companyId}`, 'approver');
    expect(await other.json()).toMatchObject({
      approval: { allowed: true, rule: null, small_team_exception_required: false },
    });
  });

  it('SS-UC01-12 without an Idempotency-Key the approval is refused (400) and nothing posts', async () => {
    const r = await approve(ownDraftId, 'approver', { key: null });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'idempotency_key_required' });
    expect(await statusOf(f, ownDraftId)).toBe('draft');
  });

  it('SS-UC01-12 another approver posts it: the journal equals the T-0131 preview and GP-001; audited', async () => {
    const preview = (await (
      await call(`/ar/invoices/${ownDraftId}/journal?company_id=${f.companyId}`, 'approver')
    ).json()) as {
      lines: {
        line_no: number;
        account_id: string;
        debit: string;
        credit: string;
        party_id: string | null;
      }[];
    };
    const r = await approve(ownDraftId, 'approver', { key: 'approve-own-1' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Approved;
    expect(body).toMatchObject({
      id: ownDraftId,
      status: 'posted',
      invoice_no: expect.stringMatching(/^INV-/),
      gross_total: '1375.0000',
      replayed: false,
    });
    const posted = await f.admin.query<{
      line_no: number;
      account_id: string;
      debit: string;
      credit: string;
      party_id: string | null;
    }>(
      `SELECT line_no, account_id::text, debit::text, credit::text, party_id::text
         FROM app.journal_line WHERE entry_id = $1 ORDER BY line_no`,
      [body.entry_id],
    );
    expect(posted.rows).toEqual(
      preview.lines.map((l) => ({
        line_no: l.line_no,
        account_id: l.account_id,
        debit: l.debit,
        credit: l.credit,
        party_id: l.party_id,
      })),
    );
    // GP-001: Dr AR 1,375.00; Cr revenue 1,000.00 and 250.00; Cr GST collected 125.00.
    expect(posted.rows.map((l) => [l.debit, l.credit])).toEqual([
      ['1375.0000', '0.0000'],
      ['0.0000', '1000.0000'],
      ['0.0000', '250.0000'],
      ['0.0000', '125.0000'],
    ]);
    const who = await f.admin.query<{ approved_by: string; created_by: string }>(
      'SELECT approved_by::text, created_by::text FROM app.sales_invoice WHERE id = $1',
      [ownDraftId],
    );
    expect(who.rows[0]).toEqual({
      approved_by: people['approver']?.id,
      created_by: people['maker']?.id,
    });
    expect((await auditFor(ownDraftId)).at(-1)).toEqual({
      action: 'POST /ar/invoices/:id/approve',
      actor_user_id: people['approver']?.id,
      entity_type: 'sales_invoice',
    });
  });

  it('SS-UC01-12 a replay by the approver answers 200 with the posted result and posts nothing more; it is audited', async () => {
    const entries = await entryCount();
    const first = await f.admin.query<{ entry_id: string; invoice_no: string }>(
      'SELECT entry_id::text, invoice_no FROM app.sales_invoice WHERE id = $1',
      [ownDraftId],
    );
    const audits = (await auditFor(ownDraftId)).length;
    const r = await approve(ownDraftId, 'approver', { key: 'approve-own-1' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      id: ownDraftId,
      status: 'posted',
      entry_id: first.rows[0]?.entry_id,
      invoice_no: first.rows[0]?.invoice_no,
      replayed: true,
    });
    expect(await entryCount()).toBe(entries);
    expect((await auditFor(ownDraftId)).length).toBe(audits + 1);
  });

  it('SS-UC01-12 a different user approving the posted invoice gets 409 already_posted', async () => {
    const r = await approve(ownDraftId, 'owner');
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'already_posted' });
  });

  it("SS-UC01-12 another tenant's invoice is not found (404) and nothing posts", async () => {
    const r = await approve(draftId, 'outsider');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'not_found' });
    expect(await statusOf(f, draftId)).toBe('draft');
    expect((await approve(foreignId, 'approver')).status).toBe(404);
  });

  it('SS-UC01-12 small-team mode: the only user may approve their own draft with a recorded exception', async () => {
    const on = await fetch(`${soloApi.url}/sod/settings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `lf_session=${cookies.get('solo') ?? ''}`,
      },
      body: JSON.stringify({ small_team_mode: true, reason: 'one-person business' }),
    });
    expect(on.status).toBe(201);
    const refused = await approve(soloDraftId, 'solo', { on: soloApi, companyId: other.companyId });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'sod_violation',
      rule: 'SOD_INVOICE_SELF_APPROVAL',
      small_team_exception_required: true,
    });
    const ok = await approve(soloDraftId, 'solo', {
      on: soloApi,
      companyId: other.companyId,
      body: { sod_exception: { reason: 'sole trader; accountant reviews monthly' } },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'posted', replayed: false });
    const ex = await other.admin.query<{ rule: string; kind: string }>(
      'SELECT rule, kind FROM app.sod_exception WHERE subject_id = $1',
      [soloDraftId],
    );
    expect(ex.rows).toEqual([{ rule: 'SOD_INVOICE_SELF_APPROVAL', kind: 'recorded_exception' }]);
  });

  it('SS-UC01-12 without the outboxes the approval is refused (503) and nothing posts', async () => {
    const r = await approve(draftId, 'bareApprover', { on: bare });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'outbox_unavailable' });
    expect(await statusOf(f, draftId)).toBe('draft');
  });
});
