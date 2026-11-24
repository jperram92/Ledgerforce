/**
 * Single-supply receipt reversal (T-0231: T-0204 AC-3 and AC-9; ADR-0089 R8, R11; RQ-0192;
 * GP-019 and postings.md Q11; migration 0084; DL-0980..DL-0984).
 *
 * reverseSingleSupplyReceipt — reverses a receipt on an open contract (GP-040a, GP-040b or a
 * cash-basis GP-020 receipt) by the posting engine's reversal: a new entry mirroring every line of
 * the receipt entry (GP-019), dated on the reversal date (never back-dated), the original marked
 * `reversed`. Every balance, incl. the contract's CUSTOMER_PREPAYMENTS and GST_ATTRIBUTED_UNBILLED
 * balances and the GST collected, returns to what it was before the receipt (INV-reversal).
 *
 * Receipts are reversed last in, first out (NOT_LATEST_RECEIPT otherwise): later receipts clear
 * the attribution made by the first. Reversing the attributing receipt (GP-040a) returns the
 * contract to nothing attributed; the next receipt attributes the whole GST again (GP-040a,
 * recorded in app.single_supply_attribution_renewal by recordSingleSupplyReceipt).
 *
 * The reversal record keeps the BAS treatment for BAS preparation (T-0218, review MINOR-4):
 * `error_correction` when the reversal date is after the end of the receipt's BAS period, else
 * `same_period`. The period is set by the BAS frequency in force on the receipt date: the calendar
 * month, the calendar quarter, or the financial year 1 July – 30 June (basPeriodOf).
 *
 * Refused with nothing written: an unknown receipt (UNKNOWN_RECEIPT); a finalised contract
 * (REVERSAL_AFTER_FINALISATION — the receipts are part of the final invoice; issue a credit note,
 * Q11); a cancelled contract (REVERSAL_AFTER_CANCELLATION — the cancellation already adjusted the
 * GST); a receipt already reversed (ALREADY_REVERSED); not the latest (NOT_LATEST_RECEIPT); a date
 * that is not a calendar date or is before the receipt, a reason not 1–500 characters
 * (INVALID_SINGLE_SUPPLY); a basis in force on the reversal date that differs from the contract's
 * (BASIS_CHANGED, ADR-0089 R8). The engine's own refusals (locked period) apply. The same
 * idempotency key returns the same reversal.
 */
import type { Database } from '@ledgerforce/db';
import { reverse, type PostOptions } from '@ledgerforce/ledger';
import { taxSettingsOf, type BasFrequency } from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import {
  SingleSupplyError,
  singleSupplyContract,
  type SingleSupplyErrorCode,
} from './single-supply.ts';

type Trx = Transaction<Database>;

export type ReceiptReversalErrorCode =
  | SingleSupplyErrorCode
  | 'UNKNOWN_RECEIPT'
  | 'REVERSAL_AFTER_FINALISATION'
  | 'REVERSAL_AFTER_CANCELLATION'
  | 'ALREADY_REVERSED'
  | 'NOT_LATEST_RECEIPT';

const fail = (code: ReceiptReversalErrorCode, message: string): never => {
  throw new SingleSupplyError(code as SingleSupplyErrorCode, message);
};

export type BasTreatment = 'same_period' | 'error_correction';

export interface ReceiptReversalView {
  readonly reversalId: string;
  readonly receiptId: string;
  readonly contractId: string;
  /** The receipt's entry (now `reversed`). */
  readonly reversedEntryId: string;
  /** The engine reversal entry (source ledger_reversal). */
  readonly entryId: string;
  readonly replayed: boolean;
  readonly receiptDate: string;
  readonly reversalDate: string;
  readonly reason: string;
  /** True when the reversed receipt attributed the contract's whole GST (GP-040a). */
  readonly unattributes: boolean;
  readonly basTreatment: BasTreatment;
  /** The receipt's BAS period (frequency in force on the receipt date). */
  readonly basPeriodStart: string;
  readonly basPeriodEnd: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDate = (d: string) => {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Last day of month m (1–12) of year y. */
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The BAS period containing `date` for a reporting frequency: the calendar month; the calendar
 * quarter (ATO quarters end 30 Sep, 31 Dec, 31 Mar, 30 Jun); or the Australian financial year
 * 1 July – 30 June.
 */
export function basPeriodOf(date: string, frequency: BasFrequency): { start: string; end: string } {
  // Calendar arithmetic on a date (not money): year and month of the UTC calendar date.
  const day = new Date(`${date}T00:00:00Z`);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  if (frequency === 'monthly') return { start: iso(y, m, 1), end: iso(y, m, lastDay(y, m)) };
  if (frequency === 'quarterly') {
    const first = Math.floor((m - 1) / 3) * 3 + 1;
    return { start: iso(y, first, 1), end: iso(y, first + 2, lastDay(y, first + 2)) };
  }
  const startYear = m >= 7 ? y : y - 1;
  return { start: iso(startYear, 7, 1), end: iso(startYear + 1, 6, 30) };
}

async function lockContract(trx: Trx, contractId: string): Promise<void> {
  // Same key as receipts, the final invoice and the cancellation: contract documents serialise.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lf.single-supply:' + contractId}, 0))`.execute(
    trx,
  );
}

interface ReceiptRow {
  id: string;
  contract_id: string;
  entry_id: string;
  receipt_date: string;
  reversed: boolean;
}

async function receiptOf(trx: Trx, companyId: string, receiptId: string): Promise<ReceiptRow> {
  if (!UUID_RE.test(receiptId)) return fail('UNKNOWN_RECEIPT', `receipt ${receiptId} not found`);
  const r = (
    await sql<ReceiptRow>`
      SELECT r.id::text, r.contract_id::text, r.entry_id::text,
             to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date,
             EXISTS (SELECT 1 FROM app.single_supply_receipt_reversal v
                      WHERE v.tenant_id = r.tenant_id AND v.receipt_id = r.id) AS reversed
        FROM app.single_supply_receipt r
       WHERE r.company_id = ${companyId}::uuid AND r.id = ${receiptId}::uuid`.execute(trx)
  ).rows[0];
  return r ?? fail('UNKNOWN_RECEIPT', `receipt ${receiptId} is not in company ${companyId}`);
}

export async function reverseSingleSupplyReceipt(
  trx: Trx,
  c: {
    companyId: string;
    receiptId: string;
    /** YYYY-MM-DD: the reversal's own date, on or after the receipt. */
    reversalDate: string;
    /** 1–500 characters: why the receipt is reversed (error, dishonour). */
    reason: string;
    idempotencyKey: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<ReceiptReversalView> {
  const companyId = c.companyId.toLowerCase();
  const first = await receiptOf(trx, companyId, c.receiptId.toLowerCase());
  await lockContract(trx, first.contract_id);
  const existing = await trx
    .selectFrom('app.single_supply_receipt_reversal')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return reversalOf(trx, companyId, existing.id, true);

  // Re-read under the contract lock.
  const receipt = await receiptOf(trx, companyId, first.id);
  const k = await singleSupplyContract(trx, companyId, receipt.contract_id);
  if (k.status === 'finalised') {
    fail(
      'REVERSAL_AFTER_FINALISATION',
      `contract ${k.reference} is finalised: its receipts are part of the final invoice; issue a credit note instead (postings.md Q11)`,
    );
  }
  if (k.status === 'cancelled') {
    fail(
      'REVERSAL_AFTER_CANCELLATION',
      `contract ${k.reference} is cancelled: the cancellation already adjusted the GST on its receipts`,
    );
  }
  if (receipt.reversed) fail('ALREADY_REVERSED', `receipt ${receipt.id} is already reversed`);
  const later = (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM app.single_supply_receipt r
       WHERE r.company_id = ${companyId}::uuid AND r.contract_id = ${receipt.contract_id}::uuid
         AND (r.created_at, r.id) > (SELECT x.created_at, x.id FROM app.single_supply_receipt x
                                      WHERE x.id = ${receipt.id}::uuid)
         AND NOT EXISTS (SELECT 1 FROM app.single_supply_receipt_reversal v
                          WHERE v.tenant_id = r.tenant_id AND v.receipt_id = r.id)`.execute(trx)
  ).rows[0]?.n;
  if (later) {
    fail(
      'NOT_LATEST_RECEIPT',
      `contract ${k.reference} has ${String(later)} later receipt(s) not reversed: reverse the latest first (later receipts clear the attribution of the first)`,
    );
  }
  if (!isDate(c.reversalDate) || c.reversalDate < receipt.receipt_date) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      `the reversal date is a YYYY-MM-DD date on or after the receipt (${receipt.receipt_date})`,
    );
  }
  const reason = c.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    fail('INVALID_SINGLE_SUPPLY', 'the reason for the reversal is 1–500 characters');
  }
  const settings = await taxSettingsOf(trx, companyId, c.reversalDate);
  if (settings?.gstBasis !== k.gstBasis) {
    fail(
      'BASIS_CHANGED',
      `contract ${k.reference} is on the ${k.gstBasis} basis; the basis in force on ${c.reversalDate} is ${String(settings?.gstBasis)}`,
    );
  }
  const atReceipt = await taxSettingsOf(trx, companyId, receipt.receipt_date);
  if (!atReceipt) {
    return fail('INVALID_SINGLE_SUPPLY', `no BAS frequency is in force on ${receipt.receipt_date}`);
  }
  const period = basPeriodOf(receipt.receipt_date, atReceipt.basFrequency);
  const treatment: BasTreatment = c.reversalDate > period.end ? 'error_correction' : 'same_period';
  const unattributes = (
    await sql<{ a: boolean }>`
      SELECT EXISTS (SELECT 1 FROM app.single_supply_attribution a
                      WHERE a.company_id = ${companyId}::uuid AND a.entry_id = ${receipt.entry_id}::uuid)
          OR EXISTS (SELECT 1 FROM app.single_supply_attribution_renewal n
                      WHERE n.company_id = ${companyId}::uuid AND n.entry_id = ${receipt.entry_id}::uuid) AS a`.execute(
      trx,
    )
  ).rows[0]?.a;

  const reversed = await reverse(
    trx,
    {
      companyId,
      entryId: receipt.entry_id,
      idempotencyKey: `ar-single-supply-receipt-reversal:${c.idempotencyKey}`,
      entryDate: c.reversalDate,
      memo: `Reversal of single-supply receipt — ${k.reference}${treatment === 'error_correction' ? ' (error correction of an earlier BAS period)' : ''}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
    },
    opts,
  );
  const row = await trx
    .insertInto('app.single_supply_receipt_reversal')
    .values({
      company_id: companyId,
      contract_id: receipt.contract_id,
      receipt_id: receipt.id,
      reversal_date: c.reversalDate,
      reason,
      reversed_entry_id: receipt.entry_id,
      entry_id: reversed.entryId,
      unattributes: unattributes === true,
      bas_treatment: treatment,
      bas_period_start: period.start,
      bas_period_end: period.end,
      idempotency_key: c.idempotencyKey,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return reversalOf(trx, companyId, row.id, false);
}

async function reversalOf(
  trx: Trx,
  companyId: string,
  id: string,
  replayed: boolean,
): Promise<ReceiptReversalView> {
  const r = (
    await sql<{
      id: string;
      receipt_id: string;
      contract_id: string;
      reversed_entry_id: string;
      entry_id: string;
      receipt_date: string;
      reversal_date: string;
      reason: string;
      unattributes: boolean;
      bas_treatment: BasTreatment;
      bas_period_start: string;
      bas_period_end: string;
    }>`
      SELECT v.id::text, v.receipt_id::text, v.contract_id::text, v.reversed_entry_id::text,
             v.entry_id::text, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date,
             to_char(v.reversal_date, 'YYYY-MM-DD') AS reversal_date, v.reason, v.unattributes,
             v.bas_treatment, to_char(v.bas_period_start, 'YYYY-MM-DD') AS bas_period_start,
             to_char(v.bas_period_end, 'YYYY-MM-DD') AS bas_period_end
        FROM app.single_supply_receipt_reversal v
        JOIN app.single_supply_receipt r ON r.tenant_id = v.tenant_id AND r.id = v.receipt_id
       WHERE v.company_id = ${companyId}::uuid AND v.id = ${id}::uuid`.execute(trx)
  ).rows[0];
  if (!r) return fail('UNKNOWN_RECEIPT', `reversal ${id} not found`);
  return {
    reversalId: r.id,
    receiptId: r.receipt_id,
    contractId: r.contract_id,
    reversedEntryId: r.reversed_entry_id,
    entryId: r.entry_id,
    replayed,
    receiptDate: r.receipt_date,
    reversalDate: r.reversal_date,
    reason: r.reason,
    unattributes: r.unattributes,
    basTreatment: r.bas_treatment,
    basPeriodStart: r.bas_period_start,
    basPeriodEnd: r.bas_period_end,
  };
}
