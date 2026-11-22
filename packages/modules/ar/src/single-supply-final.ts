/**
 * Single-supply final tax invoice (T-0204 slice 1; ADR-0089 R6 + addendum A; RQ-0178;
 * golden GP-045; migration 0078; DL-0830..DL-0833).
 *
 * finaliseSingleSupply — on an open accruals contract whose whole GST was attributed at the first
 * receipt (GP-040a), issues the final tax invoice as a register invoice (app.sales_invoice,
 * numbered from the invoice series) and posts one GP-045 entry (source ar_invoice):
 *   Dr AR_CONTROL (the whole tax invoice) / Dr CUSTOMER_PREPAYMENTS (net received) /
 *   [decrease: Dr revenue coded (change, its GST) / Dr GST collected] /
 *   Cr revenue uncoded (the contract's known net, one line per revenue account) /
 *   [increase: Cr revenue coded (change, its GST)] / Cr GST_ATTRIBUTED_UNBILLED (its actual
 *   balance, debit or credit) / [increase: Cr GST collected] / Cr AR_CONTROL (cash received)
 * and allocates the cash-received credit item to the invoice item at once. The invoice shows the
 * fixed GST (attributed GST + GST on the change) spread over its lines by the GP-023a residual
 * rule. The contract becomes finalised (app.single_supply_contract_status) and the finalisation
 * row (0078) keeps the final price and the change with its date and reason; a decrease returns
 * adjustment-note particulars (AC-10), also when its GST is within the $75 threshold (s 29-80).
 *
 * Refused with nothing written: a final price that differs from the contract unless the change
 * was agreed on the invoice date (VARIATION_NOT_ON_INVOICE_DATE — other dates need the variation
 * document, T-0217); a final invoice below the cash received (BELOW_CASH_RECEIVED, AC-8); a change
 * larger than the revenue of the account that carries it (CHANGE_EXCEEDS_LINE); nothing attributed
 * yet (NOTHING_ATTRIBUTED); a cash-basis contract (CASH_BASIS_NOT_BUILT — GP-022 application,
 * T-0217); a basis in force on the invoice date that differs from the contract's (BASIS_CHANGED);
 * a contract that is not open. The same idempotency key returns the same invoice.
 */
import type { Database } from '@ledgerforce/db';
import {
  allocate,
  nextNumber,
  post,
  subledgerEntriesOf,
  type PostingLineInput,
  type PostOptions,
} from '@ledgerforce/ledger';
import { resolvePosting } from '@ledgerforce/products';
import { Money } from '@ledgerforce/shared/money';
import { computeTax, taxSettingsOf } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { INVOICE_NUMBER_SERIES } from './invoices.ts';
import {
  SingleSupplyError,
  singleSupplyContract,
  type SingleSupplyErrorCode,
} from './single-supply.ts';

type Trx = Transaction<Database>;

export type FinalInvoiceErrorCode =
  | SingleSupplyErrorCode
  | 'VARIATION_NOT_ON_INVOICE_DATE'
  | 'BELOW_CASH_RECEIVED'
  | 'CHANGE_EXCEEDS_LINE'
  | 'NOTHING_ATTRIBUTED'
  | 'CASH_BASIS_NOT_BUILT';

const fail = (code: FinalInvoiceErrorCode, message: string): never => {
  throw new SingleSupplyError(code as SingleSupplyErrorCode, message);
};

export interface FinalInvoiceLineInput {
  readonly description: string;
  /** The product posting profile whose revenue account the line posts to. */
  readonly productProfileId: string;
  /** GST-exclusive line amount, > 0, ≤ 2 decimals. The lines sum to the final price. */
  readonly amount: string;
}

export interface FinalInvoiceAdjustmentNote {
  readonly title: 'Adjustment note';
  readonly reason: string;
  readonly decreaseNet: string;
  readonly decreaseTax: string;
  readonly decreaseGross: string;
  /** The earlier document the decrease adjusts: the contract's GST attribution. */
  readonly adjusts: string;
  /** True when the GST decrease is $75 or less (s 29-80): the note is optional but still issued. */
  readonly withinThreshold: boolean;
}

export interface FinalInvoicePriceChange {
  /** Signed: + increase, − decrease. */
  readonly net: string;
  readonly tax: string;
  readonly variationDate: string;
  readonly reason: string;
  /** Particulars of the decrease (AC-10); null for an increase. */
  readonly adjustmentNote: FinalInvoiceAdjustmentNote | null;
}

export interface FinalInvoiceLineView {
  readonly lineNo: number;
  readonly description: string;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

export interface FinalInvoiceView {
  readonly contractId: string;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly entryId: string;
  readonly replayed: boolean;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly netTotal: string;
  readonly taxTotal: string;
  readonly grossTotal: string;
  readonly receivedGross: string;
  readonly amountDue: string;
  readonly lines: readonly FinalInvoiceLineView[];
  readonly priceChange: FinalInvoicePriceChange | null;
}

/** GST decrease at or under which an adjustment note is not required (s 29-80). */
const ADJUSTMENT_NOTE_THRESHOLD = new Decimal(75);
const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const ZERO = new Decimal(0);

/** Index of the largest amount, ties to the last (the GP-023a residual target). */
function largestIndex(amounts: readonly Decimal[]): number {
  let at = 0;
  amounts.forEach((a, i) => {
    if (a.gte(amounts[at] ?? ZERO)) at = i;
  });
  return at;
}

/**
 * Spread a fixed document tax over line nets in proportion, half-up to cents, the residual to the
 * largest line (ties: the last) — the GP-023a total-invoice rule with the total given.
 */
export function distributeTax(nets: readonly Decimal[], total: Decimal): Decimal[] {
  const sum = nets.reduce((s, n) => s.plus(n), ZERO);
  if (sum.isZero()) return nets.map(() => ZERO);
  const taxes = nets.map((n) => n.times(total).div(sum).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  const residual = total.minus(taxes.reduce((s, t) => s.plus(t), ZERO));
  const at = largestIndex(nets);
  taxes[at] = (taxes[at] ?? ZERO).plus(residual);
  return taxes;
}

async function lockContract(trx: Trx, contractId: string): Promise<void> {
  // Same key as receipts (single-supply.ts): receipts and the final invoice are serialised.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lf.single-supply:' + contractId}, 0))`.execute(
    trx,
  );
}

export async function finaliseSingleSupply(
  trx: Trx,
  c: {
    companyId: string;
    contractId: string;
    /** YYYY-MM-DD; on or after the contract date and the last receipt. */
    invoiceDate: string;
    /** YYYY-MM-DD; default the invoice date. */
    dueDate?: string;
    lines: readonly FinalInvoiceLineInput[];
    /** Required exactly when the lines differ from the contract's known net (AC-6). */
    priceChange?: { variationDate: string; reason: string };
    idempotencyKey: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<FinalInvoiceView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.contractId)) fail('UNKNOWN_CONTRACT', `contract ${c.contractId} not found`);
  const contractId = c.contractId.toLowerCase();
  await lockContract(trx, contractId);
  const existing = await trx
    .selectFrom('app.single_supply_finalisation')
    .select('contract_id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return finalInvoiceOf(trx, companyId, existing.contract_id, true);

  const k = await singleSupplyContract(trx, companyId, contractId);
  if (k.status !== 'open') fail('CONTRACT_NOT_OPEN', `contract ${k.reference} is ${k.status}`);
  if (!DATE_RE.test(c.invoiceDate)) fail('INVALID_SINGLE_SUPPLY', 'invoice date is YYYY-MM-DD');
  const dueDate = c.dueDate ?? c.invoiceDate;
  if (!DATE_RE.test(dueDate) || dueDate < c.invoiceDate) {
    fail('INVALID_SINGLE_SUPPLY', 'the due date is YYYY-MM-DD, on or after the invoice date');
  }
  if (c.lines.length === 0 || c.lines.length > 1000) {
    fail('INVALID_SINGLE_SUPPLY', 'the final invoice has 1–1000 lines');
  }
  for (const [i, l] of c.lines.entries()) {
    const at = `line ${String(i + 1)}`;
    if (!AMOUNT_RE.test(l.amount) || !new Decimal(l.amount).gt(0)) {
      fail('INVALID_SINGLE_SUPPLY', `${at}: the amount must be > 0 with ≤ 2 decimals`);
    }
    const d = l.description.trim();
    if (d.length < 1 || d.length > 1000) {
      fail('INVALID_SINGLE_SUPPLY', `${at}: the description is 1–1000 characters`);
    }
    if (!UUID_RE.test(l.productProfileId)) {
      fail('INVALID_SINGLE_SUPPLY', `${at}: unknown product posting profile`);
    }
  }

  const settings = await taxSettingsOf(trx, companyId, c.invoiceDate);
  if (settings?.gstBasis !== k.gstBasis) {
    fail(
      'BASIS_CHANGED',
      `contract ${k.reference} is on the ${k.gstBasis} basis; the basis in force on ${c.invoiceDate} is ${String(settings?.gstBasis)}`,
    );
  }
  if (k.gstBasis === 'cash') {
    fail(
      'CASH_BASIS_NOT_BUILT',
      `contract ${k.reference} is on the cash basis: its final invoice applies the receipts by GP-022, not built yet (T-0217)`,
    );
  }
  if (k.attributedTax === null || k.attributionDate === null) {
    return fail(
      'NOTHING_ATTRIBUTED',
      `contract ${k.reference} has no receipt, so no GST was attributed; no golden covers its final invoice yet`,
    );
  }
  const last = (
    await sql<{ d: string | null }>`
      SELECT to_char(max(receipt_date), 'YYYY-MM-DD') AS d FROM app.single_supply_receipt
       WHERE company_id = ${companyId}::uuid AND contract_id = ${contractId}::uuid`.execute(trx)
  ).rows[0]?.d;
  if (c.invoiceDate < k.contractDate || (last && c.invoiceDate < last)) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      `the final invoice is dated on or after the contract (${k.contractDate}) and its last receipt (${String(last)})`,
    );
  }

  const code = (
    await sql<{ code: string; rate: string }>`
      SELECT code, rate::text FROM app.tax_code
       WHERE company_id = ${companyId}::uuid AND id = ${k.taxCodeId}::uuid AND status = 'active'
         AND effective_from <= ${c.invoiceDate}::date
         AND (effective_to IS NULL OR effective_to >= ${c.invoiceDate}::date)`.execute(trx)
  ).rows[0];
  if (!code) {
    return fail(
      'INVALID_SINGLE_SUPPLY',
      `the contract's tax code is not in force on ${c.invoiceDate}`,
    );
  }
  const rounding = await trx
    .selectFrom('app.company')
    .select(['tax_rounding', 'base_currency'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();

  // AC-6: a different final price only for a variation agreed on the invoice date.
  const amounts = c.lines.map((l) => new Decimal(l.amount));
  const finalNet = amounts.reduce((s, a) => s.plus(a), ZERO);
  const knownNet = new Decimal(k.knownNet);
  const delta = finalNet.minus(knownNet);
  const reason = c.priceChange?.reason.trim() ?? '';
  if (delta.isZero() && c.priceChange) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      'a price change was given but the lines equal the contract price',
    );
  }
  if (!delta.isZero()) {
    if (c.priceChange?.variationDate !== c.invoiceDate) {
      fail(
        'VARIATION_NOT_ON_INVOICE_DATE',
        `the lines (${numeric(finalNet)}) differ from contract ${k.reference} (${numeric(knownNet)}): a price change is posted on the invoice only when agreed on the invoice date; a variation agreed on another date needs the contract-variation document (T-0217)`,
      );
    }
    if (reason.length < 1 || reason.length > 500) {
      fail('INVALID_SINGLE_SUPPLY', 'the reason for the price change is 1–500 characters');
    }
  }
  const deltaTaxAbs = delta.isZero()
    ? ZERO
    : new Decimal(
        computeTax({
          pricing: 'exclusive',
          rounding: rounding.tax_rounding,
          lines: [{ amount: delta.abs().toString(), rate: new Decimal(code.rate).toString() }],
        }).tax,
      );
  const deltaTax = delta.isNegative() ? deltaTaxAbs.neg() : deltaTaxAbs;
  const attributed = new Decimal(k.attributedTax);
  const taxTotal = attributed.plus(deltaTax);
  const gross = finalNet.plus(taxTotal);
  const received = new Decimal(k.receivedGross);
  if (gross.lt(received)) {
    fail(
      'BELOW_CASH_RECEIVED',
      `the final invoice (${numeric(gross)}) is below the ${numeric(received)} already received on ${k.reference}; no golden covers the credit and refund of the difference yet`,
    );
  }

  // Revenue accounts by the posting matrix; one uncoded line per account, the change on the
  // account of the largest line (RQ-0178 Q2).
  const party = await trx
    .selectFrom('app.party')
    .select('customer_profile_id')
    .where('company_id', '=', companyId)
    .where('id', '=', k.partyId)
    .executeTakeFirst();
  if (!party?.customer_profile_id) {
    return fail('INVALID_SINGLE_SUPPLY', 'the customer has no party posting profile');
  }
  const accounts: string[] = [];
  let controlAccountId = '';
  for (const [i, l] of c.lines.entries()) {
    const r = await resolvePosting(trx, companyId, {
      partyProfileId: party.customer_profile_id,
      productProfileId: l.productProfileId,
      purpose: 'sale',
      date: c.invoiceDate,
    });
    if (!r.ok) return fail('INVALID_SINGLE_SUPPLY', `line ${String(i + 1)}: ${r.gap.message}`);
    accounts.push(r.accountId);
    controlAccountId = r.controlAccountId;
  }
  const uncoded = new Map<string, Decimal>();
  accounts.forEach((a, i) => uncoded.set(a, (uncoded.get(a) ?? ZERO).plus(amounts[i] ?? ZERO)));
  const changeAccount = accounts[largestIndex(amounts)] ?? '';
  const carrying = (uncoded.get(changeAccount) ?? ZERO).minus(delta);
  if (!carrying.gt(0)) {
    fail(
      'CHANGE_EXCEEDS_LINE',
      `the price change ${numeric(delta)} is larger than the revenue of the largest line's account; put the change on one line`,
    );
  }
  uncoded.set(changeAccount, carrying);
  const lineTaxes = distributeTax(amounts, taxTotal);

  // The register invoice: a draft with its priced lines, posted below (lines are frozen once
  // the invoice is posted, 0035 guard).
  const invoice = await trx
    .insertInto('app.sales_invoice')
    .values({
      company_id: companyId,
      party_id: k.partyId,
      issue_date: c.invoiceDate,
      due_date: dueDate,
      pricing: 'exclusive',
      currency: rounding.base_currency,
      reference: k.reference,
      source_key: `single-supply:${contractId}`,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [i, l] of c.lines.entries()) {
    const net = amounts[i] ?? ZERO;
    const tax = lineTaxes[i] ?? ZERO;
    await trx
      .insertInto('app.sales_invoice_line')
      .values({
        company_id: companyId,
        invoice_id: invoice.id,
        line_no: i + 1,
        product_profile_id: l.productProfileId,
        description: l.description.trim(),
        quantity: '1',
        unit_price: numeric(net),
        amount: numeric(net),
        tax_code: code.code,
        net: numeric(net),
        tax: numeric(tax),
        gross: numeric(net.plus(tax)),
        account_id: accounts[i] ?? '',
        tax_code_id: k.taxCodeId,
      })
      .execute();
  }

  const onContract = { partyId: k.partyId, dimensions: [k.dimensionValueId] };
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
  const ar = { id: controlAccountId };
  const change = (side: 'debit' | 'credit'): PostingLineInput[] => [
    {
      account: { id: changeAccount },
      [side]: numeric(delta.abs()),
      taxCodeId: k.taxCodeId,
      taxAmount: numeric(deltaTaxAbs),
      partyId: k.partyId,
    },
  ];
  const lines: PostingLineInput[] = [
    { account: ar, debit: numeric(gross), partyId: k.partyId, dueDate },
    ...signed({ role: 'CUSTOMER_PREPAYMENTS' }, new Decimal(k.receivedNet), onContract),
    ...(delta.isNegative()
      ? [...change('debit'), ...signed({ role: 'GST_COLLECTED' }, deltaTaxAbs)]
      : []),
    ...[...uncoded].map(([account, amount]) => ({
      account: { id: account },
      credit: numeric(amount),
      partyId: k.partyId,
    })),
    ...(delta.gt(0) ? change('credit') : []),
    ...signed({ role: 'GST_ATTRIBUTED_UNBILLED' }, new Decimal(k.unbilledTax).neg(), onContract),
    ...(delta.gt(0) ? signed({ role: 'GST_COLLECTED' }, deltaTaxAbs.neg()) : []),
    ...signed(ar, received.neg(), { partyId: k.partyId }),
  ];
  const invoiceNo = await nextNumber(trx, companyId, INVOICE_NUMBER_SERIES);
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-single-supply-final:${contractId}`,
      entryDate: c.invoiceDate,
      sourceType: 'ar_invoice',
      sourceId: invoice.id,
      memo: `Invoice ${invoiceNo} — final tax invoice for single supply ${k.reference} (GP-045)`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines,
    },
    opts,
  );
  if (received.gt(0)) {
    const items = await subledgerEntriesOf(trx, posted.entryId);
    const debit = items.find((i) => new Decimal(i.originalAmount).gt(0));
    const credit = items.find((i) => new Decimal(i.originalAmount).lt(0));
    await allocate(trx, {
      companyId,
      idempotencyKey: `ar-single-supply-final-alloc:${posted.entryId}`,
      fromEntryId: credit?.id ?? '',
      toEntryId: debit?.id ?? '',
      amount: numeric(received),
      allocationDate: c.invoiceDate,
    });
  }
  await trx
    .updateTable('app.sales_invoice')
    .set({
      status: 'posted',
      invoice_no: invoiceNo,
      entry_id: posted.entryId,
      net_total: numeric(finalNet),
      tax_total: numeric(taxTotal),
      gross_total: numeric(gross),
      approved_by: c.createdBy ?? null,
      approved_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', invoice.id)
    .execute();
  await trx
    .insertInto('app.single_supply_finalisation')
    .values({
      company_id: companyId,
      contract_id: contractId,
      invoice_id: invoice.id,
      entry_id: posted.entryId,
      invoice_date: c.invoiceDate,
      final_net: numeric(finalNet),
      price_change_net: numeric(delta),
      price_change_tax: numeric(deltaTax),
      variation_date: delta.isZero() ? null : c.invoiceDate,
      variation_reason: delta.isZero() ? null : reason,
      idempotency_key: c.idempotencyKey,
      created_by: c.createdBy ?? null,
    })
    .execute();
  await trx
    .insertInto('app.single_supply_contract_status')
    .values({
      company_id: companyId,
      contract_id: contractId,
      status: 'finalised',
      status_date: c.invoiceDate,
      entry_id: posted.entryId,
      set_by: c.createdBy ?? null,
    })
    .execute();
  return finalInvoiceOf(trx, companyId, contractId, false);
}

/** The final invoice of a finalised contract, as issued. */
export async function finalInvoiceOf(
  trx: Trx,
  companyId: string,
  contractId: string,
  replayed = false,
): Promise<FinalInvoiceView> {
  const r = (
    await sql<{
      invoice_id: string;
      invoice_no: string;
      entry_id: string;
      issue_date: string;
      due_date: string;
      net_total: string;
      tax_total: string;
      gross_total: string;
      price_change_net: string;
      price_change_tax: string;
      variation_date: string | null;
      variation_reason: string | null;
    }>`
      SELECT fz.invoice_id::text, i.invoice_no, fz.entry_id::text,
             to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
             to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
             i.net_total::text, i.tax_total::text, i.gross_total::text,
             fz.price_change_net::text, fz.price_change_tax::text,
             to_char(fz.variation_date, 'YYYY-MM-DD') AS variation_date, fz.variation_reason
        FROM app.single_supply_finalisation fz
        JOIN app.sales_invoice i ON i.tenant_id = fz.tenant_id AND i.id = fz.invoice_id
       WHERE fz.company_id = ${companyId}::uuid AND fz.contract_id = ${contractId}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!r) return fail('UNKNOWN_CONTRACT', `contract ${contractId} has no final invoice`);
  const k = await singleSupplyContract(trx, companyId, contractId);
  const lines = (
    await sql<{ line_no: number; description: string; net: string; tax: string; gross: string }>`
      SELECT line_no, description, net::text, tax::text, gross::text FROM app.sales_invoice_line
       WHERE company_id = ${companyId}::uuid AND invoice_id = ${r.invoice_id}::uuid
       ORDER BY line_no`.execute(trx)
  ).rows;
  const changeNet = new Decimal(r.price_change_net);
  const changeTax = new Decimal(r.price_change_tax);
  const reason = r.variation_reason ?? '';
  return {
    contractId,
    invoiceId: r.invoice_id,
    invoiceNo: r.invoice_no,
    entryId: r.entry_id,
    replayed,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    netTotal: numeric(r.net_total),
    taxTotal: numeric(r.tax_total),
    grossTotal: numeric(r.gross_total),
    receivedGross: k.receivedGross,
    amountDue: numeric(new Decimal(r.gross_total).minus(k.receivedGross)),
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      net: numeric(l.net),
      tax: numeric(l.tax),
      gross: numeric(l.gross),
    })),
    priceChange: changeNet.isZero()
      ? null
      : {
          net: numeric(changeNet),
          tax: numeric(changeTax),
          variationDate: r.variation_date ?? '',
          reason,
          adjustmentNote: changeNet.isNegative()
            ? {
                title: 'Adjustment note',
                reason,
                decreaseNet: numeric(changeNet.neg()),
                decreaseTax: numeric(changeTax.neg()),
                decreaseGross: numeric(changeNet.plus(changeTax).neg()),
                adjusts: `GST attributed on ${k.reference} on ${k.attributionDate ?? ''}`,
                withinThreshold: changeTax.neg().lte(ADJUSTMENT_NOTE_THRESHOLD),
              }
            : null,
        },
  };
}
