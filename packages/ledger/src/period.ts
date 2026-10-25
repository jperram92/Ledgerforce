/**
 * Period control API (design §3.5, §2 lock dates, §5.6 rule 5; T-0023, RQ-0026).
 *
 * The database is the last line of defence (migration 0018): a BEFORE trigger on journal_entry
 * refuses a posted entry whose entry_date is in no period of its company, or in a period whose
 * status does not allow its source type (unless a matching override was recorded). Status
 * changes run only through SECURITY DEFINER functions that check the actor's period permission;
 * a hard-locked period reopens only through request + approval by two different users.
 *
 * This module is what the posting engine and the close screens call. resolvePostingDate()
 * applies the tenant lock-date policy before anything is written.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import {
  DEFAULT_PERIOD_SETTINGS,
  FISCAL_YEAR_CONVENTIONS,
  fiscalYearPlan,
  periodDecision,
  type FiscalYearConvention,
  type FiscalYearConventionName,
  type PeriodSettings,
  type PeriodStatus,
} from './period-matrix.ts';

type Trx = Transaction<Database>;

export type PeriodErrorCode = 'PERIOD_LOCKED' | 'NO_PERIOD' | 'UNKNOWN_SOURCE_TYPE';

/** A posting (or reconciliation change) refused by period control. */
export class PeriodLockedError extends Error {
  readonly code: PeriodErrorCode;
  readonly entryDate: string | undefined;
  readonly periodStatus: PeriodStatus | undefined;
  constructor(
    code: PeriodErrorCode,
    message: string,
    detail: { entryDate?: string; periodStatus?: PeriodStatus; cause?: unknown } = {},
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'PeriodLockedError';
    this.code = code;
    this.entryDate = detail.entryDate;
    this.periodStatus = detail.periodStatus;
  }
}

/** Constraint names raised by migration 0018's triggers → error code. */
const DB_CONSTRAINTS: Readonly<Record<string, PeriodErrorCode>> = {
  journal_entry_period_allows: 'PERIOD_LOCKED',
  bank_statement_line_period_open: 'PERIOD_LOCKED',
  journal_entry_in_period: 'NO_PERIOD',
  journal_entry_source_type_known: 'UNKNOWN_SOURCE_TYPE',
};

/** Map a database error from period control to a PeriodLockedError; anything else → undefined. */
export function toPeriodError(error: unknown): PeriodLockedError | undefined {
  if (error instanceof PeriodLockedError) return error;
  const e = error as { code?: string; constraint?: string; message?: string } | null;
  const code = e?.code === '23514' && e.constraint ? DB_CONSTRAINTS[e.constraint] : undefined;
  return code ? new PeriodLockedError(code, e?.message ?? code, { cause: error }) : undefined;
}

export interface PeriodRow {
  id: string;
  name: string;
  status: PeriodStatus;
  start: string;
  end: string;
}

/** The company's period containing `date` (YYYY-MM-DD), if any. */
export async function findPeriod(
  trx: Trx,
  companyId: string,
  date: string,
): Promise<PeriodRow | undefined> {
  const r = await sql<PeriodRow>`
    SELECT id, name, status, start_date::text AS start, end_date::text AS end
      FROM app.fiscal_period
     WHERE company_id = ${companyId} AND ${date}::date BETWEEN start_date AND end_date`.execute(
    trx,
  );
  return r.rows[0];
}

export interface GeneratedFiscalYear {
  fiscalYearId: string;
  label: string;
  periods: { id: string; no: number; name: string; start: string; end: string }[];
}

/** Insert one fiscal year and its twelve open monthly periods (overlaps are refused by the DB). */
export async function generateFiscalYear(
  trx: Trx,
  input: {
    companyId: string;
    convention: FiscalYearConventionName | FiscalYearConvention;
    startYear: number;
    createdBy?: string;
  },
): Promise<GeneratedFiscalYear> {
  const convention =
    typeof input.convention === 'string'
      ? FISCAL_YEAR_CONVENTIONS[input.convention]
      : input.convention;
  const plan = fiscalYearPlan(convention, input.startYear);
  const fy = await sql<{ id: string }>`
    INSERT INTO app.fiscal_year (company_id, label, start_date, end_date, created_by)
    VALUES (${input.companyId}, ${plan.label}, ${plan.start}, ${plan.end}, ${input.createdBy ?? null})
    RETURNING id`.execute(trx);
  const fiscalYearId = fy.rows[0]?.id;
  if (!fiscalYearId) throw new Error('generateFiscalYear: insert returned no id');
  const periods: GeneratedFiscalYear['periods'] = [];
  for (const p of plan.periods) {
    const r = await sql<{ id: string }>`
      INSERT INTO app.fiscal_period (company_id, fiscal_year_id, period_no, name, start_date, end_date)
      VALUES (${input.companyId}, ${fiscalYearId}, ${p.no}, ${p.name}, ${p.start}, ${p.end})
      RETURNING id`.execute(trx);
    periods.push({ id: r.rows[0]?.id ?? '', ...p });
  }
  return { fiscalYearId, label: plan.label, periods };
}

/**
 * Change a period's status (not out of hard_locked: use requestReopen/approveReopen). Forward
 * needs period.lock (AR/AP lock) or period.close (soft close, hard lock); backward needs
 * period.reopen and a reason.
 */
export async function setPeriodStatus(
  trx: Trx,
  input: { periodId: string; status: PeriodStatus; actorId: string; reason?: string },
): Promise<void> {
  await sql`SELECT app.period_set_status(${input.periodId}, ${input.status}, ${input.actorId}, ${
    input.reason ?? null
  })`.execute(trx);
}

/** First approval of reopening a hard-locked period (needs period.reopen and a reason). */
export async function requestReopen(
  trx: Trx,
  input: { periodId: string; toStatus: PeriodStatus; actorId: string; reason: string },
): Promise<string> {
  const r = await sql<{ id: string }>`
    SELECT app.period_reopen_request(${input.periodId}, ${input.toStatus}, ${input.actorId}, ${input.reason}) AS id`.execute(
    trx,
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('requestReopen: no request id');
  return id;
}

/** Second approval by a different holder of period.reopen; the period then reopens. */
export async function approveReopen(
  trx: Trx,
  input: { requestId: string; actorId: string },
): Promise<void> {
  await sql`SELECT app.period_reopen_approve(${input.requestId}, ${input.actorId})`.execute(trx);
}

/**
 * Record that `grantedBy` (holder of period.lock.override) posts this one entry (company,
 * idempotency key) into a period whose cell is "override". The entry must be created_by the
 * same user. Audited by the database.
 */
export async function recordPeriodOverride(
  trx: Trx,
  input: {
    companyId: string;
    periodId: string;
    sourceType: string;
    idempotencyKey: string;
    grantedBy: string;
    reason: string;
  },
): Promise<string> {
  const r = await sql<{ id: string }>`
    INSERT INTO app.period_override (company_id, period_id, source_type, idempotency_key, granted_by, reason)
    VALUES (${input.companyId}, ${input.periodId}, ${input.sourceType}, ${input.idempotencyKey},
            ${input.grantedBy}, ${input.reason})
    RETURNING id`.execute(trx);
  return r.rows[0]?.id ?? '';
}

/** The tenant's current period settings (latest row), or the defaults. */
export async function getPeriodSettings(trx: Trx): Promise<PeriodSettings> {
  const r = await sql<{ lock_date_policy: string; payout_under_ar_lock: string }>`
    SELECT lock_date_policy, payout_under_ar_lock FROM app.period_settings
     ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  if (!row) return { ...DEFAULT_PERIOD_SETTINGS };
  return {
    lockDatePolicy: row.lock_date_policy as PeriodSettings['lockDatePolicy'],
    payoutUnderArLock: row.payout_under_ar_lock as PeriodSettings['payoutUnderArLock'],
  };
}

/** Save new settings as a new history row (needs period.lock; audited by the database). */
export async function setPeriodSettings(
  trx: Trx,
  input: { settings: PeriodSettings; setBy: string; reason: string },
): Promise<void> {
  await sql`
    INSERT INTO app.period_settings (lock_date_policy, payout_under_ar_lock, set_by, reason)
    VALUES (${input.settings.lockDatePolicy}, ${input.settings.payoutUnderArLock}, ${input.setBy}, ${input.reason})`.execute(
    trx,
  );
}

export interface ResolvedPostingDate {
  entryDate: string;
  periodId: string;
  /** True when the lock-date policy moved the date forward. */
  redirected: boolean;
  /** The note to put on the document when redirected. */
  note?: string;
  /** True when the date stays in a period that needs a recorded override (caller has one). */
  needsOverride: boolean;
}

/**
 * Decide the posting date before anything is written (design §2, §5.6 rule 5):
 *  - the period allows the source type → the date stands;
 *  - the cell is "override" and the caller holds one (`withOverride`) → the date stands, and an
 *    override must be recorded for the entry;
 *  - otherwise policy `reject` → PeriodLockedError(PERIOD_LOCKED); policy
 *    `post_to_first_open_date_with_note` → the start date of the first later period that allows
 *    the source type without override, with a note (none → PERIOD_LOCKED).
 */
export async function resolvePostingDate(
  trx: Trx,
  input: { companyId: string; entryDate: string; sourceType: string; withOverride?: boolean },
): Promise<ResolvedPostingDate> {
  const settings = await getPeriodSettings(trx);
  const period = await findPeriod(trx, input.companyId, input.entryDate);
  if (!period) {
    throw new PeriodLockedError(
      'NO_PERIOD',
      `NO_PERIOD: no fiscal period of company ${input.companyId} covers ${input.entryDate}`,
      { entryDate: input.entryDate },
    );
  }
  const decision = periodDecision(period.status, input.sourceType, settings);
  if (decision === 'allow') {
    return {
      entryDate: input.entryDate,
      periodId: period.id,
      redirected: false,
      needsOverride: false,
    };
  }
  if (decision === 'override' && input.withOverride === true) {
    return {
      entryDate: input.entryDate,
      periodId: period.id,
      redirected: false,
      needsOverride: true,
    };
  }
  const locked = () =>
    new PeriodLockedError(
      'PERIOD_LOCKED',
      `PERIOD_LOCKED: period ${period.name} is ${period.status}; ${input.sourceType} dated ${input.entryDate} cannot post`,
      { entryDate: input.entryDate, periodStatus: period.status },
    );
  if (settings.lockDatePolicy === 'reject') throw locked();
  const later = await sql<PeriodRow>`
    SELECT id, name, status, start_date::text AS start, end_date::text AS end
      FROM app.fiscal_period
     WHERE company_id = ${input.companyId} AND start_date > ${period.end}::date
     ORDER BY start_date`.execute(trx);
  const target = later.rows.find(
    (p) => periodDecision(p.status, input.sourceType, settings) === 'allow',
  );
  if (!target) throw locked();
  return {
    entryDate: target.start,
    periodId: target.id,
    redirected: true,
    needsOverride: false,
    note:
      `Dated ${input.entryDate} in period ${period.name} (${period.status}); ` +
      `posted on the first open date ${target.start} under the tenant lock-date policy.`,
  };
}
