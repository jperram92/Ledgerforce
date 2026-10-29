/**
 * Posting command (design §3.9 step 1) and its pure, in-memory checks (T-0025).
 *
 * A posting command is a *raw* journal: the caller already knows every line (account by
 * system role or account id, debit or credit in base currency, transaction currency, amount and
 * rate, tax code, dimensions, party). Event-specific rules (invoice, receipt, bill, payout …)
 * build such commands later, each only once its golden posting is Approved; this file contains
 * none of them.
 *
 * checkCommand() runs before any SQL: shape, at most 4 decimals on amounts and 8 on rates
 * (PostgreSQL would round a 5th decimal silently on insert — DL-0074), one side per line, at
 * least two lines, a known source type, and Σdebit = Σcredit in base currency (Money).
 */
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { SOURCE_TYPES, sourceClassOf } from './period-matrix.ts';

export type PostingErrorCode =
  | 'INVALID_COMMAND'
  | 'TOO_FEW_LINES'
  | 'LINE_SIDE'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_SCALE'
  | 'INVALID_RATE'
  | 'RATE_SCALE'
  | 'UNBALANCED'
  | 'UNKNOWN_SOURCE_TYPE'
  | 'SOURCE_TYPE_NOT_SUPPORTED'
  | 'UNKNOWN_COMPANY'
  | 'UNKNOWN_ACCOUNT'
  | 'UNBOUND_SYSTEM_ROLE'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'ACCOUNT_CURRENCY'
  | 'CONTROL_ACCOUNT'
  | 'INVALID_PARTY'
  | 'INVALID_DIMENSION'
  | 'MISSING_DIMENSION'
  | 'NO_NUMBER_SERIES'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_RACE'
  | 'UNKNOWN_USER'
  | 'OVERRIDE_NOT_PERMITTED'
  /** preview() only: the key already posted this document; post() would replay it (T-0026). */
  | 'ALREADY_POSTED';

/** A posting command refused by the engine. Nothing was written. `line` is 1-based. */
export class PostingError extends DomainError {
  declare readonly code: PostingErrorCode;
  readonly line: number | undefined;
  /** ALREADY_POSTED: the entry the key posted. */
  readonly entryId: string | undefined;
  readonly entryNo: string | undefined;
  constructor(
    code: PostingErrorCode,
    message: string,
    opts: { line?: number; cause?: unknown; entryId?: string; entryNo?: string } = {},
  ) {
    super(code, message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.line = opts.line;
    this.entryId = opts.entryId;
    this.entryNo = opts.entryNo;
  }
}

/** An account named by its system role (resolved per company) or by its id. */
export type AccountRef = { readonly role: string } | { readonly id: string };

export interface PostingLineInput {
  readonly account: AccountRef;
  /** Base-currency amount, plain decimal string, at most 4 decimals. Exactly one side > 0. */
  readonly debit?: string;
  readonly credit?: string;
  /** Default: the company's base currency, with txnAmount = the base amount and rate 1. */
  readonly txnCurrency?: string;
  readonly txnAmount?: string;
  /** Carried as given (≤ 8 decimals); the engine does no FX conversion. */
  readonly fxRate?: string;
  readonly taxCodeId?: string;
  readonly taxAmount?: string;
  /** Dimension value ids (one per dimension). */
  readonly dimensions?: readonly string[];
  readonly partyId?: string;
  readonly memo?: string;
  /**
   * YYYY-MM-DD; only on a line to an AR_CONTROL or AP_CONTROL account, whose open item it
   * dates (T-0028). Default: the entry date.
   */
  readonly dueDate?: string;
}

export interface PostingCommand {
  readonly companyId: string;
  /** 1..200 characters; unique per company. A repeat returns the first result. */
  readonly idempotencyKey: string;
  /** YYYY-MM-DD. The tenant lock-date policy may move it forward (period.ts). */
  readonly entryDate: string;
  /** Stored source-type code (period-matrix.ts SOURCE_TYPES), e.g. manual_journal. */
  readonly sourceType: string;
  readonly sourceId?: string;
  readonly memo?: string;
  /** The posting user (app_user id). Required with periodOverride. */
  readonly createdBy?: string;
  /**
   * The user who approved the document (app_user id), e.g. a manual journal above the approval
   * threshold (T-0029). Written to journal_entry.approved_by; the document enforces the approval.
   */
  readonly approvedBy?: string;
  /** Post into a period whose cell is "override"; createdBy must hold period.lock.override. */
  readonly periodOverride?: { readonly reason: string };
  readonly lines: readonly PostingLineInput[];
}

export interface CheckedLine {
  readonly lineNo: number;
  readonly account: AccountRef;
  readonly debit: string;
  readonly credit: string;
  readonly txnCurrency: string | undefined;
  readonly txnAmount: string | undefined;
  readonly fxRate: string | undefined;
  readonly taxCodeId: string | undefined;
  readonly taxAmount: string | undefined;
  readonly dimensions: readonly string[];
  readonly partyId: string | undefined;
  readonly memo: string | undefined;
  readonly dueDate: string | undefined;
}

export interface CheckedCommand {
  readonly command: PostingCommand;
  readonly lines: readonly CheckedLine[];
  /** Σdebit = Σcredit, NUMERIC(19,4) text. */
  readonly total: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[A-Z][A-Z_]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Plain non-negative decimal literal: digits, optional fraction. No sign, exponent or spaces. */
const PLAIN_DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Placeholder currency for the in-memory sums: every debit/credit is in the company's base. */
const BASE = 'XXX';
export const AMOUNT_SCALE = 4;
export const RATE_SCALE = 8;
/** NUMERIC(18,8): at most 10 integer digits. */
const RATE_INT_DIGITS = 10;

function fail(code: PostingErrorCode, message: string, line?: number): never {
  throw new PostingError(code, line === undefined ? message : `line ${String(line)}: ${message}`, {
    ...(line === undefined ? {} : { line }),
  });
}

/** Significant fraction digits of a plain decimal (trailing zeros carry no value). */
const fractionDigits = (frac: string | undefined): number => (frac ?? '').replace(/0+$/, '').length;

/** A NUMERIC(19,4) amount ≥ 0, as canonical 4-decimal text. Refuses a 5th decimal (DL-0074). */
function amount(value: unknown, what: string, line: number): string {
  const m = typeof value === 'string' ? PLAIN_DECIMAL_RE.exec(value) : null;
  if (!m) {
    fail(
      'INVALID_AMOUNT',
      `${what} ${JSON.stringify(value)} is not a plain non-negative decimal string`,
      line,
    );
  }
  if (fractionDigits(m[2]) > AMOUNT_SCALE) {
    fail(
      'AMOUNT_SCALE',
      `${what} ${String(value)} has more than ${String(AMOUNT_SCALE)} decimal places; round it before posting`,
      line,
    );
  }
  try {
    return Money.of(m[0], BASE).toNumericString();
  } catch (error) {
    if (error instanceof DomainError) {
      fail('INVALID_AMOUNT', `${what} ${String(value)}: ${error.message}`, line);
    }
    throw error;
  }
}

/** A NUMERIC(18,8) rate > 0, as canonical text without trailing zeros. */
function rate(value: unknown, line: number): string {
  const m = typeof value === 'string' ? PLAIN_DECIMAL_RE.exec(value) : null;
  if (!m) {
    fail('INVALID_RATE', `fxRate ${JSON.stringify(value)} is not a plain positive decimal`, line);
  }
  const int = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > RATE_SCALE) {
    fail(
      'RATE_SCALE',
      `fxRate ${String(value)} has more than ${String(RATE_SCALE)} decimal places`,
      line,
    );
  }
  if (int.length > RATE_INT_DIGITS) {
    fail('INVALID_RATE', `fxRate ${String(value)} does not fit NUMERIC(18,8)`, line);
  }
  if (/^0*$/.test(int + frac)) fail('INVALID_RATE', 'fxRate must be greater than zero', line);
  return frac === '' ? int : `${int}.${frac}`;
}

function validDate(s: string): boolean {
  // A real calendar date round-trips through ISO formatting unchanged (2026-02-30 does not).
  if (!DATE_RE.test(s)) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

function checkUuid(v: unknown, what: string, line?: number): void {
  if (v !== undefined && (typeof v !== 'string' || !UUID_RE.test(v))) {
    fail('INVALID_COMMAND', `${what} ${JSON.stringify(v)} is not a uuid`, line);
  }
}

function checkLine(l: PostingLineInput, lineNo: number): CheckedLine {
  const acct = l.account as Partial<Record<'role' | 'id', unknown>> | undefined;
  if (acct && 'role' in acct) {
    if (typeof acct.role !== 'string' || !ROLE_RE.test(acct.role)) {
      fail(
        'INVALID_COMMAND',
        `system role ${JSON.stringify(acct.role)} is not a role code`,
        lineNo,
      );
    }
  } else if (acct && 'id' in acct) {
    checkUuid(acct.id ?? null, 'account id', lineNo);
  } else {
    fail('INVALID_COMMAND', 'account must be { role } or { id }', lineNo);
  }
  const debit = l.debit === undefined ? '0.0000' : amount(l.debit, 'debit', lineNo);
  const credit = l.credit === undefined ? '0.0000' : amount(l.credit, 'credit', lineNo);
  if (Money.of(debit, BASE).isPositive() === Money.of(credit, BASE).isPositive()) {
    fail(
      'LINE_SIDE',
      `exactly one of debit (${debit}) and credit (${credit}) must be greater than zero`,
      lineNo,
    );
  }
  if (l.txnCurrency !== undefined && !CURRENCY_RE.test(l.txnCurrency)) {
    fail(
      'INVALID_COMMAND',
      `txnCurrency ${JSON.stringify(l.txnCurrency)} is not an ISO 4217 code`,
      lineNo,
    );
  }
  const txnAmount =
    l.txnAmount === undefined ? undefined : amount(l.txnAmount, 'txnAmount', lineNo);
  const fxRate = l.fxRate === undefined ? undefined : rate(l.fxRate, lineNo);
  if (l.txnCurrency === undefined && (txnAmount !== undefined || fxRate !== undefined)) {
    fail('INVALID_COMMAND', 'txnAmount and fxRate need a txnCurrency', lineNo);
  }
  const taxAmount =
    l.taxAmount === undefined ? undefined : amount(l.taxAmount, 'taxAmount', lineNo);
  checkUuid(l.taxCodeId, 'taxCodeId', lineNo);
  checkUuid(l.partyId, 'partyId', lineNo);
  const dimensions = [...(l.dimensions ?? [])];
  for (const v of dimensions) checkUuid(v, 'dimension value', lineNo);
  if (new Set(dimensions.map((v) => v.toLowerCase())).size !== dimensions.length) {
    fail('INVALID_DIMENSION', 'a dimension value is listed twice', lineNo);
  }
  if (l.memo !== undefined && typeof l.memo !== 'string') {
    fail('INVALID_COMMAND', 'memo must be a string', lineNo);
  }
  if (l.dueDate !== undefined && (typeof l.dueDate !== 'string' || !validDate(l.dueDate))) {
    fail(
      'INVALID_COMMAND',
      `dueDate ${JSON.stringify(l.dueDate)} is not a YYYY-MM-DD date`,
      lineNo,
    );
  }
  return {
    lineNo,
    account: l.account,
    debit,
    credit,
    txnCurrency: l.txnCurrency,
    txnAmount,
    fxRate,
    taxCodeId: l.taxCodeId,
    taxAmount,
    dimensions,
    partyId: l.partyId,
    memo: l.memo,
    dueDate: l.dueDate,
  };
}

/** Σdebit and Σcredit of lines in base currency (exact, Money), and whether they are equal. */
export function lineTotals(lines: readonly { debit: string; credit: string }[]): {
  debit: string;
  credit: string;
  balanced: boolean;
} {
  let d = Money.zero(BASE);
  let c = Money.zero(BASE);
  for (const l of lines) {
    d = d.add(Money.of(l.debit, BASE));
    c = c.add(Money.of(l.credit, BASE));
  }
  return { debit: d.toNumericString(), credit: c.toNumericString(), balanced: d.equals(c) };
}

/** Pure checks of a command (no I/O). Throws PostingError. */
export function checkCommand(command: PostingCommand): CheckedCommand {
  const key: unknown = command.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    fail('INVALID_COMMAND', 'idempotencyKey must be 1..200 characters');
  }
  if (typeof command.entryDate !== 'string' || !validDate(command.entryDate)) {
    fail(
      'INVALID_COMMAND',
      `entryDate ${JSON.stringify(command.entryDate)} is not a YYYY-MM-DD date`,
    );
  }
  checkUuid(command.companyId ?? null, 'companyId');
  checkUuid(command.createdBy, 'createdBy');
  checkUuid(command.approvedBy, 'approvedBy');
  const cls = sourceClassOf(command.sourceType);
  if (cls === undefined) {
    fail(
      'UNKNOWN_SOURCE_TYPE',
      `source type ${JSON.stringify(command.sourceType)} is not in the period matrix`,
    );
  }
  if (cls === 'reversal') {
    fail(
      'SOURCE_TYPE_NOT_SUPPORTED',
      `${command.sourceType} is not posted through raw commands (reversals wait for GP-019)`,
    );
  }
  if (command.periodOverride !== undefined) {
    if (command.createdBy === undefined) {
      fail('INVALID_COMMAND', 'periodOverride needs createdBy (the user granting the override)');
    }
    const reason: unknown = command.periodOverride.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      fail('INVALID_COMMAND', 'periodOverride needs a reason');
    }
  }
  const input = Array.isArray(command.lines) ? command.lines : [];
  if (input.length < 2) {
    fail('TOO_FEW_LINES', `a journal entry needs at least two lines (has ${String(input.length)})`);
  }
  const lines = input.map((l, i) => checkLine(l, i + 1));
  const t = lineTotals(lines);
  if (!t.balanced) {
    fail('UNBALANCED', `entry does not balance: debit ${t.debit}, credit ${t.credit}`);
  }
  return { command, lines, total: t.debit };
}

const goldenOf = (sourceType: string): string | undefined =>
  Object.hasOwn(SOURCE_TYPES, sourceType) ? SOURCE_TYPES[sourceType]?.golden : undefined;

/** Which subledger posts to each control role (design §3.2; DL-0136). */
const CONTROL_SUBLEDGERS: Readonly<Record<string, (sourceType: string) => boolean>> = Object.freeze(
  {
    // Every AR-class source: ar.* and the Stripe charge, which settles AR (GP-003, Draft).
    AR_CONTROL: (st: string) => sourceClassOf(st) === 'ar',
    AP_CONTROL: (st: string) => goldenOf(st)?.startsWith('ap.') === true,
    PAYROLL_CLEARING: (st: string) => goldenOf(st)?.startsWith('payroll.') === true,
  },
);

/**
 * Control accounts accept postings only from their subledger (design §3.2). Keyed by the
 * control system role bound to the account; any other role, or none, accepts nothing.
 */
export function controlAccountAccepts(role: string, sourceType: string): boolean {
  const rule = Object.hasOwn(CONTROL_SUBLEDGERS, role) ? CONTROL_SUBLEDGERS[role] : undefined;
  return rule !== undefined && rule(sourceType);
}

/** Number series that numbers journal entries of a source type (DL-0135). */
export function entrySeriesFor(sourceType: string): string {
  return `je_${sourceType}`;
}
