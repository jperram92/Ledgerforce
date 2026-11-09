/**
 * Test-only setup for customer receipts (T-0046): the receipt journal number series and a company
 * bank account "Operating" on GL 1010 (the AU services SMB template's operating bank account,
 * which the golden world binds to `bank:OPERATING`). Runs inside the caller's tenant transaction.
 */
import { createCompanyBankAccount } from '@ledgerforce/bank';
import type { Database } from '@ledgerforce/db';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

export interface ReceiptWorld {
  /** app.bank_account id of "Operating" (GL 1010). */
  operatingBankAccountId: string;
  /** Its GL account id. */
  operatingGlAccountId: string;
}

export async function setupReceipts(trx: Trx, companyId: string): Promise<ReceiptWorld> {
  // The golden world already numbers je_ar_receipt; keep its series when present.
  await sql`
    INSERT INTO app.number_series (company_id, code, prefix)
    VALUES (${companyId}, 'je_ar_receipt', 'ARR-')
    ON CONFLICT DO NOTHING`.execute(trx);
  const gl = await sql<{ id: string }>`
    SELECT id::text FROM app.account WHERE company_id = ${companyId} AND code = '1010'`.execute(
    trx,
  );
  const glId = gl.rows[0]?.id;
  if (glId === undefined) throw new Error('receipt world: the chart has no account 1010');
  const id = await createCompanyBankAccount(trx, kms, companyId, {
    glAccountId: glId,
    name: 'Operating',
    bsb: '062000',
    accountNumber: '12345678',
    accountName: 'Harbour & Co Pty Ltd',
    currency: 'AUD',
  });
  return { operatingBankAccountId: id, operatingGlAccountId: glId };
}
