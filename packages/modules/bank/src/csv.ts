/**
 * Bank CSV exports (RQ-0019 finding 7). There is no standard layout, so a CsvMapping — stored
 * per bank account as data — says which column holds what. Records are read per RFC 4180.
 */
import { StatementParseError } from './errors.ts';
import type { ParsedStatement, StatementLine } from './types.ts';
import { collapse, csvAmount, isoDate } from './values.ts';

/** A column by header name (needs header: true) or by 0-based position. */
export type CsvColumn = string | number;

export const CSV_DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD'] as const;
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

export interface CsvMapping {
  header: boolean;
  dateFormat: (typeof CSV_DATE_FORMATS)[number];
  /** Default ",". */
  delimiter?: (typeof CSV_DELIMITERS)[number];
  /** Default ".". */
  decimalSeparator?: '.' | ',';
  columns: {
    date: CsvColumn;
    /** One signed column (+ in, − out) ... */
    amount?: CsvColumn;
    /** ... or debit (money out) and/or credit (money in) columns. */
    debit?: CsvColumn;
    credit?: CsvColumn;
    /** Joined with a space, in this order. */
    description: CsvColumn[];
    reference?: CsvColumn;
    bankTxnId?: CsvColumn;
  };
}

const invalid = (why: string): never => {
  throw new StatementParseError(`invalid CSV mapping: ${why}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate an untrusted mapping (e.g. read from bank_account.csv_mapping); returns a clean copy. */
export function validateCsvMapping(input: unknown): CsvMapping {
  if (!isRecord(input)) return invalid('not an object');
  for (const k of Object.keys(input)) {
    if (!['header', 'dateFormat', 'delimiter', 'decimalSeparator', 'columns'].includes(k)) {
      invalid(`unknown setting "${k}"`);
    }
  }
  const { header, dateFormat, delimiter, decimalSeparator, columns } = input;
  if (typeof header !== 'boolean') invalid('header must be true or false');
  const fmt = CSV_DATE_FORMATS.find((f) => f === dateFormat);
  if (!fmt) return invalid(`dateFormat must be one of ${CSV_DATE_FORMATS.join(', ')}`);
  const delim = CSV_DELIMITERS.find((d) => d === delimiter);
  if (delimiter !== undefined && !delim) invalid('delimiter must be one of , ; tab |');
  if (decimalSeparator !== undefined && decimalSeparator !== '.' && decimalSeparator !== ',') {
    invalid('decimalSeparator must be "." or ","');
  }
  if (!isRecord(columns)) return invalid('columns must be an object');
  const col = (name: string, v: unknown): CsvColumn => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      if (!header) invalid(`column ${name} is named "${v}" but the file has no header row`);
      return v;
    }
    return invalid(`column ${name} must be a header name or a 0-based position`);
  };
  const out: CsvMapping['columns'] = { date: col('date', columns['date']), description: [] };
  for (const k of Object.keys(columns)) {
    if (
      !['date', 'amount', 'debit', 'credit', 'description', 'reference', 'bankTxnId'].includes(k)
    ) {
      invalid(`unknown column "${k}"`);
    }
  }
  const desc = columns['description'];
  if (!Array.isArray(desc) || desc.length === 0) invalid('description needs at least one column');
  out.description = (desc as unknown[]).map((d) => col('description', d));
  for (const k of ['amount', 'debit', 'credit', 'reference', 'bankTxnId'] as const) {
    if (columns[k] !== undefined) out[k] = col(k, columns[k]);
  }
  const signedStyle = out.amount !== undefined;
  const splitStyle = out.debit !== undefined || out.credit !== undefined;
  if (signedStyle === splitStyle) {
    invalid('give either an amount column or debit/credit columns');
  }
  return {
    header: header as boolean,
    dateFormat: fmt,
    ...(delim === undefined ? {} : { delimiter: delim }),
    ...(decimalSeparator === undefined ? {} : { decimalSeparator: decimalSeparator as '.' | ',' }),
    columns: out,
  };
}

/** RFC 4180 records: quoted fields may hold the delimiter, doubled quotes and line breaks. */
export function readCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    records.push(row);
    row = [];
    field = '';
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (quoted) throw new StatementParseError('CSV: a quoted field is never closed');
  if (field !== '' || row.length > 0) endRow();
  return records.filter((r) => !(r.length === 1 && (r[0] ?? '').trim() === ''));
}

function csvDate(raw: string, format: CsvMapping['dateFormat']): string | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case 'YYYY-MM-DD':
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
      return m ? isoDate(m[1] ?? '', m[2] ?? '', m[3] ?? '') : null;
    case 'YYYYMMDD':
      m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      return m ? isoDate(m[1] ?? '', m[2] ?? '', m[3] ?? '') : null;
    case 'DD/MM/YYYY':
      m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
      return m ? isoDate(m[3] ?? '', m[2] ?? '', m[1] ?? '') : null;
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
      return m ? isoDate(m[3] ?? '', m[1] ?? '', m[2] ?? '') : null;
  }
}

export function parseCsv(text: string, currency: string, mapping: CsvMapping): ParsedStatement {
  const records = readCsvRecords(text, mapping.delimiter ?? ',');
  let index = (c: CsvColumn): number => (typeof c === 'number' ? c : -1);
  if (mapping.header) {
    const head = (records.shift() ?? []).map((h) => h.trim().toLowerCase());
    index = (c) => {
      if (typeof c === 'number') return c;
      const at = head.indexOf(c.trim().toLowerCase());
      if (at === -1) throw new StatementParseError(`CSV: column "${c}" is not in the header row`);
      return at;
    };
  }
  const cols = mapping.columns;
  const at = {
    date: index(cols.date),
    amount: cols.amount === undefined ? undefined : index(cols.amount),
    debit: cols.debit === undefined ? undefined : index(cols.debit),
    credit: cols.credit === undefined ? undefined : index(cols.credit),
    description: cols.description.map(index),
    reference: cols.reference === undefined ? undefined : index(cols.reference),
    bankTxnId: cols.bankTxnId === undefined ? undefined : index(cols.bankTxnId),
  };
  const lines = records.map((r, i): StatementLine => {
    const row = `CSV row ${String(i + 1)}`;
    const cell = (c: number | undefined) => (c === undefined ? '' : (r[c] ?? '').trim());
    const postedOn = csvDate(cell(at.date), mapping.dateFormat);
    if (postedOn === null) {
      throw new StatementParseError(
        `${row}: date "${cell(at.date)}" does not match ${mapping.dateFormat}`,
      );
    }
    const amountOf = (raw: string, what: string) =>
      csvAmount(raw, currency, `${row} ${what}`, mapping.decimalSeparator);
    let amount;
    if (at.amount !== undefined) {
      if (cell(at.amount) === '') throw new StatementParseError(`${row}: the amount is empty`);
      amount = amountOf(cell(at.amount), 'amount');
    } else {
      const debit = cell(at.debit);
      const credit = cell(at.credit);
      if (debit !== '' && credit !== '') {
        throw new StatementParseError(`${row}: both debit and credit amount are filled`);
      }
      if (debit === '' && credit === '') {
        throw new StatementParseError(`${row}: neither debit nor credit amount is filled`);
      }
      amount =
        debit !== '' ? amountOf(debit, 'debit').abs().negate() : amountOf(credit, 'credit').abs();
    }
    const optional = (c: number | undefined) => {
      const v = collapse(cell(c));
      return v === '' ? null : v;
    };
    return {
      postedOn,
      amount,
      description: collapse(
        at.description
          .map(cell)
          .filter((d) => d !== '')
          .join(' '),
      ),
      reference: optional(at.reference),
      bankTxnId: optional(at.bankTxnId),
    };
  });
  return {
    format: 'csv',
    currency: null,
    accountRef: null,
    periodStart: null,
    periodEnd: null,
    openingBalance: null,
    closingBalance: null,
    lines,
  };
}
