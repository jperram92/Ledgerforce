/**
 * Company bank accounts (T-0058, design §4.1 step 4, §6.6, ADR-0018). Each is bound to one GL
 * account of type asset and subtype bank (the database checks it). The account number is sealed
 * with envelope encryption before it reaches the database, with AAD bound to tenant, company,
 * row and field; reads are masked; revealCompanyBankAccountNumber() is the one decrypting call,
 * reserved for ABA payment files (T-0054: trace account) and the remittance account on customer
 * documents (remittance.ts, ADR-0079).
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

interface NormalisedInput {
  bsb: string;
  accountNumber: string;
  name: string;
  accountName: string;
  mapping: CsvMapping | undefined;
}

function normaliseInput(input: CompanyBankAccountInput): NormalisedInput {
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
  return { bsb, accountNumber, name, accountName: input.accountName.trim(), mapping };
}

/**
 * The checks createCompanyBankAccount applies, without writing: throws
 * BankAccountValidationError with a message that never contains the account number (T-0185:
 * a malformed request is refused before the replay test, RQ-0166).
 */
export function validateCompanyBankAccountInput(input: CompanyBankAccountInput): void {
  normaliseInput(input);
}

export async function createCompanyBankAccount(
  trx: Transaction<Database>,
  kms: Kms,
  companyId: string,
  input: CompanyBankAccountInput,
): Promise<string> {
  const { bsb, accountNumber, name, accountName, mapping } = normaliseInput(input);
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
      account_name: accountName,
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

/**
 * Whether a stored (masked) bank account is what a create request would have written: the replay
 * test of `POST /setup/bank-accounts` (T-0185, RQ-0166, DL-0700). Compares, after this module's
 * normalisation, the GL account, name, BSB, last 3 characters of the number, account name,
 * currency and ABA details. Never decrypts: the full number is not compared (RQ-0166 finding 2).
 * An archived account is never a replay. An input this module would refuse is never equal.
 */
export function sameCompanyBankAccount(
  existing: MaskedCompanyBankAccount,
  input: Omit<CompanyBankAccountInput, 'csvMapping' | 'createdBy'>,
): boolean {
  let n: NormalisedInput;
  try {
    n = normaliseInput(input);
  } catch {
    return false;
  }
  return (
    existing.status === 'active' &&
    existing.glAccountId === input.glAccountId &&
    existing.name === n.name &&
    existing.bsb === n.bsb &&
    existing.accountNumber === `***${n.accountNumber.slice(-3)}` &&
    existing.accountName === n.accountName &&
    existing.currency === input.currency &&
    existing.apcaUserId === (input.apcaUserId ?? null) &&
    existing.abaUserName === (input.abaUserName ?? null) &&
    existing.abaFiMnemonic === (input.abaFiMnemonic ?? null)
  );
}

/** The ABA header of a company bank account (ABA type 0 record, RQ-0006); all three together. */
export interface CompanyBankAccountAba {
  apcaUserId: string;
  abaUserName: string;
  abaFiMnemonic: string;
}

/** The account is archived: its ABA details no longer change (ADR-0094, migration 0074). */
export class BankAccountArchivedError extends Error {
  constructor(message = 'the bank account is archived; its ABA details cannot change') {
    super(message);
    this.name = 'BankAccountArchivedError';
  }
}

/** Throws BankAccountValidationError unless all three ABA fields pass the create rules. */
export function validateCompanyBankAccountAba(input: CompanyBankAccountAba): void {
  check(/^[0-9]{6}$/.test(input.apcaUserId), 'APCA user id must be 6 digits');
  check(BECS.test(input.abaUserName), 'ABA user name: up to 26 BECS characters');
  check(/^[A-Z]{3}$/.test(input.abaFiMnemonic), 'FI mnemonic must be 3 capital letters, e.g. CBA');
}

export interface CompanyBankAccountChange {
  before: MaskedCompanyBankAccount;
  after: MaskedCompanyBankAccount;
  /** false when the account was already in the requested state (nothing written). */
  changed: boolean;
}

const MASKED_COLUMNS = [
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
] as const;

interface MaskedRow {
  id: string;
  name: string;
  gl_account_id: string;
  currency: string;
  bsb: string;
  account_name: string;
  account_number_last3: string;
  apca_user_id: string | null;
  aba_user_name: string | null;
  aba_fi_mnemonic: string | null;
  status: string;
}

const masked = (r: MaskedRow): MaskedCompanyBankAccount => ({
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
});

/** One account of the company, locked for this transaction; undefined when not visible. */
async function lockedAccount(
  trx: Transaction<Database>,
  companyId: string,
  bankAccountId: string,
): Promise<MaskedCompanyBankAccount | undefined> {
  const r = await trx
    .selectFrom('app.bank_account')
    .select(MASKED_COLUMNS)
    .where('company_id', '=', companyId)
    .where('id', '=', bankAccountId)
    .forUpdate()
    .executeTakeFirst();
  return r ? masked(r) : undefined;
}

/**
 * Set the APCA user id, ABA user name and FI mnemonic of an active company bank account
 * (T-0193, ADR-0094). The BSB and number never change in place. Returns undefined when the
 * company has no such account; `changed: false` when the values are already stored. Throws
 * BankAccountValidationError for a malformed value and BankAccountArchivedError for an archived
 * account (the database refuses it too, migration 0074).
 */
export async function setCompanyBankAccountAba(
  trx: Transaction<Database>,
  companyId: string,
  bankAccountId: string,
  input: CompanyBankAccountAba,
): Promise<CompanyBankAccountChange | undefined> {
  validateCompanyBankAccountAba(input);
  const before = await lockedAccount(trx, companyId, bankAccountId);
  if (!before) return undefined;
  if (
    before.apcaUserId === input.apcaUserId &&
    before.abaUserName === input.abaUserName &&
    before.abaFiMnemonic === input.abaFiMnemonic
  )
    return { before, after: before, changed: false };
  if (before.status !== 'active') throw new BankAccountArchivedError();
  const r = await trx
    .updateTable('app.bank_account')
    .set({
      apca_user_id: input.apcaUserId,
      aba_user_name: input.abaUserName,
      aba_fi_mnemonic: input.abaFiMnemonic,
    })
    .where('company_id', '=', companyId)
    .where('id', '=', bankAccountId)
    .returning(MASKED_COLUMNS)
    .executeTakeFirstOrThrow();
  return { before, after: masked(r), changed: true };
}

/**
 * Archive a company bank account (T-0193, ADR-0094). Its history stays; statements can no longer
 * be imported to it and payment files no longer use it; its GL account can take a new account.
 * If it is the designated remittance account, the database releases that designation in the
 * same statement (migration 0072, ADR-0086). Returns undefined when the company has no such
 * account; `changed: false` when it is already archived.
 */
export async function archiveCompanyBankAccount(
  trx: Transaction<Database>,
  companyId: string,
  bankAccountId: string,
): Promise<CompanyBankAccountChange | undefined> {
  const before = await lockedAccount(trx, companyId, bankAccountId);
  if (!before) return undefined;
  if (before.status === 'archived') return { before, after: before, changed: false };
  const r = await trx
    .updateTable('app.bank_account')
    .set({ status: 'archived' })
    .where('company_id', '=', companyId)
    .where('id', '=', bankAccountId)
    .returning(MASKED_COLUMNS)
    .executeTakeFirstOrThrow();
  return { before, after: masked(r), changed: true };
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

/**
 * Decrypt one account number. Permitted uses (ADR-0018 as widened by ADR-0079): payment files
 * (ABA, T-0054), and the company's designated remittance account on its customer documents via
 * remittanceDetailsOf (T-0180). Never for display in the app or read APIs.
 */
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
