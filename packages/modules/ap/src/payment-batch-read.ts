/**
 * Reading payment batches for the release screen (T-0153, for T-0087; UC-06, design §6.5, §6.6):
 * the company's batches with their counts, and the names a batch view shows instead of ids —
 * supplier, bill number, creator, releasers — with each payee account masked to its last 3
 * characters. Read-only; the caller's RLS scopes every query to its tenant.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { twoReleaserThreshold, type PaymentBatchView } from './payment-batches.ts';

type Trx = Transaction<Database>;

export interface PaymentBatchListRow {
  readonly batchId: string;
  readonly batchNo: string;
  readonly status: PaymentBatchView['status'];
  readonly paymentDate: string;
  readonly total: string;
  readonly paymentCount: number;
  readonly excludedCount: number;
  readonly releasesRequired: 1 | 2;
  readonly releaseCount: number;
  readonly createdByName: string | null;
  readonly createdAt: Date;
}

/** The company's payment batches, newest first (at most 200). */
export async function listPaymentBatches(
  trx: Trx,
  companyId: string,
): Promise<PaymentBatchListRow[]> {
  const r = await sql<{
    id: string;
    batch_no: string;
    status: PaymentBatchView['status'];
    payment_date: string;
    total: string;
    payment_count: number;
    excluded_count: number;
    release_count: number;
    created_by_name: string | null;
    created_at: Date;
  }>`
    SELECT b.id, b.batch_no, b.status, to_char(b.payment_date, 'YYYY-MM-DD') AS payment_date,
           b.total::text AS total, b.payment_count, b.created_at, u.display_name AS created_by_name,
           ((SELECT count(*) FROM app.payment_batch_item i
              WHERE i.batch_id = b.id AND i.excluded_reason IS NOT NULL)
          + (SELECT count(*) FROM app.payment_batch_refund i
              WHERE i.batch_id = b.id AND i.excluded_reason IS NOT NULL))::int AS excluded_count,
           (SELECT count(*) FROM app.payment_batch_release x WHERE x.batch_id = b.id)::int
             AS release_count
      FROM app.payment_batch b
      LEFT JOIN app.app_user u ON u.tenant_id = b.tenant_id AND u.id = b.created_by
     WHERE b.company_id = ${companyId.toLowerCase()}::uuid
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 200`.execute(trx);
  const threshold = await twoReleaserThreshold(trx);
  return r.rows.map((b) => ({
    batchId: b.id,
    batchNo: b.batch_no,
    status: b.status,
    paymentDate: b.payment_date,
    total: Money.of(b.total, 'XXX').toNumericString(),
    paymentCount: b.payment_count,
    excludedCount: b.excluded_count,
    releasesRequired: new Decimal(b.total).gt(threshold) ? 2 : 1,
    releaseCount: b.release_count,
    createdByName: b.created_by_name,
    createdAt: new Date(b.created_at),
  }));
}

export interface PaymentBatchNames {
  readonly parties: ReadonlyMap<string, string>;
  readonly bills: ReadonlyMap<string, string | null>;
  /** Payee accounts, masked: `***` and the last 3 characters (design §6.6). */
  readonly accounts: ReadonlyMap<string, { bsb: string; accountNumber: string }>;
  readonly users: ReadonlyMap<string, string>;
}

const unique = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))];

/** The names of the parties, bills, accounts and people a batch view refers to. */
export async function paymentBatchNames(trx: Trx, b: PaymentBatchView): Promise<PaymentBatchNames> {
  const partyIds = unique([
    ...b.payments.map((x) => x.partyId),
    ...b.excluded.map((x) => x.partyId),
    ...b.refunds.map((x) => x.partyId),
    ...b.excludedRefunds.map((x) => x.partyId),
  ]);
  const billIds = unique([...b.payments.map((x) => x.billId), ...b.excluded.map((x) => x.billId)]);
  const accountIds = unique([
    ...b.payments.map((x) => x.bankAccountId),
    ...b.refunds.map((x) => x.bankAccountId),
  ]);
  const userIds = unique([b.createdBy, ...b.releases.map((x) => x.releasedBy)]);
  const parties = partyIds.length
    ? await trx
        .selectFrom('app.party')
        .select(['id', 'legal_name'])
        .where('id', 'in', partyIds)
        .execute()
    : [];
  const bills = billIds.length
    ? await trx
        .selectFrom('app.supplier_bill')
        .select(['id', 'bill_no'])
        .where('id', 'in', billIds)
        .execute()
    : [];
  const accounts = accountIds.length
    ? await trx
        .selectFrom('app.party_bank_account')
        .select(['id', 'bsb', 'account_number_last3'])
        .where('id', 'in', accountIds)
        .execute()
    : [];
  const users = userIds.length
    ? await trx
        .selectFrom('app.app_user')
        .select(['id', 'display_name'])
        .where('id', 'in', userIds)
        .execute()
    : [];
  return {
    parties: new Map(parties.map((x) => [x.id, x.legal_name])),
    bills: new Map(bills.map((x) => [x.id, x.bill_no])),
    accounts: new Map(
      accounts.map((x) => [x.id, { bsb: x.bsb, accountNumber: `***${x.account_number_last3}` }]),
    ),
    users: new Map(users.map((x) => [x.id, x.display_name])),
  };
}
