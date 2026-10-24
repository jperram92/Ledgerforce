/**
 * ISO 20022 camt.053 bank-to-customer statement, versions .001.02 to .001.13 (RQ-0019 finding 6).
 * Only booked entries (Sts "BOOK", or Sts/Cd "BOOK" from .001.08) become lines.
 * Line: postedOn = BookgDt/Dt or the date part of BookgDt/DtTm as written; amount = Amt signed by
 * CdtDbtInd (CRDT in, DBIT out); description = RmtInf/Ustrd ?? AddtlTxInf ?? AddtlNtryInf;
 * reference = EndToEndId unless NOTPROVIDED; bankTxnId = AcctSvcrRef.
 */
import type { Money } from '@ledgerforce/shared/money';
import { StatementParseError } from './errors.ts';
import { decode } from './ofx.ts';
import { child, childrenNamed, parseTags, textAt, type TagNode } from './tags.ts';
import type { ParsedStatement, StatementLine } from './types.ts';
import { collapse, isoDatePart, money } from './values.ts';

function signed(node: TagNode, currency: string, what: string): Money {
  const amt = child(node, 'Amt');
  const raw = amt?.text.trim() ?? '';
  const ccy = amt?.attrs['Ccy'];
  if (ccy !== undefined && ccy !== currency) {
    throw new StatementParseError(
      `${what}: amount in ${ccy}, but the bank account is in ${currency}`,
    );
  }
  const ind = textAt(node, 'CdtDbtInd');
  if (ind !== 'CRDT' && ind !== 'DBIT') {
    throw new StatementParseError(`${what}: CdtDbtInd "${ind ?? ''}" is neither CRDT nor DBIT`);
  }
  const value = money(raw, currency, `${what} Amt`);
  return ind === 'DBIT' ? value.negate() : value;
}

function status(ntry: TagNode): string | null {
  const sts = child(ntry, 'Sts');
  if (!sts) return null;
  return textAt(sts, 'Cd') ?? textAt(sts, 'Prtry') ?? (sts.text.trim() || null);
}

function line(ntry: TagNode, n: number, currency: string): StatementLine {
  const what = `CAMT entry ${String(n)}`;
  const raw = textAt(ntry, 'BookgDt/Dt') ?? textAt(ntry, 'BookgDt/DtTm');
  const postedOn = raw === null ? null : isoDatePart(raw);
  if (postedOn === null) {
    throw new StatementParseError(`${what} BookgDt: "${raw ?? ''}" is not a date`);
  }
  const tx = child(ntry, 'NtryDtls/TxDtls');
  const ustrd = childrenNamed(child(tx, 'RmtInf'), 'Ustrd')
    .map((u) => collapse(u.text))
    .filter((u) => u !== '')
    .join(' ');
  const description = ustrd || textAt(tx, 'AddtlTxInf') || textAt(ntry, 'AddtlNtryInf') || '';
  const e2e = textAt(tx, 'Refs/EndToEndId');
  return {
    postedOn,
    amount: signed(ntry, currency, what),
    description: collapse(description),
    reference: e2e === null || e2e.toUpperCase() === 'NOTPROVIDED' ? null : e2e,
    bankTxnId: textAt(ntry, 'AcctSvcrRef') ?? textAt(tx, 'Refs/AcctSvcrRef'),
  };
}

export function parseCamt053(bytes: Uint8Array, currency: string): ParsedStatement {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('latin1');
  const label = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  const doc = child(parseTags(decode(bytes, label)), 'Document');
  const ns = Object.entries(doc?.attrs ?? {})
    .filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:'))
    .map(([, v]) => v);
  if (!doc || !ns.some((v) => /camt\.053\.001\.\d+$/.test(v))) {
    throw new StatementParseError(
      `not a camt.053 statement (namespace ${ns.join(', ') || 'missing'})`,
    );
  }
  const stmts = childrenNamed(child(doc, 'BkToCstmrStmt'), 'Stmt');
  const stmt = stmts[0];
  if (!stmt || stmts.length > 1) {
    throw new StatementParseError(
      `a camt.053 file must hold exactly one statement, found ${String(stmts.length)}`,
    );
  }
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
      .map((n, i) => line(n, i + 1, currency)),
  };
}
