/**
 * Bad-debt write-off → posting-command lines (T-0048, design §3.8 row 5; RQ-0130; golden postings
 * GP-007 Approved per DL-0253 and GP-007-A Approved per DL-0282/DL-0387). Pure: no I/O.
 *
 * GST (RQ-0130 finding 2): the Div 21 decreasing adjustment of the written-off amount is
 * amount × invoice tax ÷ invoice total, half-up to cents (GP-007: amount × 1/11 for a wholly
 * taxable 10 % invoice); a full write-off of an unpaid invoice returns exactly the GST raised.
 *
 * Journal (GP-007 / GP-007-A order). Every amount is non-negative; the side gives the direction:
 *   1. allowance path only — Dr `setting:ar.ecl_allowance_account` the charge (ex-GST), ADJ-BD
 *      with tax = GST × charge ÷ ex-GST (half-up), party.
 *   2. Dr `setting:ar.bad_debt_account` the ex-GST amount not charged to the allowance, ADJ-BD
 *      with the remaining tax, party.
 *   3. Dr the ADJ-BD collected account (GST collected) the GST, ADJ-BD.
 *   4. Cr AR control the written-off amount, party, due date = write-off date.
 *
 * Allowance rule (GP-007-A, persona RC-1): the charge is the user-stated ex-GST amount, default
 * the lesser of the ex-GST amount and the allowance credit balance; it never exceeds either, so
 * the allowance never goes to a debit balance.
 */
import type { PostingLineInput } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';

export type BadDebtErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_WRITE_OFF'
  | 'INVOICE_NOT_POSTED'
  | 'NOT_OVERDUE'
  | 'DATE_BEFORE_INVOICE'
  | 'EXCEEDS_OPEN_AMOUNT'
  | 'FOREIGN_CURRENCY'
  | 'NO_SETTINGS'
  | 'INVALID_SETTINGS'
  | 'NO_ALLOWANCE_ACCOUNT'
  | 'ALLOWANCE_EMPTY'
  | 'ALLOWANCE_EXCEEDED'
  | 'TAX_CODE_MISSING'
  | 'TAX_ACCOUNT_MISSING';

/** A write-off refusal. Engine refusals (PERIOD_*, …) stay PostingError. */
export class BadDebtError extends DomainError {
  declare readonly code: BadDebtErrorCode;
}

export const refuseBadDebt = (code: BadDebtErrorCode, message: string): never => {
  throw new BadDebtError(code, message);
};

export type WriteOffMethod = 'direct' | 'allowance';

/** At most cents; NUMERIC(19,4) text ("200.0000") is accepted as 200.00. */
const CENTS = /^\d+(\.\d{1,2}0{0,2})?$/;
/** A signed NUMERIC text (a balance may be negative). */
const SIGNED = /^-?\d+(\.\d{1,4})?$/;

function cents(v: string, what: string, currency: string): Money {
  if (!CENTS.test(v)) {
    refuseBadDebt('INVALID_WRITE_OFF', `${what} ${JSON.stringify(v)} must be an amount in cents`);
  }
  return Money.of(v, currency);
}

/** Minor units (cents) of a non-negative cents amount, exactly. */
const unitsOf = (m: Money): bigint => BigInt(m.roundToCents().toNumericString().replace('.', '')) / 100n;

/** a × b ÷ c, half-up to cents, for non-negative cents amounts (exact integer arithmetic). */
function proportion(a: Money, b: Money, c: Money, currency: string): Money {
  const cu = unitsOf(c);
  if (cu === 0n) return Money.zero(currency);
  const q = (2n * unitsOf(a) * unitsOf(b) + cu) / (2n * cu);
  return Money.fromMinorUnits(q, currency);
}

/** RQ-0130 finding 2: the GST decreasing adjustment of a written-off amount (NUMERIC text). */
export function writeOffGst(i: {
  amount: string;
  invoiceTotal: string;
  invoiceTax: string;
  currency: string;
}): string {
  const amount = cents(i.amount, 'amount', i.currency);
  const total = cents(i.invoiceTotal, 'invoice total', i.currency);
  const tax = cents(i.invoiceTax, 'invoice tax', i.currency);
  return proportion(amount, tax, total, i.currency).toNumericString();
}

export interface WriteOffJournalInput {
  currency: string;
  partyId: string;
  /** The AR control account of the invoice's open item. */
  controlAccountId: string;
  badDebtAccountId: string;
  /** setting:ar.ecl_allowance_account; null when the company holds no allowance setting. */
  allowanceAccountId: string | null;
  /** The ADJ-BD tax-code version valid on the write-off date; null when not loaded. */
  adjBd: { id: string; collectedAccountId: string | null } | null;
  /** The gross amount written off (cents, > 0). */
  amount: string;
  invoiceTotal: string;
  invoiceTax: string;
  method: WriteOffMethod;
  /** The allowance account's credit balance (NUMERIC text; ≤ 0 means nothing available). */
  allowanceAvailable: string;
  /** The ex-GST charge to the allowance stated by the user; default per the allowance rule. */
  allowanceRequested?: string;
  /** YYYY-MM-DD; dates the credit open item. */
  writeOffDate: string;
}

export interface WriteOffJournal {
  lines: PostingLineInput[];
  gst: string;
  net: string;
  allowanceCharge: string;
  allowanceTax: string;
  badDebtAmount: string;
  badDebtTax: string;
}

export function buildWriteOffJournal(input: WriteOffJournalInput): WriteOffJournal {
  const cur = input.currency;
  const amount = cents(input.amount, 'amount', cur);
  if (!amount.isPositive()) refuseBadDebt('INVALID_WRITE_OFF', 'the write-off amount must be > 0');
  const gst = Money.of(writeOffGst({ ...input, amount: input.amount }), cur);
  const net = amount.sub(gst);
  const zero = Money.zero(cur);

  let charge = zero;
  if (input.method === 'direct') {
    if (input.allowanceRequested !== undefined) {
      refuseBadDebt('INVALID_WRITE_OFF', 'a direct write-off charges nothing to the allowance');
    }
  } else {
    if (input.allowanceAccountId === null) {
      refuseBadDebt(
        'NO_ALLOWANCE_ACCOUNT',
        'the company has no ECL allowance account (setting ar.ecl_allowance_account)',
      );
    }
    if (!SIGNED.test(input.allowanceAvailable)) {
      throw new Error(`allowance balance ${JSON.stringify(input.allowanceAvailable)} is not NUMERIC`);
    }
    const available = Money.of(input.allowanceAvailable, cur);
    if (!available.isPositive()) {
      refuseBadDebt(
        'ALLOWANCE_EMPTY',
        `the ECL allowance has no credit balance (${available.toNumericString()})`,
      );
    }
    if (input.allowanceRequested === undefined) {
      charge = net.compare(available) <= 0 ? net : available;
    } else {
      charge = cents(input.allowanceRequested, 'allowance charge', cur);
      if (!charge.isPositive()) {
        refuseBadDebt('INVALID_WRITE_OFF', 'the allowance charge must be > 0');
      }
      if (charge.compare(net) > 0 || charge.compare(available) > 0) {
        refuseBadDebt(
          'ALLOWANCE_EXCEEDED',
          `allowance charge ${charge.toNumericString()} exceeds the ex-GST amount ${net.toNumericString()} or the allowance available ${available.toNumericString()}`,
        );
      }
    }
  }
  const allowanceTax = charge.equals(net) ? gst : proportion(gst, charge, net, cur);
  const badDebt = net.sub(charge);
  const badDebtTax = gst.sub(allowanceTax);

  let tax: { id: string; account: string } | null = null;
  if (!gst.isZero()) {
    if (input.adjBd === null) {
      refuseBadDebt('TAX_CODE_MISSING', 'tax code ADJ-BD is not valid on the write-off date');
    }
    const acct = input.adjBd?.collectedAccountId ?? null;
    if (acct === null) {
      refuseBadDebt(
        'TAX_ACCOUNT_MISSING',
        'tax code ADJ-BD has no collected account (GST_COLLECTED role)',
      );
    }
    tax = { id: input.adjBd?.id ?? '', account: acct ?? '' };
  }
  const taxed = (m: Money) =>
    tax === null ? {} : { taxCodeId: tax.id, taxAmount: m.toNumericString() };

  const lines: PostingLineInput[] = [];
  if (charge.isPositive()) {
    lines.push({
      account: { id: input.allowanceAccountId ?? '' },
      debit: charge.toNumericString(),
      ...taxed(allowanceTax),
      partyId: input.partyId,
    });
  }
  if (badDebt.isPositive()) {
    lines.push({
      account: { id: input.badDebtAccountId },
      debit: badDebt.toNumericString(),
      ...taxed(badDebtTax),
      partyId: input.partyId,
    });
  }
  if (tax !== null) {
    lines.push({ account: { id: tax.account }, debit: gst.toNumericString(), taxCodeId: tax.id });
  }
  lines.push({
    account: { id: input.controlAccountId },
    credit: amount.toNumericString(),
    partyId: input.partyId,
    dueDate: input.writeOffDate,
  });
  return {
    lines,
    gst: gst.toNumericString(),
    net: net.toNumericString(),
    allowanceCharge: charge.toNumericString(),
    allowanceTax: allowanceTax.toNumericString(),
    badDebtAmount: badDebt.toNumericString(),
    badDebtTax: badDebtTax.toNumericString(),
  };
}

/**
 * GP-007-A A4: the lines of the adjusting manual journal that releases allowance left after a
 * write-off (Dr allowance / Cr bad debts). Capped at the allowance credit balance, so the release
 * never takes the allowance to a debit balance. Posted through the manual-journal workflow.
 */
export function allowanceReleaseLinesOf(i: {
  currency: string;
  allowanceAccountId: string;
  badDebtAccountId: string;
  amount: string;
  allowanceAvailable: string;
}): PostingLineInput[] {
  const amount = cents(i.amount, 'release amount', i.currency);
  if (!amount.isPositive()) refuseBadDebt('INVALID_WRITE_OFF', 'the release must be > 0');
  const available = Money.of(i.allowanceAvailable, i.currency);
  if (amount.compare(available) > 0) {
    refuseBadDebt(
      'ALLOWANCE_EXCEEDED',
      `release ${amount.toNumericString()} exceeds the allowance available ${available.toNumericString()}`,
    );
  }
  return [
    { account: { id: i.allowanceAccountId }, debit: amount.toNumericString() },
    { account: { id: i.badDebtAccountId }, credit: amount.toNumericString() },
  ];
}
