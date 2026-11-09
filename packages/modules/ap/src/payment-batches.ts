/**
 * Supplier payment batches with maker-checker and step-up release (T-0054, UC-06 steps 1–2,
 * design §6.5 rules 1–2, §6.2, ADR-0025, ADR-0026, migration 0042).
 *
 *   listPayableBills    approved (posted) bills due on or before a date with an open AP item and
 *                       no scheduled payment: the proposal
 *   createPaymentBatch  one payment per bill for its open amount, to the supplier's verified
 *                       account; suppliers in cooling-off or without verified details are left
 *                       out with the reason (app.party_payment_eligibility, migration 0025)
 *   releasePaymentBatch permission → fresh step-up → SoD (creator ≠ releaser; two distinct
 *                       releasers above the threshold), then app.payment_batch_release, which
 *                       repeats every check in the database
 *   getPaymentBatch     the batch with its payments, exclusions and releases
 *
 * Nothing here writes a ledger table: GP-009 posts on bank confirmation (T-0057), never at release.
 * Money is NUMERIC text summed with decimal.js.
 */
import type { Database } from '@ledgerforce/db';
import { DomainError, Money } from '@ledgerforce/shared';
import { permissionsOf, type Permission } from '@ledgerforce/shared/rbac';
import {
  evaluateSod,
  releasersRequired,
  type SodExceptionRequest,
  type SodRuleId,
} from '@ledgerforce/shared/sod';
import { sql, type Transaction } from 'kysely';
import { currentSodSettings } from './bill-approval.ts';

type Trx = Transaction<Database>;

export const PAYMENT_BATCH_SERIES = 'payment_batch';
export const PAYMENT_BATCH_CREATE_PERMISSION: Permission = 'ap.payment_batch.create';
export const PAYMENT_BATCH_RELEASE_PERMISSION: Permission = 'ap.payment_batch.release';

export type PaymentBatchErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_PERMITTED'
  | 'BANK_ACCOUNT_INVALID'
  | 'NO_PAYMENT_BATCH_SERIES'
  | 'NO_PAYABLE_BILLS'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_WRONG_STATUS'
  /** Release: a payee's scheduled bank account is no longer its active, payable account. */
  | 'PAYEE_INELIGIBLE'
  /** Release: the payments no longer add up to the batch total frozen at creation. */
  | 'BATCH_TOTAL_MISMATCH';

/** Refusals of the payment-batch module. Nothing was written when one is thrown. */
export class PaymentBatchError extends DomainError {
  declare readonly code: PaymentBatchErrorCode;
  constructor(code: PaymentBatchErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(code, message, opts.cause === undefined ? undefined : { cause: opts.cause });
  }
}

export type PaymentExclusionReason = 'BANK_DETAILS_COOLING_OFF' | 'NO_VERIFIED_BANK_DETAILS';
export type PaymentBatchStatus =
  'created' | 'partially_released' | 'released' | 'confirmed' | 'cancelled';

export interface PayableBill {
  billId: string;
  billNo: string;
  supplierId: string;
  dueDate: string;
  currency: string;
  /** The AP open item of the bill. */
  openItemId: string;
  /** Positive NUMERIC(19,4) text: what is still owed. */
  openAmount: string;
}

export interface BatchPayment {
  lineNo: number;
  billId: string;
  supplierId: string;
  bankAccountId: string;
  amount: string;
}

export interface BatchExclusion {
  billId: string;
  supplierId: string;
  reason: PaymentExclusionReason;
  payableFrom: Date | null;
}

export interface CreatedPaymentBatch {
  batchId: string;
  batchNo: string;
  status: 'created';
  currency: string;
  totalAmount: string;
  paymentCount: number;
  requiredReleasers: 1 | 2;
  payments: BatchPayment[];
  excluded: BatchExclusion[];
}

export interface PaymentBatchView extends Omit<CreatedPaymentBatch, 'status'> {
  status: PaymentBatchStatus;
  companyId: string;
  bankAccountId: string;
  paymentDate: string;
  createdBy: string;
  releases: { releaseNo: number; releasedBy: string; releasedAt: Date }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string): never => {
  throw new PaymentBatchError('INVALID_INPUT', message);
};

/** Active roles of an active user (under RLS). */
async function rolesOf(trx: Trx, userId: string): Promise<string[]> {
  if (!UUID_RE.test(userId)) return [];
  const rows = await trx
    .selectFrom('app.user_role as r')
    .innerJoin('app.app_user as u', (j) =>
      j.onRef('u.tenant_id', '=', 'r.tenant_id').onRef('u.id', '=', 'r.user_id'),
    )
    .select('r.role')
    .where('r.user_id', '=', userId)
    .where('r.revoked_at', 'is', null)
    .where('u.status', '=', 'active')
    .execute();
  return rows.map((r) => r.role);
}

async function requirePermission(trx: Trx, userId: string, permission: Permission): Promise<void> {
  if (!permissionsOf(await rolesOf(trx, userId)).has(permission)) {
    throw new PaymentBatchError('NOT_PERMITTED', `user ${userId} does not hold ${permission}`);
  }
}

/** Other active users holding `permission` (small-team eligibility, ADR-0026). */
async function otherEligible(trx: Trx, actorId: string, permission: Permission): Promise<number> {
  const rows = await trx
    .selectFrom('app.user_role as r')
    .innerJoin('app.app_user as u', (j) =>
      j.onRef('u.tenant_id', '=', 'r.tenant_id').onRef('u.id', '=', 'r.user_id'),
    )
    .select(['r.user_id', 'r.role'])
    .where('r.revoked_at', 'is', null)
    .where('u.status', '=', 'active')
    .where('r.user_id', '<>', actorId)
    .execute();
  const byUser = new Map<string, string[]>();
  for (const { user_id, role } of rows) byUser.set(user_id, [...(byUser.get(user_id) ?? []), role]);
  let n = 0;
  for (const roles of byUser.values()) if (permissionsOf(roles).has(permission)) n += 1;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Proposal

/**
 * Approved bills that can be paid: posted (an approved bill posts on approval, T-0052), due on or
 * before `dueOnOrBefore` (or exactly the `billIds` given), with an open AP item and no scheduled
 * payment in another batch. Oldest due first.
 */
export async function listPayableBills(
  trx: Trx,
  q: { companyId: string; dueOnOrBefore?: string; billIds?: readonly string[] },
): Promise<PayableBill[]> {
  if (!UUID_RE.test(q.companyId)) invalid('companyId must be a uuid');
  if (q.dueOnOrBefore !== undefined && !DATE_RE.test(q.dueOnOrBefore)) {
    invalid('dueOnOrBefore must be YYYY-MM-DD');
  }
  if (q.billIds?.some((id) => !UUID_RE.test(id))) invalid('billIds must be uuids');
  if (q.dueOnOrBefore === undefined && q.billIds === undefined) {
    invalid('give dueOnOrBefore or billIds');
  }
  const ids = q.billIds === undefined ? null : q.billIds.map((id) => id.toLowerCase());
  const r = await sql<PayableBill>`
    SELECT b.id AS "billId", b.bill_no AS "billNo", b.supplier_id AS "supplierId",
           to_char(s.due_date, 'YYYY-MM-DD') AS "dueDate", s.currency,
           s.id AS "openItemId", (-s.open_amount)::numeric(19,4)::text AS "openAmount"
      FROM app.bill b
      JOIN app.subledger_entry s
        ON s.tenant_id = b.tenant_id AND s.company_id = b.company_id
       AND s.entry_id = b.journal_entry_id AND s.control_role = 'AP_CONTROL'
     WHERE b.company_id = ${q.companyId.toLowerCase()} AND b.status = 'posted'
       AND b.approved_by IS NOT NULL AND s.open_amount < 0
       AND (${q.dueOnOrBefore ?? null}::date IS NULL OR s.due_date <= ${q.dueOnOrBefore ?? null}::date)
       AND (${ids}::uuid[] IS NULL OR b.id = ANY(${ids}::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM app.payment_batch_payment p
                        WHERE p.tenant_id = b.tenant_id AND p.bill_id = b.id AND p.status = 'scheduled')
     ORDER BY s.due_date, b.bill_no`.execute(trx);
  return r.rows;
}

// ---------------------------------------------------------------------------------------------
// Create

interface EligibilityRow {
  party_id: string;
  eligible: boolean;
  reason: PaymentExclusionReason | null;
  bank_account_id: string | null;
  payable_from: Date | null;
}

/**
 * Create a batch from the payable bills (UC-06 step 1). The creator needs
 * ap.payment_batch.create and records SoD step payment_batch.create. Bills of suppliers who
 * cannot be paid now are excluded with the reason and stored with the batch. Writes no ledger row.
 */
export async function createPaymentBatch(
  trx: Trx,
  input: {
    companyId: string;
    bankAccountId: string;
    paymentDate: string;
    dueOnOrBefore?: string;
    billIds?: readonly string[];
    createdBy: string;
  },
): Promise<CreatedPaymentBatch> {
  if (!UUID_RE.test(input.bankAccountId)) invalid('bankAccountId must be a uuid');
  if (!DATE_RE.test(input.paymentDate)) invalid('paymentDate must be YYYY-MM-DD');
  await requirePermission(trx, input.createdBy, PAYMENT_BATCH_CREATE_PERMISSION);
  const account = await trx
    .selectFrom('app.bank_account')
    .select(['currency', 'status'])
    .where('company_id', '=', input.companyId)
    .where('id', '=', input.bankAccountId.toLowerCase())
    .executeTakeFirst();
  if (!account || account.status !== 'active') {
    throw new PaymentBatchError(
      'BANK_ACCOUNT_INVALID',
      `bank account ${input.bankAccountId} is not an active account of this company`,
    );
  }
  const cur = account.currency;
  const proposed = (
    await listPayableBills(trx, {
      companyId: input.companyId,
      ...(input.dueOnOrBefore === undefined ? {} : { dueOnOrBefore: input.dueOnOrBefore }),
      ...(input.billIds === undefined ? {} : { billIds: input.billIds }),
    })
  ).filter((b) => b.currency === cur);

  const suppliers = [...new Set(proposed.map((b) => b.supplierId))];
  const eligibility = new Map<string, EligibilityRow>();
  if (suppliers.length > 0) {
    const r = await sql<EligibilityRow>`
      SELECT party_id, eligible, reason, bank_account_id, payable_from
        FROM app.party_payment_eligibility(${suppliers}::uuid[])`.execute(trx);
    for (const row of r.rows) eligibility.set(row.party_id, row);
  }
  const included: { bill: PayableBill; bankAccountId: string }[] = [];
  const excluded: BatchExclusion[] = [];
  for (const bill of proposed) {
    const e = eligibility.get(bill.supplierId);
    if (e?.eligible && e.bank_account_id !== null) {
      included.push({ bill, bankAccountId: e.bank_account_id });
    } else {
      excluded.push({
        billId: bill.billId,
        supplierId: bill.supplierId,
        reason: e?.reason ?? 'NO_VERIFIED_BANK_DETAILS',
        payableFrom:
          e?.reason === 'BANK_DETAILS_COOLING_OFF' && e.payable_from !== null
            ? new Date(e.payable_from)
            : null,
      });
    }
  }
  if (included.length === 0) {
    throw new PaymentBatchError(
      'NO_PAYABLE_BILLS',
      excluded.length === 0
        ? 'no approved bill is payable for this selection'
        : `every proposed bill is excluded (${excluded.map((x) => x.reason).join(', ')})`,
    );
  }

  const total = included.reduce(
    (sum, i) => sum.add(Money.fromNumeric(i.bill.openAmount, cur)),
    Money.zero(cur),
  );
  const totalAmount = total.toNumericString();
  const required = releasersRequired(totalAmount, await currentSodSettings(trx)) as 1 | 2;

  let batchNo: string;
  try {
    const r = await sql<{ no: string }>`
      SELECT app.next_document_number(${input.companyId}, ${PAYMENT_BATCH_SERIES}) AS no`.execute(
      trx,
    );
    batchNo = r.rows[0]?.no ?? '';
  } catch (e) {
    throw new PaymentBatchError(
      'NO_PAYMENT_BATCH_SERIES',
      `no active number series '${PAYMENT_BATCH_SERIES}' for this company`,
      { cause: e },
    );
  }
  const batch = await sql<{ id: string }>`
    INSERT INTO app.payment_batch (company_id, batch_no, bank_account_id, payment_date, currency,
                                   total_amount, payment_count, required_releasers, created_by)
    VALUES (${input.companyId}, ${batchNo}, ${input.bankAccountId.toLowerCase()}, ${input.paymentDate},
            ${cur}, ${totalAmount}, ${included.length}, ${required}, ${input.createdBy})
    RETURNING id`.execute(trx);
  const batchId = batch.rows[0]?.id;
  if (!batchId) throw new Error('payment batch not created');

  const payments: BatchPayment[] = included.map((i, n) => ({
    lineNo: n + 1,
    billId: i.bill.billId,
    supplierId: i.bill.supplierId,
    bankAccountId: i.bankAccountId,
    amount: i.bill.openAmount,
  }));
  for (const [n, p] of payments.entries()) {
    await sql`
      INSERT INTO app.payment_batch_payment (company_id, batch_id, line_no, bill_id, supplier_id,
                                             bank_account_id, subledger_entry_id, amount, currency)
      VALUES (${input.companyId}, ${batchId}, ${p.lineNo}, ${p.billId}, ${p.supplierId},
              ${p.bankAccountId}, ${included[n]?.bill.openItemId ?? null}, ${p.amount}, ${cur})`.execute(
      trx,
    );
  }
  for (const x of excluded) {
    await sql`
      INSERT INTO app.payment_batch_exclusion (company_id, batch_id, bill_id, supplier_id, reason,
                                               payable_from)
      VALUES (${input.companyId}, ${batchId}, ${x.billId}, ${x.supplierId}, ${x.reason},
              ${x.payableFrom})`.execute(trx);
  }
  await sql`
    INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, amount)
    VALUES ('payment_batch', ${batchId}, 'payment_batch.create', ${input.createdBy}, ${totalAmount})`.execute(
    trx,
  );
  await trx
    .insertInto('audit.audit_log')
    .values({
      actor_type: 'user',
      actor_user_id: input.createdBy,
      action: 'payment_batch.created',
      entity_type: 'payment_batch',
      entity_id: batchId,
      after: JSON.stringify({
        batch_no: batchNo,
        total_amount: totalAmount,
        payment_count: payments.length,
        required_releasers: required,
        excluded: excluded.map((x) => ({ bill_id: x.billId, reason: x.reason })),
      }),
    })
    .execute();
  return {
    batchId,
    batchNo,
    status: 'created',
    currency: cur,
    totalAmount,
    paymentCount: payments.length,
    requiredReleasers: required,
    payments,
    excluded,
  };
}

// ---------------------------------------------------------------------------------------------
// Release

export type ReleasePaymentBatchResult =
  | { outcome: 'step_up_required'; batchId: string }
  | {
      outcome: 'denied';
      batchId: string;
      rule: SodRuleId;
      /** True when small-team mode allows it with an exception request (reason). */
      smallTeamExceptionRequired: boolean;
    }
  | {
      outcome: 'partially_released' | 'released';
      batchId: string;
      status: 'partially_released' | 'released';
      releases: number;
      requiredReleasers: number;
      sodException: { rules: SodRuleId[]; kind: 'external_reviewer' | 'recorded_exception' } | null;
    };

const RELEASE_REFUSALS: Readonly<Record<string, PaymentBatchErrorCode>> = {
  payment_batch_not_found: 'BATCH_NOT_FOUND',
  payment_batch_permission: 'NOT_PERMITTED',
  payment_batch_state: 'BATCH_WRONG_STATUS',
  payment_batch_total: 'BATCH_TOTAL_MISMATCH',
  payment_batch_payee_ineligible: 'PAYEE_INELIGIBLE',
};

/**
 * Release a batch (UC-06 step 2). Order as in the API (ADR-0025, ADR-0026): the releaser must hold
 * ap.payment_batch.release, then have a fresh MFA step-up on `sessionId` (else
 * `step_up_required`, nothing written), then pass the SoD engine (a refusal is audited and
 * returned — commit to keep the audit row). The database function repeats every check, re-checks
 * each payee's bank account and the frozen total, and moves the status. Writes no ledger row.
 */
export async function releasePaymentBatch(
  trx: Trx,
  opts: {
    batchId: string;
    releasedBy: string;
    sessionId: string;
    sodException?: SodExceptionRequest | null;
  },
): Promise<ReleasePaymentBatchResult> {
  if (!UUID_RE.test(opts.batchId)) {
    throw new PaymentBatchError('BATCH_NOT_FOUND', `payment batch ${opts.batchId} not found`);
  }
  if (!UUID_RE.test(opts.sessionId)) invalid('sessionId must be a uuid');
  const batchId = opts.batchId.toLowerCase();
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
              'lf.sod:' || current_setting('app.tenant_id') || ${`:payment_batch:${batchId}`}, 0))`.execute(
    trx,
  );
  const batch = await sql<{
    status: PaymentBatchStatus;
    batch_no: string;
    total_amount: string;
    required_releasers: number;
  }>`
    SELECT status, batch_no, total_amount::text AS total_amount,
           required_releasers::int AS required_releasers FROM app.payment_batch
     WHERE id = ${batchId}`.execute(trx);
  const b = batch.rows[0];
  if (!b) throw new PaymentBatchError('BATCH_NOT_FOUND', `payment batch ${batchId} not found`);
  await requirePermission(trx, opts.releasedBy, PAYMENT_BATCH_RELEASE_PERMISSION);
  if (b.status !== 'created' && b.status !== 'partially_released') {
    throw new PaymentBatchError(
      'BATCH_WRONG_STATUS',
      `payment batch ${b.batch_no} is ${b.status}; releasing needs created or partially_released`,
    );
  }
  const fresh = await sql<{ ok: boolean }>`
    SELECT app.payment_batch_step_up_fresh(${opts.releasedBy}::uuid, ${opts.sessionId}::uuid) AS ok`.execute(
    trx,
  );
  if (fresh.rows[0]?.ok !== true) return { outcome: 'step_up_required', batchId };

  const history = await sql<{ step: string; actorId: string }>`
    SELECT step, actor_user_id::text AS "actorId" FROM app.sod_action
     WHERE subject_type = 'payment_batch' AND subject_id = ${batchId}
     ORDER BY occurred_at, id`.execute(trx);
  const settings = await currentSodSettings(trx);
  const decision = evaluateSod({
    step: 'payment_batch.release',
    actorId: opts.releasedBy,
    subject: { amount: b.total_amount },
    history: history.rows,
    settings,
    otherEligible: await otherEligible(trx, opts.releasedBy, PAYMENT_BATCH_RELEASE_PERMISSION),
    exception: opts.sodException ?? null,
  });
  if (decision.outcome === 'deny') {
    await trx
      .insertInto('audit.audit_log')
      .values({
        actor_type: 'user',
        actor_user_id: opts.releasedBy,
        action: 'sod_violation',
        entity_type: 'payment_batch',
        entity_id: batchId,
        after: JSON.stringify({
          step: 'payment_batch.release',
          rule: decision.rule,
          amount: b.total_amount,
          small_team_exception_required: decision.smallTeamExceptionRequired,
        }),
      })
      .execute();
    return {
      outcome: 'denied',
      batchId,
      rule: decision.rule,
      smallTeamExceptionRequired: decision.smallTeamExceptionRequired,
    };
  }
  if (decision.outcome === 'allow_with_exception' && opts.sodException) {
    for (const rule of decision.rules) {
      await sql`
        INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind,
                                       reviewer_user_id, reason)
        VALUES (${rule}, 'payment_batch', ${batchId}, 'payment_batch.release', ${opts.releasedBy},
                ${decision.kind}, ${opts.sodException.reviewerId ?? null},
                ${opts.sodException.reason.trim()})`.execute(trx);
    }
  }

  let status: 'partially_released' | 'released';
  try {
    const r = await sql<{ status: 'partially_released' | 'released' }>`
      SELECT app.payment_batch_release(${batchId}::uuid, ${opts.releasedBy}::uuid,
                                       ${opts.sessionId}::uuid) AS status`.execute(trx);
    const s = r.rows[0]?.status;
    if (s !== 'released' && s !== 'partially_released')
      throw new Error('release returned no status');
    status = s;
  } catch (e) {
    const code = RELEASE_REFUSALS[(e as { constraint?: string }).constraint ?? ''];
    if (code) throw new PaymentBatchError(code, (e as Error).message, { cause: e });
    throw e;
  }
  await sql`
    INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, amount)
    VALUES ('payment_batch', ${batchId}, 'payment_batch.release', ${opts.releasedBy},
            ${b.total_amount})`.execute(trx);
  const releases = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.payment_batch_release WHERE batch_id = ${batchId}`.execute(
    trx,
  );
  return {
    outcome: status,
    batchId,
    status,
    releases: releases.rows[0]?.n ?? 0,
    // As the database decides: the frozen value, raised if the threshold was lowered since.
    requiredReleasers: Math.max(b.required_releasers, releasersRequired(b.total_amount, settings)),
    sodException:
      decision.outcome === 'allow_with_exception'
        ? { rules: decision.rules, kind: decision.kind }
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Read

/** A batch with its payments, exclusions and releases (under RLS). */
export async function getPaymentBatch(trx: Trx, batchId: string): Promise<PaymentBatchView> {
  if (!UUID_RE.test(batchId)) {
    throw new PaymentBatchError('BATCH_NOT_FOUND', `payment batch ${batchId} not found`);
  }
  const id = batchId.toLowerCase();
  const head = await sql<{
    company_id: string;
    batch_no: string;
    status: PaymentBatchStatus;
    bank_account_id: string;
    payment_date: string;
    currency: string;
    total_amount: string;
    payment_count: number;
    required_releasers: number;
    created_by: string;
  }>`
    SELECT company_id, batch_no, status, bank_account_id, to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
           currency, total_amount::text AS total_amount, payment_count, required_releasers::int AS required_releasers,
           created_by
      FROM app.payment_batch WHERE id = ${id}`.execute(trx);
  const h = head.rows[0];
  if (!h) throw new PaymentBatchError('BATCH_NOT_FOUND', `payment batch ${batchId} not found`);
  const payments = await sql<BatchPayment>`
    SELECT line_no AS "lineNo", bill_id AS "billId", supplier_id AS "supplierId",
           bank_account_id AS "bankAccountId", amount::text AS amount
      FROM app.payment_batch_payment WHERE batch_id = ${id} ORDER BY line_no`.execute(trx);
  const excluded = await sql<BatchExclusion>`
    SELECT bill_id AS "billId", supplier_id AS "supplierId", reason, payable_from AS "payableFrom"
      FROM app.payment_batch_exclusion WHERE batch_id = ${id} ORDER BY created_at, id`.execute(trx);
  const releases = await sql<{ releaseNo: number; releasedBy: string; releasedAt: Date }>`
    SELECT release_no::int AS "releaseNo", released_by AS "releasedBy", released_at AS "releasedAt"
      FROM app.payment_batch_release WHERE batch_id = ${id} ORDER BY release_no`.execute(trx);
  return {
    batchId: id,
    batchNo: h.batch_no,
    status: h.status,
    companyId: h.company_id,
    bankAccountId: h.bank_account_id,
    paymentDate: h.payment_date,
    currency: h.currency,
    totalAmount: h.total_amount,
    paymentCount: h.payment_count,
    requiredReleasers: h.required_releasers === 2 ? 2 : 1,
    createdBy: h.created_by,
    payments: payments.rows,
    excluded: excluded.rows,
    releases: releases.rows,
  };
}
