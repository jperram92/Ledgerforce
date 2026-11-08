/**
 * Customer credit note → posting-command lines, the creditable-amount check and the BAS period
 * (T-0045, design §3.8 row 4, UC-11; RQ-0114; golden posting GP-005, Approved per DL-0253).
 * Pure: no I/O, nothing posted.
 *
 * Journal (RQ-0114 finding 6, GP-005 order). Each credit-note line carries the revenue account
 * and tax-code version of the invoice line it adjusts (ADR-0044 R5/W6: never re-resolved):
 *   1. One debit per (revenue account, tax code) in first-appearance order — Σnet, with Σ line
 *      tax as the tax amount, party.
 *   2. One debit per tax code whose tax is > 0 — to the code's collected account.
 *   3. ROUNDING — a per-document residue, on the mirrored side of an invoice (credit if > 0).
 *   4. AR control — credit the credit-note total, party, due date: the customer's credit item.
 * Every amount is non-negative; the side gives the direction (RQ-0095 F-notes).
 */
import type { TaxRounding } from '@ledgerforce/db';
import type { PostingLineInput } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import {
  TaxCalculationError,
  calculateTax,
  type AmountsAre,
  type TaxCalculation,
} from '@ledgerforce/tax';

export type CreditNoteErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'INVALID_CREDIT_NOTE'
  | 'INVOICE_NOT_POSTED'
  | 'NO_LINE_POSTING'
  | 'LINE_NOT_ON_INVOICE'
  | 'CREDIT_EXCEEDS_INVOICE'
  | 'UNKNOWN_APPROVER'
  | 'TAX_ACCOUNT_MISSING'
  | 'SOD_CREDIT_NOTE_SELF_APPROVAL';

/** A credit-note refusal. Engine refusals (PERIOD_*, …) stay PostingError. */
export class CreditNoteError extends DomainError {
  declare readonly code: CreditNoteErrorCode;
}

const refuse = (code: CreditNoteErrorCode, message: string): never => {
  throw new CreditNoteError(code, message);
};

/** The tax-code version of the invoice line (valid on the invoice date). */
export interface CreditNoteTaxCode {
  id: string;
  code: string;
  /** NUMERIC(18,8) text. */
  rate: string;
  collectedAccountId: string | null;
}

export interface CreditNoteJournalLine {
  /** Plain decimal > 0 at most cents; tax-exclusive or -inclusive per amountsAre. */
  amount: string;
  /** The invoice line's revenue account. */
  accountId: string;
  taxCode: CreditNoteTaxCode;
}

export interface CreditNoteJournalInput {
  partyId: string;
  /** The AR control account of the invoice's open item (allocation needs the same account). */
  controlAccountId: string;
  currency: string;
  amountsAre: AmountsAre;
  rounding: TaxRounding;
  /** YYYY-MM-DD; dates the credit open item. */
  dueDate: string;
  lines: readonly CreditNoteJournalLine[];
}

export interface CreditNoteJournal {
  lines: PostingLineInput[];
  /** Per input line: net and tax (NUMERIC(19,4) text), in input order. */
  lineResults: { net: string; tax: string }[];
  netTotal: string;
  taxTotal: string;
  total: string;
  residue: string;
}

const CENTS = /^\d+(\.\d{1,2})?$/;

export function buildCreditNoteJournal(input: CreditNoteJournalInput): CreditNoteJournal {
  if (input.lines.length === 0) refuse('INVALID_CREDIT_NOTE', 'a credit note needs a line');
  input.lines.forEach((l, i) => {
    if (!CENTS.test(l.amount) || Money.of(l.amount, input.currency).isZero()) {
      refuse(
        'INVALID_CREDIT_NOTE',
        `line ${String(i + 1)}: amount ${JSON.stringify(l.amount)} must be a positive amount in cents`,
      );
    }
  });
  let calc: TaxCalculation;
  try {
    calc = calculateTax({
      currency: input.currency,
      amountsAre: input.amountsAre,
      rounding: input.rounding,
      lines: input.lines.map((l) => ({
        amount: l.amount,
        taxCode: l.taxCode.code,
        rate: l.taxCode.rate,
      })),
    });
  } catch (e) {
    if (e instanceof TaxCalculationError) refuse('INVALID_CREDIT_NOTE', e.message);
    throw e;
  }
  const lineResults = calc.lines.map((l) => {
    // Positive amounts always carry a line tax (null only for mixed signs, gst.engine.ts).
    if (l.tax === null) throw new Error('credit-note line without line tax');
    return { net: l.net.toNumericString(), tax: l.tax.toNumericString() };
  });

  const groups = new Map<
    string,
    { accountId: string; code: CreditNoteTaxCode; net: Money; tax: Money }
  >();
  input.lines.forEach((l, i) => {
    const r = calc.lines[i];
    if (!r?.tax) return;
    const key = JSON.stringify([l.accountId, l.taxCode.id]);
    const g = groups.get(key);
    if (g) {
      g.net = g.net.add(r.net);
      g.tax = g.tax.add(r.tax);
    } else {
      groups.set(key, { accountId: l.accountId, code: l.taxCode, net: r.net, tax: r.tax });
    }
  });

  const out: PostingLineInput[] = [];
  for (const g of groups.values()) {
    if (g.net.isZero()) continue;
    out.push({
      account: { id: g.accountId },
      debit: g.net.toNumericString(),
      taxCodeId: g.code.id,
      taxAmount: g.tax.toNumericString(),
      partyId: input.partyId,
    });
  }
  const taxByCode = new Map<string, { code: CreditNoteTaxCode; tax: Money }>();
  for (const g of groups.values()) {
    const t = taxByCode.get(g.code.id);
    if (t) t.tax = t.tax.add(g.tax);
    else taxByCode.set(g.code.id, { code: g.code, tax: g.tax });
  }
  // Per-document rounding allocates the code's tax to its lines, so Σ line tax = the code's tax.
  for (const { code, tax } of taxByCode.values()) {
    if (tax.isZero()) continue;
    if (code.collectedAccountId === null) {
      refuse(
        'TAX_ACCOUNT_MISSING',
        `tax code ${code.code} carries tax ${tax.toNumericString()} but has no collected account (GST_COLLECTED role)`,
      );
    }
    out.push({
      account: { id: code.collectedAccountId ?? '' },
      debit: tax.toNumericString(),
      taxCodeId: code.id,
    });
  }
  if (!calc.residue.isZero()) {
    const r = calc.residue;
    out.push(
      r.isPositive()
        ? { account: { role: 'ROUNDING' }, credit: r.toNumericString() }
        : { account: { role: 'ROUNDING' }, debit: r.negate().toNumericString() },
    );
  }
  out.push({
    account: { id: input.controlAccountId },
    credit: calc.total.toNumericString(),
    partyId: input.partyId,
    dueDate: input.dueDate,
  });
  return {
    lines: out,
    lineResults,
    netTotal: calc.netTotal.toNumericString(),
    taxTotal: calc.taxTotal.toNumericString(),
    total: calc.total.toNumericString(),
    residue: calc.residue.toNumericString(),
  };
}

export interface CreditableInvoiceLine {
  invoiceLineId: string;
  /** The invoice line's posted net and tax. */
  net: string;
  tax: string;
  /** Σ of approved and posted credit notes (other than the one being checked). */
  creditedNet: string;
  creditedTax: string;
}

export interface CreditableInput {
  currency: string;
  invoiceTotal: string;
  /** Σ totals of approved and posted credit notes on the invoice (other than this one). */
  creditedTotal: string;
  invoiceLines: readonly CreditableInvoiceLine[];
  request: { total: string; lines: readonly { invoiceLineId: string; net: string; tax: string }[] };
}

/**
 * UC-11 A1 / SS-UC11-07 (RQ-0114 finding 3): per invoice line, credited net and tax (incl. this
 * note) ≤ the line's net and tax; and the note's total + earlier credits ≤ the invoice total.
 */
export function checkCreditable(c: CreditableInput): void {
  const m = (s: string) => Money.of(s, c.currency);
  const lines = new Map(c.invoiceLines.map((l) => [l.invoiceLineId, l]));
  const asked = new Map<string, { net: Money; tax: Money }>();
  for (const r of c.request.lines) {
    if (!lines.has(r.invoiceLineId)) {
      refuse(
        'LINE_NOT_ON_INVOICE',
        `invoice line ${r.invoiceLineId} is not on the credited invoice`,
      );
    }
    const a = asked.get(r.invoiceLineId);
    if (a) {
      a.net = a.net.add(m(r.net));
      a.tax = a.tax.add(m(r.tax));
    } else asked.set(r.invoiceLineId, { net: m(r.net), tax: m(r.tax) });
  }
  for (const [id, a] of asked) {
    const l = lines.get(id);
    if (!l) continue;
    const netLeft = m(l.net).sub(m(l.creditedNet));
    const taxLeft = m(l.tax).sub(m(l.creditedTax));
    if (a.net.compare(netLeft) > 0 || a.tax.compare(taxLeft) > 0) {
      refuse(
        'CREDIT_EXCEEDS_INVOICE',
        `invoice line ${id}: credit net ${a.net.toNumericString()} / tax ${a.tax.toNumericString()} exceeds the creditable ${netLeft.toNumericString()} / ${taxLeft.toNumericString()}`,
      );
    }
  }
  const left = m(c.invoiceTotal).sub(m(c.creditedTotal));
  if (m(c.request.total).compare(left) > 0) {
    refuse(
      'CREDIT_EXCEEDS_INVOICE',
      `credit note total ${m(c.request.total).toNumericString()} exceeds the creditable ${left.toNumericString()} of the invoice`,
    );
  }
}

export type BasFrequency = 'monthly' | 'quarterly' | 'annual';

const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Month → first month of its calendar quarter. */
const QUARTER_START: Readonly<Record<string, string>> = Object.freeze({
  '01': '01',
  '02': '01',
  '03': '01',
  '04': '04',
  '05': '04',
  '06': '04',
  '07': '07',
  '08': '07',
  '09': '07',
  '10': '10',
  '11': '10',
  '12': '10',
});

/**
 * The first day of the BAS period containing `date` (RQ-0114 finding 4): calendar month;
 * calendar quarter (Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun); AU financial year from 1 July.
 */
export function basPeriodOf(date: string, frequency: BasFrequency): string {
  const p = DATE.exec(date);
  const yyyy = p?.[1];
  const mm = p?.[2];
  if (!p || yyyy === undefined || mm === undefined) {
    return refuse('INVALID_CREDIT_NOTE', `date ${JSON.stringify(date)} is not YYYY-MM-DD`);
  }
  if (frequency === 'monthly') return `${yyyy}-${mm}-01`;
  if (frequency === 'quarterly') return `${yyyy}-${QUARTER_START[mm] ?? mm}-01`;
  if (mm >= '07') return `${yyyy}-07-01`;
  const startYear = new Date(`${yyyy}-01-01T00:00:00Z`).getUTCFullYear() - 1;
  return `${String(startYear).padStart(4, '0')}-07-01`;
}
