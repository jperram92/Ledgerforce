/**
 * Stripe payout → GP-027 (T-0075, design §3.8 row 3, RQ-0107, DL-0403).
 *
 * Input: the payout and its balance transactions (Stripe's documented shape; fetched by T-0130).
 * Output: one journal through the posting engine (source payments_stripe_payout):
 *   Dr payout bank account (net paid out) · Dr Stripe fees (fee excl. GST, GST tax code, Stripe party)
 *   · Dr GST paid (the `tax` fee_details) · Cr Stripe clearing (gross of the payout's charges, refunds net)
 * and one app.stripe_payout row (idempotency on the payout id; fee GST pending the monthly tax
 * invoice, GP-028).
 *
 * Rules (RQ-0107): fee = Σ fee_details except `tax`; GST on fees = Σ `tax` entries (never computed as
 * 10 %). `withheld_tax` is refused until a golden posting covers it. The payout amount must equal
 * the net of its non-payout balance transactions. AUD only (GP-027 is single-currency).
 * Money: cents are integers from Stripe; converted to decimal strings with decimal.js only.
 */
import type { Database } from '@ledgerforce/db';
import { post, type PostOptions } from '@ledgerforce/ledger';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type StripePayoutErrorCode =
  'NOT_CONFIGURED' | 'UNBALANCED' | 'UNSUPPORTED_FEE' | 'UNSUPPORTED_CURRENCY' | 'INVALID_PAYOUT';

export class StripePayoutError extends Error {
  readonly code: StripePayoutErrorCode;
  constructor(code: StripePayoutErrorCode, message: string) {
    super(message);
    this.name = 'StripePayoutError';
    this.code = code;
  }
}

export interface StripeFeeDetail {
  readonly amount: number;
  readonly currency: string;
  readonly description: string | null;
  readonly type: string;
  readonly application: string | null;
}

export interface StripeBalanceTransaction {
  readonly id: string;
  readonly type: string;
  /** Integer minor units (cents), as Stripe sends them. */
  readonly amount: number;
  readonly fee: number;
  readonly net: number;
  readonly currency: string;
  readonly fee_details: readonly StripeFeeDetail[];
}

export interface StripePayoutFacts {
  readonly id: string;
  /** Integer cents paid out to the bank. */
  readonly amountCents: number;
  readonly currency: string;
  /** YYYY-MM-DD: the date the payout arrives (the entry date). */
  readonly arrivalDate: string;
}

const FEE_TYPES = new Set(['stripe_fee', 'application_fee', 'payment_method_passthrough_fee']);
const cents = (n: number) => {
  if (!Number.isSafeInteger(n))
    throw new StripePayoutError('INVALID_PAYOUT', `not an integer amount: ${String(n)}`);
  return new Decimal(n).div(100);
};
const two = (d: Decimal) => d.toFixed(2);

/** The GP-027 figures of a payout from its balance transactions (pure). */
export function payoutFigures(
  payout: StripePayoutFacts,
  txns: readonly StripeBalanceTransaction[],
): { amount: Decimal; gross: Decimal; fee: Decimal; feeGst: Decimal } {
  if (payout.currency.toLowerCase() !== 'aud') {
    throw new StripePayoutError(
      'UNSUPPORTED_CURRENCY',
      `payout ${payout.id} is in ${payout.currency}; GP-027 covers AUD only`,
    );
  }
  let gross = new Decimal(0);
  let fee = new Decimal(0);
  let feeGst = new Decimal(0);
  let net = new Decimal(0);
  for (const t of txns) {
    if (t.type === 'payout') continue;
    if (t.currency.toLowerCase() !== 'aud') {
      throw new StripePayoutError(
        'UNSUPPORTED_CURRENCY',
        `balance transaction ${t.id} is in ${t.currency}`,
      );
    }
    let detailTotal = new Decimal(0);
    for (const d of t.fee_details) {
      const amt = cents(d.amount);
      detailTotal = detailTotal.plus(amt);
      if (d.type === 'tax') feeGst = feeGst.plus(amt);
      else if (FEE_TYPES.has(d.type)) fee = fee.plus(amt);
      else {
        throw new StripePayoutError(
          'UNSUPPORTED_FEE',
          `balance transaction ${t.id} has a ${d.type} fee; no golden posting covers it`,
        );
      }
    }
    if (!detailTotal.eq(cents(t.fee)) || !cents(t.amount).minus(cents(t.fee)).eq(cents(t.net))) {
      throw new StripePayoutError(
        'INVALID_PAYOUT',
        `balance transaction ${t.id}: amount − fee ≠ net or fee ≠ Σ fee_details`,
      );
    }
    gross = gross.plus(cents(t.amount));
    net = net.plus(cents(t.net));
  }
  const amount = cents(payout.amountCents);
  if (!amount.gt(0) || !net.eq(amount)) {
    throw new StripePayoutError(
      'UNBALANCED',
      `payout ${payout.id} is ${two(amount)} but its balance transactions net ${two(net)}`,
    );
  }
  return { amount, gross, fee, feeGst };
}

/** Post one Stripe payout as GP-027 (idempotent on the payout id). */
export async function processStripePayout(
  trx: Trx,
  c: {
    companyId: string;
    payout: StripePayoutFacts;
    balanceTransactions: readonly StripeBalanceTransaction[];
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<{ entryId: string; replayed: boolean }> {
  const companyId = c.companyId.toLowerCase();
  const { payout } = c;
  if (!/^po_[A-Za-z0-9]{8,64}$/.test(payout.id)) {
    throw new StripePayoutError('INVALID_PAYOUT', `not a Stripe payout id: ${payout.id}`);
  }
  const done = await trx
    .selectFrom('app.stripe_payout')
    .select('entry_id')
    .where('company_id', '=', companyId)
    .where('stripe_payout_id', '=', payout.id)
    .executeTakeFirst();
  if (done) return { entryId: done.entry_id, replayed: true };

  const { amount, gross, fee, feeGst } = payoutFigures(payout, c.balanceTransactions);
  const s = await trx
    .selectFrom('app.stripe_settings')
    .select(['clearing_account_id', 'fee_account_id', 'payout_account_id', 'stripe_party_id'])
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (!s?.fee_account_id || !s.payout_account_id || !s.stripe_party_id) {
    throw new StripePayoutError(
      'NOT_CONFIGURED',
      'Stripe settings need the fees account, the payout bank account and the Stripe party before payouts post',
    );
  }
  const gst = feeGst.gt(0)
    ? (
        await sql<{ id: string }>`
          SELECT id::text FROM app.tax_code
           WHERE company_id = ${companyId} AND status = 'active' AND code = 'GST'
             AND effective_from <= ${payout.arrivalDate}::date
             AND (effective_to IS NULL OR effective_to >= ${payout.arrivalDate}::date)`.execute(trx)
      ).rows[0]?.id
    : undefined;
  if (feeGst.gt(0) && !gst) {
    throw new StripePayoutError(
      'NOT_CONFIGURED',
      `no GST tax code in force on ${payout.arrivalDate}`,
    );
  }

  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `stripe-payout:${payout.id}`,
      entryDate: payout.arrivalDate,
      sourceType: 'payments_stripe_payout',
      memo: `Stripe payout ${payout.id}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        { account: { id: s.payout_account_id }, debit: two(amount) },
        ...(fee.gt(0)
          ? [
              {
                account: { id: s.fee_account_id },
                debit: two(fee),
                partyId: s.stripe_party_id,
                ...(gst ? { taxCodeId: gst, taxAmount: two(feeGst) } : {}),
              },
            ]
          : []),
        ...(feeGst.gt(0) ? [{ account: { role: 'GST_PAID' }, debit: two(feeGst) }] : []),
        { account: { id: s.clearing_account_id }, credit: two(gross) },
      ],
    },
    opts,
  );
  await trx
    .insertInto('app.stripe_payout')
    .values({
      company_id: companyId,
      stripe_payout_id: payout.id,
      arrival_date: payout.arrivalDate,
      currency: payout.currency.toUpperCase(),
      amount: amount.toFixed(4),
      gross: gross.toFixed(4),
      fee: fee.toFixed(4),
      fee_gst: feeGst.toFixed(4),
      entry_id: posted.entryId,
    })
    .execute();
  return { entryId: posted.entryId, replayed: false };
}
