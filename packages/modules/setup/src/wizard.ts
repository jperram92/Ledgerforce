/**
 * The persisted setup wizard (T-0123, design §4.1, ADR-0067, RQ-0149).
 *
 * Per company, steps 1–10 unlock in order. The wizard stores only the completion record
 * (app.setup_wizard_step, migration 0065); status is derived — a record = complete, the first
 * step without one = in progress (the only unlocked incomplete step), later steps = locked and
 * not started. A step completes only when its validator (wizard-validators.ts, reading the owning
 * module) lists nothing missing; step 9 may instead record a no-history declaration with a reason.
 * Validators run on every read, so a completed step whose module state regresses shows
 * valid: false and what is missing, but stays complete (no reopen in the MVP).
 * Completing step 1 seeds the default overdue-reminder schedule (AC-6, UC-04 precondition).
 */
import { seedReminderSchedule } from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import type { Selectable, Transaction } from 'kysely';
import type { SetupWizardStepTable } from '@ledgerforce/db';
import { openingBalanceOf } from './opening-balances.ts';
import { NO_HISTORY_STEP, WIZARD_STEPS } from './wizard-validators.ts';

type Trx = Transaction<Database>;
type Row = Selectable<SetupWizardStepTable>;

export type WizardErrorCode =
  'INVALID_COMMAND' | 'UNKNOWN_COMPANY' | 'STEP_LOCKED' | 'STEP_INVALID' | 'NO_HISTORY_NOT_ALLOWED';

/** A wizard request refused; nothing was written. `missing` is set for STEP_INVALID. */
export class WizardError extends DomainError {
  declare readonly code: WizardErrorCode;
  readonly missing: readonly string[];
  constructor(code: WizardErrorCode, message: string, missing: readonly string[] = []) {
    super(code, message);
    this.missing = missing;
  }
}

export interface WizardStepView {
  step: number;
  title: string;
  status: 'not_started' | 'in_progress' | 'complete';
  locked: boolean;
  /** The validator passes now (a complete step can become invalid if its module state regresses). */
  valid: boolean;
  /** What the validator finds missing, in plain words; [] when valid. */
  missing: string[];
  outcome: 'validated' | 'no_history' | null;
  reason: string | null;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface WizardView {
  companyId: string;
  /** All ten steps complete. */
  complete: boolean;
  steps: WizardStepView[];
}

export interface CompleteWizardStep {
  companyId: string;
  step: number;
  /** YYYY-MM-DD the validators check against (tax codes in force, posting-profile gaps). */
  asOf: string;
  completedBy?: string;
  /** Step 9 only: complete it by declaring a new business with no history (1–500 characters). */
  noHistoryReason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEP_COUNT = WIZARD_STEPS.length;

const invalid = (message: string): never => {
  throw new WizardError('INVALID_COMMAND', message);
};
const titleOf = (step: number) => WIZARD_STEPS[step - 1]?.title ?? '';

function checkCompanyAndDate(companyId: string, asOf: string): string {
  if (!UUID.test(companyId)) invalid('companyId must be a uuid');
  if (!DATE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)))
    invalid('asOf must be a date YYYY-MM-DD');
  return companyId.toLowerCase();
}

async function requireCompany(trx: Trx, companyId: string): Promise<void> {
  const c = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!c) throw new WizardError('UNKNOWN_COMPANY', `no company ${companyId}`);
}

async function completionRows(trx: Trx, companyId: string): Promise<Map<number, Row>> {
  const rows = await trx
    .selectFrom('app.setup_wizard_step')
    .selectAll()
    .where('company_id', '=', companyId)
    .execute();
  return new Map(rows.map((r) => [r.step, r]));
}

/** The first step without a completion record (STEP_COUNT + 1 when all are complete). */
const firstOpen = (done: Map<number, Row>): number => {
  let n = 1;
  while (n <= STEP_COUNT && done.has(n)) n += 1;
  return n;
};

function viewOf(step: number, row: Row | undefined, open: number, missing: string[]) {
  return {
    step,
    title: titleOf(step),
    status: row ? 'complete' : step === open ? 'in_progress' : 'not_started',
    locked: step > open,
    valid: missing.length === 0,
    missing,
    outcome: row?.outcome ?? null,
    reason: row?.reason ?? null,
    completedAt: row?.completed_at ?? null,
    completedBy: row?.completed_by ?? null,
  } satisfies WizardStepView;
}

const validate = (trx: Trx, companyId: string, step: number, asOf: string, row?: Row) =>
  WIZARD_STEPS[step - 1]?.validate(trx, {
    companyId,
    asOf,
    noHistory: row?.outcome === 'no_history',
  }) ?? Promise.resolve([]);

/** The wizard of one company: every step's status, lock and what its validator finds missing. */
export async function wizardOf(
  trx: Trx,
  companyIdIn: string,
  o: { asOf: string },
): Promise<WizardView> {
  const companyId = checkCompanyAndDate(companyIdIn, o.asOf);
  await requireCompany(trx, companyId);
  const done = await completionRows(trx, companyId);
  const open = firstOpen(done);
  const steps: WizardStepView[] = [];
  for (let n = 1; n <= STEP_COUNT; n += 1) {
    const row = done.get(n);
    steps.push(viewOf(n, row, open, await validate(trx, companyId, n, o.asOf, row)));
  }
  return { companyId, complete: open > STEP_COUNT, steps };
}

/**
 * Complete one step: refused unless every earlier step is complete and the validator passes
 * (or, for step 9, a no-history reason is given and no opening balance exists). A step already
 * complete is a replay (`replayed: true`, nothing written).
 */
export async function completeWizardStep(
  trx: Trx,
  c: CompleteWizardStep,
): Promise<{ replayed: boolean; step: WizardStepView }> {
  const companyId = checkCompanyAndDate(c.companyId, c.asOf);
  if (!Number.isInteger(c.step) || c.step < 1 || c.step > STEP_COUNT)
    invalid(`step must be 1–${String(STEP_COUNT)}`);
  if (c.completedBy !== undefined && !UUID.test(c.completedBy))
    invalid('completedBy must be a uuid');
  const reason = c.noHistoryReason?.trim();
  if (reason !== undefined && (reason.length < 1 || reason.length > 500))
    invalid('the no-history reason must be 1–500 characters');
  await requireCompany(trx, companyId);

  const done = await completionRows(trx, companyId);
  const existing = done.get(c.step);
  if (existing) return { replayed: true, step: viewOf(c.step, existing, firstOpen(done), []) };

  if (reason !== undefined) {
    if (c.step !== NO_HISTORY_STEP)
      throw new WizardError(
        'NO_HISTORY_NOT_ALLOWED',
        `only step ${String(NO_HISTORY_STEP)} (${titleOf(NO_HISTORY_STEP)}) can be completed without history`,
      );
    if (await openingBalanceOf(trx, companyId))
      throw new WizardError(
        'NO_HISTORY_NOT_ALLOWED',
        'an opening balance has been posted, so the company has history',
      );
  }

  const open = firstOpen(done);
  if (c.step > open)
    throw new WizardError(
      'STEP_LOCKED',
      `step ${String(c.step)} is locked: complete step ${String(open)} (${titleOf(open)}) first`,
    );

  if (reason === undefined) {
    const missing = await validate(trx, companyId, c.step, c.asOf);
    if (missing.length > 0)
      throw new WizardError(
        'STEP_INVALID',
        `step ${String(c.step)} (${titleOf(c.step)}) is not ready: ${missing.join('; ')}`,
        missing,
      );
  }

  const row = await trx
    .insertInto('app.setup_wizard_step')
    .values({
      company_id: companyId,
      step: c.step,
      outcome: reason === undefined ? 'validated' : 'no_history',
      reason: reason ?? null,
      completed_by: c.completedBy ?? null,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'company_id', 'step']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    // A concurrent request completed it first: replay that record.
    const winner = (await completionRows(trx, companyId)).get(c.step);
    return { replayed: true, step: viewOf(c.step, winner, open + 1, []) };
  }
  if (c.step === 1) await seedReminderSchedule(trx, companyId);
  return { replayed: false, step: viewOf(c.step, row, open + 1, []) };
}
