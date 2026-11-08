/**
 * Reading dates, amounts and text out of bank files (RQ-0019). Amounts go from text straight to
 * Money (decimal.js); no value ever passes through a JS number.
 */
import { InvalidMoneyError, MoneyOverflowError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { StatementParseError } from './errors.ts';

/** Collapse runs of whitespace (including line breaks) to one space and trim. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** "YYYY-MM-DD" when y-m-d is a real calendar date, else null. */
export function isoDate(y: string, m: string, d: string): string | null {
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day > days) return null;
  return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * OFX date-time `YYYYMMDD[HHMMSS[.XXX]][[±h[.mm]][:TZ]]`. The posting date is the date as the
 * bank wrote it, in the bank's own offset — never converted through UTC (RQ-0019 finding 3).
 */
export function ofxDate(raw: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{4}(\d{2}(\.\d{1,6})?)?)?(\s*\[[^\]]*\])?$/.exec(raw.trim());
  return m ? isoDate(m[1] ?? '', m[2] ?? '', m[3] ?? '') : null;
}

/** ISO 8601 date or date-time (CAMT): the date part as written. */
export function isoDatePart(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw.trim());
  return m ? isoDate(m[1] ?? '', m[2] ?? '', m[3] ?? '') : null;
}

/** A plain decimal string ("-12.5", "+3", ".25") → Money, or a StatementParseError. */
export function money(decimal: string, currency: string, what: string): Money {
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(decimal);
  if (!m || (m[2] === '' && m[3] === undefined)) {
    throw new StatementParseError(`${what}: "${decimal}" is not an amount`);
  }
  const text = `${m[1] === '-' ? '-' : ''}${m[2] || '0'}${m[3] === undefined ? '' : `.${m[3]}`}`;
  try {
    return Money.of(text, currency);
  } catch (error) {
    if (error instanceof InvalidMoneyError || error instanceof MoneyOverflowError) {
      throw new StatementParseError(
        `${what}: "${decimal}" cannot be held exactly (${error.message})`,
      );
    }
    throw error;
  }
}

/**
 * Amount text as banks print it in CSV files: "1,234.56", "(10.00)", "$-4.50", "-$4.50",
 * "7.00 DR", "7.00 CR", "+0.01". With decimalSeparator "," the roles of "." and "," swap.
 */
export function csvAmount(
  raw: string,
  currency: string,
  what: string,
  decimalSeparator: '.' | ',' = '.',
): Money {
  let s = raw.trim();
  let negative = false;
  let marks = 0;
  const suffix = /\s*(CR|DR)$/i.exec(s);
  if (suffix) {
    negative = (suffix[1] ?? '').toUpperCase() === 'DR';
    marks += 1;
    s = s.slice(0, suffix.index).trim();
  }
  const parens = /^\((.*)\)$/.exec(s);
  if (parens) {
    negative = true;
    marks += 1;
    s = (parens[1] ?? '').trim();
  }
  s = s.replace(/[$\s\u00a0]/g, '');
  const sign = /^([+-]?)(.*)$/.exec(s);
  if (sign?.[1] === '-') {
    negative = true;
    marks += 1;
  }
  s = sign?.[2] ?? '';
  if (marks > 1) throw new StatementParseError(`${what}: "${raw}" has more than one sign`);
  const thousands = decimalSeparator === '.' ? ',' : '.';
  s = s.split(thousands).join('');
  if (decimalSeparator === ',') s = s.replace(',', '.');
  return money(`${negative ? '-' : ''}${s}`, currency, what);
}
