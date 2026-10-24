/**
 * Base class for expected, business-meaningful failures. `code` is a stable, machine-readable
 * identifier (SCREAMING_SNAKE_CASE) that APIs and tests match on; `message` is for humans.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** A value cannot be represented as money (bad string, float input, too many decimals...). */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

/** Arithmetic or comparison between two different currencies. */
export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: ${left} vs ${right}`);
  }
}

/** Value does not fit NUMERIC(19,4) (|x| >= 10^15). */
export class MoneyOverflowError extends DomainError {
  constructor(value: string) {
    super('MONEY_OVERFLOW', `Amount ${value} does not fit NUMERIC(19,4)`);
  }
}
