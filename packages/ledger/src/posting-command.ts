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
  | 'IDEMPOTENCY_RACE';

/** A posting command refused by the engine. Nothing was written. `line` is 1-based. */
export class PostingError extends DomainError {
  declare readonly code: PostingErrorCode;
  readonly line: number | undefined;
  constructor(
    code: PostingErrorCode,
    message: string,
    opts: { line?: number; cause?: unknown } = {},
  ) {
    super(code, message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.line = opts.line;
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
}

export interface CheckedCommand {
  readonly command: PostingCommand;
  readonly lines: readonly CheckedLine[];
  /** Σdebit = Σcredit, NUMERIC(19,4) text. */
  readonly total: string;
}

/** Pure checks of a command (no I/O). Throws PostingError. */
export function checkCommand(command: PostingCommand): CheckedCommand {
  void command;
  throw new Error('not implemented: T-0025 checkCommand');
}

/**
 * Control accounts accept postings only from their subledger (design §3.2). Keyed by the
 * control system role bound to the account; any other role, or none, accepts nothing.
 */
export function controlAccountAccepts(role: string, sourceType: string): boolean {
  void role;
  void sourceType;
  throw new Error('not implemented: T-0025 controlAccountAccepts');
}

/** Number series that numbers journal entries of a source type (DL-0135). */
export function entrySeriesFor(sourceType: string): string {
  void sourceType;
  throw new Error('not implemented: T-0025 entrySeriesFor');
}
