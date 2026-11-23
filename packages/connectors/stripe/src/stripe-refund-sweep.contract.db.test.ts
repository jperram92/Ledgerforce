/**
 * The nightly sweep for Stripe refunds that no refund document records (T-0208 AC-2, RQ-0185,
 * ADR-0103; review r8 R2, r10 M1(c)). Real PostgreSQL as lf_app; Stripe is the local stub replaying
 * the documented sweep fixture, which answers list requests only: any create would be a mismatch.
 *
 * SS-UC11-17: per Stripe refund document (requested, or cancelled in the last 30 days), the sweep
 * runs the read-only lookup under the party lock and publishes one `ar.refund.stripe_unrecorded`
 * event per document Stripe holds a live refund for. It records nothing (no journal, no
 * stripe_refund row, no status change), creates nothing at Stripe, publishes nothing twice while
 * the first report is open, and never sees another tenant's documents. The event's handler repeats
 * the read-only look: it fails permanently (so the dead letter becomes the Sync issue) while the
 * stray is there, and succeeds once the document is recorded by a person's "Check with Stripe".
 */
import { randomUUID } from 'node:crypto';
import {
  approveCustomerRefund,
  cancelCustomerRefund,
  createCustomerRefund,
  getCustomerRefund,
  type CustomerRefundView,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeClient } from './client.ts';
import { assertStripeRefundable, checkStripeCustomerRefund } from './refund.ts';
import {
  STRIPE_REFUND_UNRECORDED,
  STRIPE_REFUND_UNRECORDED_HANDLER,
  stripeRefundSweepCandidates,
  stripeRefundUnrecordedHandler,
  sweepStripeRefund,
} from './refund-sweep.ts';
import {
  loadCassette,
  REFUND_SWEEP_FIXTURE,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
  type StripePaidCredit,
} from './testing/index.ts';

const NOW = new Date('2026-11-24T00:00:00Z');

let f: LedgerFixture;
let other: LedgerFixture;
let stub: RecordedStripe;
let client: StripeClient;
let profiles: SeededProfiles;
let otherProfiles: SeededProfiles;
const clerk = randomUUID();
const approver = randomUUID();

/** Writes the event as the outbox would (the job itself is the worker's, tested there). */
const outbox: DocumentOutbox = {
  publish: async (trx, e) => {
    await sql`INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
      VALUES (${e.companyId}::uuid, ${e.topic}, ${e.aggregateType}, ${e.aggregateId}::uuid,
              ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  },
};

interface Doc {
  credit: StripePaidCredit;
  refund: CustomerRefundView;
}

async function seedDoc(fx: LedgerFixture, p: SeededProfiles, prefix: string): Promise<Doc> {
  const [party = ''] = await seedBillableCustomers(fx, p, {
    count: 1,
    prefix: `Sweep${prefix}`,
    billDate: '2026-11-01',
  });
  const credit = await seedStripePaidCredit(fx, {
    professionalServicesProfileId: p.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: fx.acct['1210'] ?? '',
  });
  const refund = await fx.inTenant((trx) =>
    createCustomerRefund(
      trx,
      {
        companyId: fx.companyId,
        id: randomUUID(),
        partyId: credit.partyId,
        refundDate: '2026-11-24',
        amount: '220.00',
        method: 'stripe',
        createdBy: clerk,
      },
      { stripeCheck: assertStripeRefundable },
    ),
  );
  Object.assign(stub.vars, {
    [`${prefix}RefundId`]: refund.refundId,
    [`${prefix}RefundNo`]: refund.refundNo,
    [`${prefix}CreditNoteId`]: credit.creditNoteId,
    [`${prefix}CreditNoteNo`]: credit.creditNoteNo,
    [`${prefix}PaymentIntentId`]: credit.paymentIntentId,
    [`${prefix}StripeRefundId`]: `re_1SQbT0208${prefix}`,
    [`${prefix}StripeRefundIdA`]: `re_1SQbT0208${prefix}A`,
    [`${prefix}StripeRefundIdB`]: `re_1SQbT0208${prefix}B`,
  });
  return { credit, refund };
}

const approve = (fx: LedgerFixture, d: Doc) =>
  fx.inTenant((trx) =>
    approveCustomerRefund(trx, {
      companyId: fx.companyId,
      refundId: d.refund.refundId,
      approvedBy: approver,
      today: '2026-11-24',
    }),
  );

const docs: Record<string, Doc> = {};

/** What the sweep must never change: journals, Stripe records, document status. */
const ledgerState = async (fx: LedgerFixture) =>
  (
    await fx.admin.query<{ entries: number; recorded: number; statuses: string }>(
      `SELECT (SELECT count(*)::int FROM app.journal_entry WHERE tenant_id = $1) AS entries,
              (SELECT count(*)::int FROM app.stripe_refund WHERE tenant_id = $1) AS recorded,
              (SELECT string_agg(id::text || ':' || status, ',' ORDER BY id)
                 FROM app.customer_refund WHERE tenant_id = $1) AS statuses`,
      [fx.tenantId],
    )
  ).rows[0];

const reported = async (fx: LedgerFixture) =>
  (
    await fx.admin.query<{ aggregate_id: string; payload: Record<string, unknown> }>(
      `SELECT aggregate_id::text, payload FROM app.outbox_event
        WHERE tenant_id = $1 AND topic = $2 ORDER BY created_at, id`,
      [fx.tenantId, STRIPE_REFUND_UNRECORDED],
    )
  ).rows;

const sweepAll = async (fx: LedgerFixture) => {
  const ids = await fx.inTenant((trx) => stripeRefundSweepCandidates(trx, fx.companyId));
  const out: Record<string, string | null> = {};
  for (const refundId of ids) {
    // One tenant transaction per document, as the worker does.
    const r = await fx.inTenant((trx) =>
      sweepStripeRefund(trx, client, outbox, { companyId: fx.companyId, refundId }),
    );
    out[refundId] = r.published ? r.finding : null;
  }
  return { ids, out };
};

beforeAll(async () => {
  stub = await startRecordedStripe(loadCassette(REFUND_SWEEP_FIXTURE));
  client = new StripeClient({ secretKey: 'sk_test_dummy', mode: 'test', baseUrl: stub.url });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020801');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000020802');
  for (const fx of [f, other]) {
    for (const id of [clerk, approver]) {
      await fx.admin.query(
        `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $3, 'active')`,
        [id, fx.tenantId, `${id}@t0208.test`],
      );
    }
  }
  profiles = await seedBillingCompany(f);
  otherProfiles = await seedBillingCompany(other);
  Object.assign(stub.vars, { tenantId: f.tenantId, companyId: f.companyId });
  docs['unapproved'] = await seedDoc(f, profiles, 'unapproved');
  docs['unrecorded'] = await seedDoc(f, profiles, 'unrecorded');
  docs['cancelled'] = await seedDoc(f, profiles, 'cancelled');
  docs['clean'] = await seedDoc(f, profiles, 'clean');
  docs['failedonly'] = await seedDoc(f, profiles, 'failedonly');
  docs['twice'] = await seedDoc(f, profiles, 'twice');
  for (const k of ['unrecorded', 'cancelled', 'clean', 'failedonly', 'twice']) {
    const d = docs[k];
    if (d) await approve(f, d);
  }
  // A cancelled document whose create landed at Stripe after the cancel (r10 M1(c)).
  const c = docs['cancelled'];
  if (c)
    await f.inTenant((trx) =>
      cancelCustomerRefund(
        trx,
        { companyId: f.companyId, refundId: c.refund.refundId },
        { heldAtStripe: async () => null, sendNotFinished: async () => null },
      ),
    );
}, 240_000);

afterAll(async () => {
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-17 the nightly sweep reports Stripe refunds no document records, and records and creates nothing', () => {
  it('SS-UC11-17 one report per stray document (unapproved, approved-unrecorded, cancelled, two live); none for clean or failed-only; no create, no journal; a second sweep adds nothing', async () => {
    const before = await ledgerState(f);
    const first = await sweepAll(f);
    const id = (k: string) => docs[k]?.refund.refundId ?? '';
    expect([...first.ids].sort()).toEqual(
      ['unapproved', 'unrecorded', 'cancelled', 'clean', 'failedonly', 'twice'].map(id).sort(),
    );
    expect(first.out).toEqual({
      [id('unapproved')]: 'held_unapproved',
      [id('unrecorded')]: 'held_unrecorded',
      [id('cancelled')]: 'held_cancelled',
      [id('twice')]: 'several_live',
      [id('clean')]: null,
      [id('failedonly')]: null,
    });
    const events = await reported(f);
    expect(events.map((e) => e.aggregate_id).sort()).toEqual(
      ['unapproved', 'unrecorded', 'cancelled', 'twice'].map(id).sort(),
    );
    expect(events.find((e) => e.aggregate_id === id('unrecorded'))?.payload).toEqual({
      refundId: id('unrecorded'),
      refundNo: docs['unrecorded']?.refund.refundNo,
      finding: 'held_unrecorded',
      stripeRefundIds: ['re_1SQbT0208unrecorded'],
    });
    // Read-only: no create at Stripe, nothing recorded, no status changed.
    expect(stub.received.filter((x) => x.method !== 'GET')).toEqual([]);
    expect(stub.mismatches).toEqual([]);
    expect(await ledgerState(f)).toEqual(before);

    // Idempotent: while the first reports are not delivered, a second sweep publishes nothing.
    const second = await sweepAll(f);
    expect(Object.values(second.out).filter((x) => x !== null)).toEqual([]);
    expect(await reported(f)).toHaveLength(4);
    expect(await ledgerState(f)).toEqual(before);
  });

  it("SS-UC11-17 tenant isolation: one tenant's sweep never sees, asks Stripe about or reports another tenant's documents", async () => {
    Object.assign(stub.vars, { tenantId: other.tenantId, companyId: other.companyId });
    const foreign = await seedDoc(other, otherProfiles, 'foreign');
    Object.assign(stub.vars, { tenantId: f.tenantId, companyId: f.companyId });
    const asked = stub.received.length;
    const mine = await f.inTenant((trx) => stripeRefundSweepCandidates(trx, f.companyId));
    expect(mine).not.toContain(foreign.refund.refundId);
    // Another company's id is never found under this tenant (RLS): nothing asked, nothing reported.
    const cross = await f.inTenant((trx) =>
      sweepStripeRefund(trx, client, outbox, {
        companyId: other.companyId,
        refundId: foreign.refund.refundId,
      }).then(
        (r) => r,
        (e: unknown) => (e as { code?: string }).code ?? String(e),
      ),
    );
    expect(cross).toBe('REFUND_NOT_FOUND');
    expect(stub.received.length).toBe(asked);
    expect(await reported(other)).toEqual([]);
    // Its own sweep, in its own tenant, reports its own stray.
    Object.assign(stub.vars, { tenantId: other.tenantId, companyId: other.companyId });
    const own = await sweepAll(other);
    expect(own.out).toEqual({ [foreign.refund.refundId]: 'held_unapproved' });
    expect((await reported(other)).map((e) => e.aggregate_id)).toEqual([foreign.refund.refundId]);
    Object.assign(stub.vars, { tenantId: f.tenantId, companyId: f.companyId });
  });

  it('SS-UC11-17 the report handler repeats the read-only look: a permanent HELD_AT_STRIPE error while the stray is there, success once a person recorded it', async () => {
    const handler = stripeRefundUnrecordedHandler({ client });
    expect(handler.name).toBe(STRIPE_REFUND_UNRECORDED_HANDLER);
    expect(handler.topics).toEqual([STRIPE_REFUND_UNRECORDED]);
    const d = docs['unrecorded'];
    if (!d) throw new Error('no doc');
    const event = {
      id: randomUUID(),
      tenantId: f.tenantId,
      companyId: f.companyId,
      topic: STRIPE_REFUND_UNRECORDED,
      aggregateType: 'customer_refund',
      aggregateId: d.refund.refundId,
      payload: { refundId: d.refund.refundId },
      createdAt: NOW,
    };
    const before = await ledgerState(f);
    const err = await f
      .inTenant((trx) => handler.handle(trx, event))
      .then(
        () => null,
        (e: unknown) => e as { code?: string; retryable?: boolean; message?: string },
      );
    expect(err).toMatchObject({ code: 'HELD_AT_STRIPE', retryable: false });
    expect(err?.message).toContain('re_1SQbT0208unrecorded');
    expect(err?.message).toContain(d.refund.refundNo);
    expect(err?.message).toContain('Check with Stripe');
    expect(await ledgerState(f)).toEqual(before);

    const unapproved = docs['unapproved'];
    if (!unapproved) throw new Error('no doc');
    const e2 = await f
      .inTenant((trx) => handler.handle(trx, { ...event, aggregateId: unapproved.refund.refundId }))
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(e2?.code).toBe('HELD_AT_STRIPE');
    expect(e2?.message).toMatch(/not approved/);

    // A person records it with "Check with Stripe" (the T-0189 path, which records once).
    const c = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: d.refund.refundId,
        now: NOW,
        createdBy: approver,
      }),
    );
    expect(c.outcome).toBe('recorded');
    expect(
      (await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, d.refund.refundId))).status,
    ).toBe('paid');
    // The retry of the report now succeeds (the Sync issue resolves), and records nothing more.
    const after = await ledgerState(f);
    await f.inTenant((trx) => handler.handle(trx, event));
    expect(await ledgerState(f)).toEqual(after);
    // A paid document is no longer a sweep candidate.
    expect(await f.inTenant((trx) => stripeRefundSweepCandidates(trx, f.companyId))).not.toContain(
      d.refund.refundId,
    );
    expect(stub.received.filter((x) => x.method !== 'GET')).toEqual([]);
  });
});
