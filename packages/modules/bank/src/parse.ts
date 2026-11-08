/**
 * Statement parsing entry point (T-0058, RQ-0019): bytes → ParsedStatement with normalised lines,
 * whatever the format. Pure; no database.
 */
import {
  camt053Statements,
  camtVariantError,
  parseCamt053,
  type CamtStatement,
} from './camt053.ts';
import { parseCsv, type CsvMapping } from './csv.ts';
import { StatementParseError } from './errors.ts';
import { decode, parseOfx } from './ofx.ts';
import { LIMITS, type ParsedStatement, type StatementFormat } from './types.ts';

export { CSV_DATE_FORMATS, validateCsvMapping, type CsvColumn, type CsvMapping } from './csv.ts';
export { StatementImportError, StatementParseError } from './errors.ts';
export type { ParsedStatement, StatementFormat, StatementLine } from './types.ts';
export type { CamtStatement } from './camt053.ts';

export interface ParseOptions {
  format: StatementFormat;
  /** The bank account's currency: every amount is in it, and a file declaring another is refused. */
  currency: string;
  /** Required for CSV. */
  csv?: CsvMapping | undefined;
}

/**
 * Guess the format from the first bytes: OFX header or root, camt.053 namespace, else CSV.
 * Another camt message (camt.052 intraday report, camt.054 notification, …) is refused with the
 * reason rather than mistaken for CSV (RQ-0028).
 */
export function detectFormat(bytes: Uint8Array): StatementFormat {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  if (/^\s*(ï»¿)?OFXHEADER\s*:/i.test(head) || /<\?OFX\b|<OFX>/i.test(head)) {
    return 'ofx';
  }
  const camt = /urn:iso:std:iso:20022:tech:xsd:camt\.(\d{3})\./.exec(head)?.[1];
  if (camt === '053') return 'camt053';
  if (camt !== undefined) throw camtVariantError(camt);
  return 'csv';
}

/** CSV text: UTF-8 if it is valid UTF-8, else Windows-1252 (common for bank exports). */
function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return decode(bytes, 'windows-1252');
  }
}

export function parseStatement(bytes: Uint8Array, opts: ParseOptions): ParsedStatement {
  let s: ParsedStatement;
  switch (opts.format) {
    case 'ofx':
      s = parseOfx(bytes, opts.currency);
      break;
    case 'camt053':
      s = parseCamt053(bytes, opts.currency);
      break;
    case 'csv':
      if (!opts.csv) {
        throw new StatementParseError(
          'CSV import needs a column mapping: save one on the bank account or pass one',
        );
      }
      s = parseCsv(decodeCsv(bytes), opts.currency, opts.csv);
      break;
  }
  return checkLimits(s);
}

/** Every field fits its column (LIMITS), else a StatementParseError naming the line. */
function checkLimits(s: ParsedStatement): ParsedStatement {
  s.lines.forEach((l, i) => {
    const too = (field: string, max: number) =>
      new StatementParseError(
        `line ${String(i + 1)}: ${field} is longer than ${String(max)} characters`,
      );
    if (l.description.length > LIMITS.description) throw too('description', LIMITS.description);
    if ((l.reference?.length ?? 0) > LIMITS.reference) throw too('reference', LIMITS.reference);
    if ((l.bankTxnId?.length ?? 0) > LIMITS.bankTxnId) throw too('bank id', LIMITS.bankTxnId);
    if ((l.batch?.entryRef?.length ?? 0) > LIMITS.entryRef) {
      throw too('entry reference', LIMITS.entryRef);
    }
  });
  return s;
}

/**
 * The statements of a camt.053 file (one per bank account, RQ-0028), each read later in its bank
 * account's currency. Pure; the importer decides which bank account each one is for.
 */
export function splitCamt053(bytes: Uint8Array): CamtStatement[] {
  return camt053Statements(bytes).map((st) => ({
    ...st,
    read: (currency: string) => checkLimits(st.read(currency)),
  }));
}

/** When a file gives both balances: opening + Σ lines must equal closing (RQ-0019). */
export function assertBalances(s: ParsedStatement): void {
  if (s.openingBalance === null || s.closingBalance === null) return;
  const expected = s.lines.reduce((acc, l) => acc.add(l.amount), s.openingBalance);
  if (!expected.equals(s.closingBalance)) {
    throw new StatementParseError(
      `the balances do not add up: opening ${s.openingBalance.toNumericString()} plus the lines gives ` +
        `${expected.toNumericString()}, but the closing balance is ${s.closingBalance.toNumericString()} ` +
        '(is the file complete?)',
    );
  }
}
