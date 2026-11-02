/**
 * Supplier payment batches: build and release (T-0054, UC-06 steps 1–2, design §6.5 rule 1,
 * DL-0281). Nothing is posted here: the payments post (GP-009) on bank confirmation
 * (payment-confirmation.ts, T-0057, DL-0285); the ABA file is T-0056.
 *
 * createPaymentBatch takes every posted bill of the company due on or before `dueBy` with an open
 * AP amount that no live batch already pays, and makes one payment per bill at its open amount
 * to the supplier's verified active bank account. A supplier whose bank details are cooling off
 * (or missing) is excluded with the reason (app.party_payment_eligibility, T-0053) — the bill
 * stays due for a later batch. releasePaymentBatch records a release; the batch is released once
 * it has the required releases: two when its total is above the tenant's batch_two_releasers
 * threshold, else one. Creator ≠ releaser, distinct releasers and step-up are enforced by the
 * API (SoD engine, @RequireStepUp). Money is decimal strings; no floating point.
 */
import type { Database } from '@ledgerforce/db';
import { nextNumber } from '@ledgerforce/ledger';
import { paymentEligibility } from '@ledgerforce/parties';
import { Money } from '@ledgerforce/shared/money';
import { DEFAULT_SOD_SETTINGS } from '@ledgerforce/shared/sod';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const PAYMENT_BATCH_NUMBER_SERIES = 'ap_payment_batch_document';

export type PaymentBatchErrorCode =
  'INVALID_BATCH' | 'NOTHING_DUE' | 'NOT_RELEASABLE' | 'NOT_CONFIRMABLE' | 'NOT_CONFIRMED';

export class PaymentBatchError extends Error {
  readonly code: PaymentBatchErrorCode;
  constructor(code: PaymentBatchErrorCode, message: string) {
    super(message);
    this.name = 'PaymentBatchError';
    this.code = code;
  }
}

export type ExclusionReason = 'BANK_DETAILS_COOLING_OFF' | 'NO_VERIFIED_BANK_DETAILS';

export interface PaymentBatchView {
  readonly batchId: string;
  readonly batchNo: string;
  readonly status: 'draft' | 'partially_released' | 'released' | 'cancelled';
  readonly paymentDate: string;
  readonly accountId: string;
  readonly total: string;
  readonly paymentCount: number;
  readonly releasesRequired: 1 | 2;
  readonly releases: readonly { releasedBy: string | null; releasedAt: Date }[];
  readonly payments: readonly {
    billId: string;
    partyId: string;
    amount: string;
    bankAccountId: string;
  }[];
  readonly excluded: readonly {
    billId: string;
    partyId: string;
    amount: string;
    reason: ExclusionReason;
    payableFrom: Date | null;
  }[];
  readonly createdBy: string | null;
  /** The bank's confirmation and its GP-009 entry (T-0057); null until confirmed. */
  readonly confirmation: {
    readonly entryId: string;
    readonly confirmedOn: string;
    readonly bankReference: string | null;
    readonly confirmedBy: string | null;
    readonly confirmedAt: Date;
  } | null;
  readonly replayed: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

/** The tenant's two-releaser threshold (latest SoD settings row, else the placeholder default). */
async function twoReleaserThreshold(trx: Trx): Promise<string> {
  const r = await sql<{ t: string }>`
    SELECT batch_two_releasers_threshold::text AS t FROM app.sod_settings
     ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  return r.rows[0]?.t ?? DEFAULT_SOD_SETTINGS.thresholds.batch_two_releasers;
}

/** One batch of the company with its payments, exclusions and releases. */
export async function getPaymentBatch(
  trx: Trx,
  companyId: string,
  batchId: string,
  replayed = false,
): Promise<PaymentBatchView> {
  const cid = companyId.toLowerCase();
  const b = await trx
    .selectFrom('app.payment_batch')
    .select([
      'id',
      'batch_no',
      'status',
      'account_id',
      'total',
      'payment_count',
      'created_by',
      sql<string>`to_char(payment_date, 'YYYY-MM-DD')`.as('payment_date'),
    ])
    .where('company_id', '=', cid)
    .where('id', '=', batchId.toLowerCase())
    .executeTakeFirst();
  if (!b)
    throw new PaymentBatchError(
      'INVALID_BATCH',
      `payment batch ${batchId} is not in company ${cid}`,
    );
  const items = await trx
    .selectFrom('app.payment_batch_item')
    .select(['bill_id', 'party_id', 'amount', 'bank_account_id', 'excluded_reason', 'payable_from'])
    .where('batch_id', '=', b.id)
    .orderBy('line_no')
    .execute();
  const releases = await trx
    .selectFrom('app.payment_batch_release')
    .select(['released_by', 'released_at'])
    .where('batch_id', '=', b.id)
    .orderBy('released_at')
    .orderBy('id')
    .execute();
  const confirmation = await trx
    .selectFrom('app.payment_batch_confirmation')
    .select([
      'entry_id',
      'bank_reference',
      'confirmed_by',
      'confirmed_at',
      sql<string>`to_char(confirmed_on, 'YYYY-MM-DD')`.as('confirmed_on'),
    ])
    .where('batch_id', '=', b.id)
    .executeTakeFirst();
  const threshold = await twoReleaserThreshold(trx);
  return {
    batchId: b.id,
    batchNo: b.batch_no,
    status: b.status,
    paymentDate: b.payment_date,
    accountId: b.account_id,
    total: numeric(b.total),
    paymentCount: b.payment_count,
    releasesRequired: new Decimal(b.total).gt(threshold) ? 2 : 1,
    releases: releases.map((r) => ({ releasedBy: r.released_by, releasedAt: r.released_at })),
    payments: items.flatMap((i) =>
      i.bank_account_id !== null && i.excluded_reason === null
        ? [
            {
              billId: i.bill_id,
              partyId: i.party_id,
              amount: numeric(i.amount),
              bankAccountId: i.bank_account_id,
            },
          ]
        : [],
    ),
    excluded: items.flatMap((i) =>
      i.excluded_reason !== null
        ? [
            {
              billId: i.bill_id,
              partyId: i.party_id,
              amount: numeric(i.amount),
              reason: i.excluded_reason,
              payableFrom: i.payable_from,
            },
          ]
        : [],
    ),
    createdBy: b.created_by,
    confirmation: confirmation
      ? {
          entryId: confirmation.entry_id,
          confirmedOn: confirmation.confirmed_on,
          bankReference: confirmation.bank_reference,
          confirmedBy: confirmation.confirmed_by,
          confirmedAt: confirmation.confirmed_at,
        }
      : null,
    replayed,
  };
}

/** Build a payment batch from the bills due on or before `dueBy` (one transaction). */
export async function createPaymentBatch(
  trx: Trx,
  c: {
    companyId: string;
    /** Client-chosen uuid: the SoD subject; a replay returns the stored batch. */
    id: string;
    paymentDate: string;
    dueBy: string;
    /** The operating bank account the payments leave from (GL account, subtype bank). */
    accountId: string;
    createdBy?: string;
  },
): Promise<PaymentBatchView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.id)) throw new PaymentBatchError('INVALID_BATCH', 'the batch id is a uuid');
  const id = c.id.toLowerCase();
  // One batch build at a time per company, so a bill cannot land in two live batches.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`ap-payment-batch:${companyId}`}))`.execute(
    trx,
  );
  const existing = await trx
    .selectFrom('app.payment_batch')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (existing) return getPaymentBatch(trx, companyId, id, true);
  if (!DATE_RE.test(c.paymentDate) || !DATE_RE.test(c.dueBy)) {
    throw new PaymentBatchError('INVALID_BATCH', 'payment date and due-by date are YYYY-MM-DD');
  }
  const bank = await trx
    .selectFrom('app.account')
    .select(['subtype', 'status', 'postable'])
    .where('company_id', '=', companyId)
    .where('id', '=', c.accountId)
    .executeTakeFirst();
  if (!bank || bank.subtype !== 'bank' || bank.status !== 'active' || !bank.postable) {
    throw new PaymentBatchError('INVALID_BATCH', 'pay from an active postable bank account');
  }
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();

  const due = (
    await sql<{ bill_id: string; party_id: string; open: string }>`
      SELECT b.id::text AS bill_id, b.party_id::text AS party_id, abs(s.open_amount)::text AS open
        FROM app.supplier_bill b
        JOIN app.subledger_entry s ON s.tenant_id = b.tenant_id AND s.entry_id = b.entry_id
                                  AND s.control_role = 'AP_CONTROL'
       WHERE b.company_id = ${companyId} AND b.status = 'posted'
         AND b.due_date <= ${c.dueBy}::date AND s.open_amount <> 0
         AND NOT EXISTS (
           SELECT 1 FROM app.payment_batch_item i
             JOIN app.payment_batch pb ON pb.tenant_id = i.tenant_id AND pb.id = i.batch_id
            WHERE i.tenant_id = b.tenant_id AND i.bill_id = b.id
              AND i.excluded_reason IS NULL AND pb.status <> 'cancelled')
       ORDER BY b.due_date, b.bill_no`.execute(trx)
  ).rows;
  const eligibility = new Map(
    (await paymentEligibility(trx, [...new Set(due.map((d) => d.party_id))])).map((e) => [
      e.partyId,
      e,
    ]),
  );
  const payable = due.filter((d) => eligibility.get(d.party_id)?.eligible === true);
  if (payable.length === 0) {
    throw new PaymentBatchError(
      'NOTHING_DUE',
      `no bill due by ${c.dueBy} can be paid now (${String(due.length)} due, all excluded or already in a batch)`,
    );
  }
  const total = payable.reduce((s, d) => s.plus(d.open), new Decimal(0));
  const batchNo = await nextNumber(trx, companyId, PAYMENT_BATCH_NUMBER_SERIES);
  await trx
    .insertInto('app.payment_batch')
    .values({
      id,
      company_id: companyId,
      batch_no: batchNo,
      payment_date: c.paymentDate,
      due_by: c.dueBy,
      account_id: c.accountId,
      currency: company.base_currency,
      total: numeric(total),
      payment_count: payable.length,
      created_by: c.createdBy ?? null,
    })
    .execute();
  // Payments first, then exclusions, each in due order.
  const ordered = [...payable, ...due.filter((d) => !payable.includes(d))];
  await trx
    .insertInto('app.payment_batch_item')
    .values(
      ordered.map((d, i) => {
        const e = eligibility.get(d.party_id);
        const ok = e?.eligible === true;
        return {
          company_id: companyId,
          batch_id: id,
          line_no: i + 1,
          bill_id: d.bill_id,
          party_id: d.party_id,
          amount: numeric(d.open),
          bank_account_id: ok ? (e.bankAccountId ?? null) : null,
          excluded_reason: ok ? null : (e?.reason ?? 'NO_VERIFIED_BANK_DETAILS'),
          payable_from: ok ? null : (e?.payableFrom ?? null),
        };
      }),
    )
    .execute();
  return getPaymentBatch(trx, companyId, id);
}

/** Record a release; the batch is released once it has the releases its total requires. */
export async function releasePaymentBatch(
  trx: Trx,
  c: { companyId: string; batchId: string; releasedBy?: string },
): Promise<PaymentBatchView> {
  const companyId = c.companyId.toLowerCase();
  const batchId = c.batchId.toLowerCase();
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`ap-payment-batch-release:${batchId}`}))`.execute(
    trx,
  );
  const before = await getPaymentBatch(trx, companyId, batchId);
  if (before.status !== 'draft' && before.status !== 'partially_released') {
    throw new PaymentBatchError(
      'NOT_RELEASABLE',
      `payment batch ${before.batchNo} is ${before.status}; only draft or partially released batches can be released`,
    );
  }
  await trx
    .insertInto('app.payment_batch_release')
    .values({ company_id: companyId, batch_id: batchId, released_by: c.releasedBy ?? null })
    .execute();
  const status =
    before.releases.length + 1 >= before.releasesRequired ? 'released' : 'partially_released';
  if (status !== before.status) {
    await trx
      .updateTable('app.payment_batch')
      .set({ status, updated_at: sql`clock_timestamp()` })
      .where('company_id', '=', companyId)
      .where('id', '=', batchId)
      .execute();
  }
  return getPaymentBatch(trx, companyId, batchId);
}
