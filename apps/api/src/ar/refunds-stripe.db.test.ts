/**
 * Stripe refunds over HTTP (T-0172, ADR-0083, DL-0562, ADR-0074; SS-UC11-09, SS-UC11-10). Real
 * PostgreSQL (lf_app), real sessions and the local Stripe stub replaying the documented fixture.
 *   PUT  /ar/refunds/:id            method stripe: needs a Stripe payment covering the refund
 *   POST /ar/refunds/:id/approve    a Stripe refund also needs step-up (300 s); SoD unchanged;
 *                                   the approval sends it once and posts GP-006 Stripe variant
 * The approval and its outbox event commit together; a failed send leaves the refund approved
 * for the outbox handler, with nothing posted. Another tenant's refund is 404.
 * Security review r8 (RQ-0164): a Stripe success that cannot be posted answers `failed` with
 * code SENT_NOT_POSTED and the Stripe refund id (F1); the handler refuses a Stripe refund whose
 * step-up the interceptor did not verify, whatever the route's condition saw (F3).
 * T-0190 (SS-UC11-11): cancel a refused Stripe refund. T-0189 (SS-UC11-12, SS-UC11-13, ADR-0091):
 * stripe-check records a refund Stripe holds; a resend is asked and confirmed by two people.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createCustomerRefund,
  createDraftInvoice,
  recordReceipt,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import {
  assertStripeRefundable,
  StripeApiError,
  StripeClient,
  STRIPE_REFUND_APPROVED,
  type HttpPost,
} from '@ledgerforce/connector-stripe';
import {
  APPROVED_REFUNDS_FIXTURE,
  loadCassette,
  REFUND_FOLLOWUPS_FIXTURE,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
  type StripePaidCredit,
} from '@ledgerforce/connector-stripe/testing';
import type { PostingOutbox } from '@ledgerforce/ledger';
import { describeFailure, recordDeliveryFailure, recordSyncIssue } from '@ledgerforce/outbox';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { RequireStepUp } from '../authz/permission.decorator.ts';
import { ArRefundsController, stripeRefundOnly } from './refunds.controller.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp006 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-006',
);
const CODE_OF: Record<string, string> = {
  'setting:stripe.clearing_account': '1210',
  'system:AR_CONTROL': '1200',
};
const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;
/** 2026-11-24 11:00 in Sydney (the golden's date); the API's clock. */
const NOW = new Date('2026-11-24T00:00:00Z');
const FRESH = new Date(NOW.getTime() - 60 * 1000);
const STALE = new Date(NOW.getTime() - 30 * 60 * 1000);

let f: LedgerFixture;
let other: LedgerFixture;
let profiles: SeededProfiles;
let api: Api;
let stub: RecordedStripe;
let stripeDown = false;
let postingDown = false;
let foreignRefund = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  financeAdmin: { id: randomUUID(), roles: ['finance_admin'] },
};

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
  h['sec-fetch-site'] = 'same-origin';
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const q = () => `company_id=${f.companyId}`;
/** The cancel route needs an Idempotency-Key (T-0207, ADR-0107). */
const cancelAs = (path: string, who: string) =>
  call('POST', path, who, undefined, { 'idempotency-key': randomUUID() });
const stripeBody = (party: string, amount = '220.00') => ({
  company_id: f.companyId,
  party_id: party,
  refund_date: '2026-11-24',
  amount,
  method: 'stripe',
  reason: 'Back to the card',
});

const seedCredit = async (fx: LedgerFixture, prefix: string, p: SeededProfiles) => {
  const [party = ''] = await seedBillableCustomers(fx, p, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return seedStripePaidCredit(fx, {
    professionalServicesProfileId: p.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: fx.acct['1210'] ?? '',
  });
};

function useVars(credit: StripePaidCredit, refundId: string, refundNo: string, re: string) {
  Object.assign(stub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    refundId,
    refundNo,
    creditNoteId: credit.creditNoteId,
    creditNoteNo: credit.creditNoteNo,
    paymentIntentId: credit.paymentIntentId,
    stripeRefundId: re,
  });
}

const entriesFor = async (refundId: string) =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.journal_entry
        WHERE tenant_id = $1 AND source_type = 'ar_refund' AND source_id = $2`,
      [f.tenantId, refundId],
    )
  ).rows[0]?.n;

const eventsFor = async (refundId: string) =>
  (
    await f.admin.query<{ topic: string }>(
      `SELECT topic FROM app.outbox_event WHERE tenant_id = $1 AND aggregate_id = $2`,
      [f.tenantId, refundId],
    )
  ).rows.map((r) => r.topic);

async function session(who: string, authTime: Date, fx: LedgerFixture = f) {
  const p = people[who];
  if (!p || !api.sessions) throw new Error('no such person or sessions');
  return api.sessions.create(fx.tenantId, {
    userId: p.id,
    amr: ['pwd', 'otp'],
    acr: null,
    authTime,
  });
}

beforeAll(async () => {
  // T-0189: the follow-ups fixture's interactions (expired, vanished) next to T-0172's.
  const approved = loadCassette(APPROVED_REFUNDS_FIXTURE);
  const followups = loadCassette(REFUND_FOLLOWUPS_FIXTURE);
  stub = await startRecordedStripe({
    ...approved,
    interactions: [...approved.interactions, ...followups.interactions],
  });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000017211');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000017212');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@t0172.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  profiles = await seedBillingCompany(f);
  const otherProfiles = await seedBillingCompany(other);
  const foreign = await seedCredit(other, 'Elsewhere', otherProfiles);
  foreignRefund = (
    await other.inTenant((trx) =>
      createCustomerRefund(
        trx,
        {
          companyId: other.companyId,
          id: randomUUID(),
          partyId: foreign.partyId,
          refundDate: '2026-11-24',
          amount: '220.00',
          method: 'stripe',
        },
        { stripeCheck: assertStripeRefundable },
      ),
    )
  ).refundId;

  const http: HttpPost = async (url, init) => {
    if (stripeDown) throw new Error('connect ECONNREFUSED');
    const res = await fetch(url, init);
    return { status: res.status, text: () => res.text() };
  };
  const documentOutbox: DocumentOutbox = {
    publish: async (trx, e) => {
      await sql`INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
        VALUES (${e.companyId}, ${e.topic}, ${e.aggregateType}, ${e.aggregateId},
                ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
    },
  };
  const postingOutbox: PostingOutbox = {
    enqueue: async () => {
      if (postingDown) throw new Error('posting outbox unavailable');
    },
  };
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: { clock: { now: () => NOW } },
    documentOutbox,
    postingOutbox,
    stripeRefunds: {
      client: new StripeClient({
        secretKey: 'sk_test_dummy',
        mode: 'test',
        baseUrl: stub.url,
        http,
      }),
    },
  });
  for (const who of Object.keys(people)) cookies.set(who, await session(who, FRESH));
  cookies.set('staleApprover', await session('approver', STALE));
  cookies.set('staleFinanceAdmin', await session('financeAdmin', STALE));
}, 240_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-09 approving a Stripe refund: step-up, SoD, sent once, GP-006 Stripe variant', () => {
  it('SS-UC11-09 a stepped-up Approver approves a Stripe refund: Stripe is called once, GP-006 (Stripe) posts, a repeat replays', async () => {
    const credit = await seedCredit(f, 'Acme', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string; stripe: unknown };
    expect(c).toMatchObject({ id, method: 'stripe', status: 'requested', approval: 'pending' });
    expect(c.stripe).toEqual({ status: 'not_sent', stripe_refund_id: null, message: null });
    expect(stub.received).toHaveLength(0);
    useVars(credit, id, c.refund_no, 're_1SQbT0172ApiAcme220');

    // "Show me the journal" for a Stripe refund previews GP-006's Stripe variant (clearing).
    const preview = await call('GET', `/ar/refunds/${id}/journal?${q()}`, 'arClerk');
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as {
      bank_account_source: string;
      lines: { account_code: string; debit: string; credit: string }[];
    };
    expect(p.bank_account_source).toBe('stripe_clearing');
    expect(p.lines.map((l) => [l.account_code, l.debit, l.credit])).toEqual([
      ['1200', '220.0000', '0.0000'],
      ['1210', '0.0000', '220.0000'],
    ]);

    const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entry_id: string };
    expect(body).toMatchObject({
      id,
      replayed: false,
      method: 'stripe',
      status: 'paid',
      paid_on: '2026-11-24',
      approval: 'approved',
      approved_by: people.approver?.id,
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220', message: null },
    });
    expect(stub.mismatches).toEqual([]);
    // RQ-0164: the send first looks for this document's refund at Stripe, then creates it.
    expect(stub.received.map((x) => [x.method, x.idempotencyKey, x.matched])).toEqual([
      ['GET', null, 'list-refunds-none'],
      ['POST', `lf-refund-v2-${id}`, 'refund-document-220.00'],
    ]);
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);

    // The journal is GP-006, Stripe variant, line for line.
    const rows = (
      await f.admin.query<{ code: string; debit: string; credit: string; party_id: string | null }>(
        `SELECT a.code, l.debit::text, l.credit::text, l.party_id::text
           FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY l.line_no`,
        [body.entry_id],
      )
    ).rows;
    expect(rows).toHaveLength(gp006?.lines.length ?? -1);
    gp006?.lines.forEach((g, i) => {
      const at = `GP-006 (Stripe variant) line ${String(i + 1)}`;
      const binding =
        g.binding === 'bank:OPERATING' ? 'setting:stripe.clearing_account' : g.binding;
      expect(rows[i]?.code, at).toBe(CODE_OF[binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? credit.partyId : null);
    });

    const again = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      id,
      replayed: true,
      status: 'paid',
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220' },
    });
    expect(stub.received).toHaveLength(2);
    expect(await entriesFor(id)).toBe(1);
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await read.json()).toMatchObject({
      status: 'paid',
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220' },
    });
  });

  it('SS-UC11-09 approving a Stripe refund without a fresh step-up is 401 step_up_required (300 s); a bank refund needs none', async () => {
    const credit = await seedCredit(f, 'Beta', profiles);
    const id = randomUUID();
    expect(
      (await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId, '100.00')))
        .status,
    ).toBe(201);
    const before = stub.received.length;
    const stale = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'staleApprover');
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(stub.received.length).toBe(before);
    expect(await (await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk')).json()).toMatchObject({
      approval: 'pending',
      status: 'requested',
    });
    expect(await eventsFor(id)).toEqual([]);

    // A bank refund (paid later by a released batch, itself under step-up) needs no step-up here.
    const bank = randomUUID();
    expect(
      (
        await call('PUT', `/ar/refunds/${bank}`, 'arClerk', {
          ...stripeBody(credit.partyId, '20.00'),
          method: 'bank_batch',
        })
      ).status,
    ).toBe(201);
    const ok = await call('POST', `/ar/refunds/${bank}/approve?${q()}`, 'staleApprover');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ approval: 'approved', status: 'requested' });
  });

  it('SS-UC11-09 the person who requested a Stripe refund is refused its approval (SOD_REFUND_SELF_APPROVAL), even stepped up', async () => {
    const credit = await seedCredit(f, 'Gamma', profiles);
    const id = randomUUID();
    expect(
      (await call('PUT', `/ar/refunds/${id}`, 'financeAdmin', stripeBody(credit.partyId))).status,
    ).toBe(201);
    const before = stub.received.length;
    const own = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'financeAdmin');
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_REFUND_SELF_APPROVAL',
    });
    expect(stub.received.length).toBe(before);
    expect(await entriesFor(id)).toBe(0);
  });

  it("SS-UC11-09 another tenant's Stripe refund is 404; a Stripe refund with no Stripe payment behind it is 422 NO_STRIPE_PAYMENT", async () => {
    const foreign = await call('POST', `/ar/refunds/${foreignRefund}/approve?${q()}`, 'approver');
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: 'not_found' });

    // A customer whose credit comes from a bank-paid invoice has no card to refund to.
    const [party = ''] = await seedBillableCustomers(f, profiles, {
      count: 1,
      prefix: 'Bank',
      billDate: '2026-11-01',
    });
    await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: party,
          issueDate: '2026-11-05',
          lines: [
            {
              productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
              description: 'Professional services',
              quantity: '1',
              unitPrice: '1250.00',
            },
          ],
        },
        { outbox: { publish: async () => {} } },
      );
      await approveInvoice(
        trx,
        { companyId: f.companyId, invoiceId: d.invoiceId },
        { outbox: { publish: async () => {} } },
      );
      await recordReceipt(trx, {
        companyId: f.companyId,
        partyId: party,
        receiptDate: '2026-11-10',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: `t0172-eft-${party}`,
        allocations: [{ invoiceId: d.invoiceId, amount: '1375.00' }],
      });
      const cn = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: d.invoiceId,
        id: randomUUID(),
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      await approveCreditNote(trx, { companyId: f.companyId, creditNoteId: cn.creditNoteId });
    });
    const none = await call('PUT', `/ar/refunds/${randomUUID()}`, 'arClerk', stripeBody(party));
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ error: 'NO_STRIPE_PAYMENT' });
  });
});

describe('SS-UC11-10 a Stripe refund that cannot be sent at approval is retried, never posted twice', () => {
  it('SS-UC11-10 Stripe unreachable: the approval and its outbox event commit, nothing is posted, the answer says it will be retried', async () => {
    const credit = await seedCredit(f, 'Delta', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    stripeDown = true;
    try {
      const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        id,
        status: 'requested',
        approval: 'approved',
        entry_id: null,
        stripe: { status: 'pending', stripe_refund_id: null },
      });
    } finally {
      stripeDown = false;
    }
    expect(await entriesFor(id)).toBe(0);
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await read.json()).toMatchObject({
      approval: 'approved',
      status: 'requested',
      stripe: { status: 'pending' },
    });
    // A repeated approve does not send again from the request: the outbox owns the retry.
    const again = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(await again.json()).toMatchObject({ replayed: true, stripe: { status: 'pending' } });
    expect(await entriesFor(id)).toBe(0);
  });
});

describe('Security review r8: a Stripe success that cannot be posted, and step-up the handler re-checks', () => {
  const creates = () => stub.received.filter((x) => x.method === 'POST').length;

  it('SS-UC11-10 F1 the posting fails after Stripe accepted: the answer is failed SENT_NOT_POSTED with the Stripe refund id, nothing is posted', async () => {
    const credit = await seedCredit(f, 'Theta', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string };
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      sentRefundId: id,
      sentRefundNo: c.refund_no,
      sentCreditNoteId: credit.creditNoteId,
      sentCreditNoteNo: credit.creditNoteNo,
      sentPaymentIntentId: credit.paymentIntentId,
      sentStripeRefundId: 're_1SQbT0172ApiSentNotPosted',
    });
    const before = creates();
    postingDown = true;
    let body: { stripe?: { status: string; code?: string | null; message: string | null } };
    try {
      const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
      expect(ok.status).toBe(200);
      body = (await ok.json()) as typeof body;
    } finally {
      postingDown = false;
    }
    expect(stub.mismatches).toEqual([]);
    expect(body).toMatchObject({
      id,
      status: 'requested',
      approval: 'approved',
      entry_id: null,
      stripe: {
        status: 'failed',
        code: 'SENT_NOT_POSTED',
        stripe_refund_id: 're_1SQbT0172ApiSentNotPosted',
      },
    });
    expect(body.stripe?.message).toMatch(
      /sent to Stripe as re_1SQbT0172ApiSentNotPosted.*not posted/,
    );
    expect(creates()).toBe(before + 1);
    expect(await entriesFor(id)).toBe(0);
    // The approval and its event stand, so the worker's attempt turns it into a Sync issue.
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);
  });

  it('SS-UC11-09 F3 the handler refuses a Stripe refund whose step-up was not verified, even when the route condition saw none', async () => {
    // The race of F3: the condition read the refund before it existed (false), the handler
    // reads it as a Stripe refund. Forced here by a condition that always answers false.
    const descriptor = Object.getOwnPropertyDescriptor(ArRefundsController.prototype, 'approve');
    if (!descriptor) throw new Error('no approve handler');
    RequireStepUp(300, () => Promise.resolve(false))(
      ArRefundsController.prototype,
      'approve',
      descriptor,
    );
    try {
      const credit = await seedCredit(f, 'Kappa', profiles);
      const id = randomUUID();
      const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
      expect(created.status).toBe(201);
      const c = (await created.json()) as { refund_no: string };
      useVars(credit, id, c.refund_no, 're_1SQbT0172ApiKappa220');
      const before = stub.received.length;
      const stale = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'staleApprover');
      expect(stale.status).toBe(401);
      expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
      expect(stub.received.length).toBe(before);
      expect(await eventsFor(id)).toEqual([]);
      expect(await (await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk')).json()).toMatchObject(
        { approval: 'pending', status: 'requested' },
      );
      const audited = await f.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit.audit_log
          WHERE tenant_id = $1 AND action = 'step_up_required' AND after->>'route' LIKE '%approve%'`,
        [f.tenantId],
      );
      expect(audited.rows[0]?.n).toBeGreaterThan(0);

      // A stepped-up approver passes: the interceptor verified the session, whatever the condition.
      const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        status: 'paid',
        stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiKappa220' },
      });
    } finally {
      RequireStepUp(300, stripeRefundOnly)(ArRefundsController.prototype, 'approve', descriptor);
    }
  });
});

describe('RQ-0165 Q1: the step-up condition fails closed, and an API token never approves a Stripe refund', () => {
  it('SS-UC11-09 RQ-0165 test 2: an error thrown by the step-up condition fails the request: no approval, no event, no Stripe call, nothing posted', async () => {
    // Test-only seam (as in F3 above): re-declare the route's step-up with a condition that throws.
    const descriptor = Object.getOwnPropertyDescriptor(ArRefundsController.prototype, 'approve');
    if (!descriptor) throw new Error('no approve handler');
    let asked = 0;
    RequireStepUp(300, () => {
      asked += 1;
      return Promise.reject(new Error('step-up condition failed'));
    })(ArRefundsController.prototype, 'approve', descriptor);
    try {
      const credit = await seedCredit(f, 'Lambda', profiles);
      const stripeId = randomUUID();
      const created = await call(
        'PUT',
        `/ar/refunds/${stripeId}`,
        'arClerk',
        stripeBody(credit.partyId, '120.00'),
      );
      expect(created.status).toBe(201);
      const c = (await created.json()) as { refund_no: string };
      useVars(credit, stripeId, c.refund_no, 're_1SQbT0172ApiLambda120');
      const before = stub.received.length;

      // A session without a fresh step-up makes the interceptor ask the condition.
      const failed = await call('POST', `/ar/refunds/${stripeId}/approve?${q()}`, 'staleApprover');
      expect(asked).toBe(1);
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('step-up condition failed');
      expect(stub.received.length).toBe(before);
      expect(await eventsFor(stripeId)).toEqual([]);
      expect(await entriesFor(stripeId)).toBe(0);
      expect(
        await (await call('GET', `/ar/refunds/${stripeId}?${q()}`, 'arClerk')).json(),
      ).toMatchObject({
        approval: 'pending',
        approved_by: null,
        status: 'requested',
        stripe: { status: 'not_sent', stripe_refund_id: null },
      });

      // Fail closed whatever the method: a bank refund is not approved past a failing condition.
      const bank = randomUUID();
      expect(
        (
          await call('PUT', `/ar/refunds/${bank}`, 'arClerk', {
            ...stripeBody(credit.partyId, '10.00'),
            method: 'bank_batch',
          })
        ).status,
      ).toBe(201);
      const bankFailed = await call('POST', `/ar/refunds/${bank}/approve?${q()}`, 'staleApprover');
      expect(asked).toBe(2);
      expect(bankFailed.status).toBe(500);
      expect(
        await (await call('GET', `/ar/refunds/${bank}?${q()}`, 'arClerk')).json(),
      ).toMatchObject({ approval: 'pending', approved_by: null, status: 'requested' });
    } finally {
      RequireStepUp(300, stripeRefundOnly)(ArRefundsController.prototype, 'approve', descriptor);
    }
  });

  it('SS-UC11-09 RQ-0165 test 4: an API token holding ar.refund.approve cannot approve a Stripe refund: 401 step_up_required, no Stripe call', async () => {
    // The approver issues a token under a fresh step-up (ADR-0027); ar.refund.approve is a
    // token-allowed scope, so the refusal comes from the step-up, not from the scope.
    const issued = await call('POST', '/api-tokens', 'approver', {
      name: 'refund-bot',
      scopes: ['ar.refund.approve'],
    });
    expect(issued.status).toBe(201);
    const t = (await issued.json()) as { id: string; scopes: string[]; token: string };
    expect(t.scopes).toEqual(['ar.refund.approve']);
    const bearer = (path: string) =>
      fetch(`${api.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}` },
      });

    const credit = await seedCredit(f, 'Mu', profiles);
    const id = randomUUID();
    // 200.00 of the 220.00 credit, leaving 20.00 for the bank refund below.
    const created = await call(
      'PUT',
      `/ar/refunds/${id}`,
      'arClerk',
      stripeBody(credit.partyId, '200.00'),
    );
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string };
    useVars(credit, id, c.refund_no, 're_1SQbT0172ApiMu200');
    const before = stub.received.length;

    const refused = await bearer(`/ar/refunds/${id}/approve?${q()}`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(stub.received.length).toBe(before);
    expect(await eventsFor(id)).toEqual([]);
    expect(await entriesFor(id)).toBe(0);
    expect(await (await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk')).json()).toMatchObject({
      approval: 'pending',
      approved_by: null,
      status: 'requested',
    });
    const audited = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'step_up_required' AND api_token_id = $2`,
      [f.tenantId, t.id],
    );
    expect(audited.rows[0]?.n).toBe(1);

    // The same token approves a bank refund (no step-up there), so the token itself is valid.
    const bank = randomUUID();
    expect(
      (
        await call('PUT', `/ar/refunds/${bank}`, 'arClerk', {
          ...stripeBody(credit.partyId, '20.00'),
          method: 'bank_batch',
        })
      ).status,
    ).toBe(201);
    const ok = await bearer(`/ar/refunds/${bank}/approve?${q()}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ approval: 'approved', status: 'requested' });
  });
});

/**
 * Move every recorded send activity of a refund an hour back (superuser, triggers off: the
 * records are append-only), as if the cancel's cooling-off had passed (security review r10).
 */
async function anHourAgo(refundId: string) {
  const id = refundId.toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('not a uuid');
  await f.admin.query(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE app.customer_refund_approval SET approved_at = approved_at - interval '1 hour'
     WHERE refund_id = '${id}';
    UPDATE app.outbox_delivery_failure d SET failed_at = d.failed_at - interval '1 hour'
      FROM app.outbox_event e WHERE e.id = d.event_id AND e.aggregate_id = '${id}';
    UPDATE app.sync_issue i
       SET last_failed_at = i.last_failed_at - interval '1 hour',
           first_failed_at = i.first_failed_at - interval '1 hour',
           status_changed_at = i.status_changed_at - interval '1 hour',
           created_at = i.created_at - interval '1 hour'
      FROM app.outbox_event e WHERE e.id = i.event_id AND e.aggregate_id = '${id}';
    UPDATE app.outbox_event SET created_at = created_at - interval '1 hour'
     WHERE aggregate_id = '${id}';
    COMMIT;`);
}

describe('SS-UC11-11 T-0190: cancel a Stripe refund that Stripe refused permanently', () => {
  /** The open Sync issue the worker leaves for a refused send (outbox dead letter). */
  async function syncIssueFor(refundId: string, error: unknown) {
    await f.inTenant(async (trx) => {
      const event = (
        await sql<{ id: string }>`SELECT id::text FROM app.outbox_event
          WHERE aggregate_id = ${refundId} AND topic = ${STRIPE_REFUND_APPROVED}`.execute(trx)
      ).rows[0];
      if (!event) throw new Error('no approval event');
      const failureId = await recordDeliveryFailure(trx, {
        eventId: event.id,
        handler: 'stripe.refund.send',
        attempt: 1,
        failure: describeFailure(error),
      });
      await recordSyncIssue(trx, {
        eventId: event.id,
        attempts: 1,
        deadLetterJobId: randomUUID(),
        output: { handler: 'stripe.refund.send', failureId },
      });
    });
  }

  it('SS-UC11-11 a refused Stripe refund shows failed after a reload, the clerk cancels it (a repeat replays) and its credit is freed', async () => {
    const credit = await seedCredit(f, 'Disputed', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string };
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      disputedRefundId: id,
      disputedRefundNo: c.refund_no,
      disputedCreditNoteId: credit.creditNoteId,
      disputedCreditNoteNo: credit.creditNoteNo,
      disputedPaymentIntentId: credit.paymentIntentId,
    });
    const approved = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(await approved.json()).toMatchObject({
      status: 'requested',
      approval: 'approved',
      stripe: { status: 'failed' },
    });
    // The worker's attempt dead-letters the permanent refusal into a Sync issue.
    await syncIssueFor(
      id,
      new StripeApiError(400, 'charge_disputed', 'Charge has been charged back'),
    );
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await read.json()).toMatchObject({
      status: 'requested',
      stripe: {
        status: 'failed',
        code: 'StripeApiError',
        message: expect.stringMatching(/charged back/) as unknown,
      },
    });

    // An Approver (no ar.refund.create) cannot cancel; the clerk can.
    const denied = await cancelAs(`/ar/refunds/${id}/cancel?${q()}`, 'approver');
    expect(denied.status).toBe(403);
    // Security review r10 M1(b): within 15 minutes of the last send activity, 422
    // SEND_NOT_FINISHED, and Stripe is not asked.
    const asked = stub.received.length;
    const early = await cancelAs(`/ar/refunds/${id}/cancel?${q()}`, 'arClerk');
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({
      error: 'SEND_NOT_FINISHED',
      message: expect.stringMatching(/less than 15 minutes ago/) as unknown,
    });
    expect(stub.received.length).toBe(asked);
    await anHourAgo(id);
    const before = stub.received.length;
    const ok = await cancelAs(`/ar/refunds/${id}/cancel?${q()}`, 'arClerk');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id,
      replayed: false,
      status: 'cancelled',
      stripe: { status: 'not_sent' },
    });
    // The cancel asked Stripe (read-only) whether it holds a refund for this document.
    expect(stub.received.slice(before).map((x) => [x.method, x.matched])).toEqual([
      ['GET', 'list-refunds-none-disputed'],
    ]);
    const again = await cancelAs(`/ar/refunds/${id}/cancel?${q()}`, 'arClerk');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, status: 'cancelled' });
    expect(stub.received.length).toBe(before + 1);
    const credited = await call('GET', `/ar/parties/${credit.partyId}/credit?${q()}`, 'arClerk');
    expect(await credited.json()).toMatchObject({ requested: '0.0000', available: '220.0000' });
    const audited = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'customer_refund' AND entity_id = $2
          AND after->>'status' = 'cancelled'`,
      [f.tenantId, id],
    );
    expect(audited.rows[0]?.n).toBe(1);
  });

  it("SS-UC11-11 a sent (paid) Stripe refund is 422 NOT_CANCELLABLE; another tenant's is 404; a malformed id is 400", async () => {
    const credit = await seedCredit(f, 'Sent', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    const c = (await created.json()) as { refund_no: string };
    useVars(credit, id, c.refund_no, 're_1SQbT0190ApiSent220');
    const paid = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(await paid.json()).toMatchObject({ status: 'paid' });
    const sent = await cancelAs(`/ar/refunds/${id}/cancel?${q()}`, 'arClerk');
    expect(sent.status).toBe(422);
    expect(await sent.json()).toMatchObject({ error: 'NOT_CANCELLABLE' });
    expect(await entriesFor(id)).toBe(1);

    const foreign = await cancelAs(`/ar/refunds/${foreignRefund}/cancel?${q()}`, 'arClerk');
    expect(foreign.status).toBe(404);
    const malformed = await cancelAs(`/ar/refunds/not-a-uuid/cancel?${q()}`, 'arClerk');
    expect(malformed.status).toBe(400);
  });
});

describe('T-0189 a Stripe refund older than 23 hours: check at Stripe, record once, or resend after a second person (ADR-0091)', () => {
  const approvedHoursAgo = (refundId: string, hours: number) =>
    f.admin.query(
      `INSERT INTO app.customer_refund_approval (tenant_id, company_id, refund_id, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() - make_interval(hours => $5))`,
      [f.tenantId, f.companyId, refundId, people.approver?.id, hours],
    );
  const setVars = (prefix: string, credit: StripePaidCredit, id: string, no: string, re: string) =>
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      [`${prefix}RefundId`]: id,
      [`${prefix}RefundNo`]: no,
      [`${prefix}CreditNoteId`]: credit.creditNoteId,
      [`${prefix}CreditNoteNo`]: credit.creditNoteNo,
      [`${prefix}PaymentIntentId`]: credit.paymentIntentId,
      [`${prefix}StripeRefundId`]: re,
    });
  const requested = async (prefix: string) => {
    const credit = await seedCredit(f, prefix, profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string };
    return { credit, id, no: c.refund_no };
  };

  it('SS-UC11-12 stripe-check records a refund Stripe holds for an expired send once, dated the Stripe refund date; an AR Clerk cannot check', async () => {
    const { credit, id, no } = await requested('ApiExpired');
    await approvedHoursAgo(id, 30);
    setVars('expired', credit, id, no, 're_1SQbT0189ApiExpired');
    const clerk = await call('POST', `/ar/refunds/${id}/stripe-check?${q()}`, 'arClerk');
    expect(clerk.status).toBe(403);
    const posts = stub.received.filter((x) => x.method === 'POST').length;
    const ok = await call('POST', `/ar/refunds/${id}/stripe-check?${q()}`, 'approver');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      outcome: 'recorded',
      stripe_refund_id: 're_1SQbT0189ApiExpired',
      failed_at_stripe: [],
      resendable: false,
      refund: { id, status: 'paid', paid_on: '2026-11-25', stripe: { status: 'sent' } },
    });
    expect(stub.received.filter((x) => x.method === 'POST').length).toBe(posts);
    expect(await entriesFor(id)).toBe(1);
  });

  it('SS-UC11-13 nothing at Stripe: one person asks a resend, the same person cannot confirm, a stale step-up is refused, a second person confirms and it is sent once with a new key', async () => {
    const { credit, id, no } = await requested('ApiVanished');
    await approvedHoursAgo(id, 30);
    setVars('vanished', credit, id, no, 're_1SQbT0189ApiResent');
    // Security review r10 L1: past its window the stored view says the send finished.
    const stored = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await stored.json()).toMatchObject({
      status: 'requested',
      stripe: { status: 'failed', code: 'KEY_EXPIRED' },
    });
    // Twice: a repeated check changes nothing.
    for (let i = 0; i < 2; i++) {
      const check = await call('POST', `/ar/refunds/${id}/stripe-check?${q()}`, 'approver');
      expect(await check.json()).toMatchObject({
        outcome: 'not_at_stripe',
        stripe_refund_id: null,
        resendable: true,
        refund: { status: 'requested', approval: 'approved' },
      });
    }
    const resendId = randomUUID();
    stub.vars['vanishedResendId'] = resendId;
    const body = { reason: 'Checked the payment in Stripe: no refund was made' };
    const byClerk = await call(
      'PUT',
      `/ar/refunds/${id}/stripe-resends/${resendId}?${q()}`,
      'arClerk',
      body,
    );
    expect(byClerk.status).toBe(403);
    const asked = await call(
      'PUT',
      `/ar/refunds/${id}/stripe-resends/${resendId}?${q()}`,
      'approver',
      body,
    );
    expect(asked.status).toBe(201);
    expect(await asked.json()).toMatchObject({
      id: resendId,
      refund_id: id,
      status: 'requested',
      requested_by: people.approver?.id,
      idempotency_key: `lf-refund-v3-${resendId}`,
    });
    const replay = await call(
      'PUT',
      `/ar/refunds/${id}/stripe-resends/${resendId}?${q()}`,
      'approver',
      body,
    );
    expect(replay.status).toBe(200);

    const posts = stub.received.filter((x) => x.method === 'POST').length;
    const self = await call(
      'POST',
      `/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
      'approver',
    );
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_REFUND_RESEND_SELF_CONFIRM',
    });
    const stale = await call(
      'POST',
      `/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
      'staleFinanceAdmin',
    );
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(stub.received.filter((x) => x.method === 'POST').length).toBe(posts);

    const ok = await call(
      'POST',
      `/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
      'financeAdmin',
    );
    expect(ok.status).toBe(200);
    expect(stub.mismatches).toEqual([]);
    expect(await ok.json()).toMatchObject({
      resend: { id: resendId, status: 'confirmed', confirmed_by: people.financeAdmin?.id },
      refund: {
        id,
        status: 'paid',
        stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0189ApiResent' },
      },
    });
    const creates = stub.received.filter((x) => x.method === 'POST');
    expect(creates.slice(posts).map((x) => x.idempotencyKey)).toEqual([`lf-refund-v3-${resendId}`]);
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);
    const again = await call(
      'POST',
      `/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
      'financeAdmin',
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      resend: { replayed: true },
      refund: { status: 'paid' },
    });
    expect(stub.received.filter((x) => x.method === 'POST').length).toBe(posts + 1);
    expect(await entriesFor(id)).toBe(1);
    const foreign = await call(
      'POST',
      `/ar/refunds/${foreignRefund}/stripe-check?${q()}`,
      'approver',
    );
    expect(foreign.status).toBe(404);
  });
});

describe('Security review r10 L3: confirming a resend sends money, so an API token never confirms it', () => {
  it('SS-UC11-13 an API token holding ar.refund.approve cannot confirm a Stripe refund resend: 401 step_up_required, no Stripe call, nothing confirmed', async () => {
    const issued = await call('POST', '/api-tokens', 'financeAdmin', {
      name: 'resend-bot',
      scopes: ['ar.refund.approve'],
    });
    expect(issued.status).toBe(201);
    const t = (await issued.json()) as { id: string; token: string };
    const credit = await seedCredit(f, 'TokenResend', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    const c = (await created.json()) as { refund_no: string };
    await f.admin.query(
      `INSERT INTO app.customer_refund_approval (tenant_id, company_id, refund_id, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() - interval '30 hours')`,
      [f.tenantId, f.companyId, id, people.approver?.id],
    );
    // A resend asked for under the T-0189 rules ('refused' always answers an empty lookup).
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      refusedRefundId: id,
      refusedRefundNo: c.refund_no,
      refusedCreditNoteId: credit.creditNoteId,
      refusedCreditNoteNo: credit.creditNoteNo,
      refusedPaymentIntentId: credit.paymentIntentId,
    });
    const resendId = randomUUID();
    const asked = await call(
      'PUT',
      `/ar/refunds/${id}/stripe-resends/${resendId}?${q()}`,
      'approver',
      { reason: 'Checked at Stripe: nothing was refunded' },
    );
    expect(asked.status).toBe(201);
    const before = stub.received.length;
    const refused = await fetch(
      `${api.url}/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
      { method: 'POST', headers: { authorization: `Bearer ${t.token}` } },
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(stub.received.length).toBe(before);
    const row = await f.admin.query<{ confirmed_by: string | null }>(
      `SELECT confirmed_by::text FROM app.customer_refund_stripe_resend WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, resendId],
    );
    expect(row.rows).toEqual([{ confirmed_by: null }]);
    expect(await entriesFor(id)).toBe(0);

    // The handler re-checks (the final gate, DL-0692): with the route's step-up declaration made
    // conditional and false (test-only seam, as F3), a stale session is still refused.
    const descriptor = Object.getOwnPropertyDescriptor(
      ArRefundsController.prototype,
      'confirmResend',
    );
    if (!descriptor) throw new Error('no confirmResend handler');
    RequireStepUp(300, () => Promise.resolve(false))(
      ArRefundsController.prototype,
      'confirmResend',
      descriptor,
    );
    try {
      const stale = await call(
        'POST',
        `/ar/refunds/${id}/stripe-resends/${resendId}/confirm?${q()}`,
        'staleFinanceAdmin',
      );
      expect(stale.status).toBe(401);
      expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
      expect(stub.received.length).toBe(before);
      const still = await f.admin.query<{ confirmed_by: string | null }>(
        `SELECT confirmed_by::text FROM app.customer_refund_stripe_resend WHERE tenant_id = $1 AND id = $2`,
        [f.tenantId, resendId],
      );
      expect(still.rows).toEqual([{ confirmed_by: null }]);
    } finally {
      RequireStepUp(300)(ArRefundsController.prototype, 'confirmResend', descriptor);
    }
  });
});
