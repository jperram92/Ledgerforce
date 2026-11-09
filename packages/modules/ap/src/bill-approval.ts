/**
 * Supplier bill approval with segregation of duties (T-0052, UC-05 steps 3–4, design §6.5 rule 3,
 * ADR-0026, RQ-0116, migration 0041).
 *
 *   draft ──submit──▶ awaiting_approval ──approve──▶ approved ──post──▶ posted
 *     ▲                   │                            │
 *     └──reject (reason)──┘◀──── send back (reason) ───┘   (an edit needs a new approval)
 *
 *  submitBill            previews the bill through the posting engine (every check post makes),
 *                        freezes the coding and the gross amount; the bill joins the queue
 *  listBillApprovalQueue routing by amount: each awaiting bill with whether this approver may
 *                        approve it (SOD_BILL_SELF_APPROVAL above the bill threshold)
 *  approveBill           the SoD engine (T-0015) decides; a refusal is audited and returned, not
 *                        thrown (RQ-0116 F6); an approval posts in the same transaction unless
 *                        `post: false` (UC-05 step 4, A2)
 *  rejectBill            awaiting → draft with a reason
 *  returnBillToDraft     approved → draft with a reason; clears the approval
 *  updateDraftBill       edits a draft (header, line content); the editor records `bill.enter`
 *  billApprovalHistory   the approval trail (app.bill_approval_event)
 *
 * Every function runs in the caller's tenant transaction. The database repeats rule 3 at commit
 * (0041 bill_sod). Nothing here writes a ledger table; posting is postBill → posting engine.
 */
import type { Database } from '@ledgerforce/db';
import { PeriodLockedError, type PostingOutbox } from '@ledgerforce/ledger';
import { minorUnits, Money, currency as toCurrency } from '@ledgerforce/shared';
import { permissionsOf, type Permission } from '@ledgerforce/shared/rbac';
import {
  DEFAULT_SOD_SETTINGS,
  evaluateSod,
  type SodExceptionRequest,
  type SodRuleId,
  type SodSettings,
} from '@ledgerforce/shared/sod';
import { sql, type Transaction } from 'kysely';
import {
  BillError,
  billCommand,
  freezeBillCoding,
  postBill,
  previewBill,
  recordBillEnter,
  supplierRefKey,
  type BillLineInput,
  type PostedBill,
} from './bills.ts';

type Trx = Transaction<Database>;

/** RBAC permission whose holders are eligible approvers (design §6.4; small-team count). */
export const BILL_APPROVE_PERMISSION: Permission = 'ap.bill.approve';

const MAX_REASON = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d+(?:\.(\d+))?$/;

interface WorkflowRow {
  id: string;
  company_id: string;
  bill_no: string;
  status: string;
  currency: string;
  entered_by: string | null;
  submitted_by: string | null;
  approval_amount: string | null;
  approved_by: string | null;
}

async function loadForWorkflow(trx: Trx, billId: string): Promise<WorkflowRow> {
  if (!UUID_RE.test(billId)) throw new BillError('BILL_NOT_FOUND', `bill ${billId} not found`);
  const row = await trx
    .selectFrom('app.bill')
    .select([
      'id',
      'company_id',
      'bill_no',
      'status',
      'currency',
      'entered_by',
      'submitted_by',
      'approval_amount',
      'approved_by',
    ])
    .where('id', '=', billId.toLowerCase())
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new BillError('BILL_NOT_FOUND', `bill ${billId} not found`);
  return row;
}

function expectStatus(bill: WorkflowRow, allowed: readonly string[], action: string): void {
  if (!allowed.includes(bill.status)) {
    throw new BillError(
      'BILL_WRONG_STATUS',
      `bill ${bill.bill_no} is ${bill.status}; ${action} needs ${allowed.join(' or ')}`,
    );
  }
}

function reasonOf(reason: string | null | undefined, required: boolean): string | null {
  const r = (reason ?? '').trim();
  if (r === '') {
    if (required) throw new BillError('REASON_REQUIRED', 'give a reason (1–2000 characters)');
    return null;
  }
  if (r.length > MAX_REASON) {
    throw new BillError('REASON_REQUIRED', `the reason is longer than ${String(MAX_REASON)}`);
  }
  return r;
}

async function event(
  trx: Trx,
  bill: WorkflowRow,
  e: {
    action: 'submit' | 'approve' | 'approval_denied' | 'reject' | 'return_to_draft';
    actorId: string;
    reason?: string | null;
    amount?: string | null;
    sodRule?: SodRuleId | null;
    sodException?: boolean;
  },
): Promise<void> {
  await trx
    .insertInto('app.bill_approval_event')
    .values({
      company_id: bill.company_id,
      bill_id: bill.id,
      action: e.action,
      actor_user_id: e.actorId,
      reason: e.reason ?? null,
      amount: e.amount ?? null,
      sod_rule: e.sodRule ?? null,
      sod_exception: e.sodException ?? false,
    })
    .execute();
}

// ---------------------------------------------------------------------------------------------
// SoD inputs read under RLS (the same sources as apps/api sod.service.ts, ADR-0026)

/** The tenant's current SoD settings (latest row), or the placeholder defaults (DL-0131). */
export async function currentSodSettings(trx: Trx): Promise<SodSettings> {
  const r = await sql<{
    small_team_mode: boolean;
    bill: string;
    credit_note: string;
    journal: string;
    batch: string;
    report_timezone: string;
  }>`
    SELECT small_team_mode, bill_self_approval_threshold::text AS bill,
           credit_note_self_approval_threshold::text AS credit_note,
           journal_approval_threshold::text AS journal,
           batch_two_releasers_threshold::text AS batch, report_timezone
      FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  if (!row) return DEFAULT_SOD_SETTINGS;
  return {
    smallTeamMode: row.small_team_mode,
    thresholds: {
      bill_self_approval: row.bill,
      credit_note_self_approval: row.credit_note,
      journal_approval: row.journal,
      batch_two_releasers: row.batch,
    },
    reportTimezone: row.report_timezone,
  };
}

/** Other active users holding `permission` through an active role grant. */
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

async function sodHistory(trx: Trx, billId: string) {
  const r = await sql<{ step: string; actorId: string }>`
    SELECT step, actor_user_id::text AS "actorId" FROM app.sod_action
     WHERE subject_type = 'bill' AND subject_id = ${billId}
     ORDER BY occurred_at, id`.execute(trx);
  return r.rows;
}

function historyWithEnterer(
  bill: { entered_by: string | null },
  rows: readonly { step: string; actorId: string }[],
): { step: string; actorId: string }[] {
  return bill.entered_by === null
    ? [...rows]
    : [{ step: 'bill.enter', actorId: bill.entered_by }, ...rows];
}

// ---------------------------------------------------------------------------------------------
// Submit

export interface SubmittedBill {
  billId: string;
  status: 'awaiting_approval';
  /** Gross bill total in base currency, NUMERIC(19,4) text (RQ-0116 F1). */
  approvalAmount: string;
}

/**
 * Submit a draft for approval: the posting engine's preview must accept it (coding, tax codes,
 * period, control accounts, duplicates), the resolved coding is frozen on the lines, and the gross
 * total is frozen on the bill. Writes no ledger row.
 */
export async function submitBill(
  trx: Trx,
  opts: { billId: string; submittedBy: string },
): Promise<SubmittedBill> {
  const bill = await loadForWorkflow(trx, opts.billId);
  expectStatus(bill, ['draft'], 'submitting');
  const total = await grossTotal(trx, bill);
  await freezeBillCoding(trx, bill.id);
  await trx
    .updateTable('app.bill')
    .set({
      status: 'awaiting_approval',
      submitted_by: opts.submittedBy,
      approval_amount: total,
    })
    .where('id', '=', bill.id)
    .execute();
  await event(trx, bill, { action: 'submit', actorId: opts.submittedBy, amount: total });
  return { billId: bill.id, status: 'awaiting_approval', approvalAmount: total };
}

/**
 * The gross total by the posting engine's preview. A bill dated in a locked period still goes to
 * approval (the lock is decided at post, with an override — UC-05 A2, RQ-0116 F3): its total is
 * then the Σcredit of the same built command (coding, tax codes and duplicates were checked).
 */
async function grossTotal(trx: Trx, bill: WorkflowRow): Promise<string> {
  try {
    return (await previewBill(trx, bill.id)).entry.total;
  } catch (e) {
    if (!(e instanceof PeriodLockedError && e.code === 'PERIOD_LOCKED')) throw e;
  }
  const command = await billCommand(trx, bill.id);
  return command.lines
    .reduce((t, l) => t.add(Money.of(l.credit ?? '0', bill.currency)), Money.zero(bill.currency))
    .toNumericString();
}

// ---------------------------------------------------------------------------------------------
// Queue (routing by amount)

export interface BillApprovalQueueItem {
  billId: string;
  billNo: string;
  supplierId: string;
  supplierRef: string;
  billDate: string;
  dueDate: string;
  approvalAmount: string;
  enteredBy: string | null;
  submittedBy: string;
  submittedAt: Date;
  /** Whether `approverId` may approve it now (SoD; RBAC is the caller's check). */
  canApprove: boolean;
  /** The rule that stops this approver, or null. */
  blockedBy: SodRuleId | null;
  /** Small-team mode would allow it with a recorded exception or external reviewer. */
  smallTeamExceptionRequired: boolean;
}

/**
 * The bills awaiting approval in a company, oldest submission first, each routed for one
 * approver: above the bill threshold a bill is not theirs to approve if they entered or edited it.
 */
export async function listBillApprovalQueue(
  trx: Trx,
  q: { companyId: string; approverId: string },
): Promise<BillApprovalQueueItem[]> {
  const rows = await trx
    .selectFrom('app.bill')
    .select([
      'id',
      'bill_no',
      'supplier_id',
      'supplier_ref',
      sql<string>`bill_date::text`.as('bill_date'),
      sql<string>`due_date::text`.as('due_date'),
      'approval_amount',
      'entered_by',
      'submitted_by',
      'submitted_at',
    ])
    .where('company_id', '=', q.companyId)
    .where('status', '=', 'awaiting_approval')
    .orderBy('submitted_at')
    .orderBy('bill_no')
    .execute();
  if (rows.length === 0) return [];
  const settings = await currentSodSettings(trx);
  const eligible = await otherEligible(trx, q.approverId, BILL_APPROVE_PERMISSION);
  const out: BillApprovalQueueItem[] = [];
  for (const r of rows) {
    const decision = evaluateSod({
      step: 'bill.approve',
      actorId: q.approverId,
      subject: { amount: r.approval_amount },
      history: historyWithEnterer(r, await sodHistory(trx, r.id)),
      settings,
      otherEligible: eligible,
      exception: null,
    });
    out.push({
      billId: r.id,
      billNo: r.bill_no,
      supplierId: r.supplier_id,
      supplierRef: r.supplier_ref,
      billDate: r.bill_date,
      dueDate: r.due_date,
      approvalAmount: r.approval_amount ?? '',
      enteredBy: r.entered_by,
      submittedBy: r.submitted_by ?? '',
      submittedAt: r.submitted_at ?? new Date(0),
      canApprove: decision.outcome === 'allow',
      blockedBy: decision.outcome === 'deny' ? decision.rule : null,
      smallTeamExceptionRequired:
        decision.outcome === 'deny' ? decision.smallTeamExceptionRequired : false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Approve

export type ApproveBillResult =
  | {
      outcome: 'approved';
      billId: string;
      status: 'approved' | 'posted';
      /** The posted entry when the approval posted the bill (default). */
      posted: PostedBill | null;
      sodException: { rules: SodRuleId[]; kind: 'external_reviewer' | 'recorded_exception' } | null;
    }
  | {
      outcome: 'denied';
      billId: string;
      rule: SodRuleId;
      /** True when small-team mode allows it with an exception request (reason). */
      smallTeamExceptionRequired: boolean;
    };

/**
 * Approve a bill awaiting approval. The SoD engine (ADR-0026) decides under a per-bill advisory
 * lock (the API's key). A refusal writes an audit row and an `approval_denied` event and returns
 * `denied` with the bill unchanged — commit the transaction to keep the audit. An approval
 * records the SoD step (and any small-team exception) and, unless `post: false`, posts the bill
 * through the posting engine in the same transaction (a posting refusal rolls everything back).
 */
export async function approveBill(
  trx: Trx,
  opts: {
    billId: string;
    approvedBy: string;
    /** Optional note recorded on the approval event. */
    note?: string | null;
    /** Small-team mode only: why the control is weakened; optional external reviewer. */
    sodException?: SodExceptionRequest | null;
    /** Default true: post on approval (UC-05 step 4). */
    post?: boolean;
    periodOverride?: { reason: string };
    outbox?: PostingOutbox;
  },
): Promise<ApproveBillResult> {
  const note = reasonOf(opts.note, false);
  const bill = await loadForWorkflow(trx, opts.billId);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
              'lf.sod:' || current_setting('app.tenant_id') || ${`:bill:${bill.id}`}, 0))`.execute(
    trx,
  );
  expectStatus(bill, ['awaiting_approval'], 'approving');
  const decision = evaluateSod({
    step: 'bill.approve',
    actorId: opts.approvedBy,
    subject: { amount: bill.approval_amount },
    history: historyWithEnterer(bill, await sodHistory(trx, bill.id)),
    settings: await currentSodSettings(trx),
    otherEligible: await otherEligible(trx, opts.approvedBy, BILL_APPROVE_PERMISSION),
    exception: opts.sodException ?? null,
  });

  if (decision.outcome === 'deny') {
    await trx
      .insertInto('audit.audit_log')
      .values({
        actor_type: 'user',
        actor_user_id: opts.approvedBy,
        action: 'sod_violation',
        entity_type: 'bill',
        entity_id: bill.id,
        after: JSON.stringify({
          step: 'bill.approve',
          rule: decision.rule,
          amount: bill.approval_amount,
          small_team_exception_required: decision.smallTeamExceptionRequired,
        }),
      })
      .execute();
    await event(trx, bill, {
      action: 'approval_denied',
      actorId: opts.approvedBy,
      reason: note,
      amount: bill.approval_amount,
      sodRule: decision.rule,
    });
    return {
      outcome: 'denied',
      billId: bill.id,
      rule: decision.rule,
      smallTeamExceptionRequired: decision.smallTeamExceptionRequired,
    };
  }

  const exception =
    decision.outcome === 'allow_with_exception' && opts.sodException ? opts.sodException : null;
  if (decision.outcome === 'allow_with_exception' && exception) {
    for (const rule of decision.rules) {
      await sql`
        INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind,
                                       reviewer_user_id, reason)
        VALUES (${rule}, 'bill', ${bill.id}, 'bill.approve', ${opts.approvedBy}, ${decision.kind},
                ${exception.reviewerId ?? null}, ${exception.reason.trim()})`.execute(trx);
    }
  }
  await sql`
    INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, amount)
    VALUES ('bill', ${bill.id}, 'bill.approve', ${opts.approvedBy}, ${bill.approval_amount})`.execute(
    trx,
  );
  await trx
    .updateTable('app.bill')
    .set({ status: 'approved', approved_by: opts.approvedBy })
    .where('id', '=', bill.id)
    .execute();
  await event(trx, bill, {
    action: 'approve',
    actorId: opts.approvedBy,
    reason: note ?? (exception ? exception.reason.trim() : null),
    amount: bill.approval_amount,
    sodException: exception !== null,
  });

  const sodException =
    decision.outcome === 'allow_with_exception'
      ? { rules: decision.rules, kind: decision.kind }
      : null;
  if (opts.post === false) {
    return { outcome: 'approved', billId: bill.id, status: 'approved', posted: null, sodException };
  }
  const posted = await postBill(trx, bill.id, {
    createdBy: opts.approvedBy,
    ...(opts.periodOverride === undefined ? {} : { periodOverride: opts.periodOverride }),
    ...(opts.outbox === undefined ? {} : { outbox: opts.outbox }),
  });
  return { outcome: 'approved', billId: bill.id, status: 'posted', posted, sodException };
}

// ---------------------------------------------------------------------------------------------
// Reject / send back

const BACK_TO_DRAFT = {
  status: 'draft',
  submitted_by: null,
  submitted_at: null,
  approval_amount: null,
  approved_by: null,
  approved_at: null,
} as const;

/** Reject a bill awaiting approval: back to draft, with a reason on the trail. */
export async function rejectBill(
  trx: Trx,
  opts: { billId: string; rejectedBy: string; reason: string },
): Promise<{ billId: string; status: 'draft' }> {
  const reason = reasonOf(opts.reason, true);
  const bill = await loadForWorkflow(trx, opts.billId);
  expectStatus(bill, ['awaiting_approval'], 'rejecting');
  await trx.updateTable('app.bill').set(BACK_TO_DRAFT).where('id', '=', bill.id).execute();
  await event(trx, bill, {
    action: 'reject',
    actorId: opts.rejectedBy,
    reason,
    amount: bill.approval_amount,
  });
  return { billId: bill.id, status: 'draft' };
}

/**
 * Send an approved (not yet posted) bill back to draft so it can be edited; the approval is
 * cleared and the bill must be submitted and approved again.
 */
export async function returnBillToDraft(
  trx: Trx,
  opts: { billId: string; by: string; reason: string },
): Promise<{ billId: string; status: 'draft' }> {
  const reason = reasonOf(opts.reason, true);
  const bill = await loadForWorkflow(trx, opts.billId);
  expectStatus(bill, ['approved'], 'sending back to draft');
  await trx.updateTable('app.bill').set(BACK_TO_DRAFT).where('id', '=', bill.id).execute();
  await event(trx, bill, {
    action: 'return_to_draft',
    actorId: opts.by,
    reason,
    amount: bill.approval_amount,
  });
  return { billId: bill.id, status: 'draft' };
}

// ---------------------------------------------------------------------------------------------
// Edit a draft

export interface DraftBillChanges {
  supplierRef?: string;
  billDate?: string;
  dueDate?: string;
  memo?: string | null;
  /**
   * The bill's lines in order. Existing lines are replaced by line number and extra lines are
   * added; a bill's lines are never deleted (directive 6), so fewer lines than stored are refused.
   */
  lines?: readonly BillLineInput[];
}

/** Edit a draft bill. The editor records SoD step `bill.enter` (RQ-0116 F4). */
export async function updateDraftBill(
  trx: Trx,
  opts: { billId: string; updatedBy: string; changes: DraftBillChanges },
): Promise<void> {
  const bill = await loadForWorkflow(trx, opts.billId);
  if (bill.status !== 'draft') {
    throw new BillError(
      'BILL_NOT_EDITABLE',
      `bill ${bill.bill_no} is ${bill.status}; send it back to draft to edit it (it must then be approved again)`,
    );
  }
  const c = opts.changes;
  const bad = (m: string, line?: number): never => {
    throw new BillError('INVALID_BILL', m, line === undefined ? {} : { line });
  };
  if (c.supplierRef !== undefined && supplierRefKey(c.supplierRef) === '') {
    bad('the supplier invoice number needs at least one letter or digit');
  }
  for (const d of [c.billDate, c.dueDate])
    if (d !== undefined && !DATE_RE.test(d)) bad('dates are YYYY-MM-DD');
  const header = {
    ...(c.supplierRef === undefined ? {} : { supplier_ref: c.supplierRef.trim() }),
    ...(c.billDate === undefined ? {} : { bill_date: c.billDate }),
    ...(c.dueDate === undefined ? {} : { due_date: c.dueDate }),
    ...(c.memo === undefined ? {} : { memo: c.memo }),
  };
  if (Object.keys(header).length > 0) {
    await trx.updateTable('app.bill').set(header).where('id', '=', bill.id).execute();
  }
  if (c.lines !== undefined) {
    const scale = minorUnits(toCurrency(bill.currency));
    const stored = await trx
      .selectFrom('app.bill_line')
      .select('line_no')
      .where('bill_id', '=', bill.id)
      .execute();
    if (c.lines.length < stored.length) {
      bad(`a bill keeps its ${String(stored.length)} lines; lines are never deleted`);
    }
    for (const [i, l] of c.lines.entries()) {
      const m = AMOUNT_RE.exec(l.amount);
      if (!m || /^0*(\.0*)?$/.test(l.amount)) bad(`amount ${l.amount} must be positive`, i + 1);
      if ((m?.[1] ?? '').replace(/0+$/, '').length > scale) {
        bad(`amount ${l.amount} has more than ${String(scale)} decimals`, i + 1);
      }
      if (l.description.trim() === '') bad('a line needs a description', i + 1);
      const coded = (l.accountId ?? l.productId ?? null) !== null;
      const values = {
        description: l.description.trim(),
        amount: l.amount,
        account_id: l.accountId ?? null,
        product_id: l.productId ?? null,
        posting_slot: l.postingSlot ?? 'expense',
        tax_code: l.taxCode ?? null,
        coding_source: coded ? (l.codingSource ?? 'manual') : null,
      };
      if (i < stored.length) {
        await trx
          .updateTable('app.bill_line')
          .set(values)
          .where('bill_id', '=', bill.id)
          .where('line_no', '=', i + 1)
          .execute();
      } else {
        await trx
          .insertInto('app.bill_line')
          .values({ ...values, company_id: bill.company_id, bill_id: bill.id, line_no: i + 1 })
          .execute();
      }
    }
  }
  await recordBillEnter(trx, bill.id, opts.updatedBy);
}

// ---------------------------------------------------------------------------------------------
// Trail

export interface BillApprovalEvent {
  action: 'submit' | 'approve' | 'approval_denied' | 'reject' | 'return_to_draft';
  actorId: string;
  reason: string | null;
  amount: string | null;
  sodRule: string | null;
  sodException: boolean;
  occurredAt: Date;
}

/** The approval trail of a bill, oldest first. */
export async function billApprovalHistory(trx: Trx, billId: string): Promise<BillApprovalEvent[]> {
  const rows = await trx
    .selectFrom('app.bill_approval_event')
    .select([
      'action',
      'actor_user_id',
      'reason',
      'amount',
      'sod_rule',
      'sod_exception',
      'occurred_at',
    ])
    .where('bill_id', '=', billId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    action: r.action,
    actorId: r.actor_user_id,
    reason: r.reason,
    amount: r.amount,
    sodRule: r.sod_rule,
    sodException: r.sod_exception,
    occurredAt: r.occurred_at,
  }));
}
