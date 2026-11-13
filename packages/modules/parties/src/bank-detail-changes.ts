/**
 * Bank-detail change verification with cooling-off (design §6.1, §6.5 rule 2, T-0053, RQ-0034,
 * ADR-0030). The rules live in the database (migration 0025): these functions call its
 * SECURITY DEFINER functions, which check the permission, a fresh step-up of the acting session,
 * the confirmation note and the state, and refuse a self-verification at COMMIT (outside a
 * recorded small-team exception). Refusals arrive here as named constraints and are mapped to
 * BankDetailChangeRefused. Account numbers are sealed (ADR-0018) and never leave in clear.
 */
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import { addBankAccount, type BankAccountInput } from './bank-accounts.ts';

/** Design §6.5 default; the tenant's value is app.bank_detail_settings (latest row). */
export const DEFAULT_COOLING_OFF_HOURS = 24;

export type BankDetailChangeRefusal =
  | 'NOT_FOUND'
  | 'NOT_PERMITTED'
  | 'STEP_UP_REQUIRED'
  | 'CONFIRMATION_NOTE_REQUIRED'
  | 'NOT_PENDING'
  | 'OPEN_CHANGE_EXISTS';

export class BankDetailChangeRefused extends Error {
  readonly reason: BankDetailChangeRefusal;
  constructor(reason: BankDetailChangeRefusal) {
    super(reason);
    this.name = 'BankDetailChangeRefused';
    this.reason = reason;
  }
}

/** Why a party cannot be paid now (the reason a payment batch shows, UC-06 step 1). */
export type PaymentIneligibleReason = 'BANK_DETAILS_COOLING_OFF' | 'NO_VERIFIED_BANK_DETAILS';

export interface PaymentEligibility {
  partyId: string;
  eligible: boolean;
  reason: PaymentIneligibleReason | null;
  /** The active, verified account; null when there is none. */
  bankAccountId: string | null;
  /** When the active account became (or becomes) payable. */
  payableFrom: Date | null;
}

type Trx = Transaction<Database>;

const REFUSALS: Readonly<Record<string, BankDetailChangeRefusal>> = {
  bank_detail_not_found: 'NOT_FOUND',
  bank_detail_permission: 'NOT_PERMITTED',
  bank_detail_step_up: 'STEP_UP_REQUIRED',
  bank_detail_confirmation_note: 'CONFIRMATION_NOTE_REQUIRED',
  bank_detail_change_state: 'NOT_PENDING',
  bank_detail_change_open: 'OPEN_CHANGE_EXISTS',
};

/** Runs a workflow statement; a named refusal of migration 0025 becomes BankDetailChangeRefused. */
async function refusable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const reason = REFUSALS[(e as { constraint?: string }).constraint ?? ''];
    if (reason) throw new BankDetailChangeRefused(reason);
    throw e;
  }
}

/**
 * Request new bank details for a supplier or employee: the account is sealed and stored pending,
 * and a change awaiting verification is opened. `sessionId` must be the requester's session with
 * a fresh step-up. `changeId` lets the caller choose the id (the SoD subject, ADR-0026).
 */
export async function requestBankDetailChange(
  trx: Trx,
  kms: Kms,
  input: {
    changeId?: string;
    partyId: string;
    account: Omit<BankAccountInput, 'createdBy'>;
    requestedBy: string;
    sessionId: string;
  },
): Promise<{ changeId: string; bankAccountId: string }> {
  const party = await trx
    .selectFrom('app.party')
    .select('company_id')
    .where('id', '=', input.partyId)
    .executeTakeFirst();
  if (!party) throw new BankDetailChangeRefused('NOT_FOUND');
  const bankAccountId = await addBankAccount(trx, kms, party.company_id, input.partyId, {
    ...input.account,
    createdBy: input.requestedBy,
  });
  const r = await refusable(() =>
    sql<{ id: string }>`
      SELECT app.bank_detail_change_request(${input.changeId ?? null}::uuid, ${bankAccountId}::uuid,
                                            ${input.requestedBy}::uuid, ${input.sessionId}::uuid) AS id`.execute(
      trx,
    ),
  );
  const changeId = r.rows[0]?.id;
  if (!changeId) throw new Error('bank_detail_change_request returned no id');
  return { changeId, bankAccountId };
}

/**
 * Verify a change: a different user (checked at COMMIT) holding parties.bank_account.verify,
 * with a fresh step-up session, records how the change was confirmed out of band. The new
 * account becomes active and payable after the cooling-off; the previous remittance contact is
 * notified. Returns when the account becomes payable (database clock).
 */
export async function verifyBankDetailChange(
  trx: Trx,
  input: { changeId: string; verifiedBy: string; sessionId: string; confirmationNote: string },
): Promise<{ payableFrom: Date }> {
  const r = await refusable(() =>
    sql<{ payable_from: Date }>`
      SELECT app.bank_detail_change_verify(${input.changeId}::uuid, ${input.verifiedBy}::uuid,
                                           ${input.sessionId}::uuid, ${input.confirmationNote}) AS payable_from`.execute(
      trx,
    ),
  );
  const payableFrom = r.rows[0]?.payable_from;
  if (!payableFrom) throw new Error('bank_detail_change_verify returned no time');
  return { payableFrom: new Date(payableFrom) };
}

/** Reject a change awaiting verification; its account is archived. */
export async function rejectBankDetailChange(
  trx: Trx,
  input: { changeId: string; rejectedBy: string; reason: string },
): Promise<void> {
  await refusable(() =>
    sql`SELECT app.bank_detail_change_reject(${input.changeId}::uuid, ${input.rejectedBy}::uuid,
                                             ${input.reason})`.execute(trx),
  );
}

interface EligibilityRow {
  party_id: string;
  eligible: boolean;
  reason: PaymentIneligibleReason | null;
  bank_account_id: string | null;
  payable_from: Date | null;
}

/**
 * Whether each party can be paid now, in the order given (the check payment batches call,
 * T-0054): BANK_DETAILS_COOLING_OFF while the cooling-off runs, NO_VERIFIED_BANK_DETAILS when
 * there is no active verified account. Database clock, caller's RLS.
 */
export async function paymentEligibility(
  trx: Trx,
  partyIds: readonly string[],
): Promise<PaymentEligibility[]> {
  if (partyIds.length === 0) return [];
  const r = await sql<EligibilityRow>`
    SELECT party_id, eligible, reason, bank_account_id, payable_from
      FROM app.party_payment_eligibility(${[...partyIds]}::uuid[])`.execute(trx);
  return r.rows.map((x) => ({
    partyId: x.party_id,
    eligible: x.eligible,
    reason: x.reason,
    bankAccountId: x.bank_account_id,
    payableFrom: x.payable_from === null ? null : new Date(x.payable_from),
  }));
}

export type BankDetailChangeStatus = 'requested' | 'verified' | 'rejected';

export interface MaskedAccount {
  bsb: string;
  accountName: string;
  /** `***` and the last 3 characters (design §6.6); never the number. */
  accountNumber: string;
}

export interface BankDetailChangeListRow {
  id: string;
  partyId: string;
  partyName: string;
  status: BankDetailChangeStatus;
  bankAccount: MaskedAccount;
  previousBankAccount: MaskedAccount | null;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  payableFrom: Date | null;
}

interface ChangeRow {
  id: string;
  party_id: string;
  party_name: string;
  status: BankDetailChangeStatus;
  bsb: string;
  account_name: string;
  last3: string;
  prev_bsb: string | null;
  prev_account_name: string | null;
  prev_last3: string | null;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: Date;
  decided_by_name: string | null;
  decided_at: Date | null;
  payable_from: Date | null;
}

const at = (d: Date | null) => (d === null ? null : new Date(d));

/**
 * The company's bank-detail changes in one status (for the verification screen, T-0153), oldest
 * request first, at most 200, with the new and previous account masked. Caller's RLS.
 */
export async function listBankDetailChanges(
  trx: Trx,
  companyId: string,
  status: BankDetailChangeStatus,
): Promise<BankDetailChangeListRow[]> {
  const r = await sql<ChangeRow>`
    SELECT c.id, c.party_id, p.legal_name AS party_name, c.status,
           a.bsb, a.account_name, a.account_number_last3 AS last3,
           pa.bsb AS prev_bsb, pa.account_name AS prev_account_name,
           pa.account_number_last3 AS prev_last3,
           c.requested_by, ru.display_name AS requested_by_name, c.requested_at,
           du.display_name AS decided_by_name, c.decided_at, c.payable_from
      FROM app.bank_detail_change c
      JOIN app.party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
      JOIN app.party_bank_account a ON a.tenant_id = c.tenant_id AND a.id = c.bank_account_id
      LEFT JOIN app.party_bank_account pa
             ON pa.tenant_id = c.tenant_id AND pa.id = c.previous_bank_account_id
      LEFT JOIN app.app_user ru ON ru.tenant_id = c.tenant_id AND ru.id = c.requested_by
      LEFT JOIN app.app_user du ON du.tenant_id = c.tenant_id AND du.id = c.decided_by
     WHERE c.company_id = ${companyId.toLowerCase()}::uuid AND c.status = ${status}
     ORDER BY c.requested_at, c.id
     LIMIT 200`.execute(trx);
  return r.rows.map((x) => ({
    id: x.id,
    partyId: x.party_id,
    partyName: x.party_name,
    status: x.status,
    bankAccount: { bsb: x.bsb, accountName: x.account_name, accountNumber: `***${x.last3}` },
    previousBankAccount:
      x.prev_bsb === null || x.prev_last3 === null
        ? null
        : {
            bsb: x.prev_bsb,
            accountName: x.prev_account_name ?? '',
            accountNumber: `***${x.prev_last3}`,
          },
    requestedBy: x.requested_by,
    requestedByName: x.requested_by_name,
    requestedAt: new Date(x.requested_at),
    decidedByName: x.decided_by_name,
    decidedAt: at(x.decided_at),
    payableFrom: at(x.payable_from),
  }));
}

/** Set the tenant's cooling-off length (1–720 h). Owner only (settings.sod.manage); audited. */
export async function setBankDetailCoolingOff(
  trx: Trx,
  input: { hours: number; setBy: string; reason: string },
): Promise<void> {
  if (!Number.isInteger(input.hours)) throw new RangeError('cooling-off hours must be whole hours');
  await sql`INSERT INTO app.bank_detail_settings (cooling_off_hours, set_by, reason)
            VALUES (${input.hours}, ${input.setBy}, ${input.reason})`.execute(trx);
}
