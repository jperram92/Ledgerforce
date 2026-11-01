/**
 * GST calculator — design §3.4/§3.6, golden posting GP-023 (supersedes GP-018), postings.md Q8,
 * RQ-0096, DL-0260.
 *
 * The ATO lets an invoice with several taxable supplies use either the *total invoice rule*
 * (round the invoice's GST once) or the *taxable supply rule* (round each supply's GST). The
 * AU default is `total_invoice`: GST = Σ unrounded line GST rounded once, half-up to cents;
 * each line's GST is first rounded on its own and the cent residual is put on the largest
 * taxable line (ties: the last one), so printed line amounts always add up to the document and
 * no ROUNDING line is needed. `per_line_2dp` (opt-in, as Xero and QuickBooks calculate) rounds
 * each line's GST on its own.
 *
 * Inclusive pricing keeps each line's gross and derives net = gross − GST; exclusive pricing
 * keeps each line's net and derives gross = net + GST. Amounts are decimal strings with at most
 * two decimals and results are cent amounts as NUMERIC(19,4) text ("9.1400"); rates are fractions ("0.10" for 10 %). No floating point (AGENTS.md §4).
 */
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';

export type TaxPricing = 'inclusive' | 'exclusive';
export type TaxRounding = 'total_invoice' | 'per_line_2dp';

export interface TaxLineInput {
  /** Line amount: gross when pricing is inclusive, net when exclusive; ≥ 0, ≤ 2 decimals. */
  readonly amount: string;
  /** Tax rate as a fraction, e.g. "0.10"; "0" for GST-free, input-taxed or BAS-excluded. */
  readonly rate: string;
}

export interface TaxDocumentInput {
  readonly pricing: TaxPricing;
  readonly rounding: TaxRounding;
  readonly lines: readonly TaxLineInput[];
}

export interface TaxedLine {
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

export interface TaxedDocument {
  readonly lines: readonly TaxedLine[];
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const RATE_RE = /^\d(\.\d{1,8})?$/;
const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Cent-rounded amounts as the ledger's NUMERIC(19,4) text, e.g. "9.1400". */
const text = (d: Decimal) => Money.of(d, 'AUD').toNumericString();

export function computeTax(doc: TaxDocumentInput): TaxedDocument {
  if (doc.pricing !== 'inclusive' && doc.pricing !== 'exclusive') {
    throw new RangeError(`unknown pricing ${String(doc.pricing)}`);
  }
  if (doc.rounding !== 'total_invoice' && doc.rounding !== 'per_line_2dp') {
    throw new RangeError(`unknown rounding ${String(doc.rounding)}`);
  }
  const parsed = doc.lines.map((l, i) => {
    if (typeof l.amount !== 'string' || !AMOUNT_RE.test(l.amount)) {
      throw new RangeError(
        `line ${String(i + 1)}: amount ${l.amount} must be ≥ 0 with ≤ 2 decimals`,
      );
    }
    if (typeof l.rate !== 'string' || !RATE_RE.test(l.rate)) {
      throw new RangeError(`line ${String(i + 1)}: rate ${l.rate} must be a fraction like 0.10`);
    }
    const amount = new Decimal(l.amount);
    const rate = new Decimal(l.rate);
    const exact =
      doc.pricing === 'inclusive' ? amount.times(rate).div(rate.plus(1)) : amount.times(rate);
    return { amount, rate, exact };
  });

  const taxes = parsed.map((p) => cents(p.exact));
  if (doc.rounding === 'total_invoice') {
    const documentTax = cents(parsed.reduce((s, p) => s.plus(p.exact), new Decimal(0)));
    const residual = documentTax.minus(taxes.reduce((s, t) => s.plus(t), new Decimal(0)));
    if (!residual.isZero()) {
      let target = -1;
      parsed.forEach((p, i) => {
        const best = target < 0 ? undefined : parsed[target];
        if (!p.rate.isZero() && (!best || p.amount.greaterThanOrEqualTo(best.amount))) target = i;
      });
      if (target >= 0) taxes[target] = (taxes[target] ?? new Decimal(0)).plus(residual);
    }
  }

  const lines: TaxedLine[] = parsed.map((p, i) => {
    const tax = taxes[i] ?? new Decimal(0);
    return doc.pricing === 'inclusive'
      ? { net: text(p.amount.minus(tax)), tax: text(tax), gross: text(p.amount) }
      : { net: text(p.amount), tax: text(tax), gross: text(p.amount.plus(tax)) };
  });
  const sum = (k: keyof TaxedLine) => text(lines.reduce((s, l) => s.plus(l[k]), new Decimal(0)));
  return { lines, net: sum('net'), tax: sum('tax'), gross: sum('gross') };
}
