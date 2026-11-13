/**
 * Helpers of the report screens (T-0089): CSV export of what the API returned, the date defaults,
 * search params, and the plain words (P12) for account kinds, readers and refusals. No money
 * arithmetic: amounts are only rounded for display by `formatMoney` (decimal.js).
 */
import { formatMoney } from '@ledgerforce/ui';
import { ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { AdminApiError } from '../admin/client.ts';
import { messageFor } from '../admin/messages.ts';

// --- CSV (RFC 4180, CRLF; a byte-order mark so spreadsheets read UTF-8) ---------------------

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** A text cell. A leading = + - @ (a spreadsheet formula) is defused with an apostrophe. */
export function csvText(s: string): string {
  return quote(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
}

/** An amount cell: the API's decimal string at two decimals, with a leading minus. */
export function csvAmount(value: string): string {
  return formatMoney(value, { sign: 'minus' }).amount;
}

/** UTF-8 byte-order mark, so spreadsheets read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Cells are already encoded with csvText / csvAmount (header names are plain words). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${BOM}${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;
}

/** Hands the browser a file to save. */
export function download(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

// --- Dates ------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the browser's time zone, YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const monthStart = (day: string) => `${day.slice(0, 8)}01`;

/** A real calendar day written YYYY-MM-DD, else undefined (2026-02-30 is refused). */
export function dayOnly(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}

export interface RangeSearch {
  from?: string;
  to?: string;
}

/**
 * The dates a range report runs for. Neither given: this month to today. Only `to` given: from
 * the start of the books where the report allows it (`openStart`), else the start of that month.
 */
export function dateRange(
  s: RangeSearch,
  today: string,
  openStart: boolean,
): { from: string | null; to: string } {
  if (!s.from && !s.to) return { from: monthStart(today), to: today };
  const to = s.to ?? today;
  return { from: s.from ?? (openStart ? null : monthStart(to)), to };
}

export function rangeSearch(search: Record<string, unknown>): RangeSearch {
  const from = dayOnly(search['from']);
  const to = dayOnly(search['to']);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GlDetailSearch extends RangeSearch {
  account_id?: string;
  party_id?: string;
}

export function glDetailSearch(search: Record<string, unknown>): GlDetailSearch {
  const out: GlDetailSearch = rangeSearch(search);
  for (const k of ['account_id', 'party_id'] as const) {
    const v = search[k];
    if (typeof v === 'string' && UUID.test(v)) out[k] = v;
  }
  return out;
}

/** A search parser keeping one day-valued parameter, e.g. `as_at`. */
export function dayParam<K extends string>(name: K) {
  return (search: Record<string, unknown>): Partial<Record<K, string>> => {
    const d = dayOnly(search[name]);
    const out: Partial<Record<K, string>> = {};
    if (d) out[name] = d;
    return out;
  };
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "1 Nov 2026" for a YYYY-MM-DD day. */
export const dayWords = (day: string) => DAY_FORMAT.format(new Date(`${day}T00:00:00Z`));

// --- Words -------------------------------------------------------------------------------------

const SUBTYPES: Readonly<Record<string, string>> = {
  bank: 'Bank accounts',
  current_asset: 'Other current assets',
  receivable: 'Money customers owe you',
  receivable_allowance: 'Allowance for bad debts',
  fixed_asset: 'Equipment and other fixed assets',
  payable: 'Money you owe suppliers',
  current_liability: 'Tax, wages and other amounts due',
  credit_card: 'Credit cards',
  equity: "Owner's capital and drawings",
  retained_earnings: 'Profit kept from earlier years',
  current_year_earnings: 'Profit this financial year',
  operating_revenue: 'Operating income',
  other_revenue: 'Other income',
  direct_cost: 'Direct costs',
  operating_expense: 'Operating expenses',
  employment_expense: 'Wages and super',
  other_expense: 'Other expenses',
};

/** An account kind (subtype) in plain words; unknown kinds read as their name. */
export function subtypeWord(subtype: string): string {
  const known = SUBTYPES[subtype];
  if (known) return known;
  const words = subtype.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Owners, Finance Admins, Accountants and Auditors": the interactive roles with a permission. */
export function readersOf(permission: string): string {
  const names = Object.values(ROLE_TEMPLATES)
    .filter((t) => t.interactiveLogin && (t.permissions as readonly string[]).includes(permission))
    .map((t) => `${t.name}s`);
  return names.length < 2
    ? (names[0] ?? 'Nobody')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const REFUSALS: Readonly<Record<string, string>> = {
  NO_FISCAL_YEAR:
    'There is no financial year that holds this date. Choose a date inside a year that has been set up.',
  UNBOUND_ROLE:
    'The balance sheet needs the retained earnings and current year earnings accounts in your chart. Ask your accountant to set them up.',
  UNKNOWN_COMPANY: 'Your company could not be found. Sign in again, or ask the Owner.',
  UNKNOWN_PERIOD: 'That period could not be found. Choose dates instead.',
  INVALID_RANGE: 'Check the dates: they must be real days, with From on or before To.',
  INVALID_FILTER: 'Check the account and other filters: choose them from the lists.',
  invalid_report_query: 'Check the dates: they must be real days, with From on or before To.',
};

export function reportMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    const known = REFUSALS[error.code];
    if (known) return known;
  }
  return messageFor(error);
}
