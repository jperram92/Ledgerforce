/**
 * Company bank accounts (T-0058, design §4.1 step 4, §6.6, ADR-0018). Each is bound to one GL
 * account of type asset and subtype bank (the database checks it). The account number is sealed
 * with envelope encryption before it reaches the database, with AAD bound to tenant, company,
 * row and field; reads are masked; revealCompanyBankAccountNumber() is the one decrypting call,
 * reserved for ABA payment files (T-0054: trace account).
 */
import type { Database } from '@ledgerforce/db';
import { openField, sealField, type Kms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import { validateCsvMapping, type CsvMapping } from './csv.ts';
import { StatementParseError } from './errors.ts';

export class BankAccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankAccountValidationError';
  }
}

export interface CompanyBankAccountInput {
  /** GL account (asset, subtype bank) this bank account posts to. */
  glAccountId: string;
  /** Display name, e.g. "Operating". */
  name: string;
  /** "062-000" or "062000". */
  bsb: string;
  /** Up to 9 letters/digits/hyphens after removing spaces (ABA field, RQ-0006). */
  accountNumber: string;
  accountName: string;
  currency: string;
  /** For ABA payment files (RQ-0006); all optional. */
  apcaUserId?: string;
  abaUserName?: string;
  abaFiMnemonic?: string;
  csvMapping?: CsvMapping;
  createdBy?: string;
}

export interface MaskedCompanyBankAccount {
  id: string;
  name: string;
  glAccountId: string;
  currency: string;
  bsb: string;
  accountName: string;
  /** Always "***" + last 3 characters. */
  accountNumber: string;
  apcaUserId: string | null;
  abaUserName: string | null;
  abaFiMnemonic: string | null;
  status: string;
}

const FIELD = 'account_number';
const aadFor = (tenantId: string, companyId: string, id: string) =>
  `lf-field-v1|${tenantId}|${companyId}|company_bank_account|${id}|${FIELD}`;
/** BECS character set (RQ-0006, APCA App. C7). */
const BECS = /^[A-Za-z0-9 &'()*+,./:;=?@^_!$%#[\]-]{1,26}$/;

function check(ok: boolean, message: string): void {
  if (!ok) throw new BankAccountValidationError(message);
}

function normaliseBsb(bsb: string): string {
  const digits = bsb.replace(/[\s-]/g, '');
  check(/^[0-9]{6}$/.test(digits), `BSB must be 6 digits, got "${bsb}"`);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export async function createCompanyBankAccount(
  trx: Transaction<Database>,
  kms: Kms,
  companyId: string,
  input: CompanyBankAccountInput,
): Promise<string> {
  const bsb = normaliseBsb(input.bsb);
  const accountNumber = input.accountNumber.replace(/\s+/g, '');
  check(
    /^[0-9A-Za-z-]{1,9}$/.test(accountNumber),
    'account number must be 1–9 letters, digits or hyphens',
  );
  const name = input.name.trim();
  check(name.length >= 1 && name.length <= 100, 'name must be 1–100 characters');
  check(input.accountName.trim() !== '', 'account name is required');
  check(/^[A-Z]{3}$/.test(input.currency), 'currency must be an ISO 4217 code such as AUD');
  if (input.apcaUserId !== undefined) {
    check(/^[0-9]{6}$/.test(input.apcaUserId), 'APCA user id must be 6 digits');
  }
  if (input.abaUserName !== undefined) {
    check(BECS.test(input.abaUserName), 'ABA user name: up to 26 BECS characters');
  }
  if (input.abaFiMnemonic !== undefined) {
    check(
      /^[A-Z]{3}$/.test(input.abaFiMnemonic),
      'FI mnemonic must be 3 capital letters, e.g. CBA',
    );
  }
  let mapping: CsvMapping | undefined;
  if (input.csvMapping !== undefined) {
    try {
      mapping = validateCsvMapping(input.csvMapping);
    } catch (error) {
      if (error instanceof StatementParseError) throw new BankAccountValidationError(error.message);
      throw error;
    }
  }
  const ids = await sql<{ id: string; tenant_id: string }>`
    SELECT app.uuid_generate_v7() AS id, current_setting('app.tenant_id', true) AS tenant_id`.execute(
    trx,
  );
  const row = ids.rows[0];
  if (!row?.tenant_id)
    throw new Error('createCompanyBankAccount must run inside a tenant transaction');
  const sealed = await sealField(kms, accountNumber, aadFor(row.tenant_id, companyId, row.id));
  await trx
    .insertInto('app.bank_account')
    .values({
      id: row.id,
      company_id: companyId,
      gl_account_id: input.glAccountId,
      name,
      currency: input.currency,
      bsb,
      account_name: input.accountName.trim(),
      account_number_last3: accountNumber.slice(-3),
      account_number_ct: sealed.ciphertext,
      account_number_iv: sealed.iv,
      account_number_tag: sealed.tag,
      dek_wrapped: sealed.wrappedDek,
      kek_id: sealed.keyId,
      enc_version: sealed.version,
      apca_user_id: input.apcaUserId ?? null,
      aba_user_name: input.abaUserName ?? null,
      aba_fi_mnemonic: input.abaFiMnemonic ?? null,
      csv_mapping: mapping === undefined ? null : JSON.stringify(mapping),
      created_by: input.createdBy ?? null,
    })
    .execute();
  return row.id;
}

/** Masked bank accounts of a company (never decrypts). */
export async function listCompanyBankAccounts(
  trx: Transaction<Database>,
  companyId: string,
): Promise<MaskedCompanyBankAccount[]> {
  const rows = await trx
    .selectFrom('app.bank_account')
    .select([
      'id',
      'name',
      'gl_account_id',
      'currency',
      'bsb',
      'account_name',
      'account_number_last3',
      'apca_user_id',
      'aba_user_name',
      'aba_fi_mnemonic',
      'status',
    ])
    .where('company_id', '=', companyId)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    glAccountId: r.gl_account_id,
    currency: r.currency,
    bsb: r.bsb,
    accountName: r.account_name,
    accountNumber: `***${r.account_number_last3}`,
    apcaUserId: r.apca_user_id,
    abaUserName: r.aba_user_name,
    abaFiMnemonic: r.aba_fi_mnemonic,
    status: r.status,
  }));
}

/** Save this bank's CSV layout on the account (configuration as data, design principle 3). */
export async function setCsvMapping(
  trx: Transaction<Database>,
  bankAccountId: string,
  mapping: unknown,
): Promise<void> {
  const valid = validateCsvMapping(mapping);
  const r = await trx
    .updateTable('app.bank_account')
    .set({ csv_mapping: JSON.stringify(valid) })
    .where('id', '=', bankAccountId)
    .executeTakeFirst();
  if (r.numUpdatedRows !== 1n) throw new BankAccountValidationError('bank account not found');
}

/** Decrypt one account number. Only for payment files (ABA, T-0054); never for display. */
export async function revealCompanyBankAccountNumber(
  trx: Transaction<Database>,
  kms: Kms,
  bankAccountId: string,
): Promise<string> {
  const r = await trx
    .selectFrom('app.bank_account')
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
    aadFor(r.tenant_id, r.company_id, r.id),
  );
}
