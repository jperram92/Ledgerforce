import type { Money as MoneyValue } from '@ledgerforce/shared/money';
import { formatMoney, type FormatOptions, type SignStyle } from '../money/format.ts';

export interface MoneyProps {
  /** Decimal string (e.g. "-389.00") or Money. Never a JS number. */
  value: string | MoneyValue;
  currency?: string;
  /** parentheses (accountant views, default), minus (editable), words (owner sentences). */
  sign?: SignStyle;
  className?: string;
}

/**
 * An amount set for reading (P3): right-aligned tabular figures (CSS `.money`), grouped, two
 * decimals, negatives in parentheses. The visible text is hidden from screen readers and replaced
 * by a spoken form ("minus 389.00 dollars"), because "(389.00)" is read as "389.00".
 */
export function Money({ value, currency, sign = 'parentheses', className }: MoneyProps) {
  const opts: FormatOptions = { sign };
  if (currency !== undefined) opts.currency = currency;
  const f = formatMoney(value, opts);
  return (
    <span
      className={`num money${className ? ` ${className}` : ''}`}
      data-amount={f.amount}
      data-sign={f.zero ? 'zero' : f.negative ? 'negative' : 'positive'}
      data-sign-style={sign}
    >
      <span aria-hidden="true">{f.text}</span>
      <span className="sr-only">{f.spoken}</span>
    </span>
  );
}
