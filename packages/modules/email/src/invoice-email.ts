/**
 * Document email (T-0042, design §5.7, ADR-0046, DL-0270).
 *
 * - invoiceEmailHandler: outbox handler for `ar.invoice.posted` (T-0040). Renders the tax invoice
 *   (T-0041 template + PDF), resolves To = Billing To, Cc = Billing CC at send time, sends one
 *   email with the PDF attached and records it in app.email_delivery (dedupe key invoice:<id>), so
 *   redelivery or a second event for the same invoice sends nothing more (at-least-once only
 *   across a crash between send and commit).
 *   With a payment-link provider (T-0073: Stripe), an invoice whose billing format offers online
 *   payment carries a "Pay online" link for the amount due in the PDF, the HTML and the text body.
 * - sendRemittanceAdvice: one advice to the supplier's Remittance contact listing the bills paid
 *   (called by the payment-batch confirmation, T-0057).
 * Amounts are formatted from decimal strings (no floating point).
 */
import type { Database } from '@ledgerforce/db';
import {
  formatDate,
  formatMoney,
  loadInvoiceDocument,
  renderInvoiceHtml,
  type InvoicePaymentLinkProvider,
  type PdfRenderer,
} from '@ledgerforce/documents';
import type { OutboxEvent, OutboxHandler } from '@ledgerforce/outbox';
import type { Transaction } from 'kysely';
import { resolveRecipients, type EmailPurpose } from './recipients.ts';
import type { EmailMessage, EmailSender } from './sender.ts';

type Trx = Transaction<Database>;

export const INVOICE_POSTED_TOPIC = 'ar.invoice.posted';

export class EmailError extends Error {
  readonly code: 'NO_RECIPIENT' | 'INVALID_EVENT';
  constructor(code: 'NO_RECIPIENT' | 'INVALID_EVENT', message: string) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
  }
}

export async function alreadySent(trx: Trx, companyId: string, key: string): Promise<boolean> {
  const r = await trx
    .selectFrom('app.email_delivery')
    .select('id')
    .where('company_id', '=', companyId)
    .where('dedupe_key', '=', key)
    .executeTakeFirst();
  return r !== undefined;
}

/** Send once per dedupe key: skip if recorded, send, then record (same transaction). */
export async function sendOnce(
  trx: Trx,
  sender: EmailSender,
  c: { companyId: string; purpose: EmailPurpose; key: string; message: EmailMessage },
): Promise<boolean> {
  if (await alreadySent(trx, c.companyId, c.key)) return false;
  const messageId = await sender.send(c.message);
  await trx
    .insertInto('app.email_delivery')
    .values({
      company_id: c.companyId,
      purpose: c.purpose,
      dedupe_key: c.key,
      to_addrs: [...c.message.to],
      cc_addrs: [...(c.message.cc ?? [])],
      subject: c.message.subject,
      message_id: messageId.slice(0, 500),
    })
    .execute();
  return true;
}

export function invoiceEmailHandler(deps: {
  sender: EmailSender;
  renderer: PdfRenderer;
  /** Optional online payment link (T-0073); without it invoices carry no link. */
  paymentLinks?: InvoicePaymentLinkProvider;
}): OutboxHandler {
  return {
    name: 'email.invoice_posted',
    topics: [INVOICE_POSTED_TOPIC],
    async handle(trx: Trx, event: OutboxEvent): Promise<void> {
      const companyId = event.companyId;
      const partyId = event.payload['partyId'];
      if (!companyId || typeof partyId !== 'string') {
        throw new EmailError('INVALID_EVENT', `event ${event.id} has no company or party`);
      }
      const key = `invoice:${event.aggregateId}`;
      if (await alreadySent(trx, companyId, key)) return;
      const recipients = await resolveRecipients(trx, companyId, partyId, 'invoice');
      if (recipients.to.length === 0) {
        throw new EmailError(
          'NO_RECIPIENT',
          `invoice ${event.aggregateId}: the customer has no Billing To contact`,
        );
      }
      const loaded = await loadInvoiceDocument(trx, companyId, event.aggregateId);
      const link = await deps.paymentLinks?.ensure(trx, companyId, event.aggregateId);
      const doc = link ? { ...loaded, paymentLink: link } : loaded;
      const html = renderInvoiceHtml(doc);
      const pdf = await deps.renderer.render(html);
      await sendOnce(trx, deps.sender, {
        companyId,
        purpose: 'invoice',
        key,
        message: {
          to: recipients.to,
          cc: recipients.cc,
          subject: `Tax invoice ${doc.invoiceNo} from ${doc.supplier.legalName}`,
          text:
            `Please find attached tax invoice ${doc.invoiceNo} from ${doc.supplier.legalName}.\n` +
            `Amount due: ${formatMoney(link ? link.amountDue : doc.gross)}, due ${formatDate(doc.dueDate)}.\n` +
            (link ? `Pay online: ${link.url}\n` : ''),
          html,
          attachments: [
            { filename: `${doc.invoiceNo}.pdf`, contentType: 'application/pdf', content: pdf },
          ],
        },
      });
    },
  };
}

export interface RemittanceAdvice {
  readonly companyId: string;
  readonly partyId: string;
  /** The payment's reference (batch line or payment number); one advice per reference. */
  readonly paymentReference: string;
  readonly paymentDate: string;
  /**
   * Bills paid: number and amount as decimal strings, and the supplier's own invoice number
   * (`reference`), which is what the supplier matches the payment against (T-0057).
   */
  readonly bills: readonly {
    readonly billNo: string;
    readonly amount: string;
    readonly reference?: string;
  }[];
}

/** "2750.00" → 275000n cents (amounts are cents; extra decimals are not expected here). */
const cents = (v: string): bigint => {
  const [i = '0', f = ''] = v.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
};
const fromCents = (c: bigint) =>
  `${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, '0')}`;

export async function sendRemittanceAdvice(
  trx: Trx,
  a: RemittanceAdvice,
  deps: { sender: EmailSender },
): Promise<boolean> {
  const recipients = await resolveRecipients(trx, a.companyId, a.partyId, 'remittance');
  if (recipients.to.length === 0) {
    throw new EmailError('NO_RECIPIENT', `party ${a.partyId} has no Remittance contact`);
  }
  const company = await trx
    .selectFrom('app.company')
    .select(['name', 'legal_name'])
    .where('id', '=', a.companyId)
    .executeTakeFirstOrThrow();
  const payer = company.legal_name ?? company.name;
  const total = a.bills.reduce((s, b) => s + cents(b.amount), 0n);
  const lines = a.bills.map(
    (b) =>
      `  ${b.billNo.padEnd(20)} ${(b.reference ? `your ref ${b.reference}` : '').padEnd(32)} ` +
      formatMoney(b.amount),
  );
  return sendOnce(trx, deps.sender, {
    companyId: a.companyId,
    purpose: 'remittance',
    key: `remittance:${a.partyId}:${a.paymentReference}`,
    message: {
      to: recipients.to,
      cc: recipients.cc,
      subject: `Remittance advice ${a.paymentReference} from ${payer}`,
      text:
        `${payer} paid ${formatMoney(fromCents(total))} on ${formatDate(a.paymentDate)} ` +
        `(reference ${a.paymentReference}) for:\n${lines.join('\n')}\n` +
        `  ${'Total'.padEnd(20)} ${''.padEnd(32)} ${formatMoney(fromCents(total))}\n`,
    },
  });
}
