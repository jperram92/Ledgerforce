/**
 * ISO 20022 camt.053 bank-to-customer statement, versions .001.02 to .001.13 (RQ-0019 finding 6,
 * RQ-0028). Only booked entries (Sts "BOOK", or Sts/Cd "BOOK" from .001.08) become lines.
 * Line: postedOn = BookgDt/Dt or the date part of BookgDt/DtTm as written; amount = Amt signed by
 * CdtDbtInd (CRDT in, DBIT out); description = RmtInf/Ustrd ?? AddtlTxInf ?? AddtlNtryInf;
 * reference = EndToEndId unless NOTPROVIDED; bankTxnId = AcctSvcrRef.
 *
 * Batch entries (T-0059, RQ-0028): an entry with two or more NtryDtls/TxDtls that all carry an
 * amount (TxDtls/Amt, else AmtDtls/TxAmt/Amt) becomes one line per TxDtls, signed by its own
 * CdtDbtInd or else the entry's; the parts must add up exactly to the booked amount or the file
 * is refused. Parts without any amount: the entry stays one line. Only some with an amount:
 * refused. A file may hold several Stmt (camt053Statements); camt.052 and camt.054 are refused.
 */
import { Money } from '@ledgerforce/shared/money';
import { StatementParseError } from './errors.ts';
import { decode } from './ofx.ts';
import { child, childrenNamed, parseTags, textAt, type TagNode } from './tags.ts';
import type { ParsedStatement, StatementLine } from './types.ts';
import { collapse, isoDatePart, money } from './values.ts';

/** Why a camt message other than camt.053 is not imported (RQ-0028 findings 5–7). */
export function camtVariantError(code: string): StatementParseError {
  switch (code) {
    case '052':
      return new StatementParseError(
        'camt.052 intraday account reports are not imported: their entries are provisional until ' +
          "the end-of-day statement. Import the bank's camt.053 statement for the day instead.",
      );
    case '054':
      return new StatementParseError(
        'camt.054 debit/credit notifications are not imported: they carry no balances to check ' +
          "and repeat entries of the day's statement. Import the bank's camt.053 statement instead.",
      );
    default:
      return new StatementParseError(
        `camt.${code} is not a camt.053 bank statement and cannot be imported`,
      );
  }
}

function checkedAmount(
  amt: TagNode | undefined,
  ind: string | null,
  currency: string,
  what: string,
): Money {
  const raw = amt?.text.trim() ?? '';
  const ccy = amt?.attrs['Ccy'];
  if (ccy !== undefined && ccy !== currency) {
    throw new StatementParseError(
      `${what}: amount in ${ccy}, but the bank account is in ${currency}`,
    );
  }
  if (ind !== 'CRDT' && ind !== 'DBIT') {
    throw new StatementParseError(`${what}: CdtDbtInd "${ind ?? ''}" is neither CRDT nor DBIT`);
  }
  const value = money(raw, currency, `${what} Amt`);
  return ind === 'DBIT' ? value.negate() : value;
}

const signed = (node: TagNode, currency: string, what: string): Money =>
  checkedAmount(child(node, 'Amt'), textAt(node, 'CdtDbtInd'), currency, what);

function status(ntry: TagNode): string | null {
  const sts = child(ntry, 'Sts');
  if (!sts) return null;
  return textAt(sts, 'Cd') ?? textAt(sts, 'Prtry') ?? (sts.text.trim() || null);
}

function txText(tx: TagNode | undefined): string {
  const ustrd = childrenNamed(child(tx, 'RmtInf'), 'Ustrd')
    .map((u) => collapse(u.text))
    .filter((u) => u !== '')
    .join(' ');
  return ustrd || textAt(tx, 'AddtlTxInf') || '';
}

function endToEnd(tx: TagNode | undefined): string | null {
  const e2e = textAt(tx, 'Refs/EndToEndId');
  return e2e === null || e2e.toUpperCase() === 'NOTPROVIDED' ? null : e2e;
}

/** The part's own amount node: TxDtls/Amt (.001.03+), else AmtDtls/TxAmt/Amt (.001.02). */
const partAmount = (tx: TagNode): TagNode | undefined =>
  child(tx, 'Amt') ?? child(tx, 'AmtDtls/TxAmt/Amt');

function lines(ntry: TagNode, n: number, currency: string): StatementLine[] {
  const entryRef = textAt(ntry, 'AcctSvcrRef') ?? textAt(ntry, 'NtryRef');
  const what = `CAMT entry ${String(n)}${entryRef === null ? '' : ` (${entryRef})`}`;
  const raw = textAt(ntry, 'BookgDt/Dt') ?? textAt(ntry, 'BookgDt/DtTm');
  const postedOn = raw === null ? null : isoDatePart(raw);
  if (postedOn === null) {
    throw new StatementParseError(`${what} BookgDt: "${raw ?? ''}" is not a date`);
  }
  const amount = signed(ntry, currency, what);
  const entryText = textAt(ntry, 'AddtlNtryInf');
  const txs = childrenNamed(ntry, 'NtryDtls').flatMap((d) => childrenNamed(d, 'TxDtls'));

  if (txs.length <= 1) {
    const tx = txs[0];
    return [
      {
        postedOn,
        amount,
        description: collapse(txText(tx) || entryText || ''),
        reference: endToEnd(tx),
        bankTxnId: textAt(ntry, 'AcctSvcrRef') ?? textAt(tx, 'Refs/AcctSvcrRef'),
      },
    ];
  }

  const withAmount = txs.filter((tx) => partAmount(tx) !== undefined).length;
  if (withAmount === 0) {
    // References only: one line with the booked amount; no single part's reference.
    return [
      {
        postedOn,
        amount,
        description: collapse(
          entryText ||
            txs
              .map(txText)
              .filter((t) => t !== '')
              .join('; '),
        ),
        reference: null,
        bankTxnId: textAt(ntry, 'AcctSvcrRef'),
      },
    ];
  }
  if (withAmount < txs.length) {
    throw new StatementParseError(
      `${what}: some of its ${String(txs.length)} parts (TxDtls) carry an amount and some do not, ` +
        'so the entry cannot be split',
    );
  }

  const entryInd = textAt(ntry, 'CdtDbtInd');
  const parts = txs.map((tx, i): StatementLine => {
    const label = `${what} part ${String(i + 1)}`;
    return {
      postedOn,
      amount: checkedAmount(partAmount(tx), textAt(tx, 'CdtDbtInd') ?? entryInd, currency, label),
      description: collapse(txText(tx) || entryText || ''),
      reference: endToEnd(tx),
      bankTxnId: textAt(tx, 'Refs/AcctSvcrRef'),
      batch: { entryRef, part: i + 1, parts: txs.length },
    };
  });
  const sum = parts.reduce((acc, l) => acc.add(l.amount), Money.zero(currency));
  if (!sum.equals(amount)) {
    throw new StatementParseError(
      `${what}: its ${String(parts.length)} parts (TxDtls) add up to ${sum.toNumericString()}, ` +
        `but the booked amount is ${amount.toNumericString()}`,
    );
  }
  return parts;
}

/** One Stmt of a camt.053 file, before its amounts are read. */
export interface CamtStatement {
  /** 1-based position in the file. */
  index: number;
  /** Acct/Id/IBAN ?? Acct/Id/Othr/Id. */
  accountRef: string | null;
  /** Clearing member id of the account's bank (AU: the BSB), digits only, or null. */
  servicerId: string | null;
  /** Acct/Ccy, else the currency of the first balance or entry, or null. */
  currency: string | null;
  /** Read the statement's balances and booked entries in the bank account's currency. */
  read(currency: string): ParsedStatement;
}

function readStatement(stmt: TagNode, currency: string): ParsedStatement {
  const ccy = textAt(stmt, 'Acct/Ccy');
  if (ccy !== null && ccy !== currency) {
    throw new StatementParseError(
      `the file is in currency ${ccy}, but the bank account is in ${currency}`,
    );
  }
  let openingBalance: Money | null = null;
  let closingBalance: Money | null = null;
  for (const bal of childrenNamed(stmt, 'Bal')) {
    const code = textAt(bal, 'Tp/CdOrPrtry/Cd');
    if ((code === 'OPBD' || code === 'PRCD') && openingBalance === null) {
      openingBalance = signed(bal, currency, `CAMT balance ${code}`);
    } else if (code === 'CLBD') {
      closingBalance = signed(bal, currency, 'CAMT balance CLBD');
    }
  }
  const period = (tag: string) => {
    const raw = textAt(stmt, `FrToDt/${tag}`);
    return raw === null ? null : isoDatePart(raw);
  };
  return {
    format: 'camt053',
    currency: ccy,
    accountRef: textAt(stmt, 'Acct/Id/IBAN') ?? textAt(stmt, 'Acct/Id/Othr/Id'),
    periodStart: period('FrDtTm'),
    periodEnd: period('ToDtTm'),
    openingBalance,
    closingBalance,
    lines: childrenNamed(stmt, 'Ntry')
      .filter((n) => status(n) === 'BOOK')
      .flatMap((n, i) => lines(n, i + 1, currency)),
  };
}

/** Every Stmt of a camt.053 file, in file order; camt.052/054 and non-camt are refused. */
export function camt053Statements(bytes: Uint8Array): CamtStatement[] {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('latin1');
  const label = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  const doc = child(parseTags(decode(bytes, label)), 'Document');
  const ns = Object.entries(doc?.attrs ?? {})
    .filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:'))
    .map(([, v]) => v);
  const code = ns
    .map((v) => /urn:iso:std:iso:20022:tech:xsd:camt\.(\d{3})\.001\.\d+$/.exec(v)?.[1])
    .find((c) => c !== undefined);
  if (code !== undefined && code !== '053') throw camtVariantError(code);
  if (!doc || code === undefined) {
    throw new StatementParseError(
      `not a camt.053 statement (namespace ${ns.join(', ') || 'missing'})`,
    );
  }
  return childrenNamed(child(doc, 'BkToCstmrStmt'), 'Stmt').map((stmt, i) => {
    const digits = textAt(stmt, 'Acct/Svcr/FinInstnId/ClrSysMmbId/MmbId')?.replace(/\D/g, '');
    return {
      index: i + 1,
      accountRef: textAt(stmt, 'Acct/Id/IBAN') ?? textAt(stmt, 'Acct/Id/Othr/Id'),
      servicerId: digits ? digits : null,
      currency:
        textAt(stmt, 'Acct/Ccy') ??
        child(stmt, 'Bal/Amt')?.attrs['Ccy'] ??
        child(stmt, 'Ntry/Amt')?.attrs['Ccy'] ??
        null,
      read: (currency: string) => readStatement(stmt, currency),
    };
  });
}

/** A camt.053 file with exactly one statement, read in the bank account's currency. */
export function parseCamt053(bytes: Uint8Array, currency: string): ParsedStatement {
  const stmts = camt053Statements(bytes);
  const [stmt] = stmts;
  if (!stmt) throw new StatementParseError('the camt.053 file holds no statement');
  if (stmts.length > 1) {
    throw new StatementParseError(
      `this camt.053 file holds ${String(stmts.length)} statements (one per bank account): ` +
        'import it for the company, so that each statement lands on its own bank account',
    );
  }
  return stmt.read(currency);
}
