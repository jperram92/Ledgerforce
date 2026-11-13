/**
 * POST /webhooks/stripe (T-0074, ADR-0049, RQ-0104): a public route verified by the Stripe
 * signature over the raw body. A bad signature or a stale timestamp answers 400 and posts nothing
 * (SS-UC03-06); a genuine delivery posts the receipt and a redelivery is acknowledged as a
 * duplicate (SS-UC03-02, SS-UC03-05); without a configured secret the route answers 503.
 * Real PostgreSQL as lf_app; the signing secret is generated per run.
 */
import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { approveInvoice, createDraftInvoice, type DocumentEvent } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { setStripeSettings } from '@ledgerforce/connector-stripe';
import { NO_OUTBOX } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const secret = `whsec_${randomBytes(24).toString('hex')}`;
let f: LedgerFixture;
let api: Api;
let unconfigured: Api;
let invoiceId = '';
const published: DocumentEvent[] = [];

const event = (eventId: string, pi: string) =>
  JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: pi,
        object: 'payment_intent',
        amount_received: 125000,
        currency: 'aud',
        livemode: false,
        status: 'succeeded',
        metadata: {
          lf_tenant_id: f.tenantId,
          lf_company_id: f.companyId,
          lf_invoice_id: invoiceId,
          lf_invoice_no: 'INV-000001',
        },
      },
    },
  });

const sign = (body: string, t = Math.floor(Date.now() / 1000), s = secret) =>
  `t=${String(t)},v1=${createHmac('sha256', s)
    .update(`${String(t)}.${body}`)
    .digest('hex')}`;

async function deliver(target: Api, body: string, signature?: string) {
  const res = await fetch(`${target.url}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'stripe-signature': signature }),
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const counts = () =>
  f.inTenant(async (trx) => {
    const r = await sql<{ receipts: string; entries: string; events: string }>`
      SELECT (SELECT count(*) FROM app.customer_receipt)::text AS receipts,
             (SELECT count(*) FROM app.journal_entry WHERE source_type = 'payments_stripe_charge')::text AS entries,
             (SELECT count(*) FROM app.stripe_webhook_event)::text AS events`.execute(trx);
    return r.rows[0];
  });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007402');
  const profiles = await seedBillingCompany(f);
  const [partyId = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  invoiceId = await f.inTenant(async (trx) => {
    const outbox = { publish: async () => {} };
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate: '2026-07-01', // before the run's clock: Stripe dates the payment now
        lines: [
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '1136.36',
          },
        ],
      },
      { outbox },
    );
    const posted = await approveInvoice(
      trx,
      { companyId: f.companyId, invoiceId: d.invoiceId },
      { outbox },
    );
    // Precondition from T-0073: the invoice was sent with a Stripe Payment Link.
    await trx
      .insertInto('app.stripe_payment_link')
      .values({
        company_id: f.companyId,
        invoice_id: d.invoiceId,
        amount_due: posted.gross ?? '0',
        currency: 'AUD',
        stripe_id: 'plink_1T0074Api',
        url: 'https://buy.stripe.com/test_t0074api',
        livemode: false,
        idempotency_key: `lf-plink-v1-${d.invoiceId}-api`,
        deactivated_at: null,
      })
      .execute();
    await setStripeSettings(trx, f.companyId, { clearingAccountId: f.acct['1210'] ?? '' });
    return d.invoiceId;
  });
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    stripeWebhook: { secrets: [secret], mode: 'test' },
    documentOutbox: {
      publish: async (_t, e) => {
        published.push(e);
      },
    },
    postingOutbox: NO_OUTBOX,
  });
  unconfigured = await createApi({ databaseUrl: f.tdb.url('lf_app'), postingOutbox: NO_OUTBOX });
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (unconfigured as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

/** A signing value Stripe never issued, to prove forged signatures are refused (not a credential). */
const FORGED_SIGNING_VALUE = ['whsec', '1'.repeat(48)].join('_');

describe('SS-UC03-06 POST /webhooks/stripe refuses what Stripe did not sign just now', () => {
  it('SS-UC03-06: Invalid or replayed webhook rejected — bad signature and stale timestamp both answer 400 and nothing is posted', async () => {
    const body = event('evt_1T0074BadSig', 'pi_1T0074BadSig');
    const forged = await deliver(api, body, sign(body, undefined, FORGED_SIGNING_VALUE));
    expect(forged).toEqual({ status: 400, body: { error: 'no_matching_signature' } });
    const old = Math.floor(Date.now() / 1000) - 301;
    const replayed = await deliver(api, body, sign(body, old));
    expect(replayed).toEqual({ status: 400, body: { error: 'timestamp_outside_tolerance' } });
    expect(await counts()).toEqual({ receipts: '0', entries: '0', events: '0' });
  });

  it('SS-UC03-06 a missing header, a body altered after signing and a non-JSON body answer 400', async () => {
    const body = event('evt_1T0074AltSig', 'pi_1T0074AltSig');
    expect((await deliver(api, body)).body).toEqual({ error: 'missing_header' });
    const altered = await deliver(api, body.replace('125000', '999900'), sign(body));
    expect(altered).toEqual({ status: 400, body: { error: 'no_matching_signature' } });
    const res = await fetch(`${api.url}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'stripe-signature': sign('x') },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ receipts: '0', entries: '0', events: '0' });
  });

  it('SS-UC03-06 without a configured signing secret the route answers 503 and verifies nothing', async () => {
    const body = event('evt_1T0074SigOff', 'pi_1T0074SigOff');
    expect(await deliver(unconfigured, body, sign(body))).toEqual({
      status: 503,
      body: { error: 'stripe_webhook_not_configured' },
    });
  });
});

describe('SS-UC03-05 a genuine delivery posts once', () => {
  it('SS-UC03-05 the signed payment posts one receipt; Stripe retrying the same event gets 200 duplicate', async () => {
    const body = event('evt_1T0074SigOk', 'pi_1T0074SigOk');
    const first = await deliver(api, body, sign(body));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, outcome: 'receipt' });
    const again = await deliver(api, body, sign(body));
    expect(again).toEqual({ status: 200, body: { received: true, outcome: 'duplicate' } });
    expect(await counts()).toEqual({ receipts: '1', entries: '1', events: '1' });
    // The customer is not linked to a Salesforce Account: nothing to write back.
    expect(published.map((e) => e.topic)).toEqual([]);
    // One audit row, by the integration, for the one mutation.
    const audit = await f.admin.query<{ actor_type: string; entity_type: string }>(
      `SELECT actor_type, entity_type FROM audit.audit_log WHERE action = 'stripe.payment_received'`,
    );
    expect(audit.rows).toEqual([{ actor_type: 'integration', entity_type: 'customer_receipt' }]);
  });
});
