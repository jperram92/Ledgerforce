/**
 * ABA (Cemtex / BECS Direct Entry) payment file writer (T-0056, design §5.7, RQ-0006, DL-0292).
 *
 * A pure function: structured batch in, file text out. One type 0 descriptive record, one type 1
 * detail record per payment, one type 7 file total record; every record exactly 120 ASCII
 * characters; alpha fields left-justified and space-filled (truncated to their width), numeric
 * fields right-justified and zero-filled, account numbers right-justified and space-filled;
 * amounts are unsigned whole cents converted exactly with decimal.js (never floating point).
 * CRLF follows every record, including the last unless the bank profile says otherwise; an
 * optional self-balancing code-13 debit to the funding account makes the file net to zero.
 *
 * Anything a bank would reject — or that could pay the wrong account — is refused with an
 * AbaFormatError before a byte is written: characters outside the BECS set, a malformed BSB, an
 * account number longer than 9 characters, a non-positive or sub-cent amount, a total wider than
 * its 10-digit field.
 */
import { Decimal } from 'decimal.js';

export class AbaFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbaFormatError';
  }
}

/** Transaction codes used by LedgerForce (RQ-0006): 50 credit (suppliers), 53 pay, 13 debit. */
export type AbaTransactionCode = '50' | '53' | '13';

export interface AbaLine {
  /** Payee BSB, "062-000" or "062000". */
  bsb: string;
  /** Payee account number, up to 9 characters (hyphens dropped only if needed to fit). */
  accountNumber: string;
  /** Payee account title (32 characters kept). */
  accountName: string;
  /** Decimal string in dollars, e.g. "1234.56"; whole cents, > 0. */
  amount: string;
  /** Shown on the payee's statement (18 characters kept). */
  lodgementReference: string;
  /** Default "50" (externally initiated credit). */
  transactionCode?: AbaTransactionCode;
}

export interface AbaFile {
  /** The user's financial institution, 3 capitals, e.g. "CBA". */
  fiMnemonic: string;
  /** User preferred name as registered with the bank (26 characters kept). */
  userName: string;
  /** APCA / Direct Entry user id, 6 digits. */
  apcaUserId: string;
  /** File description, e.g. "SUPPLIERS" (12 characters kept). */
  description: string;
  /** YYYY-MM-DD; written DDMMYY. */
  processingDate: string;
  /** The funding account: trace BSB/account on every detail record, and the remitter name. */
  remitter: { bsb: string; accountNumber: string; name: string };
  lines: readonly AbaLine[];
}

export interface AbaOptions {
  /** Append a code-13 debit of the credit total to the funding account (bank-dependent). */
  selfBalancing?: boolean;
  /** CRLF after the type 7 record too (default true, RQ-0006). */
  trailingCrlf?: boolean;
  /** Most detail records the bank accepts in one file (default 500, RQ-0006). */
  maxDetailRecords?: number;
}

const RECORD_LENGTH = 120;
const MAX_AMOUNT_CENTS = new Decimal('9999999999');
/** BECS character set (RQ-0006, APCA BECS Procedures App. C7). */
const BECS_CHAR = /[A-Za-z0-9 &'()*+,\-./:;=?@[\]^_!$%#]/;
const BECS_TEXT = new RegExp(`^${BECS_CHAR.source}*$`);

function fail(message: string): never {
  throw new AbaFormatError(message);
}

/**
 * Best-effort conversion of free text to the BECS set: accents are removed (NFKD), any other
 * character becomes a space, runs of spaces collapse. For names and references that came from
 * people; identifiers (BSB, account numbers) are validated, never transliterated.
 */
export function toBecs(text: string): string {
  return [...text.normalize('NFKD').replace(/\p{M}/gu, '')]
    .map((c) => (BECS_CHAR.test(c) ? c : ' '))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function alpha(value: string, width: number, field: string): string {
  const v = value.trim();
  if (!BECS_TEXT.test(v)) fail(`${field} has characters outside the BECS set: "${v}"`);
  return v.slice(0, width).padEnd(width, ' ');
}

function zeros(value: Decimal | number, width: number): string {
  return value.toFixed(0).padStart(width, '0');
}

function bsb(value: string, field: string): string {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^[0-9]{6}$/.test(digits)) fail(`${field} BSB must be 6 digits, got "${value}"`);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function accountNumber(value: string, field: string): string {
  let v = value.replace(/\s+/g, '');
  if (v.length > 9) v = v.replace(/-/g, '');
  if (!/^[0-9A-Za-z-]{1,9}$/.test(v)) {
    fail(`${field} account number must be 1–9 letters, digits or hyphens, got "${value}"`);
  }
  return v.padStart(9, ' ');
}

function cents(amount: string, field: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(amount);
  } catch {
    return fail(`${field} amount is not a number: "${amount}"`);
  }
  const c = d.times(100);
  if (!c.isFinite() || !c.isInteger()) fail(`${field} amount must be whole cents: "${amount}"`);
  if (c.lte(0)) fail(`${field} amount must be greater than zero: "${amount}"`);
  if (c.gt(MAX_AMOUNT_CENTS)) fail(`${field} amount exceeds 10 digits of cents: "${amount}"`);
  return c;
}

function ddmmyy(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    !m ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    fail(`processing date must be a real YYYY-MM-DD date, got "${date}"`);
  }
  return `${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(2, 4)}`;
}

function record(parts: readonly string[]): string {
  const r = parts.join('');
  if (r.length !== RECORD_LENGTH) throw new Error(`ABA record is ${String(r.length)} characters`);
  return r;
}

/** Write the ABA file for one batch. Throws AbaFormatError on anything the bank would reject. */
export function writeAba(file: AbaFile, options: AbaOptions = {}): string {
  const max = options.maxDetailRecords ?? 500;
  if (file.lines.length === 0) fail('an ABA file needs at least one payment');
  if (file.lines.length + (options.selfBalancing ? 1 : 0) > max) {
    fail(`the bank accepts at most ${String(max)} detail records per file`);
  }
  if (!/^[A-Z]{3}$/.test(file.fiMnemonic)) {
    fail(`FI mnemonic must be 3 capital letters, got "${file.fiMnemonic}"`);
  }
  if (!/^[0-9]{6}$/.test(file.apcaUserId)) {
    fail(`APCA user id must be 6 digits, got "${file.apcaUserId}"`);
  }
  const userName = alpha(file.userName, 26, 'user name');
  const header = record([
    '0',
    ' '.repeat(17),
    '01',
    file.fiMnemonic,
    ' '.repeat(7),
    userName,
    file.apcaUserId,
    alpha(file.description, 12, 'description'),
    ddmmyy(file.processingDate),
    ' '.repeat(40),
  ]);

  const traceBsb = bsb(file.remitter.bsb, 'remitter');
  const traceAccount = accountNumber(file.remitter.accountNumber, 'remitter');
  const remitterName = alpha(file.remitter.name, 16, 'remitter name');
  const detail = (l: AbaLine, n: string): { text: string; cents: Decimal; debit: boolean } => {
    const amount = cents(l.amount, n);
    const code = l.transactionCode ?? '50';
    return {
      cents: amount,
      debit: code === '13',
      text: record([
        '1',
        bsb(l.bsb, n),
        accountNumber(l.accountNumber, n),
        ' ',
        code,
        zeros(amount, 10),
        alpha(l.accountName, 32, `${n} account name`),
        alpha(l.lodgementReference, 18, `${n} lodgement reference`),
        traceBsb,
        traceAccount,
        remitterName,
        '00000000',
      ]),
    };
  };

  const details = file.lines.map((l, i) => detail(l, `line ${String(i + 1)}`));
  const sum = (debit: boolean) =>
    details.filter((d) => d.debit === debit).reduce((s, d) => s.plus(d.cents), new Decimal(0));
  if (options.selfBalancing) {
    const credit = sum(false).minus(sum(true));
    if (credit.gt(0)) {
      details.push(
        detail(
          {
            bsb: file.remitter.bsb,
            accountNumber: file.remitter.accountNumber,
            accountName: file.userName,
            amount: credit.dividedBy(100).toFixed(2),
            lodgementReference: file.description,
            transactionCode: '13',
          },
          'balancing line',
        ),
      );
    }
  }
  const credits = sum(false);
  const debits = sum(true);
  for (const [name, total] of [
    ['credit', credits],
    ['debit', debits],
  ] as const) {
    if (total.gt(MAX_AMOUNT_CENTS)) fail(`the file ${name} total exceeds 10 digits of cents`);
  }
  const trailer = record([
    '7',
    '999-999',
    ' '.repeat(12),
    zeros(credits.minus(debits).abs(), 10),
    zeros(credits, 10),
    zeros(debits, 10),
    ' '.repeat(24),
    zeros(details.length, 6),
    ' '.repeat(40),
  ]);

  const out = [header, ...details.map((d) => d.text), trailer].join('\r\n');
  return options.trailingCrlf === false ? out : `${out}\r\n`;
}
