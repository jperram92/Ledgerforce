/**
 * OFX 1.x (SGML) and 2.x (XML) bank and credit-card statements (RQ-0019 findings 1–5).
 * Line: postedOn = DTPOSTED's date as written; amount = TRNAMT (signed, + in); description =
 * NAME (or PAYEE/NAME) and MEMO; reference = REFNUM ?? CHECKNUM; bankTxnId = FITID.
 */
import { TextDecoder } from 'node:util';
import { StatementParseError } from './errors.ts';
import { child, descendants, parseTags, textAt, type TagNode } from './tags.ts';
import type { ParsedStatement, StatementLine } from './types.ts';
import { collapse, money, ofxDate } from './values.ts';

/** OFX 1.x declares its character set in the header; 2.x is XML (UTF-8 unless declared). */
export function decodeOfx(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const xmlEncoding = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  let label = 'utf-8';
  if (xmlEncoding) {
    label = xmlEncoding;
  } else if (/^\s*OFXHEADER\s*:/i.test(head)) {
    const encoding = /ENCODING\s*:\s*([\w-]+)/i.exec(head)?.[1]?.toUpperCase();
    const charset = /CHARSET\s*:\s*([\w-]+)/i.exec(head)?.[1]?.toUpperCase();
    if (encoding === 'UTF-8' || encoding === 'UNICODE') label = 'utf-8';
    else if (charset === '8859-1' || charset === 'ISO-8859-1') label = 'iso-8859-1';
    else label = 'windows-1252'; // CHARSET:1252, NONE or absent with USASCII
  }
  return decode(bytes, label);
}

export function decode(bytes: Uint8Array, label: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new StatementParseError(`unsupported character encoding "${label}"`);
  }
  return decoder.decode(bytes).replace(/^\uFEFF/, '');
}

function line(t: TagNode, n: number, currency: string): StatementLine {
  const what = (field: string) => `OFX transaction ${String(n)} ${field}`;
  const dt = textAt(t, 'DTPOSTED');
  const postedOn = dt === null ? null : ofxDate(dt);
  if (postedOn === null) {
    throw new StatementParseError(`${what('DTPOSTED')}: "${dt ?? ''}" is not an OFX date`);
  }
  const amt = textAt(t, 'TRNAMT');
  if (amt === null) throw new StatementParseError(`${what('TRNAMT')}: missing`);
  // Some institutions write a decimal comma (RQ-0019 S5, S6).
  const decimal = amt.includes(',') && !amt.includes('.') ? amt.replace(',', '.') : amt;
  const name = textAt(t, 'NAME') ?? textAt(t, 'PAYEE/NAME');
  const memo = textAt(t, 'MEMO');
  const parts = [name, memo].map((p) => (p === null ? '' : collapse(p))).filter((p) => p !== '');
  const description =
    parts.length === 2 && parts[0] === parts[1] ? (parts[0] ?? '') : parts.join(' ');
  return {
    postedOn,
    amount: money(decimal, currency, what('TRNAMT')),
    description,
    reference: textAt(t, 'REFNUM') ?? textAt(t, 'CHECKNUM'),
    bankTxnId: textAt(t, 'FITID'),
  };
}

export function parseOfx(bytes: Uint8Array, currency: string): ParsedStatement {
  const text = decodeOfx(bytes);
  const start = text.search(/<OFX>/i);
  if (start === -1) throw new StatementParseError('not an OFX file: no <OFX> element');
  const ofx = child(parseTags(text.slice(start)), 'OFX');
  if (!ofx) throw new StatementParseError('not an OFX file: no <OFX> element');
  const curdef = descendants(ofx, 'CURDEF')[0]?.text.trim() || null;
  if (curdef !== null && curdef !== currency) {
    throw new StatementParseError(
      `the file is in currency ${curdef}, but the bank account is in ${currency}`,
    );
  }
  const tranList = descendants(ofx, 'BANKTRANLIST')[0];
  const period = (tag: string) => {
    const raw = textAt(tranList, tag);
    return raw === null ? null : ofxDate(raw);
  };
  const balance = textAt(descendants(ofx, 'LEDGERBAL')[0], 'BALAMT');
  return {
    format: 'ofx',
    currency: curdef,
    accountRef: descendants(ofx, 'ACCTID')[0]?.text.trim() || null,
    periodStart: period('DTSTART'),
    periodEnd: period('DTEND'),
    openingBalance: null, // OFX carries no opening balance (RQ-0019 finding 2)
    closingBalance: balance === null ? null : money(balance, currency, 'OFX LEDGERBAL/BALAMT'),
    lines: descendants(ofx, 'STMTTRN').map((t, i) => line(t, i + 1, currency)),
  };
}
