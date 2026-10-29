/**
 * Period control as data (design §3.5, §3.3 invariant 3, T-0023, RQ-0026).
 *
 * This file is the single source of the source-type × period-status matrix. Migration 0018
 * mirrors it in two IMMUTABLE SQL functions (`app.source_type_class`, `app.period_decision`)
 * that the invariant-3 trigger uses; period-control.db.test.ts proves the two agree for every
 * cell (fast-check) and that the trigger enforces each one. Change both together, never one.
 *
 * Open question for the product owner (design §11.3 item 4): may a bank/Stripe payout dated in
 * an AR-locked period post? Until decided, the cell is the tenant setting `payoutUnderArLock`,
 * default `override` (treated as AR — the safe choice).
 */
import type { Permission } from '@ledgerforce/shared/rbac';

export const PERIOD_STATUSES = [
  'open',
  'ar_locked',
  'ap_locked',
  'soft_closed',
  'hard_locked',
] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const SOURCE_CLASSES = ['ar', 'ap', 'journal', 'payout', 'reversal'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/** allow = anyone with the posting permission; override = needs a recorded period override. */
export type Decision = 'allow' | 'override' | 'deny';

export const PAYOUT_UNDER_AR_LOCK = ['override', 'allow'] as const;
export type PayoutUnderArLock = (typeof PAYOUT_UNDER_AR_LOCK)[number];

export const LOCK_DATE_POLICIES = ['reject', 'post_to_first_open_date_with_note'] as const;
export type LockDatePolicy = (typeof LOCK_DATE_POLICIES)[number];

export interface PeriodSettings {
  lockDatePolicy: LockDatePolicy;
  payoutUnderArLock: PayoutUnderArLock;
}

/** Used when a tenant has never saved period settings. */
export const DEFAULT_PERIOD_SETTINGS: Readonly<PeriodSettings> = Object.freeze({
  lockDatePolicy: 'reject',
  payoutUnderArLock: 'override',
});

/** The permissions migration 0018 mirrors in app.role_allows_period_permission. */
export const PERIOD_PERMISSIONS: readonly Permission[] = Object.freeze([
  'period.lock',
  'period.close',
  'period.lock.override',
  'period.reopen',
]);

/**
 * Stored code of a golden-posting source type: journal_entry.source_type allows only
 * `^[a-z][a-z0-9_]*$` (migration 0007), so dots become underscores.
 */
export function storedSourceType(golden: string): string {
  return golden.replace(/\./g, '_');
}

const st = (golden: string, cls: SourceClass) =>
  [storedSourceType(golden), { golden, class: cls }] as const;

/** Every source type the ledger accepts (RQ-0026 finding 3). Anything else is refused. */
export const SOURCE_TYPES: Readonly<
  Record<string, Readonly<{ golden: string; class: SourceClass }>>
> = Object.freeze(
  Object.fromEntries(
    [
      st('ar.invoice', 'ar'),
      st('ar.credit_note', 'ar'),
      st('ar.receipt', 'ar'),
      st('ar.refund', 'ar'),
      st('ar.write_off', 'ar'),
      st('ar.prepayment', 'ar'),
      st('ar.prepayment_application', 'ar'),
      st('payments.stripe.charge', 'ar'), // a customer payment
      st('payments.stripe.payout', 'payout'), // open question: see file header
      st('ap.bill', 'ap'),
      st('ap.payment', 'ap'),
      st('payroll.pay_run', 'ap'), // Phase 1; conservative (RQ-0026)
      st('payroll.net_pay_batch', 'ap'), // Phase 1; conservative (RQ-0026)
      st('manual_journal', 'journal'),
      st('ledger.reversal', 'reversal'), // a void changes the locked side: override under any lock
    ].map(([k, v]) => [k, Object.freeze(v)]),
  ),
);

/** Design §3.5 "Who can post". 'tenant_setting' = PeriodSettings.payoutUnderArLock. */
export const PERIOD_MATRIX: Readonly<
  Record<PeriodStatus, Readonly<Record<SourceClass, Decision | 'tenant_setting'>>>
> = Object.freeze({
  open: { ar: 'allow', ap: 'allow', journal: 'allow', payout: 'allow', reversal: 'allow' },
  ar_locked: {
    ar: 'override',
    ap: 'allow',
    journal: 'allow',
    payout: 'tenant_setting',
    reversal: 'override',
  },
  ap_locked: {
    ar: 'override',
    ap: 'override',
    journal: 'allow',
    payout: 'override',
    reversal: 'override',
  },
  soft_closed: {
    ar: 'override',
    ap: 'override',
    journal: 'override',
    payout: 'override',
    reversal: 'override',
  },
  hard_locked: { ar: 'deny', ap: 'deny', journal: 'deny', payout: 'deny', reversal: 'deny' },
});

export function sourceClassOf(sourceType: string): SourceClass | undefined {
  return Object.hasOwn(SOURCE_TYPES, sourceType) ? SOURCE_TYPES[sourceType]?.class : undefined;
}

/** What a period in `status` says about posting `sourceType`. Unknown source types: deny. */
export function periodDecision(
  status: PeriodStatus,
  sourceType: string,
  settings: PeriodSettings = DEFAULT_PERIOD_SETTINGS,
): Decision {
  const cls = sourceClassOf(sourceType);
  if (cls === undefined) return 'deny';
  const cell = PERIOD_MATRIX[status][cls];
  return cell === 'tenant_setting' ? settings.payoutUnderArLock : cell;
}

/** Whether a posting goes through, given whether a valid override was recorded for it. */
export function mayPost(
  status: PeriodStatus,
  sourceType: string,
  opts: { override: boolean },
  settings: PeriodSettings = DEFAULT_PERIOD_SETTINGS,
): boolean {
  const d = periodDecision(status, sourceType, settings);
  return d === 'allow' || (d === 'override' && opts.override);
}

// ---------------------------------------------------------------------------------------------
// Fiscal years (data, not code: AU 1 July is a convention row, not a constant in the generator)

export interface FiscalYearConvention {
  /** 1 = January … 12 = December; the year starts on day 1 of this month. */
  startMonth: number;
}

export const FISCAL_YEAR_CONVENTIONS = Object.freeze({
  AU: Object.freeze({ startMonth: 7 }), // 1 July – 30 June (ATO income year)
  calendar: Object.freeze({ startMonth: 1 }),
} satisfies Record<string, FiscalYearConvention>);
export type FiscalYearConventionName = keyof typeof FISCAL_YEAR_CONVENTIONS;

export interface PlannedPeriod {
  no: number;
  /** YYYY-MM of the month. */
  name: string;
  start: string;
  end: string;
}

export interface FiscalYearPlan {
  /** FY + the calendar year in which the fiscal year ends (FY2027 = 2026-07-01 … 2027-06-30). */
  label: string;
  start: string;
  end: string;
  periods: PlannedPeriod[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const daysIn = (y: number, m: number) =>
  [
    31,
    (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][m - 1] ?? 0;

/** Twelve monthly periods of the fiscal year that starts in calendar year `startYear`. */
export function fiscalYearPlan(
  convention: FiscalYearConventionName | FiscalYearConvention,
  startYear: number,
): FiscalYearPlan {
  const { startMonth } =
    typeof convention === 'string' ? FISCAL_YEAR_CONVENTIONS[convention] : convention;
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError(`fiscal year start month must be 1..12, got ${String(startMonth)}`);
  }
  if (!Number.isInteger(startYear) || startYear < 1000 || startYear > 9998) {
    throw new RangeError(`fiscal year start year out of range: ${String(startYear)}`);
  }
  const periods: PlannedPeriod[] = [];
  for (let i = 0; i < 12; i++) {
    const m0 = startMonth - 1 + i;
    const y = startYear + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    periods.push({
      no: i + 1,
      name: `${pad(y, 4)}-${pad(m)}`,
      start: `${pad(y, 4)}-${pad(m)}-01`,
      end: `${pad(y, 4)}-${pad(m)}-${pad(daysIn(y, m))}`,
    });
  }
  const first = periods[0];
  const last = periods[11];
  if (!first || !last) throw new Error('unreachable');
  return { label: `FY${last.end.slice(0, 4)}`, start: first.start, end: last.end, periods };
}
