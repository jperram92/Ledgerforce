/**
 * GST engine (T-0034, design §3.4, RQ-0094, DL-0244): tax on a document's lines, tax-exclusive
 * or tax-inclusive, rounded half-up to the currency's minor unit (cents for AUD) either per line
 * or once per tax code on the document (company setting `tax_rounding`).
 *
 *  per_line      exclusive: tax = round(net × r)              gross = net + tax
 *                inclusive: tax = round(gross × r / (1 + r))  net = gross − tax
 *                → net + tax = gross on every line; residue is always 0.
 *  per_document  exclusive: tax(code) = round(Σnet × r)       total = Σnet + Σtax, residue 0
 *                inclusive: net = round(gross / (1 + r)) per line, tax(code) = round(Σgross × r/(1+r))
 *                → residue = Σnet + Σtax − Σgross, which the caller posts to system:ROUNDING
 *                  (Draft GP-018b; postings.md Q8 still open for the accountant).
 *
 * Invariant for every result: total = netTotal + taxTotal − residue.
 *
 * Arithmetic is decimal.js only (no JS numbers on money): a private clone with 60 significant
 * digits, so r / (1 + r) and the divisions are correctly rounded before the single half-up
 * rounding to the minor unit; an exact half-unit tie is a terminating decimal and is therefore
 * represented exactly and rounds up.
 *
 * Pure: no I/O, nothing posted. Line-level tax under per_document is the code's tax allocated by
 * the largest-remainder method in proportion to the line bases (gross if inclusive, net if
 * exclusive) when all of the code's lines share a sign; otherwise it is null (document tax only).
 */
import type { TaxRounding } from '@ledgerforce/db';
import { currency as toCurrency, minorUnits, Money } from '@ledgerforce/shared';
import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export class TaxCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxCalculationError';
  }
}

export type AmountsAre = 'exclusive' | 'inclusive';

export interface TaxLineInput {
  /** Line amount as a plain decimal string at most at the currency minor unit (e.g. "3.35"). */
  amount: string;
  taxCode: string;
  /** Tax rate as a decimal string, 0 ≤ rate < 1, at most 8 decimals (NUMERIC(18,8)). */
  rate: string;
}

export interface TaxCalculationInput {
  currency: string;
  amountsAre: AmountsAre;
  rounding: TaxRounding;
  lines: readonly TaxLineInput[];
}

export interface TaxLineResult {
  taxCode: string;
  rate: string;
  net: Money;
  /** null under per_document when the code's lines have mixed signs (see header). */
  tax: Money | null;
  /** null under per_document exclusive: the gross only exists at document level. */
  gross: Money | null;
}

export interface TaxCodeTotal {
  taxCode: string;
  rate: string;
  net: Money;
  tax: Money;
}

export interface TaxCalculation {
  lines: TaxLineResult[];
  /** One entry per tax code, in order of first appearance. */
  byCode: TaxCodeTotal[];
  netTotal: Money;
  taxTotal: Money;
  /** The document total: Σ line amounts if inclusive, netTotal + taxTotal if exclusive. */
  total: Money;
  /**
   * Σnet + Σtax − total. Non-zero only for per_document inclusive. On a sale a positive residue
   * means the credits exceed the receivable by this amount: debit ROUNDING (GP-018b).
   */
  residue: Money;
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function parseAmount(text: string, scale: number, i: number): Dec {
  if (!PLAIN_DECIMAL.test(text)) {
    throw new TaxCalculationError(
      `line ${String(i + 1)}: amount ${JSON.stringify(text)} is not a plain decimal`,
    );
  }
  const d = new D(text);
  if (d.decimalPlaces() > scale) {
    throw new TaxCalculationError(
      `line ${String(i + 1)}: amount ${text} has more than ${String(scale)} decimals (the currency minor unit)`,
    );
  }
  return d;
}

function parseRate(text: string, code: string): Dec {
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new TaxCalculationError(
      `tax code ${code}: rate ${JSON.stringify(text)} is not a plain decimal`,
    );
  }
  const r = new D(text);
  if (r.gte(1) || r.decimalPlaces() > 8) {
    throw new TaxCalculationError(
      `tax code ${code}: rate ${text} must be 0 ≤ rate < 1 with at most 8 decimals`,
    );
  }
  return r;
}

interface Member {
  index: number;
  amount: Dec;
  net: Dec;
  tax: Dec | null;
  gross: Dec | null;
}

interface Group {
  taxCode: string;
  rateText: string;
  rate: Dec;
  members: Member[];
  tax: Dec;
}

const sum = (ds: readonly Dec[]): Dec => ds.reduce((s, d) => s.plus(d), new D(0));

export function calculateTax(input: TaxCalculationInput): TaxCalculation {
  const cur = toCurrency(input.currency);
  const scale = minorUnits(cur);
  const money = (d: Dec): Money => Money.of(d, cur);
  const round = (d: Dec): Dec => d.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  const inclusive = input.amountsAre === 'inclusive';

  const groups = new Map<string, Group>();
  const members: Member[] = input.lines.map((l, index) => {
    const m: Member = {
      index,
      amount: parseAmount(l.amount, scale, index),
      net: new D(0),
      tax: null,
      gross: null,
    };
    const rate = parseRate(l.rate, l.taxCode);
    const g = groups.get(l.taxCode);
    if (!g) {
      groups.set(l.taxCode, {
        taxCode: l.taxCode,
        rateText: l.rate,
        rate,
        members: [m],
        tax: new D(0),
      });
    } else if (!g.rate.eq(rate)) {
      throw new TaxCalculationError(
        `tax code ${l.taxCode} has two rates in one document (${g.rateText}, ${l.rate})`,
      );
    } else {
      g.members.push(m);
    }
    return m;
  });

  for (const g of groups.values()) {
    const onePlus = g.rate.plus(1);
    const taxOn = (base: Dec): Dec =>
      round(inclusive ? base.times(g.rate).div(onePlus) : base.times(g.rate));
    if (input.rounding === 'per_line') {
      for (const m of g.members) {
        const t = taxOn(m.amount);
        m.tax = t;
        m.net = inclusive ? m.amount.minus(t) : m.amount;
        m.gross = inclusive ? m.amount : m.amount.plus(t);
      }
      g.tax = sum(g.members.map((m) => m.tax ?? new D(0)));
    } else {
      g.tax = taxOn(sum(g.members.map((m) => m.amount)));
      const shares = allocateTax(
        money(g.tax),
        g.members.map((m) => m.amount),
      );
      g.members.forEach((m, k) => {
        const share = shares?.[k];
        m.net = inclusive ? round(m.amount.div(onePlus)) : m.amount;
        m.gross = inclusive ? m.amount : null;
        m.tax = share ? new D(share.toNumericString()) : null;
      });
    }
  }

  const netTotal = sum(members.map((m) => m.net));
  const taxTotal = sum([...groups.values()].map((g) => g.tax));
  const total = inclusive ? sum(members.map((m) => m.amount)) : netTotal.plus(taxTotal);

  return {
    lines: input.lines.map((l, i) => {
      const m = members[i] as Member; // members is input.lines mapped 1:1
      return {
        taxCode: l.taxCode,
        rate: l.rate,
        net: money(m.net),
        tax: m.tax === null ? null : money(m.tax),
        gross: m.gross === null ? null : money(m.gross),
      };
    }),
    byCode: [...groups.values()].map((g) => ({
      taxCode: g.taxCode,
      rate: g.rateText,
      net: money(sum(g.members.map((m) => m.net))),
      tax: money(g.tax),
    })),
    netTotal: money(netTotal),
    taxTotal: money(taxTotal),
    total: money(total),
    residue: money(netTotal.plus(taxTotal).minus(total)),
  };
}

/**
 * Split the code's tax over its lines in proportion to |base| with Money.allocate (largest
 * remainder, ties to the earlier line, sign kept). Null when the bases have mixed signs.
 */
function allocateTax(amount: Money, bases: Dec[]): Money[] | null {
  if (bases.some((b) => b.gt(0)) && bases.some((b) => b.lt(0))) return null;
  if (bases.every((b) => b.isZero())) return bases.map(() => Money.zero(amount.currency));
  return amount.allocate(
    bases.map((b) => b.abs()),
    { scale: minorUnits(amount.currency) },
  );
}
