/**
 * Single-supply contracts and their receipts (T-0203; ADR-0089 R1–R5, R8, R11; RQ-0171;
 * goldens GP-040 and GP-020; migration 0073).
 *
 * createSingleSupplyContract — records a single (non-Div 156) supply with a known GST-exclusive
 * total, one taxable tax code and the GST basis in force on the contract date, with the person
 * who confirmed the classification. It also creates the contract's value of the company's
 * `supply_contract` dimension. Every contract line on CUSTOMER_PREPAYMENTS and
 * GST_ATTRIBUTED_UNBILLED carries that value, so balances are kept per contract (AC-7).
 *
 * recordSingleSupplyReceipt — money received on an open contract, before any invoice:
 *  - accruals, first receipt (GP-040a). The whole GST on the known total is attributed:
 *    Dr bank (received) / Dr GST_ATTRIBUTED_UNBILLED (whole GST − GST part) /
 *    Cr CUSTOMER_PREPAYMENTS coded (known net, tax = whole GST) /
 *    Dr CUSTOMER_PREPAYMENTS uncoded (known net − received net) / Cr GST collected (whole GST).
 *  - accruals, later receipts (GP-040b): Dr bank / Cr CUSTOMER_PREPAYMENTS (net) /
 *    Cr GST_ATTRIBUTED_UNBILLED (GST part).
 *  - cash basis (R8, GP-020): Dr bank / Cr CUSTOMER_PREPAYMENTS coded (net, GST part) /
 *    Cr GST collected (GST part).
 * The GST part of a receipt is receipt × rate / (1 + rate), rounded by the company rule. The
 * receipt that brings receipts to the contract total takes the remaining GST, so per-receipt
 * rounding never leaves a residue (review MINOR-2, AC-8). Receipts on one contract are
 * serialised on a transaction advisory lock. A one-row-per-contract attribution table backs
 * "exactly one first receipt" in the database (AC-4).
 *
 * Refused with nothing written: no known total (use `unknown_total` prepayments); a tax code
 * that is not taxable; no GST basis in force; a second tax code; receipts above the contract
 * total; a basis in force on the receipt date that differs from the contract's (R8); a contract
 * that is not open. The deposit-invoice refusal (R9) and the s 29-70 tax invoice are T-0206.
 * The limit by a varied total is T-0205.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import { post, type PostingLineInput, type PostOptions } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { computeTax, taxSettingsOf } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type SingleSupplyErrorCode =
  | 'INVALID_SINGLE_SUPPLY'
  | 'NO_CONTRACT_TOTAL'
  | 'UNKNOWN_CONTRACT'
  | 'CONTRACT_NOT_OPEN'
  | 'SECOND_TAX_CODE'
  | 'ABOVE_CONTRACT_TOTAL'
  | 'BASIS_CHANGED';

/** A single-supply request refused; nothing was written. */
export class SingleSupplyError extends DomainError {
  declare readonly code: SingleSupplyErrorCode;
}

const fail = (code: SingleSupplyErrorCode, message: string): never => {
  throw new SingleSupplyError(code, message);
};

export interface SingleSupplyContractView {
  readonly contractId: string;
  readonly replayed: boolean;
  readonly partyId: string;
  readonly reference: string;
  readonly contractDate: string;
  readonly knownNet: string;
  readonly taxCodeId: string;
  readonly gstBasis: 'cash' | 'accrual';
  readonly dimensionValueId: string;
  /** The whole GST attributed at the first accruals receipt; null before it or on cash. */
  readonly attributedTax: string | null;
  readonly attributionDate: string | null;
  readonly receivedGross: string;
  readonly receivedNet: string;
  readonly receivedTax: string;
  /** Attributed GST not yet received (R11); 0 on the cash basis. */
  readonly unbilledTax: string;
  readonly status: 'open' | 'finalised' | 'cancelled';
}

export interface SingleSupplyReceiptView {
  readonly receiptId: string;
  readonly contractId: string;
  readonly entryId: string;
  readonly replayed: boolean;
  readonly gross: string;
  readonly net: string;
  /** GST part of the receipt. */
  readonly tax: string;
  /** True for the receipt that attributed the contract's whole GST (GP-040a). */
  readonly attributes: boolean;
}

export const SUPPLY_CONTRACT_DIMENSION = 'supply_contract';

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

async function lockContract(trx: Trx, contractId: string): Promise<void> {
  // lf_app cannot lock rows of these immutable tables (no UPDATE): serialise on an advisory lock.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lf.single-supply:' + contractId}, 0))`.execute(
    trx,
  );
}

/** The contract and its running totals, or UNKNOWN_CONTRACT. */
export async function singleSupplyContract(
  trx: Trx,
  companyId: string,
  contractId: string,
  replayed = false,
): Promise<SingleSupplyContractView> {
  if (!UUID_RE.test(contractId)) fail('UNKNOWN_CONTRACT', `contract ${contractId} not found`);
  const r = (
    await sql<{
      id: string;
      party_id: string;
      reference: string;
      contract_date: string;
      known_net: string;
      tax_code_id: string;
      gst_basis: 'cash' | 'accrual';
      dimension_value_id: string;
      attributed_tax: string | null;
      attribution_date: string | null;
      gross: string;
      net: string;
      tax: string;
      status: 'finalised' | 'cancelled' | null;
    }>`
      SELECT c.id::text, c.party_id::text, c.reference, to_char(c.contract_date, 'YYYY-MM-DD') AS contract_date,
             c.known_net::text, c.tax_code_id::text, c.gst_basis, c.dimension_value_id::text,
             a.attributed_tax::text, to_char(a.attribution_date, 'YYYY-MM-DD') AS attribution_date,
             coalesce(rc.gross, 0)::text AS gross, coalesce(rc.net, 0)::text AS net,
             coalesce(rc.tax, 0)::text AS tax, s.status
        FROM app.single_supply_contract c
        LEFT JOIN app.single_supply_attribution a ON a.tenant_id = c.tenant_id AND a.contract_id = c.id
        LEFT JOIN app.single_supply_contract_status s ON s.tenant_id = c.tenant_id AND s.contract_id = c.id
        LEFT JOIN LATERAL (
          SELECT sum(x.gross) AS gross, sum(x.net) AS net, sum(x.tax) AS tax
            FROM app.single_supply_receipt x WHERE x.tenant_id = c.tenant_id AND x.contract_id = c.id
        ) rc ON true
       WHERE c.company_id = ${companyId}::uuid AND c.id = ${contractId}::uuid`.execute(trx)
  ).rows[0];
  if (!r) return fail('UNKNOWN_CONTRACT', `contract ${contractId} is not in company ${companyId}`);
  const unbilled =
    r.attributed_tax === null ? new Decimal(0) : new Decimal(r.attributed_tax).minus(r.tax);
  return {
    contractId: r.id,
    replayed,
    partyId: r.party_id,
    reference: r.reference,
    contractDate: r.contract_date,
    knownNet: numeric(r.known_net),
    taxCodeId: r.tax_code_id,
    gstBasis: r.gst_basis,
    dimensionValueId: r.dimension_value_id,
    attributedTax: r.attributed_tax === null ? null : numeric(r.attributed_tax),
    attributionDate: r.attribution_date,
    receivedGross: numeric(r.gross),
    receivedNet: numeric(r.net),
    receivedTax: numeric(r.tax),
    unbilledTax: numeric(unbilled),
    status: r.status ?? 'open',
  };
}

async function companyRounding(trx: Trx, companyId: string) {
  return (
    await trx
      .selectFrom('app.company')
      .select('tax_rounding')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow()
  ).tax_rounding;
}

/** The tax code in force on `date` by code or id, with its kind and rate. */
async function taxCodeOn(
  trx: Trx,
  companyId: string,
  date: string,
  by: { code: string } | { id: string },
) {
  return (
    await sql<{ id: string; code: string; kind: string; rate: string }>`
      SELECT id::text, code, kind, rate::text FROM app.tax_code
       WHERE company_id = ${companyId}::uuid AND status = 'active'
         AND ${'code' in by ? sql`code = ${by.code}` : sql`id = ${by.id}::uuid`}
         AND effective_from <= ${date}::date
         AND (effective_to IS NULL OR effective_to >= ${date}::date)`.execute(trx)
  ).rows[0];
}

export async function createSingleSupplyContract(
  trx: Trx,
  c: {
    companyId: string;
    partyId: string;
    /** The customer's job or contract reference, 1..100 characters. */
    reference: string;
    /** YYYY-MM-DD; the GST basis in force on this date is the contract's for its life (R8). */
    contractDate: string;
    /** Known GST-exclusive total, > 0, ≤ 2 decimals. */
    knownNet: string;
    /** One taxable code; default GST. */
    taxCode?: string;
    /** The app_user who confirmed the legal classification as a single supply (R1). */
    confirmedBy: string;
    idempotencyKey: string;
  },
): Promise<SingleSupplyContractView> {
  const companyId = c.companyId.toLowerCase();
  const existing = await trx
    .selectFrom('app.single_supply_contract')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return singleSupplyContract(trx, companyId, existing.id, true);
  if (!AMOUNT_RE.test(c.knownNet) || !new Decimal(c.knownNet).gt(0)) {
    fail(
      'NO_CONTRACT_TOTAL',
      'a single supply needs a known GST-exclusive total > 0 with ≤ 2 decimals; use an unknown_total prepayment otherwise',
    );
  }
  if (!DATE_RE.test(c.contractDate)) fail('INVALID_SINGLE_SUPPLY', 'contract date is YYYY-MM-DD');
  if (!c.reference.trim() || c.reference.trim().length > 100) {
    fail('INVALID_SINGLE_SUPPLY', 'the reference is 1–100 characters');
  }
  const code = await taxCodeOn(trx, companyId, c.contractDate, { code: c.taxCode ?? 'GST' });
  if (!code || code.kind !== 'taxable' || !new Decimal(code.rate).gt(0)) {
    fail(
      'INVALID_SINGLE_SUPPLY',
      `tax code ${c.taxCode ?? 'GST'} is not a taxable code in force; a GST-free supply uses a gst_free prepayment`,
    );
  }
  const settings = await taxSettingsOf(trx, companyId, c.contractDate);
  if (!settings) fail('INVALID_SINGLE_SUPPLY', `no GST basis is in force on ${c.contractDate}`);
  await trx
    .insertInto('app.dimension')
    .values({ company_id: companyId, code: SUPPLY_CONTRACT_DIMENSION, name: 'Supply contract' })
    .onConflict((oc) => oc.columns(['tenant_id', 'company_id', 'code']).doNothing())
    .execute();
  const dimension = await trx
    .selectFrom('app.dimension')
    .select('id')
    .where('company_id', '=', companyId)
    .where('code', '=', SUPPLY_CONTRACT_DIMENSION)
    .executeTakeFirstOrThrow();
  const id = randomUUID();
  const value = await trx
    .insertInto('app.dimension_value')
    .values({
      company_id: companyId,
      dimension_id: dimension.id,
      code: id,
      name: c.reference.trim(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.single_supply_contract')
    .values({
      id,
      company_id: companyId,
      party_id: c.partyId,
      reference: c.reference.trim(),
      contract_date: c.contractDate,
      known_net: c.knownNet,
      tax_code_id: code?.id ?? '',
      gst_basis: settings?.gstBasis ?? 'accrual',
      dimension_value_id: value.id,
      confirmed_by: c.confirmedBy,
      idempotency_key: c.idempotencyKey,
    })
    .execute();
  return singleSupplyContract(trx, companyId, id);
}

export async function recordSingleSupplyReceipt(
  trx: Trx,
  c: {
    companyId: string;
    contractId: string;
    receiptDate: string;
    /** Amount received, GST included; ≤ 2 decimals. */
    gross: string;
    depositTo: { accountId: string };
    /** Must be the contract's code when given (one code per contract). */
    taxCode?: string;
    idempotencyKey: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<SingleSupplyReceiptView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.contractId)) fail('UNKNOWN_CONTRACT', `contract ${c.contractId} not found`);
  await lockContract(trx, c.contractId.toLowerCase());
  const existing = await trx
    .selectFrom('app.single_supply_receipt')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return receiptView(trx, companyId, existing.id, true);

  const k = await singleSupplyContract(trx, companyId, c.contractId);
  if (k.status !== 'open') fail('CONTRACT_NOT_OPEN', `contract ${k.reference} is ${k.status}`);
  if (!AMOUNT_RE.test(c.gross) || !new Decimal(c.gross).gt(0)) {
    fail('INVALID_SINGLE_SUPPLY', 'the amount must be > 0 with ≤ 2 decimals');
  }
  if (!DATE_RE.test(c.receiptDate)) fail('INVALID_SINGLE_SUPPLY', 'receipt date is YYYY-MM-DD');
  const code = await taxCodeOn(trx, companyId, c.receiptDate, { id: k.taxCodeId });
  if (!code)
    fail('INVALID_SINGLE_SUPPLY', `the contract's tax code is not in force on ${c.receiptDate}`);
  if (c.taxCode !== undefined && c.taxCode !== code?.code) {
    fail(
      'SECOND_TAX_CODE',
      `contract ${k.reference} has one tax code (${String(code?.code)}); a mixed supply is refused`,
    );
  }
  const settings = await taxSettingsOf(trx, companyId, c.receiptDate);
  if (settings?.gstBasis !== k.gstBasis) {
    fail(
      'BASIS_CHANGED',
      `contract ${k.reference} is on the ${k.gstBasis} basis; the basis in force on ${c.receiptDate} is ${String(settings?.gstBasis)}`,
    );
  }
  const rate = new Decimal(code?.rate ?? '0').toString();
  const rounding = await companyRounding(trx, companyId);
  const accrual = k.gstBasis === 'accrual';
  // The whole GST: fixed at attribution, else the total invoice rule on the known total.
  const wholeTax = new Decimal(
    k.attributedTax ??
      computeTax({
        pricing: 'exclusive',
        rounding,
        lines: [{ amount: new Decimal(k.knownNet).toString(), rate }],
      }).tax,
  );
  const total = new Decimal(k.knownNet).plus(wholeTax);
  const remaining = total.minus(k.receivedGross);
  const gross = new Decimal(c.gross);
  if (gross.gt(remaining)) {
    fail(
      'ABOVE_CONTRACT_TOTAL',
      `contract ${k.reference}: ${numeric(gross)} is above the ${numeric(remaining)} still to receive`,
    );
  }
  const tax = gross.eq(remaining)
    ? wholeTax.minus(k.receivedTax)
    : new Decimal(
        computeTax({ pricing: 'inclusive', rounding, lines: [{ amount: c.gross, rate }] }).tax,
      );
  const net = gross.minus(tax);
  const attributes = accrual && k.attributedTax === null;

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
  const prepay = { role: 'CUSTOMER_PREPAYMENTS' };
  const unbilled = { role: 'GST_ATTRIBUTED_UNBILLED' };
  const lines: PostingLineInput[] = [{ account: { id: c.depositTo.accountId }, debit: c.gross }];
  let memo: string;
  if (attributes) {
    memo = 'Single-supply receipt: whole GST attributed (GP-040a)';
    lines.push(
      ...signed(unbilled, wholeTax.minus(tax), onContract),
      {
        account: prepay,
        credit: numeric(k.knownNet),
        taxCodeId: k.taxCodeId,
        taxAmount: numeric(wholeTax),
        ...onContract,
      },
      ...signed(prepay, new Decimal(k.knownNet).minus(net), onContract),
      ...signed({ role: 'GST_COLLECTED' }, wholeTax.neg()),
    );
  } else if (accrual) {
    memo = 'Single-supply receipt (GP-040b)';
    lines.push(
      ...signed(prepay, net.neg(), onContract),
      ...signed(unbilled, tax.neg(), onContract),
    );
  } else {
    memo = 'Single-supply receipt, cash basis (GP-020)';
    lines.push(
      {
        account: prepay,
        credit: numeric(net),
        taxCodeId: k.taxCodeId,
        taxAmount: numeric(tax),
        ...onContract,
      },
      ...signed({ role: 'GST_COLLECTED' }, tax.neg()),
    );
  }
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-single-supply-receipt:${c.idempotencyKey}`,
      entryDate: c.receiptDate,
      sourceType: 'ar_prepayment',
      sourceId: k.contractId,
      memo: `${memo} — ${k.reference}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines,
    },
    opts,
  );
  if (attributes) {
    await trx
      .insertInto('app.single_supply_attribution')
      .values({
        company_id: companyId,
        contract_id: k.contractId,
        attribution_date: c.receiptDate,
        attributed_tax: numeric(wholeTax),
        entry_id: posted.entryId,
      })
      .execute();
  }
  const row = await trx
    .insertInto('app.single_supply_receipt')
    .values({
      company_id: companyId,
      contract_id: k.contractId,
      receipt_date: c.receiptDate,
      gross: numeric(gross),
      net: numeric(net),
      tax: numeric(tax),
      account_id: c.depositTo.accountId,
      entry_id: posted.entryId,
      idempotency_key: c.idempotencyKey,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return receiptView(trx, companyId, row.id, false);
}

async function receiptView(
  trx: Trx,
  companyId: string,
  id: string,
  replayed: boolean,
): Promise<SingleSupplyReceiptView> {
  const r = (
    await sql<{
      id: string;
      contract_id: string;
      entry_id: string;
      gross: string;
      net: string;
      tax: string;
      attributes: boolean;
    }>`
      SELECT r.id::text, r.contract_id::text, r.entry_id::text, r.gross::text, r.net::text,
             r.tax::text,
             EXISTS (SELECT 1 FROM app.single_supply_attribution a
                      WHERE a.tenant_id = r.tenant_id AND a.contract_id = r.contract_id
                        AND a.entry_id = r.entry_id) AS attributes
        FROM app.single_supply_receipt r
       WHERE r.company_id = ${companyId}::uuid AND r.id = ${id}::uuid`.execute(trx)
  ).rows[0];
  if (!r) return fail('UNKNOWN_CONTRACT', `receipt ${id} not found`);
  return {
    receiptId: r.id,
    contractId: r.contract_id,
    entryId: r.entry_id,
    replayed,
    gross: numeric(r.gross),
    net: numeric(r.net),
    tax: numeric(r.tax),
    attributes: r.attributes,
  };
}
