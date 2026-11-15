/**
 * The company's remittance bank account in clear, for its customer documents only (T-0180,
 * ADR-0079 controls 1 and 4, ADR-0018). This is the second permitted decrypting use next to
 * payment files: it opens **only** the account named by app.ar_settings.remittance_bank_account_id
 * (set by maker-checker, migration 0071), and only while that account is active. Call it from the
 * document render path and nowhere else; never store, log or publish what it returns.
 */
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Transaction } from 'kysely';
import { revealCompanyBankAccountNumber } from './bank-accounts.ts';

export interface RemittanceDetails {
  readonly bankAccountId: string;
  readonly accountName: string;
  /** NNN-NNN. */
  readonly bsb: string;
  readonly accountNumber: string;
  readonly currency: string;
}

/**
 * The designated remittance account with its number decrypted, or null when none is in force.
 * With `currency`, an account in another currency is not decrypted and null is returned (an
 * invoice prints only an account in its own currency, ADR-0079 decision 2).
 */
export async function remittanceDetailsOf(
  trx: Transaction<Database>,
  kms: Kms,
  companyId: string,
  opts: { readonly currency?: string } = {},
): Promise<RemittanceDetails | null> {
  let q = trx
    .selectFrom('app.ar_settings as s')
    .innerJoin('app.bank_account as b', (j) =>
      j
        .onRef('b.tenant_id', '=', 's.tenant_id')
        .onRef('b.company_id', '=', 's.company_id')
        .onRef('b.id', '=', 's.remittance_bank_account_id'),
    )
    .select(['b.id', 'b.account_name', 'b.bsb', 'b.currency'])
    .where('s.company_id', '=', companyId)
    .where('b.status', '=', 'active');
  if (opts.currency !== undefined) q = q.where('b.currency', '=', opts.currency);
  const r = await q.executeTakeFirst();
  if (!r) return null;
  return {
    bankAccountId: r.id,
    accountName: r.account_name,
    bsb: r.bsb,
    accountNumber: await revealCompanyBankAccountNumber(trx, kms, r.id),
    currency: r.currency,
  };
}
