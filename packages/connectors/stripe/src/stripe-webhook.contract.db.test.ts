/**
 * Stripe payment webhook → GP-003 receipt into Stripe clearing, write-back and refund
 * (T-0074, RQ-0104, ADR-0049; SS-UC03-02, SS-UC03-04, SS-UC03-05, SS-UC11-04).
 *
 * Real PostgreSQL as lf_app. The invoice gets its Payment Link through T-0073's
 * ensureInvoicePaymentLink against the local Stripe stub replaying the documented fixture; the
 * webhook body is signed here with a per-run secret (node:crypto, independent of the verifier);
 * the write-back event is sent to the local fake Salesforce REST API; the refund goes to the
 * Stripe stub replaying the documented refunds fixture. Never the network.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createDraftInvoice,
  invoicePaymentStatus,
  recordReceipt,
  type DocumentEvent,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { mapToRecords, parseWriteBackPayload, writeBack } from '@ledgerforce/connector-salesforce';
import {
  startFakeSalesforceRest,
  type FakeSalesforceRest,
} from '@ledgerforce/connector-salesforce/testing';
import { seedBillingFormats } from '@ledgerforce/documents';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeClient } from './client.ts';
import { ensureInvoicePaymentLink } from './payment-link.ts';
import { refundCreditViaStripe } from './refund.ts';
import {
  loadCassette,
  PAYMENT_LINKS_FIXTURE,
  REFUNDS_FIXTURE,
  startRecordedStripe,
  type RecordedStripe,
} from './testing/index.ts';
import { handleStripeWebhook, setStripeSettings, type StripeWebhookConfig } from './webhook.ts';
import { WebhookSignatureError } from './webhook-signature.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const golden = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const gp003 = golden.find((t) => t.entryId === 'GP-003');
const gp006 = golden.find((t) => t.entryId === 'GP-006');

const ACCOUNT_SF = '001TEST00000074AAA';
const OPPORTUNITY_SF = '006TEST00000074AAA';
const SF_INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const SF_TOKEN = '00DTEST000000000!t0074';
const PAID_AT = Date.UTC(2026, 10, 15, 3, 0, 0) / 1000; // 2026-11-15 03:00 UTC
const secret = `whsec_${randomBytes(24).toString('hex')}`;

let f: LedgerFixture;
let profiles: SeededProfiles;
let acme = '';
let linkStub: RecordedStripe;
let refundStub: RecordedStripe;
let sf: FakeSalesforceRest;
const published: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_t, e) => {
    published.push(e);
  },
};
let invoice = { id: '', no: '' };
let cfg: StripeWebhookConfig;

const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

async function postStripeInvoice(opportunity: string | null) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: acme,
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        ...(opportunity ? { salesforceOpportunityId: opportunity } : {}),
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
      { outbox },
    );
    const fmt = await trx
      .selectFrom('app.billing_format')
      .select('id')
      .where('company_id', '=', f.companyId)
      .where('code', '=', 'STANDARD')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('app.sales_invoice')
      .set({ billing_format_id: fmt.id })
      .where('id', '=', d.invoiceId)
      .execute();
    const posted = await approveInvoice(
      trx,
      { companyId: f.companyId, invoiceId: d.invoiceId },
      { outbox },
    );
    return { id: d.invoiceId, no: posted.invoiceNo ?? '' };
  });
}

function paymentIntentEvent(o: {
  eventId: string;
  pi: string;
  cents: number;
  invoiceId: string;
  currency?: string;
  livemode?: boolean;
  tenantId?: string;
}) {
  return JSON.stringify({
    id: o.eventId,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: PAID_AT,
    livemode: o.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: o.pi,
        object: 'payment_intent',
        amount: o.cents,
        amount_received: o.cents,
        currency: o.currency ?? 'aud',
        latest_charge: `ch_${o.pi.slice(3)}`,
        livemode: o.livemode ?? false,
        status: 'succeeded',
        metadata: {
          lf_tenant_id: o.tenantId ?? f.tenantId,
          lf_company_id: f.companyId,
          lf_invoice_id: o.invoiceId,
          lf_invoice_no: invoice.no,
        },
      },
    },
  });
}

const sign = (body: string, t = PAID_AT + 2, s = secret) =>
  `t=${String(t)},v1=${createHmac('sha256', s)
    .update(`${String(t)}.${body}`)
    .digest('hex')}`;

const deliver = (body: string, header = sign(body)) =>
  handleStripeWebhook(f.db, Buffer.from(body), header, cfg);

const counts = () =>
  f.inTenant(async (trx) => {
    const r = await sql<{ receipts: string; entries: string; events: string }>`
      SELECT (SELECT count(*) FROM app.customer_receipt)::text AS receipts,
             (SELECT count(*) FROM app.journal_entry WHERE source_type = 'payments_stripe_charge')::text AS entries,
             (SELECT count(*) FROM app.stripe_webhook_event)::text AS events`.execute(trx);
    return r.rows[0];
  });

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
        }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id::text, e.source_type
          FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
          JOIN app.journal_entry e ON e.id = l.entry_id
         WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(trx)
      ).rows,
  );
}

const CODE_OF: Record<string, string> = {
  'setting:stripe.clearing_account': '1210',
  'system:AR_CONTROL': '1200',
  'bank:OPERATING': '1010',
};

beforeAll(async () => {
  linkStub = await startRecordedStripe(loadCassette(PAYMENT_LINKS_FIXTURE));
  refundStub = await startRecordedStripe(loadCassette(REFUNDS_FIXTURE));
  sf = await startFakeSalesforceRest({
    instanceUrl: SF_INSTANCE,
    acceptToken: (t) => t === SF_TOKEN,
  });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007401');
  profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    await seedBillingFormats(trx, f.companyId);
    await trx
      .updateTable('app.party')
      .set({ salesforce_account_id: ACCOUNT_SF })
      .where('id', '=', acme)
      .execute();
    await setStripeSettings(trx, f.companyId, { clearingAccountId: f.acct['1210'] ?? '' });
  });
  invoice = await postStripeInvoice(OPPORTUNITY_SF);
  Object.assign(linkStub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    invoiceId: invoice.id,
    invoiceNo: invoice.no,
  });
  const client = new StripeClient({
    secretKey: 'sk_test_dummy',
    mode: 'test',
    baseUrl: linkStub.url,
  });
  await f.inTenant((trx) => ensureInvoicePaymentLink(trx, client, f.companyId, invoice.id));
  cfg = { secrets: [secret], mode: 'test', outbox, now: () => PAID_AT + 5 };
}, 180_000);

afterAll(async () => {
  await (linkStub as RecordedStripe | undefined)?.close();
  await (refundStub as RecordedStripe | undefined)?.close();
  await (sf as FakeSalesforceRest | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

let receiptEntryId = '';
let paymentIntentId = '';

describe('SS-UC03-02 Stripe payment webhook posts GP-003', () => {
  it('SS-UC03-02: Stripe payment posts GP-003 and marks invoice Paid', async () => {
    expect(gp003?.sourceType).toBe('payments.stripe.charge');
    expect(invoice.no).toBe('INV-000001');
    paymentIntentId = `pi_${randomBytes(8).toString('hex')}`;
    const body = paymentIntentEvent({
      eventId: 'evt_1T0074Paid000123',
      pi: paymentIntentId,
      cents: 137500,
      invoiceId: invoice.id,
    });
    const out = await deliver(body);
    expect(out).toMatchObject({ kind: 'receipt', invoiceId: invoice.id, amount: '1375.0000' });
    if (out.kind !== 'receipt') throw new Error('expected a receipt');
    receiptEntryId = out.entryId;

    const rows = await journal(out.entryId);
    expect(rows).toHaveLength(gp003?.lines.length ?? -1);
    gp003?.lines.forEach((g, i) => {
      const at = `GP-003 line ${String(i + 1)}`;
      expect(rows[i]?.code, at).toBe(CODE_OF[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
    expect(rows.every((r) => r.source_type === 'payments_stripe_charge')).toBe(true);
    expect(await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, invoice.id))).toEqual({
      status: 'paid',
      open: '0.0000',
    });
    const receipt = await f.inTenant((trx) =>
      trx
        .selectFrom('app.customer_receipt')
        .select(['method', 'reference', 'idempotency_key'])
        .where('entry_id', '=', out.entryId)
        .executeTakeFirstOrThrow(),
    );
    expect(receipt).toEqual({
      method: 'card',
      reference: paymentIntentId,
      idempotency_key: `stripe:${paymentIntentId}`,
    });
  });
});

describe('SS-UC03-04 write-back of the Stripe payment', () => {
  it('SS-UC03-04: Salesforce shows Paid with payment date', async () => {
    const ev = published.filter((e) => e.topic === 'payment.received');
    expect(ev).toHaveLength(1);
    sf.seed('Account', ACCOUNT_SF, { LF_Balance_Due__c: '1375.00' });
    sf.seed('Opportunity', OPPORTUNITY_SF, { LF_Amount_Paid__c: '0.00' });
    const records = mapToRecords(parseWriteBackPayload(ev[0]?.payload));
    const report = await writeBack(
      { http: sf.http, instanceUrl: SF_INSTANCE, accessToken: SF_TOKEN },
      records,
    );
    expect(report.created).toBe(2);
    const inv = sf.store.get('LF_Invoice__c')?.get(invoice.id);
    expect(inv).toMatchObject({
      Name: invoice.no,
      LF_Status__c: 'Paid',
      LF_Last_Payment_Date__c: '2026-11-15',
      LF_Amount_Due__c: '0.00',
      LF_Total__c: '1375.00',
    });
    const payments = [...(sf.store.get('LF_Payment__c')?.values() ?? [])];
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      LF_Invoice__c: inv?.Id,
      LF_Payment_Date__c: '2026-11-15',
      LF_Amount__c: '1375.00',
      LF_Method__c: 'card',
      LF_Reference__c: paymentIntentId,
    });
    expect(sf.store.get('Opportunity')?.get(OPPORTUNITY_SF)).toMatchObject({
      LF_Amount_Paid__c: '1375.00',
      LF_Amount_Invoiced__c: '1375.00',
      LF_Invoice_Status__c: 'Paid',
    });
    expect(sf.store.get('Account')?.get(ACCOUNT_SF)).toMatchObject({
      LF_Balance_Due__c: '0.00',
      LF_Last_Payment_Date__c: '2026-11-15',
    });
  });
});

describe('SS-UC03-05 duplicate delivery', () => {
  it('SS-UC03-05: Duplicate webhook is idempotent', async () => {
    const before = await counts();
    expect(before).toEqual({ receipts: '1', entries: '1', events: '1' });
    const body = paymentIntentEvent({
      eventId: 'evt_1T0074Paid000123',
      pi: paymentIntentId,
      cents: 137500,
      invoiceId: invoice.id,
    });
    // Same event again (Stripe retry), and concurrently twice more.
    const outs = await Promise.all([deliver(body), deliver(body), deliver(body)]);
    expect(outs.map((o) => o.kind)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    // A different event id for the same PaymentIntent does not post a second receipt either.
    const other = await deliver(
      paymentIntentEvent({
        eventId: 'evt_1T0074Paid000124',
        pi: paymentIntentId,
        cents: 137500,
        invoiceId: invoice.id,
      }),
    );
    expect(other.kind).toBe('duplicate');
    expect(await counts()).toEqual(before);
    expect(published.filter((e) => e.topic === 'payment.received')).toHaveLength(1);
  });

  it('SS-UC03-05 a refused delivery stores nothing, so the genuine one still posts later', async () => {
    const pi = `pi_${randomBytes(8).toString('hex')}`;
    const second = await postStripeInvoice(null);
    const body = paymentIntentEvent({
      eventId: 'evt_1T0074Second0001',
      pi,
      cents: 50000,
      invoiceId: second.id,
    });
    const refused = await deliver(body, sign(body, PAID_AT + 2, `whsec_${'0'.repeat(48)}`)).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(WebhookSignatureError);
    const before = await counts();
    const out = await deliver(body);
    // No Payment Link was ever created for this invoice: acknowledged, nothing posted.
    expect(out).toEqual({
      kind: 'ignored',
      eventId: 'evt_1T0074Second0001',
      reason: 'no_payment_link',
    });
    expect(await counts()).toEqual(before);
  });

  it('SS-UC03-05 signed events that are not ours to post are acknowledged and post nothing', async () => {
    const before = await counts();
    const pi = `pi_${randomBytes(8).toString('hex')}`;
    const base = { pi, cents: 137500, invoiceId: invoice.id };
    const outs = await Promise.all([
      deliver(paymentIntentEvent({ ...base, eventId: 'evt_1T0074Live', livemode: true })),
      deliver(paymentIntentEvent({ ...base, eventId: 'evt_1T0074Usd', currency: 'usd' })),
      deliver(
        paymentIntentEvent({
          ...base,
          eventId: 'evt_1T0074Tenant',
          tenantId: '01900000-0000-7000-8000-0000000074ff',
        }),
      ),
      deliver(
        JSON.stringify({
          id: 'evt_1T0074Other',
          object: 'event',
          type: 'customer.created',
          created: PAID_AT,
          livemode: false,
          data: { object: { id: 'cus_1', object: 'customer' } },
        }),
      ),
    ]);
    expect(outs.map((o) => (o.kind === 'ignored' ? o.reason : o.kind))).toEqual([
      'livemode_mismatch',
      'currency_mismatch',
      'unknown_invoice',
      'unhandled_event_type',
    ]);
    expect(await counts()).toEqual(before);
  });
});

describe('SS-UC11-04 refund through Stripe', () => {
  it('SS-UC11-04: Refund via Stripe calls the refund API', async () => {
    expect(gp006?.sourceType).toBe('ar.refund');
    const cn = await f.inTenant(async (trx) => {
      const d = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: invoice.id,
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
    });
    Object.assign(refundStub.vars, {
      tenantId: f.tenantId,
      companyId: f.companyId,
      creditNoteId: cn.creditNoteId,
      creditNoteNo: cn.creditNoteNo,
      paymentIntentId,
    });
    const client = new StripeClient({
      secretKey: 'sk_test_dummy',
      mode: 'test',
      baseUrl: refundStub.url,
    });
    const r = await f.inTenant((trx) =>
      refundCreditViaStripe(trx, client, {
        companyId: f.companyId,
        creditNoteId: cn.creditNoteId,
        amount: '220.00',
        refundDate: '2026-11-24',
      }),
    );
    expect(refundStub.mismatches).toEqual([]);
    expect(refundStub.received.map((x) => [x.path, x.form['amount'], x.matched])).toEqual([
      ['/v1/refunds', '22000', 'refund-credit-note-220.00'],
    ]);
    expect(r).toMatchObject({ stripeRefundId: 're_1SQbTestRefund000220', amount: '220.0000' });

    // GP-006, Stripe variant: line 2 is Stripe clearing instead of the bank.
    const rows = await journal(r.entryId);
    expect(rows).toHaveLength(gp006?.lines.length ?? -1);
    gp006?.lines.forEach((g, i) => {
      const at = `GP-006 (Stripe) line ${String(i + 1)}`;
      const binding =
        g.binding === 'bank:OPERATING' ? 'setting:stripe.clearing_account' : g.binding;
      expect(rows[i]?.code, at).toBe(CODE_OF[binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
    expect(rows.every((x) => x.source_type === 'ar_refund')).toBe(true);
    // Credit note and refund settle each other; Acme's AR is 0.00.
    const cnItem = await f.inTenant((trx) => subledgerEntriesOf(trx, cn.entryId ?? ''));
    const refundItem = await f.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
    expect(cnItem[0]?.openAmount).toBe('0.0000');
    expect(refundItem[0]?.openAmount).toBe('0.0000');

    // Repeating the call (same credit note) neither calls Stripe nor posts again.
    const again = await f.inTenant((trx) =>
      refundCreditViaStripe(trx, client, {
        companyId: f.companyId,
        creditNoteId: cn.creditNoteId,
        amount: '220.00',
        refundDate: '2026-11-24',
      }),
    );
    expect(again).toMatchObject({ entryId: r.entryId, replayed: true });
    expect(refundStub.received).toHaveLength(1);
    expect(receiptEntryId).not.toBe('');
  });

  it('SS-UC11-04 a refund beyond the credit or without a Stripe payment is refused before Stripe is called', async () => {
    const plain = await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: acme,
          issueDate: '2026-11-06',
          lines: [
            {
              productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
              description: 'Professional services',
              quantity: '1',
              unitPrice: '100.00',
            },
          ],
        },
        { outbox },
      );
      await approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
      // Paid by bank transfer (GP-002), so the credit note is held as customer credit.
      await recordReceipt(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-10',
        amount: '110.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 't0074-eft-plain',
        allocations: [{ invoiceId: d.invoiceId, amount: '110.00' }],
      });
      const c = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: d.invoiceId,
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '10.00' }],
      });
      return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: c.creditNoteId });
    });
    const client = new StripeClient({
      secretKey: 'sk_test_dummy',
      mode: 'test',
      baseUrl: refundStub.url,
    });
    const refund = (amount: string) =>
      f
        .inTenant((trx) =>
          refundCreditViaStripe(trx, client, {
            companyId: f.companyId,
            creditNoteId: plain.creditNoteId,
            amount,
            refundDate: '2026-11-24',
          }),
        )
        .catch((e: unknown) => (e as { code?: string }).code);
    expect(await refund('11.01')).toBe('EXCEEDS_CREDIT');
    expect(await refund('11.00')).toBe('NO_STRIPE_PAYMENT');
    expect(refundStub.received).toHaveLength(1);
  });
});
