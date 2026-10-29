/**
 * Money: an immutable amount + currency over decimal.js.
 *
 * Rules (design §3.4, AGENTS.md §4):
 *  - Stored in the DB as NUMERIC(19,4): at most 4 decimal places and |x| < 10^15.
 *  - No floating point ever enters: JS numbers are accepted only when they are safe integers,
 *    and `valueOf()` throws so `money * 2` or `+money` cannot silently coerce to a float.
 *  - Any operation that can produce more than 4 decimals (mul) requires an explicit rounding mode.
 *  - "half-up" is ROUND_HALF_UP in decimal.js: ties go away from zero (-1.005 -> -1.01), which is
 *    the usual accounting convention and the AU tax-rounding default.
 *  - allocate/split use the largest-remainder method so parts always sum back to the total.
 */
import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../errors.ts';

/** Private decimal.js constructor so we never depend on or mutate global Decimal settings. */
const D = Decimal.clone({
  precision: 60,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -60,
  toExpPos: 60,
});
type Dec = InstanceType<typeof D>;

/**
 * The single place a Decimal becomes text. decimal.js `Decimal#toFixed` is exact string
 * formatting of an arbitrary-precision value — not `Number#toFixed` — so the float ban does not
 * apply; the lint rule cannot tell the two apart without type information.
 */
function decToString(d: Dec | Decimal, decimals?: number): string {
  // eslint-disable-next-line lf/no-float-money -- decimal.js Decimal#toFixed (exact), see above
  return decimals === undefined ? d.toFixed() : d.toFixed(decimals);
}

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';
/** Accepted inputs. `number` only when it is a safe integer. */
export type MoneyInput = string | bigint | number | Decimal;

export const MONEY_SCALE = 4;
const MAX_ABS = new D('1e15'); // NUMERIC(19,4): 15 integer digits

const ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  'half-up': Decimal.ROUND_HALF_UP,
  'half-even': Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

const CURRENCY_RE = /^[A-Z]{3}$/;
/** ISO 4217 exponents that differ from the default of 2. */
const MINOR_UNIT_EXCEPTIONS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export function currency(code: string): CurrencyCode {
  if (!CURRENCY_RE.test(code)) {
    throw new InvalidMoneyError(`Invalid currency code ${JSON.stringify(code)}`);
  }
  return code as CurrencyCode;
}

export function minorUnits(code: CurrencyCode): number {
  return MINOR_UNIT_EXCEPTIONS[code] ?? 2;
}

/** Plain decimal literal: optional sign, digits, optional fraction. No exponent, no spaces. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function toDec(value: MoneyInput, what: string): Dec {
  if (typeof value === 'string') {
    if (!DECIMAL_RE.test(value)) {
      throw new InvalidMoneyError(
        `${what}: ${JSON.stringify(value)} is not a plain decimal string`,
      );
    }
    return new D(value);
  }
  if (typeof value === 'bigint') return new D(value.toString());
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidMoneyError(
        `${what}: JS number ${String(value)} rejected — pass a decimal string (floating point is banned for money)`,
      );
    }
    return new D(value.toString());
  }
  if (Decimal.isDecimal(value)) {
    if (!value.isFinite()) throw new InvalidMoneyError(`${what}: non-finite Decimal`);
    return new D(decToString(value));
  }
  throw new InvalidMoneyError(`${what}: unsupported input type`);
}

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MONEY_SCALE) {
    throw new InvalidMoneyError(`Scale must be an integer 0..${MONEY_SCALE}, got ${String(scale)}`);
  }
}

export class Money {
  readonly #amount: Dec;
  readonly #currency: CurrencyCode;

  private constructor(amount: Dec, code: CurrencyCode) {
    if (amount.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyError(
        `${decToString(amount)} has more than ${MONEY_SCALE} decimal places — round explicitly first`,
      );
    }
    if (amount.abs().gte(MAX_ABS)) throw new MoneyOverflowError(decToString(amount));
    this.#amount = amount.isZero() ? new D(0) : amount; // normalise -0
    this.#currency = code;
  }

  static of(amount: MoneyInput, code: string): Money {
    return new Money(toDec(amount, 'Money.of'), currency(code));
  }

  static zero(code: string): Money {
    return new Money(new D(0), currency(code));
  }

  /** Parse a PostgreSQL NUMERIC text value (as returned by node-postgres). */
  static fromNumeric(text: string, code: string): Money {
    return new Money(toDec(text, 'Money.fromNumeric'), currency(code));
  }

  /** e.g. fromMinorUnits(12345n, 'AUD') = 123.45 AUD; fromMinorUnits(500, 'JPY') = 500 JPY. */
  static fromMinorUnits(units: bigint | number, code: string): Money {
    const c = currency(code);
    return new Money(toDec(units, 'Money.fromMinorUnits').div(new D(10).pow(minorUnits(c))), c);
  }

  get currency(): CurrencyCode {
    return this.#currency;
  }

  #same(other: Money): void {
    if (other.#currency !== this.#currency) {
      throw new CurrencyMismatchError(this.#currency, other.#currency);
    }
  }

  add(other: Money): Money {
    this.#same(other);
    return new Money(this.#amount.plus(other.#amount), this.#currency);
  }

  sub(other: Money): Money {
    this.#same(other);
    return new Money(this.#amount.minus(other.#amount), this.#currency);
  }

  /** Multiply by a factor (rate, quantity). Rounding is mandatory; scale is 0..4 decimals. */
  mul(factor: MoneyInput, opts: { scale: number; rounding: RoundingMode }): Money {
    checkScale(opts.scale);
    const product = this.#amount.times(toDec(factor, 'Money.mul factor'));
    return new Money(product.toDecimalPlaces(opts.scale, ROUNDING[opts.rounding]), this.#currency);
  }

  roundTo(scale: number, rounding: RoundingMode): Money {
    checkScale(scale);
    return new Money(this.#amount.toDecimalPlaces(scale, ROUNDING[rounding]), this.#currency);
  }

  /** Round to 2 decimals; default half-up (AU default, design §3.4). */
  roundToCents(rounding: RoundingMode = 'half-up'): Money {
    return this.roundTo(2, rounding);
  }

  /** Round to the currency's ISO 4217 minor unit (JPY 0, AUD 2, KWD 3). */
  roundToMinorUnit(rounding: RoundingMode = 'half-up'): Money {
    return this.roundTo(minorUnits(this.#currency), rounding);
  }

  negate(): Money {
    return new Money(this.#amount.negated(), this.#currency);
  }

  abs(): Money {
    return new Money(this.#amount.abs(), this.#currency);
  }

  isZero(): boolean {
    return this.#amount.isZero();
  }

  isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  isPositive(): boolean {
    return this.#amount.isPositive() && !this.#amount.isZero();
  }

  /** Value equality. Different currencies are simply not equal (no throw). */
  equals(other: Money): boolean {
    return this.#currency === other.#currency && this.#amount.eq(other.#amount);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.#same(other);
    return this.#amount.comparedTo(other.#amount) as -1 | 0 | 1;
  }

  /**
   * Split this amount by non-negative ratios using the largest-remainder method, so the parts
   * always sum exactly to the original. Ties go to the earlier part. The amount must already be
   * expressible at `scale` (default: 2 = cents).
   */
  allocate(ratios: readonly MoneyInput[], opts: { scale?: number } = {}): Money[] {
    const scale = opts.scale ?? 2;
    checkScale(scale);
    if (ratios.length === 0) throw new InvalidMoneyError('allocate: at least one ratio required');
    const rs = ratios.map((r) => toDec(r, 'allocate ratio'));
    if (rs.some((r) => r.isNegative() && !r.isZero())) {
      throw new InvalidMoneyError('allocate: ratios must be non-negative');
    }
    const ratioSum = rs.reduce((a, b) => a.plus(b), new D(0));
    if (ratioSum.isZero()) throw new InvalidMoneyError('allocate: ratios sum to zero');

    const unit = new D(10).pow(scale);
    const totalUnits = this.#amount.times(unit);
    if (!totalUnits.isInteger()) {
      throw new InvalidMoneyError(
        `allocate: ${decToString(this.#amount)} is not a whole number at scale ${String(scale)} — round first`,
      );
    }
    const negative = totalUnits.isNegative();
    const absUnits = totalUnits.abs();

    const shares = rs.map((r, index) => {
      const exact = absUnits.times(r).div(ratioSum);
      const floor = exact.floor();
      return { index, floor, remainder: exact.minus(floor) };
    });
    let leftover = absUnits.minus(shares.reduce((a, s) => a.plus(s.floor), new D(0))).toNumber();
    // leftover < number of parts, so toNumber() here is an exact small integer count, not money.
    const order = [...shares].sort(
      (a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index,
    );
    const extra = new Set<number>();
    for (const s of order) {
      if (leftover <= 0) break;
      extra.add(s.index);
      leftover -= 1;
    }
    return shares.map((s) => {
      const u = extra.has(s.index) ? s.floor.plus(1) : s.floor;
      const value = u.div(unit);
      return new Money(negative ? value.negated() : value, this.#currency);
    });
  }

  /** Split into `parts` equal-as-possible parts (see allocate). */
  split(parts: number, opts: { scale?: number } = {}): Money[] {
    if (!Number.isSafeInteger(parts) || parts < 1) {
      throw new InvalidMoneyError(`split: parts must be a positive integer, got ${String(parts)}`);
    }
    return this.allocate(
      Array.from({ length: parts }, () => 1),
      opts,
    );
  }

  /** Canonical NUMERIC(19,4) text, e.g. "-1234.5600". Use this for DB parameters. */
  toNumericString(): string {
    return decToString(this.#amount, MONEY_SCALE);
  }

  /** A copy of the amount as a decimal.js Decimal (never a JS number). */
  toDecimal(): Decimal {
    return new Decimal(decToString(this.#amount));
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toNumericString(), currency: this.#currency };
  }

  toString(): string {
    return `${this.toNumericString()} ${this.#currency}`;
  }

  /** Blocks implicit numeric coercion (`+m`, `m * 2`, `m > n`). */
  valueOf(): never {
    throw new TypeError('Money cannot be coerced to a number; use Money methods');
  }
}
