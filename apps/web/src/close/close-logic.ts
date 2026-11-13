/**
 * Close checklist wording and state (T-0090, UC-10). P12: plain words first, the accounting term
 * after. No accounting happens here: step order and gates are enforced by the API (T-0148).
 */
import type { ChecklistStep, CloseStep, Period, PeriodStatus } from './client.ts';

export const STEP_LABEL: Record<CloseStep, string> = {
  ar_lock: 'Lock sales',
  ap_lock: 'Lock purchases',
  bank_recs: 'Bank reconciliations',
  accruals: 'Accruals and adjustments',
  tb_review: 'Trial balance review',
  soft_close: 'Soft close',
  hard_lock: 'Hard lock',
};

export const STEP_GLOSS: Record<CloseStep, string> = {
  ar_lock: 'No more customer invoices or receipts dated in the period (AR lock).',
  ap_lock: 'No more supplier bills or payments dated in the period (AP lock).',
  bank_recs: 'Every bank statement line up to the period end is reconciled.',
  accruals: 'Accruals, prepayments and other adjustments for the period are entered.',
  tb_review: 'The trial balance nets to zero and each control account agrees with its ledger.',
  soft_close: 'Only adjusting journals by finance may still post (soft close).',
  hard_lock: 'Nothing posts any more; reopening needs two approvers (hard lock).',
};

export const PERIOD_STATUS_WORD: Record<PeriodStatus, string> = {
  open: 'Open',
  ar_locked: 'Sales locked',
  ap_locked: 'Purchases locked',
  soft_closed: 'Soft closed',
  hard_locked: 'Hard locked',
};

export type StepState = 'done' | 'next' | 'waiting';

export function stepStates(steps: readonly ChecklistStep[]): StepState[] {
  const next = steps.findIndex((s) => !s.completed_by);
  return steps.map((s, i) => (s.completed_by ? 'done' : i === next ? 'next' : 'waiting'));
}

/** The period to show when the address names none: the latest that is not hard-locked. */
export function defaultPeriod(periods: readonly Period[]): Period | undefined {
  const open = periods.filter((p) => p.status !== 'hard_locked');
  return open.at(-1) ?? periods.at(-1);
}

/** The period list window: 12 months back to 1 month ahead of `today` (YYYY-MM-DD). */
export function periodWindow(today: string): { from: string; to: string } {
  const [y = 0, m = 1] = today.split('-').map((x) => Number.parseInt(x, 10));
  const iso = (yy: number, mm: number) => {
    const d = new Date(Date.UTC(yy, mm - 1, 1));
    return d.toISOString().slice(0, 10);
  };
  return { from: iso(y - 1, m), to: iso(y, m + 2) };
}

export const whenText = (iso: string): string =>
  new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
