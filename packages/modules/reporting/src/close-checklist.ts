/**
 * Month-end close checklist (T-0078, UC-10, design §3.5, DL-0404).
 *
 * Steps, in order: AR lock → AP lock → bank recs complete → accruals → TB review → soft close →
 * hard lock. Each completed step is recorded once (app.close_checklist_step, migration 0061) with
 * user, time and the period status it leaves. Preconditions:
 * - every earlier step is complete (OUT_OF_ORDER) and a step is completed once (ALREADY_DONE);
 * - status steps change the period through app.period_set_status, which enforces period.lock
 *   (AR/AP lock) and period.close (soft close, hard lock) for the acting user;
 * - bank recs: no bank account may have statement lines up to the period end that a completed
 *   reconciliation does not cover (SS-UC10-07). The check is a port; production passes
 *   @ledgerforce/bank `unreconciledBankAccounts` (reporting does not depend on bank at runtime);
 * - TB review: the trial balance at the period end nets to zero and AR/AP subledgers equal their
 *   controls (SS-UC10-08, `trialBalanceReview`).
 * "Hard lock after BAS" is the human's sign-off (UC-10); lodgement is not tracked in the MVP.
 */
import type { Database } from '@ledgerforce/db';
import { setPeriodStatus, type PeriodStatus } from '@ledgerforce/ledger';
import { sql, type Transaction } from 'kysely';
import { trialBalanceReview } from './reports.ts';

type Trx = Transaction<Database>;

export const CLOSE_STEPS = [
  'ar_lock',
  'ap_lock',
  'bank_recs',
  'accruals',
  'tb_review',
  'soft_close',
  'hard_lock',
] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

const STATUS_OF: Partial<Record<CloseStep, PeriodStatus>> = {
  ar_lock: 'ar_locked',
  ap_lock: 'ap_locked',
  soft_close: 'soft_closed',
  hard_lock: 'hard_locked',
};

export interface UnreconciledBankAccount {
  readonly bankAccountId: string;
  readonly name: string;
  readonly unreconciledLines: number;
}

export interface CloseDeps {
  /** Bank accounts with statement lines up to `asOf` not covered by a completed reconciliation. */
  unreconciledBank(trx: Trx, companyId: string, asOf: string): Promise<UnreconciledBankAccount[]>;
}

export type CloseErrorCode =
  | 'UNKNOWN_PERIOD'
  | 'OUT_OF_ORDER'
  | 'ALREADY_DONE'
  | 'BANK_UNRECONCILED'
  | 'TB_NOT_BALANCED'
  | 'SUBLEDGER_DIFFERENCE';

export class CloseError extends Error {
  readonly code: CloseErrorCode;
  readonly accounts?: readonly UnreconciledBankAccount[];
  constructor(
    code: CloseErrorCode,
    message: string,
    accounts?: readonly UnreconciledBankAccount[],
  ) {
    super(message);
    this.name = 'CloseError';
    this.code = code;
    if (accounts) this.accounts = accounts;
  }
}

export interface CloseStepView {
  readonly step: CloseStep;
  readonly completedBy: string | null;
  readonly completedAt: Date | null;
  readonly periodStatus: PeriodStatus | null;
}

async function loadPeriod(trx: Trx, companyId: string, periodId: string) {
  const p = (
    await sql<{ id: string; end: string; status: PeriodStatus }>`
      SELECT id::text, end_date::text AS end, status FROM app.fiscal_period
       WHERE company_id = ${companyId} AND id::text = ${periodId.toLowerCase()}`.execute(trx)
  ).rows[0];
  if (!p) throw new CloseError('UNKNOWN_PERIOD', `no period ${periodId} in this company`);
  return p;
}

/** The period's checklist: every step in order, with who completed it and when. */
export async function closeChecklist(
  trx: Trx,
  q: { companyId: string; periodId: string },
): Promise<CloseStepView[]> {
  const companyId = q.companyId.toLowerCase();
  const p = await loadPeriod(trx, companyId, q.periodId);
  const done = await trx
    .selectFrom('app.close_checklist_step')
    .select(['step', 'completed_by', 'completed_at', 'period_status'])
    .where('company_id', '=', companyId)
    .where('period_id', '=', p.id)
    .execute();
  return CLOSE_STEPS.map((step) => {
    const d = done.find((x) => x.step === step);
    return {
      step,
      completedBy: d?.completed_by ?? null,
      completedAt: d ? new Date(d.completed_at) : null,
      periodStatus: d?.period_status ?? null,
    };
  });
}

/** Complete one checklist step for a period (see the module rules). */
export async function completeCloseStep(
  trx: Trx,
  c: { companyId: string; periodId: string; step: CloseStep; by: string },
  deps: CloseDeps,
): Promise<{
  step: CloseStep;
  completedBy: string;
  completedAt: Date;
  periodStatus: PeriodStatus;
}> {
  const companyId = c.companyId.toLowerCase();
  const p = await loadPeriod(trx, companyId, c.periodId);
  const list = await closeChecklist(trx, { companyId, periodId: p.id });
  const index = CLOSE_STEPS.indexOf(c.step);
  if (list[index]?.completedBy) {
    throw new CloseError('ALREADY_DONE', `${c.step} is already complete for this period`);
  }
  const missing = list.slice(0, index).find((s) => !s.completedBy);
  if (missing) {
    throw new CloseError('OUT_OF_ORDER', `${c.step} needs ${missing.step} to be complete first`);
  }

  let detail: Record<string, unknown> = {};
  if (c.step === 'bank_recs') {
    const open = await deps.unreconciledBank(trx, companyId, p.end);
    if (open.length > 0) {
      const names = open.map((a) => `${a.name} (${String(a.unreconciledLines)} lines)`).join(', ');
      throw new CloseError(
        'BANK_UNRECONCILED',
        `bank reconciliations are not complete to ${p.end}: ${names}`,
        open,
      );
    }
    detail = { asOf: p.end };
  }
  if (c.step === 'tb_review') {
    const review = await trialBalanceReview(trx, { companyId, periodId: p.id });
    if (!review.netsToZero) {
      throw new CloseError('TB_NOT_BALANCED', `the trial balance at ${p.end} does not net to zero`);
    }
    const off = review.controls.filter((x) => x.status === 'difference');
    if (off.length > 0) {
      throw new CloseError(
        'SUBLEDGER_DIFFERENCE',
        `subledger and control differ for ${off.map((x) => x.role).join(', ')} at ${p.end}`,
      );
    }
    detail = {
      asOf: p.end,
      controls: review.controls.map((x) => ({ role: x.role, status: x.status })),
    };
  }

  const target = STATUS_OF[c.step];
  if (target) await setPeriodStatus(trx, { periodId: p.id, status: target, actorId: c.by });
  const status = target ?? (await loadPeriod(trx, companyId, p.id)).status;
  const row = await trx
    .insertInto('app.close_checklist_step')
    .values({
      company_id: companyId,
      period_id: p.id,
      step: c.step,
      completed_by: c.by,
      period_status: status,
      detail: JSON.stringify(detail),
    })
    .returning(['completed_at'])
    .executeTakeFirstOrThrow();
  return {
    step: c.step,
    completedBy: c.by,
    completedAt: new Date(row.completed_at),
    periodStatus: status,
  };
}
