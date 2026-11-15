/**
 * Stripe refund through the approved refund document (T-0172, ADR-0083, RQ-0163, ADR-0074,
 * DL-0477 item 3; SS-UC11-09, SS-UC11-10). Real PostgreSQL as lf_app; Stripe is the local stub
 * replaying the documented fixture (never the network).
 *
 *  - A requested Stripe refund is not sent until approved; approval sends it once (Stripe
 *    Idempotency-Key per refund document) and posts GP-006 Stripe variant line for line.
 *  - The direct `refundCreditViaStripe` path needs an approved refund document (AC-3).
 *  - A failed send is retried by the outbox handler: never a second Stripe refund, never a second
 *    journal; permanent failures and sends older than 23 hours are not retried automatically.
 *  - Security review r8 F1 (RQ-0164, DL-0680..): before every create the send lists the
 *    PaymentIntent's refunds and adopts one carrying `lf_refund_id`; a posting the engine would
 *    refuse is caught before Stripe (NOT_POSTABLE); a failure after Stripe accepted is permanent
 *    SENT_NOT_POSTED and its retry adopts, never sends again. F5: the worker's posting is the
 *    approver's.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveCustomerRefund,
  createCustomerRefund,
  getCustomerRefund,
  type CustomerRefundView,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { subledgerEntriesOf, type PostingOutbox } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchHttpPost, StripeClient, type HttpPost } from './client.ts';
import {
  assertStripeRefundable,
  refundCreditViaStripe,
  sendStripeCustomerRefund,
  STRIPE_REFUND_APPROVED,
  stripeRefundSendHandler,
  trySendStripeCustomerRefund,
} from './refund.ts';
import {
  APPROVED_REFUNDS_FIXTURE,
  loadCassette,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
  type StripePaidCredit,
} from './testing/index.ts';

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
/** 2026-11-24 11:00 in Sydney: the golden's refund date. */
const NOW = new Date('2026-11-24T00:00:00Z');

let f: LedgerFixture;
let stub: RecordedStripe;
let client: StripeClient;
let profiles: SeededProfiles;
const clerk = randomUUID();
const approver = randomUUID();

const stripeCheck = { stripeCheck: assertStripeRefundable };
/** The Stripe calls that create a refund (POST), as opposed to the read-only lookups (GET). */
const creates = () => stub.received.filter((x) => x.method === 'POST');

async function requestRefund(credit: StripePaidCredit, amount = '220.00') {
  return f.inTenant((trx) =>
    createCustomerRefund(
      trx,
      {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: credit.partyId,
        refundDate: '2026-11-24',
        amount,
        method: 'stripe',
        reason: 'Customer asked for the credit back on the card',
        createdBy: clerk,
      },
      stripeCheck,
    ),
  );
}

const approve = (r: CustomerRefundView) =>
  f.inTenant((trx) =>
    approveCustomerRefund(trx, {
      companyId: f.companyId,
      refundId: r.refundId,
      approvedBy: approver,
      today: '2026-11-24',
    }),
  );

function useVars(credit: StripePaidCredit, r: CustomerRefundView, stripeRefundId: string) {
  Object.assign(stub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    refundId: r.refundId,
    refundNo: r.refundNo,
    creditNoteId: credit.creditNoteId,
    creditNoteNo: credit.creditNoteNo,
    paymentIntentId: credit.paymentIntentId,
    stripeRefundId,
  });
}

async function journal(entryId: string) {
  return f.inTenant(
    async (trx) =>
      (
        await sql<{
          code: string;
          debit: string;
          credit: string;
          party_id: string | null;
          source_type: string;
          source_id: string;
          entry_date: string;
        }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id::text, e.source_type,
               e.source_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date
          FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
          JOIN app.journal_entry e ON e.id = l.entry_id
         WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(trx)
      ).rows,
  );
}

const entriesFor = (refundId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.journal_entry
          WHERE source_type = 'ar_refund' AND source_id = ${refundId}`.execute(trx)
      ).rows[0]?.n,
  );

const seedCredit = async (prefix: string) => {
  const [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return seedStripePaidCredit(f, {
    professionalServicesProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: f.acct['1210'] ?? '',
  });
};

beforeAll(async () => {
  stub = await startRecordedStripe(loadCassette(APPROVED_REFUNDS_FIXTURE));
  client = new StripeClient({ secretKey: 'sk_test_dummy', mode: 'test', baseUrl: stub.url });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000017201');
  profiles = await seedBillingCompany(f);
  for (const id of [clerk, approver]) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $3, 'active')`,
      [id, f.tenantId, `${id}@t0172.test`],
    );
  }
}, 180_000);

afterAll(async () => {
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-09 a Stripe refund is sent only on approval, once, and posts GP-006 Stripe variant', () => {
  it('SS-UC11-09 a requested Stripe refund is not sent before approval; approval sends it once and posts GP-006 (Stripe) line for line', async () => {
    const credit = await seedCredit('Acme');
    const r = await requestRefund(credit);
    expect(r).toMatchObject({ method: 'stripe', status: 'requested', approval: 'pending' });
    useVars(credit, r, 're_1SQbT0172Acme000220');

    // Not approved: refused before Stripe is called, nothing posted.
    const early = await f
      .inTenant((trx) =>
        sendStripeCustomerRefund(trx, client, {
          companyId: f.companyId,
          refundId: r.refundId,
          now: NOW,
        }),
      )
      .catch((e: unknown) => (e as { code?: string }).code);
    expect(early).toBe('NOT_APPROVED');
    expect(stub.received).toHaveLength(0);

    await approve(r);
    const sent = await f.inTenant((trx) =>
      sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(stub.mismatches).toEqual([]);
    // RQ-0164: first the lookup (no key, read-only), then the one create.
    expect(stub.received.map((x) => [x.method, x.path, x.idempotencyKey, x.matched])).toEqual([
      ['GET', '/v1/refunds', null, 'list-refunds-none'],
      ['POST', '/v1/refunds', `lf-refund-v2-${r.refundId}`, 'refund-document-220.00'],
    ]);
    expect(stub.received[0]?.form).toEqual({
      payment_intent: credit.paymentIntentId,
      limit: '100',
    });
    expect(sent).toMatchObject({ stripeRefundId: 're_1SQbT0172Acme000220', replayed: false });
    expect(sent.refund).toMatchObject({ status: 'paid', paidOn: '2026-11-24' });

    const rows = await journal(sent.entryId);
    expect(gp006?.lines).toHaveLength(2);
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
    expect(rows.every((x) => x.source_type === 'ar_refund' && x.source_id === r.refundId)).toBe(
      true,
    );
    expect(rows[0]?.entry_date).toBe('2026-11-24');
    // The credit note and the refund settle each other; the Stripe refund is recorded once.
    const cnItem = await f.inTenant((trx) => subledgerEntriesOf(trx, credit.creditNoteEntryId));
    const refundItem = await f.inTenant((trx) => subledgerEntriesOf(trx, sent.entryId));
    expect(cnItem[0]?.openAmount).toBe('0.0000');
    expect(refundItem[0]?.openAmount).toBe('0.0000');
    const stored = await f.inTenant((trx) =>
      trx
        .selectFrom('app.stripe_refund')
        .select(['credit_note_id', 'payment_intent_id', 'amount', 'idempotency_key', 'entry_id'])
        .where('entry_id', '=', sent.entryId)
        .execute(),
    );
    expect(stored).toEqual([
      {
        credit_note_id: credit.creditNoteId,
        payment_intent_id: credit.paymentIntentId,
        amount: '220.0000',
        idempotency_key: `lf-refund-v2-${r.refundId}`,
        entry_id: sent.entryId,
      },
    ]);

    // Replay: no second Stripe call, no second journal.
    const again = await f.inTenant((trx) =>
      sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(again).toMatchObject({ entryId: sent.entryId, replayed: true });
    expect(stub.received).toHaveLength(2);
    expect(await entriesFor(r.refundId)).toBe(1);
  });

  it('SS-UC11-09 a Stripe refund is refused when no Stripe payment covers it, and approving one dated after today is NOT_DUE', async () => {
    // Beyond the Stripe-paid credit: refused at request time, before any Stripe call.
    const credit = await seedCredit('Beta');
    const before = stub.received.length;
    const tooMuch = await requestRefund(credit, '220.01').catch(
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(tooMuch).toBe('REFUND_EXCEEDS_CREDIT');
    // Without the Stripe check the ar module refuses the method (fail closed).
    const unchecked = await f
      .inTenant((trx) =>
        createCustomerRefund(trx, {
          companyId: f.companyId,
          id: randomUUID(),
          partyId: credit.partyId,
          refundDate: '2026-11-24',
          amount: '10.00',
          method: 'stripe',
        }),
      )
      .catch((e: unknown) => (e as { code?: string }).code);
    expect(unchecked).toBe('METHOD_NOT_AVAILABLE');
    // A Stripe refund is sent when approved, so one dated tomorrow cannot be approved today.
    const late = await f.inTenant((trx) =>
      createCustomerRefund(
        trx,
        {
          companyId: f.companyId,
          id: randomUUID(),
          partyId: credit.partyId,
          refundDate: '2026-11-25',
          amount: '20.00',
          method: 'stripe',
          createdBy: clerk,
        },
        stripeCheck,
      ),
    );
    const notDue = await approve(late).catch((e: unknown) => (e as { code?: string }).code);
    expect(notDue).toBe('NOT_DUE');
    const view = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, late.refundId));
    expect(view.approval).toBe('pending');
    expect(stub.received.length).toBe(before);
  });

  it('SS-UC11-09 AC-3: refundCreditViaStripe is no longer reachable without an approved refund document', async () => {
    const credit = await seedCredit('Gamma');
    const before = stub.received.length;
    const direct = await f
      .inTenant((trx) =>
        refundCreditViaStripe(trx, client, {
          companyId: f.companyId,
          creditNoteId: credit.creditNoteId,
          refundId: randomUUID(),
          amount: '220.00',
          refundDate: '2026-11-24',
        }),
      )
      .catch((e: unknown) => (e as { code?: string }).code);
    expect(direct).toBe('NOT_APPROVED');
    const r = await requestRefund(credit);
    const pending = await f
      .inTenant((trx) =>
        refundCreditViaStripe(trx, client, {
          companyId: f.companyId,
          creditNoteId: credit.creditNoteId,
          refundId: r.refundId,
          amount: '220.00',
          refundDate: '2026-11-24',
        }),
      )
      .catch((e: unknown) => (e as { code?: string }).code);
    expect(pending).toBe('NOT_APPROVED');
    expect(stub.received.length).toBe(before);
    expect(await entriesFor(r.refundId)).toBe(0);
  });
});

describe('SS-UC11-10 a failed Stripe send is retried through the outbox, never refunded or posted twice', () => {
  it('SS-UC11-10 Stripe unreachable at approval: the approval stands, nothing is posted, and the outbox handler sends it once', async () => {
    const credit = await seedCredit('Delta');
    const r = await requestRefund(credit);
    await approve(r);
    useVars(credit, r, 're_1SQbT0172Delta00220');
    const before = stub.received.length;
    let down = true;
    const flaky: HttpPost = (url, init) => {
      if (down) return Promise.reject(new Error('connect ECONNREFUSED'));
      return fetchHttpPost(url, init);
    };
    const flakyClient = new StripeClient({
      secretKey: 'sk_test_dummy',
      mode: 'test',
      baseUrl: stub.url,
      http: flaky,
    });
    const first = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, flakyClient, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(first).toMatchObject({ status: 'pending' });
    expect(await entriesFor(r.refundId)).toBe(0);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'requested', approval: 'approved' });

    // The outbox delivers the approval event; Stripe is back.
    down = false;
    const handler = stripeRefundSendHandler({ client: flakyClient, now: () => NOW });
    expect(handler.topics).toEqual([STRIPE_REFUND_APPROVED]);
    const event = {
      id: randomUUID(),
      tenantId: f.tenantId,
      companyId: f.companyId,
      topic: STRIPE_REFUND_APPROVED,
      aggregateType: 'customer_refund',
      aggregateId: r.refundId,
      payload: { refundId: r.refundId },
      createdAt: NOW,
    };
    await f.inTenant((trx) => handler.handle(trx, event));
    expect(stub.mismatches).toEqual([]);
    expect(stub.received.slice(before).map((x) => x.matched)).toEqual([
      'list-refunds-none',
      'refund-document-220.00',
    ]);
    expect(await entriesFor(r.refundId)).toBe(1);
    // A redelivery finds the refund paid: no Stripe call, no journal.
    await f.inTenant((trx) => handler.handle(trx, event));
    expect(stub.received.length).toBe(before + 2);
    expect(await entriesFor(r.refundId)).toBe(1);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'paid' });
  });

  it('SS-UC11-10 a permanent Stripe refusal is reported and not retried; a send older than 23 hours is never automatic', async () => {
    const credit = await seedCredit('Epsilon');
    const r = await requestRefund(credit);
    await approve(r);
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      disputedRefundId: r.refundId,
      disputedRefundNo: r.refundNo,
      disputedCreditNoteId: credit.creditNoteId,
      disputedCreditNoteNo: credit.creditNoteNo,
      disputedPaymentIntentId: credit.paymentIntentId,
    });
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.status === 'failed' ? out.message : '').toMatch(/charge_disputed|charged back/);
    expect(await entriesFor(r.refundId)).toBe(0);
    const handler = stripeRefundSendHandler({ client, now: () => NOW });
    const event = {
      id: randomUUID(),
      tenantId: f.tenantId,
      companyId: f.companyId,
      topic: STRIPE_REFUND_APPROVED,
      aggregateType: 'customer_refund',
      aggregateId: r.refundId,
      payload: { refundId: r.refundId },
      createdAt: NOW,
    };
    const permanent = await f
      .inTenant((trx) => handler.handle(trx, event))
      .catch((e: unknown) => e as { retryable?: boolean });
    expect(permanent).toMatchObject({ retryable: false });

    expect(await entriesFor(r.refundId)).toBe(0);

    // Approved a day ago (the key may be pruned at Stripe): refused, Stripe not called.
    const stale = await requestRefund(await seedCredit('Zeta'));
    await f.admin.query(
      `INSERT INTO app.customer_refund_approval (tenant_id, company_id, refund_id, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() - interval '24 hours')`,
      [f.tenantId, f.companyId, stale.refundId, approver],
    );
    const before = stub.received.length;
    const expired = await f
      .inTenant((trx) => handler.handle(trx, { ...event, aggregateId: stale.refundId }))
      .catch((e: unknown) => e as { code?: string; retryable?: boolean });
    expect(expired).toMatchObject({ code: 'KEY_EXPIRED', retryable: false });
    expect(stub.received.length).toBe(before);
    expect(await entriesFor(stale.refundId)).toBe(0);
  });
});

describe('Security review r8 F1: money never leaves twice; a Stripe success that cannot be posted says so', () => {
  const failingOutbox: PostingOutbox = {
    enqueue: () => Promise.reject(new Error('posting outbox unavailable')),
  };
  const eventFor = (refundId: string) => ({
    id: randomUUID(),
    tenantId: f.tenantId,
    companyId: f.companyId,
    topic: STRIPE_REFUND_APPROVED,
    aggregateType: 'customer_refund',
    aggregateId: refundId,
    payload: { refundId },
    createdAt: NOW,
  });
  const setVars = (prefix: string, credit: StripePaidCredit, r: CustomerRefundView, re: string) =>
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      [`${prefix}RefundId`]: r.refundId,
      [`${prefix}RefundNo`]: r.refundNo,
      [`${prefix}CreditNoteId`]: credit.creditNoteId,
      [`${prefix}CreditNoteNo`]: credit.creditNoteNo,
      [`${prefix}PaymentIntentId`]: credit.paymentIntentId,
      [`${prefix}StripeRefundId`]: re,
    });

  it('SS-UC11-10 F1a a posting the engine would refuse is caught before Stripe: NOT_POSTABLE, nothing sent, not retried', async () => {
    const credit = await seedCredit('Eta');
    const r = await requestRefund(credit);
    await approve(r);
    setVars('unpostable', credit, r, 're_1SQbT0172Unpostable');
    const posts = creates().length;
    // Sent on 2027-08-01: no fiscal period covers it (the fixture has FY2027 only), so the
    // engine would refuse the journal (NO_PERIOD) — Stripe must not be asked for the money.
    const later = new Date('2027-08-01T00:00:00Z');
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: later,
      }),
    );
    expect(stub.mismatches).toEqual([]);
    expect(out).toMatchObject({ status: 'failed', code: 'NOT_POSTABLE' });
    expect(out.status === 'failed' ? out.message : '').toMatch(/not sent to Stripe/);
    expect(creates().length).toBe(posts);
    expect(await entriesFor(r.refundId)).toBe(0);
    const handler = stripeRefundSendHandler({ client, now: () => later });
    const permanent = await f
      .inTenant((trx) => handler.handle(trx, eventFor(r.refundId)))
      .catch((e: unknown) => e as { errorCode?: string; retryable?: boolean });
    expect(permanent).toMatchObject({ errorCode: 'NOT_POSTABLE', retryable: false });
    expect(creates().length).toBe(posts);
  });

  it('SS-UC11-10 F1a a posting failure after Stripe accepted is a permanent SENT_NOT_POSTED; the retry adopts the Stripe refund and posts once, as the approver (F5)', async () => {
    const credit = await seedCredit('Theta');
    const r = await requestRefund(credit);
    await approve(r);
    setVars('sent', credit, r, 're_1SQbT0172SentNotPosted');
    const posts = creates().length;
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(
        trx,
        client,
        { companyId: f.companyId, refundId: r.refundId, now: NOW },
        { outbox: failingOutbox },
      ),
    );
    expect(stub.mismatches).toEqual([]);
    expect(out).toMatchObject({
      status: 'failed',
      code: 'SENT_NOT_POSTED',
      stripeRefundId: 're_1SQbT0172SentNotPosted',
    });
    expect(out.status === 'failed' ? out.message : '').toMatch(
      /sent to Stripe as re_1SQbT0172SentNotPosted.*not posted/,
    );
    expect(creates().length).toBe(posts + 1);
    expect(await entriesFor(r.refundId)).toBe(0);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'requested', approval: 'approved' });

    // The worker's attempt finds the Stripe refund, still cannot post: permanent, said plainly.
    const failing = stripeRefundSendHandler({
      client,
      now: () => NOW,
      posting: { outbox: failingOutbox },
    });
    const err = await f
      .inTenant((trx) => failing.handle(trx, eventFor(r.refundId)))
      .catch((e: unknown) => e as { errorCode?: string; retryable?: boolean; message?: string });
    expect(err).toMatchObject({ errorCode: 'SENT_NOT_POSTED', retryable: false });
    expect((err as { message?: string }).message).toMatch(
      /sent to Stripe as re_1SQbT0172SentNotPosted.*not posted/,
    );
    expect(creates().length).toBe(posts + 1);

    // Fixed and retried from Sync issues: adopts, posts once, never a second Stripe refund.
    const handler = stripeRefundSendHandler({ client, now: () => NOW });
    await f.inTenant((trx) => handler.handle(trx, eventFor(r.refundId)));
    expect(stub.mismatches).toEqual([]);
    expect(creates().length).toBe(posts + 1);
    expect(await entriesFor(r.refundId)).toBe(1);
    const paid = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId));
    expect(paid).toMatchObject({ status: 'paid' });
    const rows = await f.inTenant((trx) =>
      trx
        .selectFrom('app.stripe_refund')
        .select(['stripe_refund_id', 'created_by'])
        .where('entry_id', '=', paid.entryId ?? '')
        .execute(),
    );
    expect(rows).toEqual([{ stripe_refund_id: 're_1SQbT0172SentNotPosted', created_by: approver }]);
    // F5: the journal of a worker-retried send is attributed to the approver.
    const by = await f.inTenant(
      async (trx) =>
        (
          await sql<{ created_by: string | null }>`SELECT created_by::text FROM app.journal_entry
            WHERE id = ${paid.entryId ?? ''}::uuid`.execute(trx)
        ).rows[0]?.created_by,
    );
    expect(by).toBe(approver);
  });

  it('SS-UC11-10 F1b a lost commit after Stripe accepted never leads to a second refund, even on a re-approval a day later', async () => {
    const credit = await seedCredit('Iota');
    const r = await requestRefund(credit);
    setVars('lost', credit, r, 're_1SQbT0172LostCommit');
    stub.vars['lostOtherRefundId'] = randomUUID();
    const posts = creates().length;
    // Approve and send, then the request's transaction fails to commit.
    const lost = await f
      .inTenant(async (trx) => {
        await approveCustomerRefund(trx, {
          companyId: f.companyId,
          refundId: r.refundId,
          approvedBy: approver,
          today: '2026-11-24',
        });
        await sendStripeCustomerRefund(trx, client, {
          companyId: f.companyId,
          refundId: r.refundId,
          now: NOW,
        });
        throw new Error('connection lost before COMMIT');
      })
      .catch((e: unknown) => (e as Error).message);
    expect(lost).toBe('connection lost before COMMIT');
    expect(creates().length).toBe(posts + 1);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'requested', approval: 'pending' });
    expect(await entriesFor(r.refundId)).toBe(0);

    // Re-approved later (a fresh approval time, as after Stripe pruned the key): the send finds
    // the refund at Stripe (second page of the list) and adopts it instead of creating another.
    await approve(r);
    const sent = await f.inTenant((trx) =>
      sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(stub.mismatches).toEqual([]);
    expect(sent).toMatchObject({ stripeRefundId: 're_1SQbT0172LostCommit', replayed: false });
    expect(creates().length).toBe(posts + 1);
    expect(stub.received.slice(-2).map((x) => x.matched)).toEqual([
      'list-refunds-lost-after-page1',
      'list-refunds-lost-after-page2',
    ]);
    expect(await entriesFor(r.refundId)).toBe(1);
  });
});

describe('Security re-review R1: the lookup finds a refund whose credit note was voided afterwards', () => {
  it('SS-UC11-10 R1 a lost commit, then the credit note is voided and the refund re-approved: no second Stripe refund through another credit note', async () => {
    const credit = await seedCredit('Lambda');
    const r = await requestRefund(credit);
    Object.assign(stub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      voidedRefundId: r.refundId,
      voidedRefundNo: r.refundNo,
      voidedCreditNoteId: credit.creditNoteId,
      voidedCreditNoteNo: credit.creditNoteNo,
      voidedPaymentIntentId: credit.paymentIntentId,
      voidedStripeRefundId: 're_1SQbT0172VoidedCn',
    });
    const posts = creates().length;
    // Approve and send, then the request's transaction fails to commit: Stripe has the refund.
    const lost = await f
      .inTenant(async (trx) => {
        await approveCustomerRefund(trx, {
          companyId: f.companyId,
          refundId: r.refundId,
          approvedBy: approver,
          today: '2026-11-24',
        });
        await sendStripeCustomerRefund(trx, client, {
          companyId: f.companyId,
          refundId: r.refundId,
          now: NOW,
        });
        throw new Error('connection lost before COMMIT');
      })
      .catch((e: unknown) => (e as Error).message);
    expect(lost).toBe('connection lost before COMMIT');
    expect(creates().length).toBe(posts + 1);

    // Later the same customer pays another invoice by card and is credited again, and the
    // credit note the refund was sent for is voided.
    const second = await seedStripePaidCredit(f, {
      professionalServicesProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
      partyId: credit.partyId,
      clearingAccountId: f.acct['1210'] ?? '',
    });
    Object.assign(stub.vars, {
      voidedSecondPaymentIntentId: second.paymentIntentId,
      voidedSecondCreditNoteId: second.creditNoteId,
      voidedSecondCreditNoteNo: second.creditNoteNo,
    });
    await f.admin.query(
      `UPDATE app.credit_note SET status = 'void' WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, credit.creditNoteId],
    );

    // Re-approved (a fresh approval time): the lookup still finds the refund sent for the voided
    // credit note, so nothing new is created; it cannot be posted, which says the money is out.
    await approve(r);
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(stub.mismatches).toEqual([]);
    expect(creates().length).toBe(posts + 1);
    // The only create for this document went to the first payment, never to the second one.
    expect(
      creates()
        .filter((x) => x.idempotencyKey === `lf-refund-v2-${r.refundId}`)
        .map((x) => x.form['payment_intent']),
    ).toEqual([credit.paymentIntentId]);
    expect(out).toMatchObject({
      status: 'failed',
      code: 'SENT_NOT_POSTED',
      stripeRefundId: 're_1SQbT0172VoidedCn',
    });
    expect(await entriesFor(r.refundId)).toBe(0);
  });
});
