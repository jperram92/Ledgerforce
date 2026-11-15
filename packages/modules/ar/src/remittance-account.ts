/**
 * The company's remittance bank account (T-0180, ADR-0079, RQ-0150, migration 0071): the one
 * company bank account whose name, BSB and number print on its customer invoices.
 *
 * Changing it is the payment-redirection risk of design §6.1, so it is maker-checker (design §6.5
 * rule 2 by analogy): one person requests a change, a different person approves it. The API
 * guards both steps with settings.setup.manage, step-up and the SoD rule
 * SOD_REMITTANCE_SELF_APPROVAL; the database repeats the checks: only an approval in the same
 * transaction can write app.ar_settings.remittance_bank_account_id, and an approval by the
 * requester is refused at COMMIT unless small-team mode recorded the exception.
 * Every view here is masked to the last 3 digits. Nothing here decrypts; the bank module's
 * remittanceDetailsOf does, for the document render path only (ADR-0079 control 4).
 */
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type RemittanceAccountErrorCode =
  | 'INVALID_REMITTANCE_CHANGE'
  | 'UNKNOWN_COMPANY'
  | 'BANK_ACCOUNT_NOT_FOUND'
  | 'BANK_ACCOUNT_ARCHIVED'
  | 'NO_CHANGE'
  | 'CHANGE_PENDING'
  | 'CHANGE_ID_CONFLICT'
  | 'CHANGE_NOT_FOUND'
  | 'NOT_PENDING'
  | 'STALE_REQUEST';

/** A remittance-account request refused; nothing was written. */
export class RemittanceAccountError extends DomainError {
  declare readonly code: RemittanceAccountErrorCode;
}

export interface MaskedRemittanceAccount {
  readonly id: string;
  readonly name: string;
  readonly bsb: string;
  readonly accountName: string;
  /** Always "***" + the last 3 characters. */
  readonly accountNumber: string;
  readonly currency: string;
  readonly status: string;
}

export type RemittanceChangeStatus = 'requested' | 'approved' | 'rejected';

export interface RemittanceChangeView {
  readonly changeId: string;
  readonly companyId: string;
  readonly status: RemittanceChangeStatus;
  /** The account asked for; null asks to remove the remittance account. */
  readonly bankAccount: MaskedRemittanceAccount | null;
  /** The account in force when the change was requested. */
  readonly previousBankAccount: MaskedRemittanceAccount | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  /** The rejection reason. */
  readonly reason: string | null;
  /** True when the call repeated an earlier identical request or decision. */
  readonly replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: RemittanceAccountErrorCode, message: string): never => {
  throw new RemittanceAccountError(code, message);
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v)
    ? v.toLowerCase()
    : fail('INVALID_REMITTANCE_CHANGE', `${name} must be a UUID`);

async function masked(
  trx: Trx,
  companyId: string,
  id: string | null,
): Promise<MaskedRemittanceAccount | null> {
  if (id === null) return null;
  const r = await trx
    .selectFrom('app.bank_account')
    .select(['id', 'name', 'bsb', 'account_name', 'account_number_last3', 'currency', 'status'])
    .where('company_id', '=', companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    bsb: r.bsb,
    accountName: r.account_name,
    accountNumber: `***${r.account_number_last3}`,
    currency: r.currency,
    status: r.status,
  };
}

async function companyExists(trx: Trx, companyId: string): Promise<void> {
  const c = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!c) fail('UNKNOWN_COMPANY', 'company not found');
}

async function currentId(trx: Trx, companyId: string): Promise<string | null> {
  const r = await trx
    .selectFrom('app.ar_settings')
    .select('remittance_bank_account_id')
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  return r?.remittance_bank_account_id ?? null;
}

interface ChangeRow {
  id: string;
  company_id: string;
  status: RemittanceChangeStatus;
  bank_account_id: string | null;
  previous_bank_account_id: string | null;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
}

async function changeRow(
  trx: Trx,
  companyId: string,
  changeId: string,
  lock = false,
): Promise<ChangeRow | undefined> {
  let q = trx
    .selectFrom('app.remittance_account_change')
    .select([
      'id',
      'company_id',
      'status',
      'bank_account_id',
      'previous_bank_account_id',
      'requested_by',
      'requested_at',
      'decided_by',
      'decided_at',
      'reason',
    ])
    .where('company_id', '=', companyId)
    .where('id', '=', changeId);
  if (lock) q = q.forUpdate();
  return q.executeTakeFirst();
}

async function viewOf(trx: Trx, r: ChangeRow, replayed: boolean): Promise<RemittanceChangeView> {
  return {
    changeId: r.id,
    companyId: r.company_id,
    status: r.status,
    bankAccount: await masked(trx, r.company_id, r.bank_account_id),
    previousBankAccount: await masked(trx, r.company_id, r.previous_bank_account_id),
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    reason: r.reason,
    replayed,
  };
}

/**
 * Ask to set (or, with `bankAccountId: null`, remove) the remittance account. The change id is
 * the client's: the same id, requester and account again replays. At most one change is pending
 * per company.
 */
export async function requestRemittanceAccountChange(
  trx: Trx,
  c: {
    companyId: string;
    changeId: string;
    bankAccountId: string | null;
    requestedBy: string;
  },
): Promise<RemittanceChangeView> {
  const companyId = uuid(c.companyId, 'companyId');
  const changeId = uuid(c.changeId, 'changeId');
  const requestedBy = uuid(c.requestedBy, 'requestedBy');
  const target = c.bankAccountId === null ? null : uuid(c.bankAccountId, 'bankAccountId');
  await companyExists(trx, companyId);
  // One request at a time per company (also the unique index of migration 0071).
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`remittance:${companyId}`}, 0))`.execute(
    trx,
  );
  const existing = await changeRow(trx, companyId, changeId);
  if (existing) {
    if (
      existing.status === 'requested' &&
      existing.requested_by === requestedBy &&
      existing.bank_account_id === target
    )
      return viewOf(trx, existing, true);
    fail('CHANGE_ID_CONFLICT', `change ${changeId} already exists with other details`);
  }
  if (target !== null) {
    const account = await masked(trx, companyId, target);
    if (!account) fail('BANK_ACCOUNT_NOT_FOUND', 'bank account not found in this company');
    if (account?.status !== 'active')
      fail('BANK_ACCOUNT_ARCHIVED', 'an archived bank account cannot receive payments');
  }
  const previous = await currentId(trx, companyId);
  if (previous === target) fail('NO_CHANGE', 'that is already the remittance account');
  const pending = await trx
    .selectFrom('app.remittance_account_change')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'requested')
    .executeTakeFirst();
  if (pending)
    fail('CHANGE_PENDING', `remittance account change ${pending.id} is waiting for approval`);
  await trx
    .insertInto('app.remittance_account_change')
    .values({
      id: changeId,
      company_id: companyId,
      bank_account_id: target,
      previous_bank_account_id: previous,
      requested_by: requestedBy,
    })
    .execute();
  const row = await changeRow(trx, companyId, changeId);
  if (!row) throw new Error('remittance account change not readable after insert');
  return viewOf(trx, row, false);
}

async function pendingForDecision(
  trx: Trx,
  companyId: string,
  changeId: string,
  status: 'approved' | 'rejected',
  actor: string,
): Promise<{ row: ChangeRow; replay: boolean }> {
  await companyExists(trx, companyId);
  const row = await changeRow(trx, companyId, changeId, true);
  if (!row) return fail('CHANGE_NOT_FOUND', 'remittance account change not found');
  if (row.status === status && row.decided_by === actor) return { row, replay: true };
  if (row.status !== 'requested')
    fail('NOT_PENDING', `remittance account change ${changeId} is ${row.status}`);
  return { row, replay: false };
}

/**
 * Approve a requested change: it becomes the company's remittance account in this transaction.
 * The approver must not be the requester (checked by the API's SoD guard and at COMMIT by the
 * database, unless small-team mode recorded the exception). A repeat by the same approver
 * replays.
 */
export async function approveRemittanceAccountChange(
  trx: Trx,
  c: { companyId: string; changeId: string; approvedBy: string },
): Promise<RemittanceChangeView> {
  const companyId = uuid(c.companyId, 'companyId');
  const changeId = uuid(c.changeId, 'changeId');
  const approvedBy = uuid(c.approvedBy, 'approvedBy');
  const { row, replay } = await pendingForDecision(
    trx,
    companyId,
    changeId,
    'approved',
    approvedBy,
  );
  if (replay) return viewOf(trx, row, true);
  if ((await currentId(trx, companyId)) !== row.previous_bank_account_id)
    fail('STALE_REQUEST', 'the remittance account changed after this request; ask again');
  if (row.bank_account_id !== null) {
    const account = await masked(trx, companyId, row.bank_account_id);
    if (account?.status !== 'active')
      fail('BANK_ACCOUNT_ARCHIVED', 'the requested bank account has been archived');
  }
  await trx
    .updateTable('app.remittance_account_change')
    .set({ status: 'approved', decided_by: approvedBy, decided_at: sql<Date>`clock_timestamp()` })
    .where('company_id', '=', companyId)
    .where('id', '=', changeId)
    .execute();
  await trx
    .insertInto('app.ar_settings')
    .values({ company_id: companyId, remittance_bank_account_id: row.bank_account_id })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'company_id']).doUpdateSet({
        remittance_bank_account_id: row.bank_account_id,
        updated_at: sql<Date>`clock_timestamp()`,
      }),
    )
    .execute();
  const after = await changeRow(trx, companyId, changeId);
  if (!after) throw new Error('remittance account change not readable after approval');
  return viewOf(trx, after, false);
}

/** Reject a requested change with a reason; the remittance account stays as it was. */
export async function rejectRemittanceAccountChange(
  trx: Trx,
  c: { companyId: string; changeId: string; rejectedBy: string; reason: string },
): Promise<RemittanceChangeView> {
  const companyId = uuid(c.companyId, 'companyId');
  const changeId = uuid(c.changeId, 'changeId');
  const rejectedBy = uuid(c.rejectedBy, 'rejectedBy');
  const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
  if (reason.length < 1 || reason.length > 2000)
    fail('INVALID_REMITTANCE_CHANGE', 'a rejection needs a reason of 1–2000 characters');
  const { row, replay } = await pendingForDecision(
    trx,
    companyId,
    changeId,
    'rejected',
    rejectedBy,
  );
  if (replay) return viewOf(trx, row, true);
  await trx
    .updateTable('app.remittance_account_change')
    .set({
      status: 'rejected',
      decided_by: rejectedBy,
      decided_at: sql<Date>`clock_timestamp()`,
      reason,
    })
    .where('company_id', '=', companyId)
    .where('id', '=', changeId)
    .execute();
  const after = await changeRow(trx, companyId, changeId);
  if (!after) throw new Error('remittance account change not readable after rejection');
  return viewOf(trx, after, false);
}

/** The remittance account in force (masked) and the pending change, if any. */
export async function remittanceAccountOf(
  trx: Trx,
  companyId: string,
): Promise<{ account: MaskedRemittanceAccount | null; pending: RemittanceChangeView | null }> {
  const id = uuid(companyId, 'companyId');
  await companyExists(trx, id);
  const account = await masked(trx, id, await currentId(trx, id));
  const p = await trx
    .selectFrom('app.remittance_account_change')
    .select('id')
    .where('company_id', '=', id)
    .where('status', '=', 'requested')
    .executeTakeFirst();
  const row = p ? await changeRow(trx, id, p.id) : undefined;
  return { account, pending: row ? await viewOf(trx, row, false) : null };
}

/** One change of the company (masked); CHANGE_NOT_FOUND when it is not there. */
export async function getRemittanceAccountChange(
  trx: Trx,
  companyId: string,
  changeId: string,
): Promise<RemittanceChangeView> {
  const cid = uuid(companyId, 'companyId');
  const row = await changeRow(trx, cid, uuid(changeId, 'changeId'));
  if (!row) return fail('CHANGE_NOT_FOUND', 'remittance account change not found');
  return viewOf(trx, row, false);
}
