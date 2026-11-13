/**
 * One Stripe Payment Link per invoice and amount due (T-0073, RQ-0115, ADR-0048).
 *
 * Called when a posted invoice is rendered for sending (the `ar.invoice.posted` email handler),
 * never inside the posting transaction. Only invoices whose billing format's payment method is
 * `stripe` get a link. The amount due is the invoice's AR open item (receipts, credit notes and
 * write-offs reduce it); the stored active link is reused while it matches. When the amount due
 * changes, the old link is deactivated in Stripe and marked here, then a new one is created; when
 * nothing is due, no link. The Stripe call carries an idempotency key derived from the invoice and
 * the amount in cents, so a retry after a rolled-back transaction gets the same link back.
 * Reads the subledger only; writes nothing to ledger tables. Money via decimal.js.
 */
import type { Database } from '@ledgerforce/db';
import type { InvoicePaymentLinkProvider } from '@ledgerforce/documents';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import type { StripeClient } from './client.ts';

type Trx = Transaction<Database>;

export const PAYMENT_LINK_INACTIVE_MESSAGE =
  'This payment link is no longer valid. Please use the link on the latest invoice or contact the sender.';

export class PaymentLinkError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_POSTED' | 'AMOUNT_NOT_CENTS';
  constructor(code: PaymentLinkError['code'], message: string) {
    super(message);
    this.name = 'PaymentLinkError';
    this.code = code;
  }
}

export interface StoredPaymentLink {
  readonly stripeId: string;
  readonly url: string;
  /** NUMERIC text, 4 decimals. */
  readonly amountDue: string;
  readonly currency: string;
  readonly livemode: boolean;
}

export const paymentLinkIdempotencyKey = (invoiceId: string, cents: string) =>
  `lf-plink-v1-${invoiceId}-${cents}`;

export async function ensureInvoicePaymentLink(
  trx: Trx,
  client: StripeClient,
  companyId: string,
  invoiceId: string,
): Promise<StoredPaymentLink | null> {
  // One caller at a time per invoice (two senders must not both create a link).
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stripe_payment_link:${invoiceId}`}, 0))`.execute(
    trx,
  );
  const inv = (
    await sql<{
      tenant_id: string;
      status: 'draft' | 'posted' | 'void';
      invoice_no: string | null;
      currency: string;
      entry_id: string | null;
      payment_link: 'none' | 'stripe' | null;
    }>`
      SELECT i.tenant_id, i.status, i.invoice_no, i.currency, i.entry_id, f.payment_link
        FROM app.sales_invoice i
        LEFT JOIN app.billing_format f
          ON f.tenant_id = i.tenant_id AND f.company_id = i.company_id AND f.id = i.billing_format_id
       WHERE i.company_id = ${companyId}::uuid AND i.id = ${invoiceId}::uuid`.execute(trx)
  ).rows[0];
  if (!inv)
    throw new PaymentLinkError('NOT_FOUND', `invoice ${invoiceId} is not in company ${companyId}`);
  if (inv.payment_link !== 'stripe') return null;
  if (inv.status === 'draft' || !inv.entry_id || !inv.invoice_no) {
    throw new PaymentLinkError(
      'NOT_POSTED',
      `invoice ${invoiceId} is a draft; only posted invoices are payable`,
    );
  }
  const open = (
    await sql<{ open: string }>`
      SELECT coalesce(sum(open_amount), 0)::text AS open FROM app.subledger_entry
       WHERE company_id = ${companyId}::uuid AND entry_id = ${inv.entry_id}::uuid
         AND control_role = 'AR_CONTROL'`.execute(trx)
  ).rows[0]?.open;
  const due = inv.status === 'void' ? new Decimal(0) : new Decimal(open ?? '0');

  const current = await trx
    .selectFrom('app.stripe_payment_link')
    .select(['id', 'stripe_id', 'url', 'amount_due', 'currency', 'livemode'])
    .where('company_id', '=', companyId)
    .where('invoice_id', '=', invoiceId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (current && due.equals(current.amount_due)) {
    return {
      stripeId: current.stripe_id,
      url: current.url,
      amountDue: current.amount_due,
      currency: current.currency,
      livemode: current.livemode,
    };
  }
  if (current) {
    await client.deactivatePaymentLink(current.stripe_id);
    await trx
      .updateTable('app.stripe_payment_link')
      .set({ status: 'deactivated', deactivated_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', current.id)
      .execute();
  }
  if (due.lte(0)) return null;

  const cents = due.times(100);
  if (!cents.isInteger()) {
    throw new PaymentLinkError(
      'AMOUNT_NOT_CENTS',
      `amount due ${due.toFixed()} is not whole cents`,
    );
  }
  const key = paymentLinkIdempotencyKey(invoiceId, cents.toFixed(0));
  const meta = {
    lf_tenant_id: inv.tenant_id,
    lf_company_id: companyId,
    lf_invoice_id: invoiceId,
    lf_invoice_no: inv.invoice_no,
  };
  const link = await client.createPaymentLink(
    {
      currency: inv.currency,
      unitAmountCents: cents.toFixed(0),
      name: `Invoice ${inv.invoice_no}`,
      singleUse: true,
      inactiveMessage: PAYMENT_LINK_INACTIVE_MESSAGE,
      metadata: meta,
    },
    key,
  );
  await trx
    .insertInto('app.stripe_payment_link')
    .values({
      company_id: companyId,
      invoice_id: invoiceId,
      amount_due: due.toFixed(4),
      currency: inv.currency,
      stripe_id: link.id,
      url: link.url,
      livemode: link.livemode,
      idempotency_key: key,
      deactivated_at: null,
    })
    .execute();
  return {
    stripeId: link.id,
    url: link.url,
    amountDue: due.toFixed(4),
    currency: inv.currency,
    livemode: link.livemode,
  };
}

/** The documents/email port backed by Stripe. */
export function stripeInvoicePaymentLinks(client: StripeClient): InvoicePaymentLinkProvider {
  return {
    async ensure(trx, companyId, invoiceId) {
      const link = await ensureInvoicePaymentLink(trx, client, companyId, invoiceId);
      return link ? { url: link.url, amountDue: link.amountDue } : null;
    },
  };
}
