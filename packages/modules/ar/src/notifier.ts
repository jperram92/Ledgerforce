/**
 * "Email the invoice" hook (UC-01 main flow 6; RQ-0104 finding 4). Posting an invoice hands one
 * `ar.invoice.posted` notice to the notifier inside the posting transaction, addressed to the
 * party's Billing To (and CC) contacts. Production uses the transactional outbox (ADR-0008), so
 * the notice commits or rolls back with the journal; the SMTP sender that consumes it (PDF,
 * recipients, retries) is T-0042.
 */
import type { Database } from '@ledgerforce/db';
import { enqueue } from '@ledgerforce/outbox';
import type { Transaction } from 'kysely';
import type { PgBoss } from 'pg-boss';

export const INVOICE_POSTED_TOPIC = 'ar.invoice.posted';

export interface InvoicePostedNotice {
  companyId: string;
  invoiceId: string;
  invoiceNo: string;
  entryId: string;
  partyId: string;
  /** Billing To emails (design §4.2), sorted. */
  to: string[];
  cc: string[];
  /** Document total, NUMERIC(19,4) text. */
  total: string;
}

export interface InvoiceNotifier {
  invoicePosted(trx: Transaction<Database>, notice: InvoicePostedNotice): Promise<void>;
}

/** Sends nothing (tests and tooling that only post). */
export const NO_NOTIFIER: InvoiceNotifier = Object.freeze({ invoicePosted: async () => {} });

/** One outbox event per posted invoice, written in the posting transaction. */
export function invoiceOutboxNotifier(boss: PgBoss): InvoiceNotifier {
  return {
    async invoicePosted(trx, notice) {
      await enqueue(trx, boss, {
        companyId: notice.companyId,
        topic: INVOICE_POSTED_TOPIC,
        aggregateType: 'sales_invoice',
        aggregateId: notice.invoiceId,
        payload: { ...notice },
      });
    },
  };
}
