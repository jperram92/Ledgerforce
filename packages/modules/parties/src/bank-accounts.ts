/**
 * Party bank accounts (design §4.2, §6.6, ADR-0018). The account number is sealed with
 * envelope encryption before it reaches the database. AAD binds it to tenant, company, party,
 * row and field, so a ciphertext copied elsewhere fails to open. Every read is masked;
 * revealAccountNumber() is the single decrypting call, reserved for payment files (T-0054).
 */
import type { Database } from '@ledgerforce/db';
import { openField, sealField, type Kms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';

export class BankAccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankAccountValidationError';
  }
}

export interface BankAccountInput {
  /** "062-000" or "062000". */
  bsb: string;
  /** Up to 9 letters/digits/hyphens after removing spaces (ABA field, RQ-0006). */
  accountNumber: string;
  accountName: string;
  source: 'ui' | 'api' | 'import';
  createdBy?: string;
}

export interface MaskedBankAccount {
  id: string;
  bsb: string;
  accountName: string;
  /** Always "***" + last 3 characters: the length is not revealed. */
  accountNumber: string;
  status: string;
}

const FIELD = 'account_number';

const aadFor = (tenantId: string, companyId: string, partyId: string, id: string) =>
  `lf-field-v1|${tenantId}|${companyId}|${partyId}|${id}|${FIELD}`;

function normaliseBsb(bsb: string): string {
  const digits = bsb.replace(/[\s-]/g, '');
  if (!/^[0-9]{6}$/.test(digits))
    throw new BankAccountValidationError(`BSB must be 6 digits, got "${bsb}"`);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function normaliseAccountNumber(input: string): string {
  const n = input.replace(/\s+/g, '');
  if (!/^[0-9A-Za-z-]{1,9}$/.test(n)) {
    throw new BankAccountValidationError('account number must be 1–9 letters, digits or hyphens');
  }
  return n;
}

export async function addBankAccount(
  trx: Transaction<Database>,
  kms: Kms,
  companyId: string,
  partyId: string,
  input: BankAccountInput,
): Promise<string> {
  const bsb = normaliseBsb(input.bsb);
  const accountNumber = normaliseAccountNumber(input.accountNumber);
  if (!input.accountName.trim()) throw new BankAccountValidationError('account name is required');
  const ids = await sql<{ id: string; tenant_id: string }>`
    SELECT app.uuid_generate_v7() AS id, current_setting('app.tenant_id', true) AS tenant_id`.execute(
    trx,
  );
  const row = ids.rows[0];
  if (!row?.tenant_id) throw new Error('addBankAccount must run inside a tenant transaction');
  const sealed = await sealField(
    kms,
    accountNumber,
    aadFor(row.tenant_id, companyId, partyId, row.id),
  );
  await trx
    .insertInto('app.party_bank_account')
    .values({
      id: row.id,
      company_id: companyId,
      party_id: partyId,
      bsb,
      account_name: input.accountName.trim(),
      account_number_last3: accountNumber.slice(-3),
      account_number_ct: sealed.ciphertext,
      account_number_iv: sealed.iv,
      account_number_tag: sealed.tag,
      dek_wrapped: sealed.wrappedDek,
      kek_id: sealed.keyId,
      enc_version: sealed.version,
      source: input.source,
      created_by: input.createdBy ?? null,
    })
    .execute();
  return row.id;
}

/** Masked bank accounts of a party (never decrypts). */
export async function listBankAccounts(
  trx: Transaction<Database>,
  partyId: string,
): Promise<MaskedBankAccount[]> {
  const rows = await trx
    .selectFrom('app.party_bank_account')
    .select(['id', 'bsb', 'account_name', 'account_number_last3', 'status'])
    .where('party_id', '=', partyId)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    bsb: r.bsb,
    accountName: r.account_name,
    accountNumber: `***${r.account_number_last3}`,
    status: r.status,
  }));
}

/** Decrypt one account number. Only for payment files (ABA, T-0054); never for display. */
export async function revealAccountNumber(
  trx: Transaction<Database>,
  kms: Kms,
  bankAccountId: string,
): Promise<string> {
  const r = await trx
    .selectFrom('app.party_bank_account')
    .selectAll()
    .where('id', '=', bankAccountId)
    .executeTakeFirstOrThrow();
  return openField(
    kms,
    {
      ciphertext: r.account_number_ct,
      iv: r.account_number_iv,
      tag: r.account_number_tag,
      wrappedDek: r.dek_wrapped,
      keyId: r.kek_id,
      version: r.enc_version,
    },
    aadFor(r.tenant_id, r.company_id, r.party_id, r.id),
  );
}
