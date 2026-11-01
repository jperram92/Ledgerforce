/**
 * Document email over SMTP (T-0042, ADR-0046, DL-0270), against a real PostgreSQL as lf_app and an
 * in-process SMTP sink speaking real SMTP to nodemailer. The invoice email is driven by the
 * `ar.invoice.posted` outbox event that T-0040 publishes; the PDF is rendered by T-0041.
 */
import { randomUUID } from 'node:crypto';
import {
  approveInvoice,
  createDraftInvoice,
  type DocumentEvent,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { PdfRenderer } from '@ledgerforce/documents';
import { auServicesSmb } from '@ledgerforce/gl';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmailError, invoiceEmailHandler, sendRemittanceAdvice } from './invoice-email.ts';
import { resolveRecipients } from './recipients.ts';
import { SmtpSender } from './sender.ts';
import { SmtpSink } from './testing/smtp-sink.ts';

let f: LedgerFixture;
const sink = new SmtpSink();
const renderer = new PdfRenderer();
let sender: SmtpSender;
const published: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_t, e) => {
    published.push(e);
  },
};
let acme = '';
let supplier = '';

async function contact(
  trx: Parameters<Parameters<LedgerFixture['inTenant']>[0]>[0],
  party: string,
  name: string,
  email: string,
  role: 'billing_to' | 'billing_cc' | 'remittance',
) {
  const c = await trx
    .insertInto('app.party_contact')
    .values({ company_id: f.companyId, party_id: party, name, email })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.party_contact_role')
    .values({ company_id: f.companyId, party_id: party, contact_id: c.id, role })
    .execute();
}

beforeAll(async () => {
  await sink.start();
  sender = new SmtpSender({ url: sink.url, from: 'Harbour Co <billing@harbour.example>' });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004201');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `E${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ar_invoice_document', prefix: 'INV-' })
      .execute();
    await trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd', abn: '51824753556' })
      .where('id', '=', f.companyId)
      .execute();
    await seedTaxCodes(trx, f.companyId);
    const profiles = await seedPostingProfiles(
      trx,
      f.companyId,
      auServicesSmb,
      new Map(Object.entries(f.acct)),
    );
    for (const [name, role] of [
      ['Acme', 'customer'],
      ['Supplier', 'supplier'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: f.companyId, party_id: p.id, role })
        .execute();
      if (name === 'Acme') acme = p.id;
      else supplier = p.id;
    }
    await setPartyProfiles(trx, f.companyId, acme, {
      customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
    });
    await contact(trx, acme, 'Acme Accounts', 'accounts@acme.example', 'billing_to');
    await contact(trx, acme, 'Acme CFO', 'cfo@acme.example', 'billing_cc');
    await contact(trx, supplier, 'Supplier AR', 'ar@supplier.example', 'remittance');
    const draft = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: acme,
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
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
    await approveInvoice(trx, { companyId: f.companyId, invoiceId: draft.invoiceId }, { outbox });
  });
}, 120_000);

afterAll(async () => {
  await renderer.close();
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

const outboxEvent = (e: DocumentEvent) => ({
  id: randomUUID(),
  tenantId: f.tenantId,
  companyId: e.companyId,
  topic: e.topic,
  aggregateType: e.aggregateType,
  aggregateId: e.aggregateId,
  payload: e.payload,
  createdAt: new Date(),
});

describe('SS-UC01-03 / SS-UC02-04: invoice emailed with its PDF to Billing To and CC', () => {
  it('SS-UC01-03 SS-UC02-04 the posted invoice event sends one email To the Billing To contact, Cc the Billing CC, with the PDF attached; redelivery sends nothing', async () => {
    const posted = published.find((e) => e.topic === 'ar.invoice.posted');
    expect(posted).toBeDefined();
    const event = outboxEvent(posted as DocumentEvent);
    const handler = invoiceEmailHandler({ sender, renderer });
    expect(handler.topics).toEqual(['ar.invoice.posted']);
    await f.inTenant((trx) => handler.handle(trx, event));
    expect(sink.messages).toHaveLength(1);
    const m = sink.messages[0];
    const invoiceNo = String(posted?.payload['invoiceNo']);
    expect([...(m?.to ?? [])].sort()).toEqual(['accounts@acme.example', 'cfo@acme.example']);
    expect(m?.raw).toMatch(/^To: accounts@acme\.example$/m);
    expect(m?.raw).toMatch(/^Cc: cfo@acme\.example$/m);
    expect(m?.raw).toMatch(
      new RegExp(`^Subject: Tax invoice ${invoiceNo} from Harbour Co Pty Ltd$`, 'm'),
    );
    expect(m?.raw).toMatch(/Content-Type: application\/pdf; name=INV-\d{6}\.pdf/);
    expect(m?.raw).toContain('$1,375.00');
    // A redelivered event (or a second handler run) sends nothing more.
    await f.inTenant((trx) => handler.handle(trx, event));
    await f.inTenant((trx) => handler.handle(trx, { ...event, id: randomUUID() }));
    expect(sink.messages).toHaveLength(1);
  }, 60_000);
});

describe('SS-UC06-08: Remittance advices emailed', () => {
  it('SS-UC06-08 the supplier Remittance contact receives one advice listing the bills paid', async () => {
    const before = sink.messages.length;
    await f.inTenant((trx) =>
      sendRemittanceAdvice(
        trx,
        {
          companyId: f.companyId,
          partyId: supplier,
          paymentReference: 'PAY-000001',
          paymentDate: '2026-11-30',
          bills: [
            { billNo: 'BILL-000045', amount: '2750.00' },
            { billNo: 'BILL-000046', amount: '99.95' },
          ],
        },
        { sender },
      ),
    );
    expect(sink.messages).toHaveLength(before + 1);
    const m = sink.messages.at(-1);
    expect(m?.to).toEqual(['ar@supplier.example']);
    expect(m?.raw).toContain('BILL-000045');
    expect(m?.raw).toContain('$2,750.00');
    expect(m?.raw).toContain('BILL-000046');
    expect(m?.raw).toContain('$2,849.95');
  });

  it('a party without the contact role gets no email: NO_RECIPIENT', async () => {
    expect(
      await f.inTenant((trx) => resolveRecipients(trx, f.companyId, acme, 'remittance')),
    ).toEqual({
      to: [],
      cc: [],
    });
    const err = await f
      .inTenant((trx) =>
        sendRemittanceAdvice(
          trx,
          {
            companyId: f.companyId,
            partyId: acme,
            paymentReference: 'PAY-2',
            paymentDate: '2026-11-30',
            bills: [],
          },
          { sender },
        ),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).code).toBe('NO_RECIPIENT');
  });
});
