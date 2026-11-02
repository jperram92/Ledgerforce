/**
 * ABA (Cemtex) file for a released supplier payment batch (T-0056, UC-06 step 3, design §5.7,
 * RQ-0006, DL-0282). Read-only: nothing is posted or changed here (the payments post on bank
 * confirmation, T-0057).
 *
 * Only a released batch is exported. The funding account is the company bank account bound to the
 * batch's GL account (app.bank_account, T-0058), which must carry the APCA user id, ABA user name
 * and FI mnemonic; its account number is unsealed with the Kms for the trace field. Each payment
 * goes to the supplier bank account the batch recorded (unsealed likewise), with the supplier's
 * own bill reference as the lodgement reference so the supplier can match the payment. Free text
 * (account titles, references) is transliterated to the BECS set; identifiers are validated by the
 * writer, never altered. Transaction code 50; no self-balancing record (RQ-0006 defaults).
 * Customer refunds in the batch (T-0055, DL-0288) follow the bills, to the customer's recorded
 * bank account, with the refund number as the lodgement reference.
 */
import { revealCompanyBankAccountNumber } from '@ledgerforce/bank';
import { AbaFormatError, toBecs, writeAba } from '@ledgerforce/connector-aba';
import type { Database } from '@ledgerforce/db';
import { revealAccountNumber } from '@ledgerforce/parties';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Transaction } from 'kysely';
import { getPaymentBatch, PaymentBatchError } from './payment-batches.ts';

export type AbaExportErrorCode =
  'INVALID_BATCH' | 'NOT_RELEASED' | 'BANK_NOT_CONFIGURED' | 'INVALID_ABA_DATA';

export class AbaExportError extends Error {
  readonly code: AbaExportErrorCode;
  constructor(code: AbaExportErrorCode, message: string) {
    super(message);
    this.name = 'AbaExportError';
    this.code = code;
  }
}

export interface AbaExport {
  readonly batchId: string;
  readonly batchNo: string;
  /** e.g. "PB-000001-20261106.aba" (only letters, digits, ".", "_" and "-"; safe in a header). */
  readonly fileName: string;
  /** The file text (ASCII, CRLF record separators). */
  readonly content: string;
  readonly paymentCount: number;
  readonly total: string;
}

export async function exportPaymentBatchAba(
  trx: Transaction<Database>,
  kms: Kms,
  c: { companyId: string; batchId: string },
): Promise<AbaExport> {
  const batch = await getPaymentBatch(trx, c.companyId, c.batchId).catch((e: unknown) => {
    if (e instanceof PaymentBatchError) throw new AbaExportError('INVALID_BATCH', e.message);
    throw e;
  });
  if (batch.status !== 'released') {
    throw new AbaExportError(
      'NOT_RELEASED',
      `payment batch ${batch.batchNo} is ${batch.status}; only a released batch has an ABA file`,
    );
  }
  const bank = await trx
    .selectFrom('app.bank_account')
    .select(['id', 'bsb', 'currency', 'apca_user_id', 'aba_user_name', 'aba_fi_mnemonic'])
    .where('company_id', '=', c.companyId.toLowerCase())
    .where('gl_account_id', '=', batch.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!bank?.apca_user_id || !bank.aba_user_name || !bank.aba_fi_mnemonic) {
    throw new AbaExportError(
      'BANK_NOT_CONFIGURED',
      'the bank account this batch pays from has no APCA user id, ABA user name and FI mnemonic',
    );
  }
  if (bank.currency !== 'AUD') {
    throw new AbaExportError('BANK_NOT_CONFIGURED', 'ABA files pay Australian dollars only');
  }

  const items = await trx
    .selectFrom('app.payment_batch_item as i')
    .innerJoin('app.supplier_bill as b', (j) =>
      j.onRef('b.tenant_id', '=', 'i.tenant_id').onRef('b.id', '=', 'i.bill_id'),
    )
    .innerJoin('app.party_bank_account as a', (j) =>
      j.onRef('a.tenant_id', '=', 'i.tenant_id').onRef('a.id', '=', 'i.bank_account_id'),
    )
    .select(['i.amount', 'i.bank_account_id', 'b.supplier_ref', 'a.bsb', 'a.account_name'])
    .where('i.batch_id', '=', batch.batchId)
    .where('i.excluded_reason', 'is', null)
    .orderBy('i.line_no')
    .execute();

  const refunds = await trx
    .selectFrom('app.payment_batch_refund as i')
    .innerJoin('app.customer_refund as r', (j) =>
      j.onRef('r.tenant_id', '=', 'i.tenant_id').onRef('r.id', '=', 'i.refund_id'),
    )
    .innerJoin('app.party_bank_account as a', (j) =>
      j.onRef('a.tenant_id', '=', 'i.tenant_id').onRef('a.id', '=', 'i.bank_account_id'),
    )
    .select(['i.amount', 'i.bank_account_id', 'r.refund_no', 'a.bsb', 'a.account_name'])
    .where('i.batch_id', '=', batch.batchId)
    .where('i.excluded_reason', 'is', null)
    .orderBy('i.line_no')
    .execute();

  const lines = [];
  for (const i of [...items, ...refunds.map((r) => ({ ...r, supplier_ref: r.refund_no }))]) {
    lines.push({
      bsb: i.bsb,
      accountNumber: await revealAccountNumber(trx, kms, i.bank_account_id ?? ''),
      accountName: toBecs(i.account_name),
      amount: i.amount,
      lodgementReference: toBecs(i.supplier_ref),
    });
  }
  let content: string;
  try {
    content = writeAba({
      fiMnemonic: bank.aba_fi_mnemonic,
      userName: bank.aba_user_name,
      apcaUserId: bank.apca_user_id,
      description: toBecs(batch.batchNo),
      processingDate: batch.paymentDate,
      remitter: {
        bsb: bank.bsb,
        accountNumber: await revealCompanyBankAccountNumber(trx, kms, bank.id),
        name: bank.aba_user_name,
      },
      lines,
    });
  } catch (e) {
    if (e instanceof AbaFormatError) throw new AbaExportError('INVALID_ABA_DATA', e.message);
    throw e;
  }
  return {
    batchId: batch.batchId,
    batchNo: batch.batchNo,
    fileName: `${batch.batchNo.replace(/[^A-Za-z0-9._-]/g, '_')}-${batch.paymentDate.replace(/-/g, '')}.aba`,
    content,
    paymentCount: lines.length,
    total: batch.total,
  };
}
