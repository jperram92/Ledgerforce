/**
 * Remittance advices for a confirmed payment batch (T-0057, UC-06 step 4, ADR-0046, DL-0304).
 *
 * sendBatchRemittances emails each supplier paid by the batch one advice (@ledgerforce/email
 * sendRemittanceAdvice: To = the supplier's active Remittance contacts) listing the bills paid —
 * our bill number, the supplier's own invoice number and the amount — with the batch number as the
 * payment reference and the confirmation date as the payment date. Each advice is sent once
 * (app.email_delivery dedupe key remittance:<party>:<batch no>), so a repeat sends nothing more.
 * A supplier without a Remittance contact is reported (noRecipient), not thrown, so one missing
 * contact never blocks or re-sends the other suppliers' advices; the confirmation already returns
 * the same list (remittanceMissing) to the user.
 *
 * remittanceAdviceHandler is the outbox handler: it runs on the `ledger.entry.posted` event the
 * posting engine writes in the confirmation's own transaction (so a confirmed batch always gets
 * its advices, and an unconfirmed one never does) and ignores every other source type.
 */
import type { Database } from '@ledgerforce/db';
import { resolveRecipients, sendRemittanceAdvice, type EmailSender } from '@ledgerforce/email';
import { LEDGER_ENTRY_POSTED, type OutboxEvent, type OutboxHandler } from '@ledgerforce/outbox';
import type { Transaction } from 'kysely';
import { batchPayments, PAYMENT_SOURCE_TYPE } from './payment-confirmation.ts';
import { getPaymentBatch, PaymentBatchError } from './payment-batches.ts';

type Trx = Transaction<Database>;

export interface RemittanceRun {
  /** Suppliers emailed now. */
  readonly sent: readonly string[];
  /** Suppliers whose advice had already been sent. */
  readonly alreadySent: readonly string[];
  /** Suppliers without a Remittance contact (nothing sent). */
  readonly noRecipient: readonly string[];
}

/** Email the remittance advices of a confirmed batch (idempotent per supplier). */
export async function sendBatchRemittances(
  trx: Trx,
  c: { companyId: string; batchId: string },
  deps: { sender: EmailSender },
): Promise<RemittanceRun> {
  const companyId = c.companyId.toLowerCase();
  const batch = await getPaymentBatch(trx, companyId, c.batchId);
  const confirmation = batch.confirmation;
  if (!confirmation) {
    throw new PaymentBatchError(
      'NOT_CONFIRMED',
      `payment batch ${batch.batchNo} is not confirmed by the bank; no remittance advice is sent before`,
    );
  }
  const payments = await batchPayments(trx, batch);
  const parties = [...new Set(payments.map((p) => p.partyId))];
  const run = { sent: [] as string[], alreadySent: [] as string[], noRecipient: [] as string[] };
  for (const partyId of parties) {
    const recipients = await resolveRecipients(trx, companyId, partyId, 'remittance');
    if (recipients.to.length === 0) {
      run.noRecipient.push(partyId);
      continue;
    }
    const sent = await sendRemittanceAdvice(
      trx,
      {
        companyId,
        partyId,
        paymentReference: batch.batchNo,
        paymentDate: confirmation.confirmedOn,
        bills: payments
          .filter((p) => p.partyId === partyId)
          .map((p) => ({ billNo: p.billNo, amount: p.amount, reference: p.supplierRef })),
      },
      deps,
    );
    (sent ? run.sent : run.alreadySent).push(partyId);
  }
  return run;
}

/** Outbox handler: remittance advices when a payment batch's GP-009 entry is posted. */
export function remittanceAdviceHandler(deps: { sender: EmailSender }): OutboxHandler {
  return {
    name: 'email.remittance_advice',
    topics: [LEDGER_ENTRY_POSTED],
    async handle(trx: Trx, event: OutboxEvent): Promise<void> {
      if (event.payload['sourceType'] !== PAYMENT_SOURCE_TYPE || !event.companyId) return;
      const confirmation = await trx
        .selectFrom('app.payment_batch_confirmation')
        .select('batch_id')
        .where('company_id', '=', event.companyId)
        .where('entry_id', '=', event.aggregateId)
        .executeTakeFirst();
      if (!confirmation) {
        throw new PaymentBatchError(
          'NOT_CONFIRMED',
          `payment entry ${event.aggregateId} has no batch confirmation`,
        );
      }
      await sendBatchRemittances(
        trx,
        { companyId: event.companyId, batchId: confirmation.batch_id },
        deps,
      );
    },
  };
}
