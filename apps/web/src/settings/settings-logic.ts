/**
 * Wording and small form helpers of the setup settings screens (T-0176, SS-PLAT-129). P12: plain
 * words first. No setting rule lives here: the API (ADR-0081) and the modules decide; this file
 * formats what they answer and says their refusals in words.
 */
import { AdminApiError } from '../admin/client.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-07-01` → `1 Jul 2026`, read from the string so no time zone can shift the day. */
export function dayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number.parseInt(m[2] ?? '', 10) - 1] ?? '';
  return `${(m[3] ?? '').replace(/^0/, '')} ${month} ${m[1] ?? ''}`;
}

/** `51824753556` → `51 824 753 556` (the ABN register's grouping); anything else as given. */
export const abnText = (abn: string): string =>
  /^\d{11}$/.test(abn) ? abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : abn;

/** The first day of a fiscal year from the chosen month (1–12) and a four-digit year, or null. */
export function fiscalStart(month: string, year: string): string | null {
  const y = year.trim();
  if (!/^\d{4}$/.test(y) || !/^(?:[1-9]|1[0-2])$/.test(month)) return null;
  return `${y}-${month.padStart(2, '0')}-01`;
}

/**
 * A rate such as `0.10000000` as `10%`: the decimal point moves two places in the string. The
 * rate is never turned into a number (apps/web rules).
 */
export function percentOf(rate: string): string {
  const m = /^(\d+)\.(\d*)$/.exec(rate);
  if (!m) return rate;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const whole = `${m[1] ?? ''}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = frac.slice(2).replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}

const sentence = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '');
const messageOf = (e: AdminApiError) =>
  typeof e.body['message'] === 'string' ? e.body['message'].replace(/\babn\b/g, 'ABN') : '';

/** A company-details or fiscal-year refusal in plain words; null for anything else. */
export function companyRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case 'INVALID_ABN':
      return 'This ABN does not pass the ABN check. Compare the 11 digits with the ABN register (abr.business.gov.au).';
    case 'BASE_CURRENCY_LOCKED':
      return 'The base currency cannot change: the company already has journal entries, and they are kept in this currency.';
    case 'FISCAL_YEAR_OVERLAP':
      return `That year would overlap a financial year the company already has. Financial years cannot be changed or removed; add the year after the last one. (${messageOf(error)})`;
    case 'invalid_request':
      return sentence(messageOf(error));
    default:
      return null;
  }
}

/** A tax-settings refusal in plain words; null for anything else. */
export function taxRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  if (error.code === 'INVALID_TAX_SETTINGS')
    return `Choose the month the settings apply from, how you account for GST and how often you lodge the BAS. (${messageOf(error)})`;
  if (error.code === 'invalid_request') return sentence(messageOf(error));
  return null;
}
