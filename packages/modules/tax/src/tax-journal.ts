/**
 * Journal lines for a taxed document, built in memory from a TaxCalculation (T-0034).
 *
 * STATUS: DRAFT. The shape follows the Draft golden postings GP-001 and GP-018a/b in
 * Docs/accounting/postings.md, which are not Approved yet (DL-0242). Nothing here writes the
 * ledger: posting profiles (T-0038/T-0039) resolve the placeholder account keys and the sales
 * invoice task (T-0040) sends the lines through packages/ledger, the only ledger writer.
 *
 * Account keys (the golden file's notation):
 *   counter   system:AR_CONTROL (sale) / system:AP_CONTROL (purchase) — the document total
 *   lines     the caller's key per document line, grouped by (account, tax code) in order of first
 *             appearance; amount = Σnet, taxAmount = Σline tax (null if any is null)
 *   tax       tax:<code>.collected (sale) / tax:<code>.paid (purchase) — one per code with tax ≠ 0
 *   rounding  system:ROUNDING — the per-document residue (design §3.4; postings.md Q8 open)
 *
 * Signs: on a sale the counter line is a debit and lines/tax are credits; a positive residue is a
 * ROUNDING debit (GP-018b). A purchase mirrors every side. A negative amount flips its side.
 * Line order: counter, rounding, document lines, tax lines. Zero-amount lines are omitted, so
 * every emitted line has exactly one of debit/credit > 0 (journal_line rule, design §3.3).
 */
import { Money } from '@ledgerforce/shared';
import type { TaxCalculation } from './gst.engine.ts';

export interface DraftJournalLine {
  account: string;
  /** NUMERIC(19,4) text; exactly one of debit/credit is > 0. */
  debit: string;
  credit: string;
  taxCode: string | null;
  /** Tax attributed to this line (document-signed), or null. */
  taxAmount: string | null;
}

export interface DraftJournalOptions {
  side: 'sale' | 'purchase';
  /** Account key for each document line, same order and length as calc.lines. */
  lineAccounts: readonly string[];
}

export function draftTaxedDocumentLines(
  calc: TaxCalculation,
  opts: DraftJournalOptions,
): DraftJournalLine[] {
  if (opts.lineAccounts.length !== calc.lines.length) {
    throw new Error(
      `draftTaxedDocumentLines: ${String(calc.lines.length)} line(s) but ${String(opts.lineAccounts.length)} account key(s)`,
    );
  }
  const cur = calc.total.currency;
  const zero = Money.zero(cur);
  const sale = opts.side === 'sale';
  /** `debitSigned` > 0 is a debit on a sale; a purchase mirrors it. */
  const line = (
    account: string,
    debitSigned: Money,
    taxCode: string | null,
    taxAmount: Money | null,
  ): DraftJournalLine => {
    const v = sale ? debitSigned : debitSigned.negate();
    return {
      account,
      debit: (v.isPositive() ? v : zero).toNumericString(),
      credit: (v.isNegative() ? v.negate() : zero).toNumericString(),
      taxCode,
      taxAmount: taxAmount?.toNumericString() ?? null,
    };
  };

  const out: DraftJournalLine[] = [];
  if (!calc.total.isZero()) {
    out.push(line(sale ? 'system:AR_CONTROL' : 'system:AP_CONTROL', calc.total, null, null));
  }
  if (!calc.residue.isZero()) out.push(line('system:ROUNDING', calc.residue, null, null));

  const groups = new Map<
    string,
    { account: string; taxCode: string; net: Money; tax: Money | null }
  >();
  calc.lines.forEach((l, i) => {
    const account = opts.lineAccounts[i] ?? '';
    const key = JSON.stringify([account, l.taxCode]);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { account, taxCode: l.taxCode, net: l.net, tax: l.tax });
    } else {
      g.net = g.net.add(l.net);
      g.tax = g.tax && l.tax ? g.tax.add(l.tax) : null;
    }
  });
  for (const g of groups.values()) {
    if (!g.net.isZero()) out.push(line(g.account, g.net.negate(), g.taxCode, g.tax));
  }

  for (const c of calc.byCode) {
    if (!c.tax.isZero()) {
      out.push(
        line(`tax:${c.taxCode}.${sale ? 'collected' : 'paid'}`, c.tax.negate(), c.taxCode, null),
      );
    }
  }
  return out;
}
