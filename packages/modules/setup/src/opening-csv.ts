/**
 * Opening-balance CSV files (T-0080, design §4.1 step 9, RQ-0109): the old system's trial balance
 * at the balance date, and the open AR/AP documents behind its control balances.
 *
 * Trial balance: columns `account_code`, `debit`, `credit` (any order, any case; other columns
 * such as an account name are ignored). One side per row, non-negative; rows with no amount are
 * dropped. Open items: `party`, `document_no`, `document_date`, `due_date`, `amount` and optional
 * `gst_amount`. Amounts are signed as they sit on the control account (+ debit, − credit): an
 * open invoice is +, a customer credit (unapplied payment, open credit note) −; an unpaid bill is
 * −, a supplier debit balance +. GST, if given, has the amount's sign and is
 * not larger than it. Dates are YYYY-MM-DD; the due date is not before the document date.
 *
 * Records are read with the bank module's RFC 4180 reader (quoted fields keep commas). Every
 * refusal names the CSV line (header = line 1). Amounts stay decimal strings; comparisons use
 * decimal.js, never floating point.
 */
import { readCsvRecords, StatementParseError } from '@ledgerforce/bank';
import { Decimal } from 'decimal.js';
import { fail } from './errors.ts';

export interface TrialBalanceRow {
  /** CSV line, when read from a file. */
  readonly row?: number;
  readonly accountCode: string;
  /** Plain non-negative decimal strings; '0' for the empty side. */
  readonly debit: string;
  readonly credit: string;
}

export type OpeningItemKind = 'ar' | 'ap';

export interface OpeningItemInput {
  readonly row?: number;
  readonly kind: OpeningItemKind;
  /** Party id, Salesforce Account id or exact legal name (case-insensitive, must be unique). */
  readonly party: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly dueDate: string;
  /** Signed, base currency: + debit on the control account, − credit. */
  readonly amount: string;
  /** GST content (data only — the opening journal carries no tax codes), '0' when unknown. */
  readonly gstAmount: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A plain decimal (optionally signed) with at most 4 decimals, else a refusal on `row`. */
export function decimalText(
  raw: string,
  what: string,
  row: number | undefined,
  signed: boolean,
): string {
  const s = raw.trim();
  const re = signed ? /^-?\d+(?:\.(\d+))?$/ : /^\d+(?:\.(\d+))?$/;
  const m = re.exec(s);
  if (!m) fail('INVALID_CSV', `${what} ${JSON.stringify(raw)} is not a plain decimal`, row);
  if ((m?.[1] ?? '').replace(/0+$/, '').length > 4) {
    fail('INVALID_CSV', `${what} ${s} has more than 4 decimals`, row);
  }
  return s;
}

function records(text: string): string[][] {
  try {
    return readCsvRecords(text.replace(/^\uFEFF/, ''), ',');
  } catch (e) {
    if (e instanceof StatementParseError) return fail('INVALID_CSV', e.message);
    throw e;
  }
}

/** Column index by header name; refuses missing required columns on line 1. */
function columns<K extends string>(
  header: readonly string[],
  required: readonly K[],
  optional: readonly K[] = [],
): Record<K, number> {
  const names = header.map((h) => h.trim().toLowerCase());
  const missing = required.filter((k) => !names.includes(k));
  if (missing.length > 0) fail('INVALID_CSV', `missing column(s) ${missing.join(', ')}`, 1);
  return Object.fromEntries([...required, ...optional].map((k) => [k, names.indexOf(k)])) as Record<
    K,
    number
  >;
}

const cell = (r: readonly string[], i: number) => (i < 0 ? '' : (r[i] ?? '').trim());

export function parseTrialBalanceCsv(text: string): TrialBalanceRow[] {
  const [header = [], ...data] = records(text);
  const c = columns(header, ['account_code', 'debit', 'credit']);
  if (data.length === 0) fail('INVALID_CSV', 'the trial balance has no rows');
  const out: TrialBalanceRow[] = [];
  data.forEach((r, i) => {
    const row = i + 2;
    const accountCode = cell(r, c.account_code);
    if (!accountCode) fail('INVALID_CSV', 'account_code is empty', row);
    const d = cell(r, c.debit) || '0';
    const k = cell(r, c.credit) || '0';
    const debit = decimalText(d, 'debit', row, false);
    const credit = decimalText(k, 'credit', row, false);
    const dz = new Decimal(debit).isZero();
    const kz = new Decimal(credit).isZero();
    if (!dz && !kz)
      fail('INVALID_CSV', `account ${accountCode} has both a debit and a credit`, row);
    if (dz && kz) return;
    out.push({ row, accountCode, debit: dz ? '0' : debit, credit: kz ? '0' : credit });
  });
  return out;
}

export function parseOpenItemsCsv(text: string, kind: OpeningItemKind): OpeningItemInput[] {
  const [header = [], ...data] = records(text);
  const c = columns(
    header,
    ['party', 'document_no', 'document_date', 'due_date', 'amount'],
    ['gst_amount'],
  );
  const seen = new Map<string, number>();
  return data.map((r, i) => {
    const row = i + 2;
    const party = cell(r, c.party);
    if (!party) fail('INVALID_CSV', 'party is empty', row);
    const documentNo = cell(r, c.document_no);
    if (!documentNo || documentNo.length > 60) {
      fail('INVALID_CSV', 'document_no must be 1..60 characters', row);
    }
    const documentDate = cell(r, c.document_date);
    if (!validDate(documentDate))
      fail('INVALID_CSV', `document_date ${documentDate} is not a date`, row);
    const dueDate = cell(r, c.due_date);
    if (!validDate(dueDate)) fail('INVALID_CSV', `due_date ${dueDate} is not a date`, row);
    if (dueDate < documentDate) {
      fail('INVALID_CSV', `due_date ${dueDate} is before document_date ${documentDate}`, row);
    }
    const amount = decimalText(cell(r, c.amount), 'amount', row, true);
    const a = new Decimal(amount);
    if (a.isZero()) fail('INVALID_CSV', `${documentNo} has a zero amount`, row);
    const gstAmount = decimalText(cell(r, c.gst_amount) || '0', 'gst_amount', row, true);
    const g = new Decimal(gstAmount);
    if (!g.isZero() && (g.isNegative() !== a.isNegative() || g.abs().gt(a.abs()))) {
      fail(
        'INVALID_CSV',
        `GST ${gstAmount} must have the sign of ${amount} and not exceed it`,
        row,
      );
    }
    const key = `${party.toLowerCase()}\u0000${documentNo.toLowerCase()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      fail('INVALID_CSV', `${documentNo} for ${party} is already on row ${String(first)}`, row);
    }
    seen.set(key, row);
    return {
      row,
      kind,
      party,
      documentNo,
      documentDate,
      dueDate,
      amount,
      gstAmount: g.isZero() ? '0' : gstAmount,
    };
  });
}
