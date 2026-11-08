/**
 * Money formatting for reading (P3). Input is a decimal string or a `Money`; JS numbers are refused
 * (floating point is banned for money, AGENTS.md §4). All arithmetic goes through `Money`
 * (decimal.js); the text is built from the exact decimal digits, never from `Number#toFixed` or
 * `toLocaleString`.
 *
 *  - Rounded half-up (away from zero) to the currency's minor unit (AUD 2, JPY 0, KWD 3).
 *  - Thousands separated by commas; the currency is not repeated on every amount.
 *  - `sign`: 'parentheses' (accountant views, default) → (389.00); 'minus' (editable values) →
 *    -389.00; 'words' (owner sentences, P3 v1) → "12,604.10 out" / "10,087.00 in".
 *  - `spoken` is the screen-reader text: "minus 389.00 dollars".
 */
import { Money, minorUnits, currency as toCurrency } from '@ledgerforce/shared/money';

export type SignStyle = 'parentheses' | 'minus' | 'words';

export interface FormatOptions {
  currency?: string;
  sign?: SignStyle;
}

export interface FormattedMoney {
  /** What is shown, e.g. "(389.00)". */
  text: string;
  /** What a screen reader says, e.g. "minus 389.00 dollars". */
  spoken: string;
  /** The rounded value as a plain decimal string, e.g. "-389.00" (for data-amount). */
  amount: string;
  negative: boolean;
  zero: boolean;
}

const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  AUD: 'dollars',
  NZD: 'dollars',
  USD: 'dollars',
  CAD: 'dollars',
  SGD: 'dollars',
  HKD: 'dollars',
  EUR: 'euros',
  GBP: 'pounds',
  JPY: 'yen',
};

export function groupThousands(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new RangeError(`Not a digit string: ${JSON.stringify(digits)}`);
  const out: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) out.unshift(digits.slice(Math.max(0, i - 3), i));
  return out.join(',');
}

function toMoney(value: string | Money, code: string): Money {
  if (value instanceof Money) return value;
  if (typeof value !== 'string') {
    throw new TypeError('Money values must be decimal strings or Money, never JS numbers');
  }
  return Money.of(value, code);
}

/** Fixed-point text of a Money at `scale` decimals: "-1234.50". Exact (decimal.js). */
function fixed(m: Money, scale: number): string {
  // toNumericString is always 4 decimals; trim (or keep) to the minor unit, which is <= 4 here.
  const s = m.roundTo(scale, 'half-up').toNumericString();
  if (scale === 4) return s;
  const [int = '0', frac = ''] = s.split('.');
  return scale === 0 ? int : `${int}.${frac.slice(0, scale)}`;
}

export function formatMoney(value: string | Money, opts: FormatOptions = {}): FormattedMoney {
  const code = opts.currency ?? (value instanceof Money ? value.currency : 'AUD');
  const scale = Math.min(minorUnits(toCurrency(code)), 4);
  const rounded = toMoney(value, code).roundTo(scale, 'half-up');
  const negative = rounded.isNegative();
  const zero = rounded.isZero();
  const plain = fixed(rounded.abs(), scale);
  const [int = '0', frac] = plain.split('.');
  const grouped = frac === undefined ? groupThousands(int) : `${groupThousands(int)}.${frac}`;
  const word = CURRENCY_WORDS[code] ?? code;
  const sign = opts.sign ?? 'parentheses';

  let text: string;
  let spoken: string;
  if (sign === 'words') {
    const dir = zero ? '' : negative ? ' out' : ' in';
    text = `${grouped}${dir}`;
    spoken = `${grouped} ${word}${dir}`;
  } else {
    text = negative ? (sign === 'minus' ? `-${grouped}` : `(${grouped})`) : grouped;
    spoken = `${negative ? 'minus ' : ''}${grouped} ${word}`;
  }
  return { text, spoken, amount: fixed(rounded, scale), negative, zero };
}

/** Exact sum of decimal strings, as NUMERIC(19,4) text. */
export function sumAmounts(values: readonly string[], code: string): string {
  return values.reduce((acc, v) => acc.add(toMoney(v, code)), Money.zero(code)).toNumericString();
}
