/**
 * Overdue reminder email (T-0068, UC-04 step 2, DL-0402): the outbox handler for
 * `ar.reminder.queued` (published by @ledgerforce/ar `runOverdueReminders`). It emails the Billing
 * To contact (Billing CC copied; recipients rule `reminder`) once per invoice and step: the
 * dedupe key is `reminder:<invoice>:<step>`, recorded in app.email_delivery in the handler's
 * transaction. A customer without a Billing To contact is a delivery failure (retried, then a
 * Sync issue), not a silent skip.
 */
import type { Database } from '@ledgerforce/db';
import { formatDate, formatMoney } from '@ledgerforce/documents';
import type { OutboxEvent, OutboxHandler } from '@ledgerforce/outbox';
import type { Transaction } from 'kysely';
import { EmailError, sendOnce } from './invoice-email.ts';
import { resolveRecipients } from './recipients.ts';
import type { EmailSender } from './sender.ts';

type Trx = Transaction<Database>;

/** Same string as @ledgerforce/ar REMINDER_QUEUED (email does not depend on ar at runtime). */
export const REMINDER_QUEUED_TOPIC = 'ar.reminder.queued';

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function reminderEmailHandler(deps: { sender: EmailSender }): OutboxHandler {
  return {
    name: 'email.reminder_queued',
    topics: [REMINDER_QUEUED_TOPIC],
    async handle(trx: Trx, event: OutboxEvent): Promise<void> {
      const companyId = event.companyId;
      const p = event.payload;
      const partyId = text(p['partyId']);
      const invoiceNo = text(p['invoiceNo']);
      const dueDate = text(p['dueDate']);
      const amountDue = text(p['amountDue']);
      const step = p['step'];
      if (
        !companyId ||
        !partyId ||
        !invoiceNo ||
        !dueDate ||
        !amountDue ||
        typeof step !== 'number'
      ) {
        throw new EmailError('INVALID_EVENT', `event ${event.id} is not a complete reminder`);
      }
      const recipients = await resolveRecipients(trx, companyId, partyId, 'reminder');
      if (recipients.to.length === 0) {
        throw new EmailError(
          'NO_RECIPIENT',
          `reminder for invoice ${invoiceNo}: the customer has no Billing To contact`,
        );
      }
      const company = await trx
        .selectFrom('app.company')
        .select('legal_name')
        .where('id', '=', companyId)
        .executeTakeFirstOrThrow();
      await sendOnce(trx, deps.sender, {
        companyId,
        purpose: 'reminder',
        key: `reminder:${event.aggregateId}:${String(step)}`,
        message: {
          to: recipients.to,
          cc: recipients.cc,
          subject: `Payment reminder: invoice ${invoiceNo} is overdue`,
          text:
            `Our records show that invoice ${invoiceNo} from ${company.legal_name ?? 'us'} was due on ` +
            `${formatDate(dueDate)} and ${formatMoney(amountDue)} is still outstanding.\n` +
            `If you have already paid, please disregard this reminder. Otherwise please arrange ` +
            `payment or contact us.\n`,
        },
      });
    },
  };
}
