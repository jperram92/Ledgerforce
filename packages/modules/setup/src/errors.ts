import { DomainError } from '@ledgerforce/shared';

export type OpeningBalanceErrorCode =
  | 'INVALID_CSV'
  | 'INVALID_COMMAND'
  | 'UNBALANCED'
  | 'UNKNOWN_ACCOUNT'
  | 'DUPLICATE_ACCOUNT'
  | 'CONTROL_MISMATCH'
  | 'UNKNOWN_PARTY'
  | 'AMBIGUOUS_PARTY'
  | 'PARTY_ROLE'
  | 'ITEM_AFTER_BALANCE_DATE'
  | 'PERIOD_NOT_OPEN'
  | 'OPENING_EXISTS'
  | 'PRIOR_ENTRIES';

/** An opening balance refused (T-0080, GP-037). Nothing was written. `row` is the CSV line. */
export class OpeningBalanceError extends DomainError {
  declare readonly code: OpeningBalanceErrorCode;
  readonly row: number | undefined;
  constructor(code: OpeningBalanceErrorCode, message: string, opts: { row?: number } = {}) {
    super(code, message);
    this.row = opts.row;
  }
}

export const fail = (code: OpeningBalanceErrorCode, message: string, row?: number): never => {
  throw new OpeningBalanceError(
    code,
    row === undefined ? message : `row ${String(row)}: ${message}`,
    {
      ...(row === undefined ? {} : { row }),
    },
  );
};
