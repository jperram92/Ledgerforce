/**
 * BAS arithmetic (T-0035, design §3.6, RQ-0102) — pure: no I/O. bas-report.ts loads the facts
 * from the ledger's read API and the BAS label map; this module turns them into label amounts.
 *
 * A *line* is a posted journal line with a tax code that is not a GST account line (the tax
 * line on GST collected / paid carries no tax amount of its own; its GST is reported through the
 * line it belongs to). Its flow is sales when its account is revenue or liability and purchases
 * when asset, expense or equity (DL-0277). A label map row applies to a line when the tax code
 * matches, the row is valid on the line's entry date, the flow matches (or is `any`) and the row's
 * basis is `both` or the report's basis. The row adds amount × (+1 on its positive side, −1 on
 * the other), where net = the line amount, tax = the line's (unsigned) tax amount and
 * gross = net + tax.
 *
 * Accruals: every line dated in the period counts in full. Cash (s 29-5(2), RQ-0102 finding 3):
 * a line of a *document* entry (invoice, credit note, write-off, bill) counts in the share of
 * the document settled by consideration in the period — Σ base released from its open items by
 * allocations dated in the period whose counter entry is a *settlement* (receipt, refund,
 * payment, Stripe charge, prepayment application), ÷ Σ |base original| of its items, rounded
 * half-up to cents per document and label; every other line counts in full at its entry date.
 *
 * decimal.js only; results are 2-decimal strings (cents).
 */
import type { AccountType, BasLabel, GstBasis } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared';
import { Decimal } from 'decimal.js';
import type { BasLabelMapRow } from './bas-report.ts';

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export const BAS_LABELS: readonly BasLabel[] = Object.freeze([
  'G1',
  'G2',
  'G3',
  'G10',
  'G11',
  '1A',
  '1B',
  'W1',
  'W2',
]);
/** Simpler BAS (GST turnover < $10M): G1, 1A and 1B only (RQ-0102 finding 5). */
export const SIMPLER_BAS_LABELS: readonly BasLabel[] = Object.freeze(['G1', '1A', '1B']);

export type BasFormat = 'full' | 'simpler';

/**
 * How the cash basis attributes an entry, by stored source type (RQ-0102 finding 3). Every
 * source type the ledger accepts (period-matrix SOURCE_TYPES) must be listed — a test enforces
 * it — and an unknown one fails the report rather than guessing.
 */
export const CASH_ATTRIBUTION: Readonly<Record<string, 'document' | 'settlement' | 'immediate'>> =
  Object.freeze({
    ar_invoice: 'document',
    ar_credit_note: 'document',
    ar_write_off: 'document',
    ap_bill: 'document',
    ar_receipt: 'settlement',
    ar_refund: 'settlement',
    payments_stripe_charge: 'settlement',
    ap_payment: 'settlement',
    ar_prepayment_application: 'settlement',
    ar_prepayment: 'immediate',
    payments_stripe_payout: 'immediate',
    payroll_pay_run: 'immediate',
    payroll_net_pay_batch: 'immediate',
    manual_journal: 'immediate',
    // A reversal is classified by the entry it reverses (classSourceType); a reversal row
    // without one (not produced by the engine) is treated as immediate.
    ledger_reversal: 'immediate',
  });

export class BasReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BasReportError';
  }
}

export function cashAttribution(sourceType: string): 'document' | 'settlement' | 'immediate' {
  const c = Object.hasOwn(CASH_ATTRIBUTION, sourceType) ? CASH_ATTRIBUTION[sourceType] : undefined;
  if (c === undefined) {
    throw new BasReportError(`source type ${sourceType} has no cash-basis attribution`);
  }
  return c;
}

/** A taxed journal line as the BAS sees it. */
export interface BasLine {
  entryId: string;
  /** YYYY-MM-DD: selects the label map version. */
  entryDate: string;
  accountType: AccountType;
  /** NUMERIC text; exactly one side > 0. */
  debit: string;
  credit: string;
  taxCode: string;
  /** Unsigned; null = none. */
  taxAmount: string | null;
}

/** A document's settled share in the period (cash basis). */
export interface DocumentShare {
  entryId: string;
  /** Σ base released by settlement allocations dated in the period (may be negative). */
  released: string;
  /** Σ |base original| of the document's open items. */
  original: string;
}

export interface BasInput {
  basis: GstBasis;
  format: BasFormat;
  map: readonly BasLabelMapRow[];
  /** Lines that count in full: accruals — every line in the period; cash — non-documents. */
  lines: readonly BasLine[];
  /** Cash basis: lines of documents settled (in part) in the period, with their shares. */
  documents?: readonly { share: DocumentShare; lines: readonly BasLine[] }[];
}

export const flowOf = (t: AccountType): 'sales' | 'purchases' =>
  t === 'revenue' || t === 'liability' ? 'sales' : 'purchases';

/** Signed contribution of one line to each label (unrounded). */
export function lineContributions(
  line: BasLine,
  map: readonly BasLabelMapRow[],
  basis: GstBasis,
): Map<BasLabel, Dec> {
  const out = new Map<BasLabel, Dec>();
  const debit = new D(line.debit);
  const credit = new D(line.credit);
  const net = debit.plus(credit);
  const tax = new D(line.taxAmount ?? 0);
  const onDebit = debit.gt(0);
  const flow = flowOf(line.accountType);
  for (const m of map) {
    if (m.taxCode !== line.taxCode) continue;
    if (m.validFrom > line.entryDate || (m.validTo !== null && m.validTo < line.entryDate))
      continue;
    if (m.flow !== 'any' && m.flow !== flow) continue;
    if (m.basis !== 'both' && m.basis !== basis) continue;
    const amount = m.amount === 'net' ? net : m.amount === 'tax' ? tax : net.plus(tax);
    const signed = onDebit === (m.positiveSide === 'debit') ? amount : amount.neg();
    out.set(m.label, (out.get(m.label) ?? new D(0)).plus(signed));
  }
  return out;
}

const cents = (d: Dec): Dec => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** A cent-rounded amount as "1375.00" via Money's exact NUMERIC(19,4) text; never "-0.00". */
const centsText = (d: Dec): string =>
  d.isZero() ? '0.00' : Money.of(d.toString(), 'AUD').toNumericString().slice(0, -2);

/** Label amounts as cent strings, in BAS order, for the format's labels. */
export function computeBas(input: BasInput): Partial<Record<BasLabel, string>> {
  const totals = new Map<BasLabel, Dec>(BAS_LABELS.map((l) => [l, new D(0)]));
  const add = (label: BasLabel, v: Dec) =>
    totals.set(label, (totals.get(label) ?? new D(0)).plus(v));

  for (const line of input.lines) {
    for (const [label, v] of lineContributions(line, input.map, input.basis)) add(label, v);
  }
  for (const doc of input.documents ?? []) {
    const original = new D(doc.share.original);
    if (original.isZero()) {
      throw new BasReportError(`document ${doc.share.entryId} has no open-item amount`);
    }
    const share = new D(doc.share.released).div(original);
    const perLabel = new Map<BasLabel, Dec>();
    for (const line of doc.lines) {
      for (const [label, v] of lineContributions(line, input.map, input.basis)) {
        perLabel.set(label, (perLabel.get(label) ?? new D(0)).plus(v));
      }
    }
    for (const [label, v] of perLabel) add(label, cents(v.times(share)));
  }

  const labels = input.format === 'simpler' ? SIMPLER_BAS_LABELS : BAS_LABELS;
  const out: Partial<Record<BasLabel, string>> = {};
  for (const l of labels) {
    out[l] = centsText(cents(totals.get(l) ?? new D(0)));
  }
  return out;
}
