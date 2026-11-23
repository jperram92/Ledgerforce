/**
 * Single-supply cancellation and contract refund (T-0217; ADR-0089 R7 + addendum A; RQ-0184;
 * goldens GP-044a–d; migration 0082; DL-0900..DL-0905).
 *
 * cancelSingleSupply — cancels an open contract on a date the user states, with the refund
 * decision (`agreed` | `undecided`; `forfeited` is refused FORFEITURE_NOT_SUPPORTED) and a reason.
 * With N the known net, T the attributed GST, Rn/Rt/Rg the net/GST/gross received and U the
 * contract's unbilled GST balance (T − Rt):
 *  - accruals, refund agreed (GP-044a, source ar_credit_note): Dr CUSTOMER_PREPAYMENTS coded N
 *    (tax T) / Dr GST collected T / Cr CUSTOMER_PREPAYMENTS uncoded (N − Rn) / Cr
 *    GST_ATTRIBUTED_UNBILLED U (its actual balance) / Cr AR_CONTROL Rg (refund owed: a customer
 *    credit, refunded by the customer refund path, GP-044b = GP-006, ADR-0074).
 *  - accruals, refund undecided (GP-044c): Dr CUSTOMER_PREPAYMENTS coded (N − Rn) (tax U) / Dr
 *    GST collected U / Cr CUSTOMER_PREPAYMENTS uncoded (N − Rn) / Cr GST_ATTRIBUTED_UNBILLED U; no
 *    entry when nothing is unbilled (fully received). The money stays on CUSTOMER_PREPAYMENTS.
 *  - cash basis, or accruals with no receipt: no entry (GP-044 "Cash basis" note; nothing was
 *    attributed beyond the cash).
 * The contract becomes cancelled. A posted decrease returns adjustment-note particulars (AC-10),
 * also when its GST is within the $75 threshold (s 29-80).
 *
 * refundCancelledSingleSupply — GP-044d (source ar_refund): the whole cash held on a cancelled
 * contract (undecided accruals or cash basis) refunded on the date it is agreed: Dr
 * CUSTOMER_PREPAYMENTS coded Rn (tax Rt) / Dr GST collected Rt / Cr bank Rg, with its own
 * adjustment note. Maker-checker (ADR-0074): `approvedBy` must differ from `createdBy`
 * (SOD_REFUND_SELF_APPROVAL; the database CHECK refuses it too).
 *
 * Refused with nothing written: forfeiture; an unknown decision; a reason not 1–500 characters;
 * dates before the contract, its last receipt or the cancellation; a basis in force that differs
 * from the contract's (BASIS_CHANGED); a contract that is not open (cancel) or not cancelled
 * (refund); an agreed accruals cancellation's refund (REFUND_VIA_CUSTOMER_REFUND); nothing
 * received (NOTHING_TO_REFUND); a second refund (ALREADY_REFUNDED). The same key replays.
 */
import type { Database } from '@ledgerforce/db';
import { post, type PostingLineInput, type PostOptions } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { taxSettingsOf } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import {
  SingleSupplyError,
  singleSupplyContract,
  type SingleSupplyContractView,
  type SingleSupplyErrorCode,
} from './single-supply.ts';
import type { FinalInvoiceAdjustmentNote } from './single-supply-final.ts';

type Trx = Transaction<Database>;

export type CancellationErrorCode =
  | SingleSupplyErrorCode
  | 'FORFEITURE_NOT_SUPPORTED'
  | 'CONTRACT_NOT_CANCELLED'
  | 'REFUND_VIA_CUSTOMER_REFUND'
  | 'NOTHING_TO_REFUND'
  | 'ALREADY_REFUNDED'
  | 'SOD_REFUND_SELF_APPROVAL';

const fail = (code: CancellationErrorCode, message: string): never => {
  throw new SingleSupplyError(code as SingleSupplyErrorCode, message);
};

export type RefundDecision = 'agreed' | 'undecided';

export interface CancellationView {
  readonly contractId: string;
  readonly replayed: boolean;
  readonly cancelDate: string;
  readonly refund: RefundDecision;
  readonly reason: string;
  /** The GP-044a/c entry; null when nothing is posted (cash basis, nothing attributed or unbilled). */
  readonly entryId: string | null;
  /** The AR credit (refund owed) created by GP-044a; 0 otherwise. */
  readonly customerCredit: string;
  readonly adjustmentNote: FinalInvoiceAdjustmentNote | null;
}

export interface ContractRefundView {
  readonly contractId: string;
  readonly replayed: boolean;
  readonly refundDate: string;
  readonly gross: string;
  readonly net: string;
  readonly tax: string;
  readonly entryId: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly approvedBy: string;
  readonly adjustmentNote: FinalInvoiceAdjustmentNote;
}

/** GST decrease at or under which an adjustment note is not required (s 29-80). */
const ADJUSTMENT_NOTE_THRESHOLD = new Decimal(75);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const isDate = (d: string) => {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const ZERO = new Decimal(0);

async function lockContract(trx: Trx, contractId: string): Promise<void> {
  // Same key as receipts and the final invoice: every contract document is serialised.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lf.single-supply:' + contractId}, 0))`.execute(
    trx,
  );
}

function reasonOf(raw: string): string {
  const reason = raw.trim();
  if (reason.length < 1 || reason.length > 500) {
    fail('INVALID_SINGLE_SUPPLY', 'the reason (the adjustment-note reason) is 1–500 characters');
  }
  return reason;
}

async function basisGuard(trx: Trx, companyId: string, k: SingleSupplyContractView, date: string) {
  const settings = await taxSettingsOf(trx, companyId, date);
  if (settings?.gstBasis !== k.gstBasis) {
    fail(
      'BASIS_CHANGED',
      `contract ${k.reference} is on the ${k.gstBasis} basis; the basis in force on ${date} is ${String(settings?.gstBasis)}`,
    );
  }
}

function note(
  k: SingleSupplyContractView,
  reason: string,
  net: Decimal,
  tax: Decimal,
): FinalInvoiceAdjustmentNote {
  return {
    title: 'Adjustment note',
    reason,
    decreaseNet: numeric(net),
    decreaseTax: numeric(tax),
    decreaseGross: numeric(net.plus(tax)),
    adjusts:
      k.attributionDate === null
        ? `GST on the receipts of ${k.reference}`
        : `GST attributed on ${k.reference} on ${k.attributionDate}`,
    withinThreshold: tax.lte(ADJUSTMENT_NOTE_THRESHOLD),
  };
}

const signed = (account: PostingLineInput['account'], amount: Decimal, extra = {}) =>
  amount.isZero()
    ? []
    : [
        {
          account,
          ...(amount.gt(0) ? { debit: numeric(amount) } : { credit: numeric(amount.neg()) }),
          ...extra,
        },
      ];

export async function cancelSingleSupply(
  trx: Trx,
  c: {
    companyId: string;
    contractId: string;
    /** YYYY-MM-DD: the date the parties cancelled (the adjustment event). */
    cancelDate: string;
    /** The refund decision on the cancellation date; `forfeited` is refused. */
    refund: RefundDecision | 'forfeited';
    /** 1–500 characters: the adjustment-note reason. */
    reason: string;
    idempotencyKey: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<CancellationView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.contractId)) fail('UNKNOWN_CONTRACT', `contract ${c.contractId} not found`);
  const contractId = c.contractId.toLowerCase();
  await lockContract(trx, contractId);
  const existing = await trx
    .selectFrom('app.single_supply_cancellation')
    .select('contract_id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return cancellationOf(trx, companyId, existing.contract_id, true);

  const k = await singleSupplyContract(trx, companyId, contractId);
  if (k.status !== 'open') fail('CONTRACT_NOT_OPEN', `contract ${k.reference} is ${k.status}`);
  if (c.refund === 'forfeited') {
    fail(
      'FORFEITURE_NOT_SUPPORTED',
      `retaining the money received on ${k.reference} is not supported until researched (ADR-0089 R7); state the refund agreed or undecided`,
    );
  }
  const decision: RefundDecision =
    c.refund === 'agreed' || c.refund === 'undecided'
      ? c.refund
      : fail('INVALID_SINGLE_SUPPLY', `unknown refund decision ${JSON.stringify(c.refund)}`);
  const reason = reasonOf(c.reason);
  if (!isDate(c.cancelDate)) fail('INVALID_SINGLE_SUPPLY', 'cancellation date is YYYY-MM-DD');
  const last = (
    await sql<{ d: string | null }>`
      SELECT to_char(max(receipt_date), 'YYYY-MM-DD') AS d FROM app.single_supply_receipt
       WHERE company_id = ${companyId}::uuid AND contract_id = ${contractId}::uuid`.execute(trx)
  ).rows[0]?.d;
  if (c.cancelDate < k.contractDate || (last && c.cancelDate < last)) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      `the cancellation is dated on or after the contract (${k.contractDate}) and its last receipt (${String(last)})`,
    );
  }
  await basisGuard(trx, companyId, k, c.cancelDate);

  const knownNet = new Decimal(k.knownNet);
  const receivedNet = new Decimal(k.receivedNet);
  const unbilled = new Decimal(k.unbilledTax);
  const onContract = { partyId: k.partyId, dimensions: [k.dimensionValueId] };
  const prepay = { role: 'CUSTOMER_PREPAYMENTS' };
  let lines: PostingLineInput[] = [];
  let decreaseNet = ZERO;
  let decreaseTax = ZERO;
  if (k.gstBasis === 'accrual' && k.attributedTax !== null) {
    const attributed = new Decimal(k.attributedTax);
    const notReceived = knownNet.minus(receivedNet);
    if (decision === 'agreed') {
      decreaseNet = knownNet;
      decreaseTax = attributed;
      lines = [
        {
          account: prepay,
          debit: numeric(knownNet),
          taxCodeId: k.taxCodeId,
          taxAmount: numeric(attributed),
          ...onContract,
        },
        ...signed({ role: 'GST_COLLECTED' }, attributed),
        ...signed(prepay, notReceived.neg(), onContract),
        ...signed({ role: 'GST_ATTRIBUTED_UNBILLED' }, unbilled.neg(), onContract),
        ...signed({ role: 'AR_CONTROL' }, new Decimal(k.receivedGross).neg(), {
          partyId: k.partyId,
        }),
      ];
    } else if (notReceived.gt(0)) {
      decreaseNet = notReceived;
      decreaseTax = unbilled;
      lines = [
        {
          account: prepay,
          debit: numeric(notReceived),
          taxCodeId: k.taxCodeId,
          taxAmount: numeric(unbilled),
          ...onContract,
        },
        ...signed({ role: 'GST_COLLECTED' }, unbilled),
        ...signed(prepay, notReceived.neg(), onContract),
        ...signed({ role: 'GST_ATTRIBUTED_UNBILLED' }, unbilled.neg(), onContract),
      ];
    }
  }
  let entryId: string | null = null;
  if (lines.length > 0) {
    const golden = decision === 'agreed' ? 'GP-044a' : 'GP-044c';
    const posted = await post(
      trx,
      {
        companyId,
        idempotencyKey: `ar-single-supply-cancel:${contractId}`,
        entryDate: c.cancelDate,
        sourceType: 'ar_credit_note',
        sourceId: contractId,
        memo: `Adjustment note — single supply ${k.reference} cancelled, refund ${decision} (${golden})`,
        ...(c.createdBy ? { createdBy: c.createdBy } : {}),
        lines,
      },
      opts,
    );
    entryId = posted.entryId;
  }
  await trx
    .insertInto('app.single_supply_cancellation')
    .values({
      company_id: companyId,
      contract_id: contractId,
      cancel_date: c.cancelDate,
      refund_decision: decision,
      reason,
      entry_id: entryId,
      decrease_net: numeric(decreaseNet),
      decrease_tax: numeric(decreaseTax),
      idempotency_key: c.idempotencyKey,
      created_by: c.createdBy ?? null,
    })
    .execute();
  await trx
    .insertInto('app.single_supply_contract_status')
    .values({
      company_id: companyId,
      contract_id: contractId,
      status: 'cancelled',
      status_date: c.cancelDate,
      entry_id: entryId,
      set_by: c.createdBy ?? null,
    })
    .execute();
  return cancellationOf(trx, companyId, contractId, false);
}

interface CancellationRow {
  cancel_date: string;
  refund_decision: RefundDecision;
  reason: string;
  entry_id: string | null;
  decrease_net: string;
  decrease_tax: string;
}

async function cancellationRow(trx: Trx, companyId: string, contractId: string) {
  return (
    await sql<CancellationRow>`
      SELECT to_char(cancel_date, 'YYYY-MM-DD') AS cancel_date, refund_decision, reason,
             entry_id::text, decrease_net::text, decrease_tax::text
        FROM app.single_supply_cancellation
       WHERE company_id = ${companyId}::uuid AND contract_id = ${contractId}::uuid`.execute(trx)
  ).rows[0];
}

/** The cancellation of a cancelled contract, as recorded. */
export async function cancellationOf(
  trx: Trx,
  companyId: string,
  contractId: string,
  replayed = false,
): Promise<CancellationView> {
  const r = await cancellationRow(trx, companyId, contractId);
  if (!r) return fail('UNKNOWN_CONTRACT', `contract ${contractId} has no cancellation`);
  const k = await singleSupplyContract(trx, companyId, contractId);
  const credit =
    r.entry_id !== null && r.refund_decision === 'agreed' ? k.receivedGross : numeric(ZERO);
  return {
    contractId,
    replayed,
    cancelDate: r.cancel_date,
    refund: r.refund_decision,
    reason: r.reason,
    entryId: r.entry_id,
    customerCredit: credit,
    adjustmentNote:
      r.entry_id === null
        ? null
        : note(k, r.reason, new Decimal(r.decrease_net), new Decimal(r.decrease_tax)),
  };
}

export async function refundCancelledSingleSupply(
  trx: Trx,
  c: {
    companyId: string;
    contractId: string;
    /** YYYY-MM-DD: the refund is agreed and paid on this date (GP-044d). */
    refundDate: string;
    /** The GL bank account the refund leaves from. */
    payFrom: { accountId: string };
    /** 1–500 characters: the adjustment-note reason. */
    reason: string;
    /** The person recording the refund (maker). */
    createdBy: string;
    /** Another person who approved it (ADR-0074 checker). */
    approvedBy: string;
    idempotencyKey: string;
  },
  opts: PostOptions = {},
): Promise<ContractRefundView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.contractId)) fail('UNKNOWN_CONTRACT', `contract ${c.contractId} not found`);
  const contractId = c.contractId.toLowerCase();
  await lockContract(trx, contractId);
  const existing = await trx
    .selectFrom('app.single_supply_refund')
    .select('contract_id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return contractRefundOf(trx, companyId, existing.contract_id, true);

  const k = await singleSupplyContract(trx, companyId, contractId);
  if (k.status !== 'cancelled') {
    fail(
      'CONTRACT_NOT_CANCELLED',
      `contract ${k.reference} is ${k.status}; only the money held on a cancelled contract is refunded here`,
    );
  }
  const cancelled = await cancellationRow(trx, companyId, contractId);
  if (!cancelled)
    return fail('CONTRACT_NOT_CANCELLED', `contract ${k.reference} has no cancellation`);
  const gross = new Decimal(k.receivedGross);
  if (!gross.gt(0)) fail('NOTHING_TO_REFUND', `nothing was received on ${k.reference}`);
  if (cancelled.entry_id !== null && cancelled.refund_decision === 'agreed') {
    fail(
      'REFUND_VIA_CUSTOMER_REFUND',
      `the refund on ${k.reference} was agreed at cancellation and is an AR credit; refund it as a customer refund (GP-044b, ADR-0074)`,
    );
  }
  const done = await trx
    .selectFrom('app.single_supply_refund')
    .select('contract_id')
    .where('company_id', '=', companyId)
    .where('contract_id', '=', contractId)
    .executeTakeFirst();
  if (done) fail('ALREADY_REFUNDED', `the money on ${k.reference} was already refunded`);
  if (!UUID_RE.test(c.createdBy) || !UUID_RE.test(c.approvedBy)) {
    fail('INVALID_SINGLE_SUPPLY', 'the maker and the approver are user ids');
  }
  if (c.createdBy.toLowerCase() === c.approvedBy.toLowerCase()) {
    fail(
      'SOD_REFUND_SELF_APPROVAL',
      'a refund is approved by another person than the one who records it (ADR-0074)',
    );
  }
  const reason = reasonOf(c.reason);
  if (!isDate(c.refundDate) || c.refundDate < cancelled.cancel_date) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      `the refund is dated YYYY-MM-DD on or after the cancellation (${cancelled.cancel_date})`,
    );
  }
  await basisGuard(trx, companyId, k, c.refundDate);
  if (!UUID_RE.test(c.payFrom.accountId)) fail('INVALID_SINGLE_SUPPLY', 'unknown bank account');

  const net = new Decimal(k.receivedNet);
  const tax = new Decimal(k.receivedTax);
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-single-supply-refund:${contractId}`,
      entryDate: c.refundDate,
      sourceType: 'ar_refund',
      sourceId: contractId,
      memo: `Refund and adjustment note — cancelled single supply ${k.reference} (GP-044d)`,
      createdBy: c.createdBy,
      lines: [
        {
          account: { role: 'CUSTOMER_PREPAYMENTS' },
          debit: numeric(net),
          taxCodeId: k.taxCodeId,
          taxAmount: numeric(tax),
          partyId: k.partyId,
          dimensions: [k.dimensionValueId],
        },
        ...signed({ role: 'GST_COLLECTED' }, tax),
        { account: { id: c.payFrom.accountId }, credit: numeric(gross) },
      ],
    },
    opts,
  );
  await trx
    .insertInto('app.single_supply_refund')
    .values({
      company_id: companyId,
      contract_id: contractId,
      refund_date: c.refundDate,
      gross: numeric(gross),
      net: numeric(net),
      tax: numeric(tax),
      account_id: c.payFrom.accountId,
      entry_id: posted.entryId,
      reason,
      created_by: c.createdBy,
      approved_by: c.approvedBy,
      idempotency_key: c.idempotencyKey,
    })
    .execute();
  return contractRefundOf(trx, companyId, contractId, false);
}

/** The GP-044d refund of a cancelled contract, as recorded. */
export async function contractRefundOf(
  trx: Trx,
  companyId: string,
  contractId: string,
  replayed = false,
): Promise<ContractRefundView> {
  const r = (
    await sql<{
      refund_date: string;
      gross: string;
      net: string;
      tax: string;
      entry_id: string;
      reason: string;
      created_by: string;
      approved_by: string;
    }>`
      SELECT to_char(refund_date, 'YYYY-MM-DD') AS refund_date, gross::text, net::text, tax::text,
             entry_id::text, reason, created_by::text, approved_by::text
        FROM app.single_supply_refund
       WHERE company_id = ${companyId}::uuid AND contract_id = ${contractId}::uuid`.execute(trx)
  ).rows[0];
  if (!r) return fail('UNKNOWN_CONTRACT', `contract ${contractId} has no refund`);
  const k = await singleSupplyContract(trx, companyId, contractId);
  return {
    contractId,
    replayed,
    refundDate: r.refund_date,
    gross: numeric(r.gross),
    net: numeric(r.net),
    tax: numeric(r.tax),
    entryId: r.entry_id,
    reason: r.reason,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    adjustmentNote: note(k, r.reason, new Decimal(r.net), new Decimal(r.tax)),
  };
}
