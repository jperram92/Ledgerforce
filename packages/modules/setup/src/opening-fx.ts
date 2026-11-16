/**
 * Foreign-currency opening items (T-0126, GP-043, RQ-0170, DL-0740, DL-0741). Pure.
 *
 * An opening item's `amount` is always the base amount the old system carries at the balance date
 * (it sums to the trial-balance control row; no exchange difference is posted). A foreign item also
 * names its transaction currency and amount, and optionally the rate in the engine's convention:
 * base units per one foreign unit (base = transaction amount × rate).
 *   - rate given: round_half_up(currencyAmount × rate, 2) must equal the base amount (FX_MISMATCH);
 *   - rate absent: rate = base ÷ currencyAmount, half-up to 8 decimals (NUMERIC(18,8)).
 * An item without a currency, or in the base currency, is a base item: a currency amount, if given,
 * must equal the amount and a rate, if given, must be 1. Money: decimal.js only.
 */
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { fail } from './errors.ts';
import type { OpeningItemInput } from './opening-csv.ts';

/** decimal.js without exponent notation, so tiny rates print as plain decimals. */
const Plain = Decimal.clone({ toExpNeg: -60, toExpPos: 60 });
const RATE_SCALE = 8;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RATE_RE = /^\d+(?:\.(\d+))?$/;

/** NUMERIC(18,8) text of a rate, half-up to 8 decimals, e.g. "1.53846000". */
export function rateText(rate: Decimal): string {
  const s = new Plain(rate.toDecimalPlaces(RATE_SCALE, Decimal.ROUND_HALF_UP)).toString();
  const [int = '0', frac = ''] = s.split('.');
  return `${int}.${frac.padEnd(RATE_SCALE, '0')}`;
}

const show = (d: Decimal) => Money.of(d, 'XXX').toNumericString();

export interface ItemFx {
  readonly currency: string;
  /** Absolute transaction amount, NUMERIC(19,4) text. */
  readonly txnAmount: string;
  /** Base per one foreign unit, as given or implied. */
  readonly fxRate: string;
}

/** Shape checks that need no database (command step 1). */
export function checkItemFxShape(it: OpeningItemInput): void {
  const doc = it.documentNo;
  if (it.currency === undefined) {
    if (it.currencyAmount !== undefined || it.fxRate !== undefined) {
      fail('INVALID_COMMAND', `${doc}: a currency amount or rate needs a currency`, it.row);
    }
    return;
  }
  if (typeof it.currency !== 'string' || !CURRENCY_RE.test(it.currency)) {
    fail(
      'INVALID_COMMAND',
      `${doc}: currency ${JSON.stringify(it.currency)} is not a three-letter code`,
      it.row,
    );
  }
  if (it.currencyAmount !== undefined) {
    const txn = new Decimal(signedText(it.currencyAmount, doc, 'currency amount', it.row));
    if (txn.isZero()) fail('INVALID_COMMAND', `${doc}: the currency amount is zero`, it.row);
    if (txn.isNegative() !== new Decimal(it.amount).isNegative()) {
      fail(
        'INVALID_COMMAND',
        `${doc}: currency amount ${it.currencyAmount} must have the sign of the amount ${it.amount}`,
        it.row,
      );
    }
  }
  if (it.fxRate !== undefined) {
    const m = RATE_RE.exec(it.fxRate);
    if (
      !m ||
      (m[1] ?? '').replace(/0+$/, '').length > RATE_SCALE ||
      new Decimal(it.fxRate).isZero()
    ) {
      fail(
        'INVALID_COMMAND',
        `${doc}: rate ${JSON.stringify(it.fxRate)} must be a positive decimal with at most 8 decimals`,
        it.row,
      );
    }
  }
}

function signedText(raw: string, doc: string, what: string, row: number | undefined): string {
  const m = /^-?\d+(?:\.(\d+))?$/.exec(raw.trim());
  if (!m || (m[1] ?? '').replace(/0+$/, '').length > 4) {
    fail(
      'INVALID_COMMAND',
      `${doc}: ${what} ${JSON.stringify(raw)} is not a decimal with at most 4 decimals`,
      row,
    );
  }
  return raw.trim();
}

/**
 * The FX fields of an item's control line, or null for a base item. Throws FX_MISMATCH when a
 * given rate does not reproduce the base amount half-up to cents. Call checkItemFxShape first.
 */
export function itemFx(it: OpeningItemInput, baseCurrency: string): ItemFx | null {
  const doc = it.documentNo;
  const base = new Decimal(it.amount);
  if (it.currency === undefined || it.currency === baseCurrency) {
    if (it.currencyAmount !== undefined && !new Decimal(it.currencyAmount).equals(base)) {
      fail(
        'INVALID_COMMAND',
        `${doc}: a ${baseCurrency} (base currency) item's currency amount must equal its amount ${it.amount}`,
        it.row,
      );
    }
    if (it.fxRate !== undefined && !new Decimal(it.fxRate).equals(1)) {
      fail(
        'INVALID_COMMAND',
        `${doc}: a ${baseCurrency} (base currency) item has rate 1, not ${it.fxRate}`,
        it.row,
      );
    }
    return null;
  }
  if (it.currencyAmount === undefined) {
    fail('INVALID_COMMAND', `${doc}: a ${it.currency} item needs its currency amount`, it.row);
  }
  const txn = new Decimal(it.currencyAmount ?? '0');
  let rate: string;
  if (it.fxRate !== undefined) {
    const expected = txn.times(it.fxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!expected.equals(base)) {
      fail(
        'FX_MISMATCH',
        `${doc}: ${it.currency} ${show(txn)} × ${it.fxRate} = ${show(expected)} (half-up to cents), ` +
          `not the base amount ${show(base)}; correct the rate or leave it empty to imply it`,
        it.row,
      );
    }
    rate = rateText(new Decimal(it.fxRate));
  } else {
    const implied = base.div(txn);
    rate = rateText(implied);
    if (new Decimal(rate).isZero()) {
      fail('INVALID_COMMAND', `${doc}: the implied rate rounds to zero at 8 decimals`, it.row);
    }
  }
  return { currency: it.currency, txnAmount: show(txn.abs()), fxRate: rate };
}
