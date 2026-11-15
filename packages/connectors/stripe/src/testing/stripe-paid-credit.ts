/**
 * Test seed (T-0172, never imported by production code): a customer invoice of 1,375.00 (GP-001)
 * paid in full by card through Stripe (GP-003, stored as a `payment_intent.succeeded` event with
 * its PaymentIntent), then credited 200.00 + GST 20.00 (GP-005): the customer holds a 220.00
 * credit that can be refunded to the card. The payment goes through the connector's own
 * processPaymentSucceeded, so the stored facts are exactly what a webhook leaves.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createDraftInvoice,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import type { LedgerFixture } from '@ledgerforce/ledger/testing';
import { processPaymentSucceeded, setStripeSettings } from '../webhook.ts';

export interface StripePaidCredit {
  readonly partyId: string;
  readonly invoiceId: string;
  readonly paymentIntentId: string;
  readonly creditNoteId: string;
  readonly creditNoteNo: string;
  readonly creditNoteEntryId: string;
}

const noOutbox: DocumentOutbox = { publish: async () => {} };

export async function seedStripePaidCredit(
  f: LedgerFixture,
  o: {
    /** The product profile id of PROFESSIONAL_SERVICES (seedBillingCompany). */
    readonly professionalServicesProfileId: string;
    readonly partyId: string;
    /** The Stripe clearing GL account (GP-003, GP-006 Stripe variant). */
    readonly clearingAccountId: string;
  },
): Promise<StripePaidCredit> {
  const pi = `pi_${randomBytes(10).toString('hex')}`;
  return f.inTenant(async (trx) => {
    await setStripeSettings(trx, f.companyId, { clearingAccountId: o.clearingAccountId });
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: o.partyId,
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: o.professionalServicesProfileId,
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox: noOutbox },
    );
    await approveInvoice(
      trx,
      { companyId: f.companyId, invoiceId: d.invoiceId },
      { outbox: noOutbox },
    );
    await trx
      .insertInto('app.stripe_payment_link')
      .values({
        company_id: f.companyId,
        invoice_id: d.invoiceId,
        amount_due: '1375.0000',
        currency: 'AUD',
        stripe_id: `plink_${randomBytes(8).toString('hex')}`,
        url: `https://buy.stripe.com/test_${randomBytes(6).toString('hex')}`,
        livemode: false,
        idempotency_key: `lf-plink-v1-${d.invoiceId}-137500`,
        deactivated_at: null,
      })
      .execute();
    const created = Date.UTC(2026, 10, 10, 1, 0, 0) / 1000;
    const out = await processPaymentSucceeded(
      trx,
      {
        id: `evt_${randomBytes(10).toString('hex')}`,
        type: 'payment_intent.succeeded',
        created,
        livemode: false,
        data: { object: {} },
      },
      {
        id: pi,
        cents: 137500,
        currency: 'AUD',
        livemode: false,
        tenantId: f.tenantId,
        companyId: f.companyId,
        invoiceId: d.invoiceId,
      },
      { mode: 'test', outbox: noOutbox },
    );
    if (out.kind !== 'receipt') throw new Error(`seed: the Stripe payment was ${out.kind}`);
    const cn = await createCreditNote(trx, {
      companyId: f.companyId,
      invoiceId: d.invoiceId,
      id: randomUUID(),
      issueDate: '2026-11-20',
      reasonCode: 'scope_reduction',
      lines: [{ invoiceLineNo: 1, amount: '200.00' }],
    });
    const posted = await approveCreditNote(trx, {
      companyId: f.companyId,
      creditNoteId: cn.creditNoteId,
    });
    return {
      partyId: o.partyId,
      invoiceId: d.invoiceId,
      paymentIntentId: pi,
      creditNoteId: posted.creditNoteId,
      creditNoteNo: posted.creditNoteNo ?? '',
      creditNoteEntryId: posted.entryId ?? '',
    };
  });
}
