/**
 * Customer prepayments (T-0047, design §3.8 row 10, GP-020, GP-022, Q7, DL-0275).
 *
 * recordPrepayment — money received before any invoice. GST is attributable on receipt (GST Act
 * s 29-5) for progressive/periodic supplies or an unknown total (Div 156): GP-020
 *   Dr bank (gross) / Cr CUSTOMER_PREPAYMENTS (net, GST code + tax, party) / Cr GST collected (tax).
 * GST-free supplies and genuine Div 99 security deposits are untaxed (GP-012 shape):
 *   Dr bank / Cr CUSTOMER_PREPAYMENTS (gross, party).
 * A single supply with a known total needs a full (deposit) tax invoice at receipt instead
 * (GP-021, GP-014) — refused here with that advice.
 *
 * applyPrepayment — applies what is left of a prepayment to the customer's final invoice: GP-022b
 *   Dr CUSTOMER_PREPAYMENTS (net, GST code + tax) / Dr GST collected (tax) / Cr AR (gross, party),
 * removing the GST already attributed at receipt, and allocates the AR credit to the invoice.
 */
import type { Database } from '@ledgerforce/db';
import { allocate, post, subledgerEntriesOf, type PostOptions } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { computeTax } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const SUPPLY_TYPES = [
  'progressive_periodic',
  'unknown_total',
  'gst_free',
  'security_deposit',
] as const;
export type SupplyType = (typeof SUPPLY_TYPES)[number];
const TAXED: readonly SupplyType[] = ['progressive_periodic', 'unknown_total'];

export type PrepaymentErrorCode = 'INVALID_PREPAYMENT' | 'NOTHING_TO_APPLY';

export class PrepaymentError extends Error {
  readonly code: PrepaymentErrorCode;
  constructor(code: PrepaymentErrorCode, message: string) {
    super(message);
    this.name = 'PrepaymentError';
    this.code = code;
  }
}

export interface PrepaymentView {
  readonly prepaymentId: string;
  readonly entryId: string;
  readonly replayed: boolean;
  readonly gross: string;
  readonly net: string;
  readonly tax: string;
  /** Net not yet applied to an invoice. */
  readonly unappliedNet: string;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

async function viewOf(
  trx: Trx,
  companyId: string,
  id: string,
  replayed: boolean,
  entryId?: string,
): Promise<PrepaymentView> {
  const r = (
    await sql<{
      id: string;
      entry_id: string;
      gross: string;
      net: string;
      tax: string;
      applied: string;
    }>`
      SELECT p.id::text, p.entry_id::text, p.gross::text, p.net::text, p.tax::text,
             coalesce((SELECT sum(a.net) FROM app.prepayment_application a WHERE a.prepayment_id = p.id), 0)::text AS applied
        FROM app.customer_prepayment p WHERE p.company_id = ${companyId} AND p.id = ${id}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!r)
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      `prepayment ${id} is not in company ${companyId}`,
    );
  return {
    prepaymentId: r.id,
    entryId: entryId ?? r.entry_id,
    replayed,
    gross: numeric(r.gross),
    net: numeric(r.net),
    tax: numeric(r.tax),
    unappliedNet: numeric(new Decimal(r.net).minus(r.applied)),
  };
}

export async function recordPrepayment(
  trx: Trx,
  c: {
    companyId: string;
    partyId: string;
    receiptDate: string;
    /** Amount received, GST included where taxed; ≤ 2 decimals. */
    gross: string;
    supplyType: string;
    depositTo: { accountId: string };
    /** Default GST. */
    taxCode?: string;
    idempotencyKey: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<PrepaymentView> {
  const companyId = c.companyId.toLowerCase();
  const existing = await trx
    .selectFrom('app.customer_prepayment')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return viewOf(trx, companyId, existing.id, true);
  if (c.supplyType === 'single') {
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      'a single supply with a known total needs a deposit tax invoice for the whole supply at receipt (GP-021, GP-014)',
    );
  }
  if (!(SUPPLY_TYPES as readonly string[]).includes(c.supplyType)) {
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      `supply type must be one of ${SUPPLY_TYPES.join(', ')}`,
    );
  }
  if (!AMOUNT_RE.test(c.gross) || !new Decimal(c.gross).gt(0)) {
    throw new PrepaymentError('INVALID_PREPAYMENT', 'the amount must be > 0 with ≤ 2 decimals');
  }
  if (!DATE_RE.test(c.receiptDate))
    throw new PrepaymentError('INVALID_PREPAYMENT', 'receipt date is YYYY-MM-DD');
  const taxed = TAXED.includes(c.supplyType as SupplyType);
  let net = numeric(c.gross);
  let tax = '0.0000';
  let taxCodeId: string | null = null;
  if (taxed) {
    const code = (
      await sql<{ id: string; rate: string }>`
        SELECT id::text, rate::text FROM app.tax_code
         WHERE company_id = ${companyId} AND code = ${c.taxCode ?? 'GST'} AND status = 'active'
           AND effective_from <= ${c.receiptDate}::date
           AND (effective_to IS NULL OR effective_to >= ${c.receiptDate}::date)`.execute(trx)
    ).rows[0];
    if (!code)
      throw new PrepaymentError(
        'INVALID_PREPAYMENT',
        `tax code ${c.taxCode ?? 'GST'} is not in force`,
      );
    const company = await trx
      .selectFrom('app.company')
      .select('tax_rounding')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    const t = computeTax({
      pricing: 'inclusive',
      rounding: company.tax_rounding,
      lines: [{ amount: c.gross, rate: new Decimal(code.rate).toString() }],
    });
    net = t.net;
    tax = t.tax;
    taxCodeId = code.id;
  }
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-prepayment:${c.idempotencyKey}`,
      entryDate: c.receiptDate,
      sourceType: 'ar_prepayment',
      memo: `Prepayment (${c.supplyType})`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        { account: { id: c.depositTo.accountId }, debit: c.gross },
        {
          account: { role: 'CUSTOMER_PREPAYMENTS' },
          credit: net,
          ...(taxCodeId ? { taxCodeId, taxAmount: tax } : {}),
          partyId: c.partyId,
        },
        ...(taxed && !new Decimal(tax).isZero()
          ? [{ account: { role: 'GST_COLLECTED' }, credit: tax }]
          : []),
      ],
    },
    opts,
  );
  const row = await trx
    .insertInto('app.customer_prepayment')
    .values({
      company_id: companyId,
      party_id: c.partyId,
      receipt_date: c.receiptDate,
      supply_type: c.supplyType as SupplyType,
      gross: c.gross,
      net,
      tax,
      tax_code_id: taxCodeId,
      account_id: c.depositTo.accountId,
      idempotency_key: c.idempotencyKey,
      entry_id: posted.entryId,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return viewOf(trx, companyId, row.id, false);
}

/** Apply what is left of a prepayment to a posted invoice of the same customer (GP-022b). */
export async function applyPrepayment(
  trx: Trx,
  c: { companyId: string; prepaymentId: string; invoiceId: string; applicationDate: string },
  opts: PostOptions = {},
): Promise<PrepaymentView> {
  const companyId = c.companyId.toLowerCase();
  // lf_app cannot lock rows of this immutable table (no UPDATE): serialise applications of one
  // prepayment on a transaction advisory lock instead.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lf.prepayment:' + c.prepaymentId}, 0))`.execute(
    trx,
  );
  const p = await sql<{ party_id: string; tax_code_id: string | null }>`
    SELECT party_id::text, tax_code_id::text FROM app.customer_prepayment
     WHERE company_id = ${companyId} AND id = ${c.prepaymentId}::uuid`.execute(trx);
  const pre = p.rows[0];
  if (!pre)
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      `prepayment ${c.prepaymentId} is not in company ${companyId}`,
    );
  const before = await viewOf(trx, companyId, c.prepaymentId, false);
  const applyNet = new Decimal(before.unappliedNet);
  if (!applyNet.gt(0))
    throw new PrepaymentError('NOTHING_TO_APPLY', 'the prepayment is fully applied');
  const appliedTax =
    (
      await sql<{
        t: string;
      }>`SELECT coalesce(sum(tax), 0)::text AS t FROM app.prepayment_application
      WHERE prepayment_id = ${c.prepaymentId}::uuid`.execute(trx)
    ).rows[0]?.t ?? '0';
  const applyTax = new Decimal(before.tax).minus(appliedTax);
  const gross = applyNet.plus(applyTax);
  const inv = await trx
    .selectFrom('app.sales_invoice')
    .select(['party_id', 'status', 'entry_id'])
    .where('company_id', '=', companyId)
    .where('id', '=', c.invoiceId)
    .executeTakeFirst();
  if (!inv || inv.status !== 'posted' || !inv.entry_id || inv.party_id !== pre.party_id) {
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      `invoice ${c.invoiceId} is not a posted invoice of this customer`,
    );
  }
  const [invoiceItem] = await subledgerEntriesOf(trx, inv.entry_id);
  if (!invoiceItem || new Decimal(invoiceItem.openAmount).lt(gross)) {
    throw new PrepaymentError(
      'INVALID_PREPAYMENT',
      `the invoice's open amount is less than the prepayment ${numeric(gross)}`,
    );
  }
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-prepayment-apply:${c.prepaymentId}:${c.invoiceId}`,
      entryDate: c.applicationDate,
      sourceType: 'ar_prepayment_application',
      sourceId: c.prepaymentId,
      memo: 'Prepayment applied',
      lines: [
        {
          account: { role: 'CUSTOMER_PREPAYMENTS' },
          debit: numeric(applyNet),
          ...(pre.tax_code_id ? { taxCodeId: pre.tax_code_id, taxAmount: numeric(applyTax) } : {}),
          partyId: pre.party_id,
        },
        ...(applyTax.isZero()
          ? []
          : [{ account: { role: 'GST_COLLECTED' }, debit: numeric(applyTax) }]),
        { account: { role: 'AR_CONTROL' }, credit: numeric(gross), partyId: pre.party_id },
      ],
    },
    opts,
  );
  const [credit] = await subledgerEntriesOf(trx, posted.entryId);
  await allocate(trx, {
    companyId,
    idempotencyKey: `ar-prepayment-alloc:${posted.entryId}`,
    fromEntryId: credit?.id ?? '',
    toEntryId: invoiceItem.id,
    amount: numeric(gross),
    allocationDate: c.applicationDate,
  });
  await trx
    .insertInto('app.prepayment_application')
    .values({
      company_id: companyId,
      prepayment_id: c.prepaymentId,
      invoice_id: c.invoiceId,
      application_date: c.applicationDate,
      net: numeric(applyNet),
      tax: numeric(applyTax),
      entry_id: posted.entryId,
    })
    .execute();
  return viewOf(trx, companyId, c.prepaymentId, false, posted.entryId);
}
