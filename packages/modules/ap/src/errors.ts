/** Refusals of the supplier-bill module (T-0050, T-0052). Nothing was written when one is thrown. */
import { DomainError } from '@ledgerforce/shared';

export type BillErrorCode =
  | 'INVALID_BILL'
  | 'BILL_NOT_FOUND'
  | 'BILL_NOT_POSTABLE'
  | 'BILL_CURRENCY'
  | 'NOT_A_SUPPLIER'
  | 'DUPLICATE_SUPPLIER_REF'
  | 'BILL_LINE_UNCODED'
  | 'TAX_CODE_REQUIRED'
  | 'TAX_ACCOUNT_MISSING'
  | 'NO_BILL_SERIES'
  /** T-0052: the workflow action needs another status (e.g. approve needs awaiting_approval). */
  | 'BILL_WRONG_STATUS'
  /** T-0052: only a draft bill is edited; send an approved bill back to draft first. */
  | 'BILL_NOT_EDITABLE'
  /** T-0052: reject and send-back need a reason (1–2000 characters). */
  | 'REASON_REQUIRED';

export class BillError extends DomainError {
  declare readonly code: BillErrorCode;
  /** 1-based bill line, when the refusal is about one line. */
  readonly line: number | undefined;
  constructor(code: BillErrorCode, message: string, opts: { line?: number; cause?: unknown } = {}) {
    super(
      code,
      opts.line === undefined ? message : `line ${String(opts.line)}: ${message}`,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.line = opts.line;
  }
}
