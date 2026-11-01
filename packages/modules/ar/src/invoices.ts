/**
 * Sales invoices — draft → approve → post (T-0040, design §3.8 row 1, §4.2, UC-01, DL-0268).
 *
 * Draft: lines get their product profile (from the product, or given), amount = quantity × unit
 * price (cents, half-up) and a tax code (the line's, or the party × product matrix's). A
 * combination that does not resolve is a PROFILE_GAP *warning* on the draft — it never posts.
 * With auto-approve on and the gross within the threshold, a clean draft is approved at once.
 *
 * Approval (one transaction): Billing To contact required (NO_BILLING_TO), every line must
 * resolve (PROFILE_GAP), the credit-hold hook must pass (CREDIT_HOLD: open AR + this invoice over
 * the party's credit limit), GST from computeTax with the company's tax_rounding and the
 * invoice's pricing, then the journal goes through the posting engine (never written here):
 *   Dr AR control (gross, party, due date) / Cr revenue per (account, tax code) in line order
 *   (net, with tax code and tax, party) / Cr GST collected (total GST) — exactly GP-001, GP-023.
 * The invoice gets its INV-… number from the gapless ar_invoice_document series, is frozen by the
 * database, and an `ar.invoice.posted` event names the Billing To recipients (email delivery is
 * T-0042). Segregation of duties is applied by the API before calling approve (as for journals).
 */
import type { Database } from '@ledgerforce/db';
import { nextNumber, post, type PostingLineInput, type PostOptions } from '@ledgerforce/ledger';
import { resolvePosting } from '@ledgerforce/products';
import { Money } from '@ledgerforce/shared/money';
import { computeTax } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const INVOICE_NUMBER_SERIES = 'ar_invoice_document';
export const INVOICE_POSTED = 'ar.invoice.posted';
const DEFAULT_TERMS_DAYS = 14;

export type InvoiceErrorCode =
  'INVALID_INVOICE' | 'NOT_DRAFT' | 'NO_BILLING_TO' | 'PROFILE_GAP' | 'CREDIT_HOLD';

export class InvoiceError extends Error {
  readonly code: InvoiceErrorCode;
  constructor(code: InvoiceErrorCode, message: string) {
    super(message);
    this.name = 'InvoiceError';
    this.code = code;
  }
}

export interface DocumentEvent {
  readonly companyId: string;
  readonly topic: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/** Where document events go: production wires @ledgerforce/outbox `enqueue` (same transaction). */
export interface DocumentOutbox {
  publish(trx: Trx, event: DocumentEvent): Promise<void>;
}

export interface InvoiceDeps {
  readonly outbox: DocumentOutbox;
  /** The posting engine's outbox (ledger.entry.posted); defaults to none. */
  readonly posting?: PostOptions;
}

export interface DraftLineInput {
  readonly productId?: string;
  /** Required when there is no product. */
  readonly productProfileId?: string;
  readonly description: string;
  /** Decimal strings; quantity > 0, unit price ≥ 0. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxCode?: string;
}

export interface DraftInvoiceInput {
  readonly companyId: string;
  readonly partyId: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly pricing?: 'exclusive' | 'inclusive';
  readonly reference?: string;
  /** Idempotency of the source (e.g. a Salesforce Opportunity), unique per company. */
  readonly sourceKey?: string;
  /** 'deposit': a deposit tax invoice crediting CUSTOMER_PREPAYMENTS (GP-014, Q10). */
  readonly kind?: 'standard' | 'deposit';
  /** Posted deposit invoices of the same customer this final invoice nets off (GP-015). */
  readonly depositInvoiceIds?: readonly string[];
  readonly createdBy?: string;
  readonly lines: readonly DraftLineInput[];
}

export interface InvoiceWarning {
  readonly code: 'PROFILE_GAP';
  readonly line: number;
  readonly reason: string;
  readonly message: string;
}

export interface InvoiceView {
  readonly invoiceId: string;
  readonly status: 'draft' | 'posted' | 'void';
  readonly invoiceNo: string | null;
  readonly entryId: string | null;
  /** NUMERIC(19,4) text; null while a draft cannot be priced (a line does not resolve). */
  readonly net: string | null;
  readonly tax: string | null;
  readonly gross: string | null;
  readonly warnings: readonly InvoiceWarning[];
}

const DECIMAL_RE = /^\d{1,15}(\.\d{1,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface LineRow {
  line_no: number;
  product_profile_id: string;
  amount: string;
  tax_code: string | null;
}

export interface Priced {
  readonly lines: readonly {
    lineNo: number;
    accountId: string;
    taxCode: string;
    taxCodeId: string;
    net: string;
    tax: string;
    gross: string;
  }[];
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
  readonly controlAccountId: string;
}

/** Resolve and price an invoice's lines. Returns warnings instead when a line does not resolve. */
export async function priceInvoiceLines(
  trx: Trx,
  companyId: string,
  inv: { party_id: string; issue_date: string; pricing: 'exclusive' | 'inclusive' },
  lines: readonly LineRow[],
): Promise<{ priced: Priced | null; warnings: InvoiceWarning[] }> {
  const party = await trx
    .selectFrom('app.party')
    .select('customer_profile_id')
    .where('company_id', '=', companyId)
    .where('id', '=', inv.party_id)
    .executeTakeFirst();
  const warnings: InvoiceWarning[] = [];
  const resolved: { lineNo: number; accountId: string; taxCode: string; amount: string }[] = [];
  let controlAccountId = '';
  for (const l of lines) {
    if (!party?.customer_profile_id) {
      warnings.push({
        code: 'PROFILE_GAP',
        line: l.line_no,
        reason: 'profile',
        message: 'the customer has no party posting profile',
      });
      continue;
    }
    const r = await resolvePosting(trx, companyId, {
      partyProfileId: party.customer_profile_id,
      productProfileId: l.product_profile_id,
      purpose: 'sale',
      date: inv.issue_date,
    });
    if (!r.ok) {
      warnings.push({
        code: 'PROFILE_GAP',
        line: l.line_no,
        reason: r.gap.reason,
        message: r.gap.message,
      });
      continue;
    }
    controlAccountId = r.controlAccountId;
    resolved.push({
      lineNo: l.line_no,
      accountId: r.accountId,
      taxCode: l.tax_code ?? r.taxCode,
      amount: l.amount,
    });
  }
  if (warnings.length > 0) return { priced: null, warnings };

  const company = await trx
    .selectFrom('app.company')
    .select('tax_rounding')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const codes = [...new Set(resolved.map((l) => l.taxCode))];
  const rates = new Map(
    (
      await sql<{ code: string; id: string; rate: string }>`
        SELECT code, id::text, rate::text FROM app.tax_code
         WHERE company_id = ${companyId} AND status = 'active' AND code = ANY(${sql.val(codes)}::text[])
           AND effective_from <= ${inv.issue_date}::date
           AND (effective_to IS NULL OR effective_to >= ${inv.issue_date}::date)`.execute(trx)
    ).rows.map((r) => [r.code, r]),
  );
  for (const l of resolved) {
    if (!rates.has(l.taxCode)) {
      warnings.push({
        code: 'PROFILE_GAP',
        line: l.lineNo,
        reason: 'tax_code',
        message: `tax code ${l.taxCode} is not active and in force on ${inv.issue_date}`,
      });
    }
  }
  if (warnings.length > 0) return { priced: null, warnings };

  const taxed = computeTax({
    pricing: inv.pricing,
    rounding: company.tax_rounding,
    lines: resolved.map((l) => ({
      amount: cents(new Decimal(l.amount)).toString(),
      rate: new Decimal(rates.get(l.taxCode)?.rate ?? '0').toString(),
    })),
  });
  return {
    priced: {
      lines: resolved.map((l, i) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        taxCode: l.taxCode,
        taxCodeId: rates.get(l.taxCode)?.id ?? '',
        net: taxed.lines[i]?.net ?? '0',
        tax: taxed.lines[i]?.tax ?? '0',
        gross: taxed.lines[i]?.gross ?? '0',
      })),
      net: taxed.net,
      tax: taxed.tax,
      gross: taxed.gross,
      controlAccountId,
    },
    warnings,
  };
}

async function loadInvoice(trx: Trx, companyId: string, invoiceId: string, lock: boolean) {
  const q = sql<{
    id: string;
    party_id: string;
    status: 'draft' | 'posted' | 'void';
    invoice_no: string | null;
    issue_date: string;
    due_date: string;
    pricing: 'exclusive' | 'inclusive';
    entry_id: string | null;
    created_by: string | null;
    net_total: string | null;
    tax_total: string | null;
    gross_total: string | null;
    warnings: InvoiceWarning[];
    kind: 'standard' | 'deposit';
  }>`
    SELECT id::text, party_id::text, status, invoice_no, kind, to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, pricing, entry_id::text, created_by::text,
           net_total::text, tax_total::text, gross_total::text, warnings
      FROM app.sales_invoice WHERE company_id = ${companyId} AND id = ${invoiceId}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}`;
  const inv = (await q.execute(trx)).rows[0];
  if (!inv)
    throw new InvoiceError(
      'INVALID_INVOICE',
      `invoice ${invoiceId} is not in company ${companyId}`,
    );
  const lines = await trx
    .selectFrom('app.sales_invoice_line')
    .select(['line_no', 'product_profile_id', 'amount', 'tax_code'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('line_no')
    .execute();
  return { inv, lines };
}

function view(
  inv: {
    id: string;
    status: 'draft' | 'posted' | 'void';
    invoice_no: string | null;
    entry_id: string | null;
  },
  totals: { net: string | null; tax: string | null; gross: string | null },
  warnings: readonly InvoiceWarning[],
): InvoiceView {
  return {
    invoiceId: inv.id,
    status: inv.status,
    invoiceNo: inv.invoice_no,
    entryId: inv.entry_id,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    warnings,
  };
}

/** Create a draft invoice; approve it at once when auto-approve allows (UC-01). */
export async function createDraftInvoice(
  trx: Trx,
  input: DraftInvoiceInput,
  deps: InvoiceDeps,
): Promise<InvoiceView> {
  const companyId = input.companyId.toLowerCase();
  if (input.lines.length === 0)
    throw new InvoiceError('INVALID_INVOICE', 'an invoice needs at least one line');
  if (
    !DATE_RE.test(input.issueDate) ||
    (input.dueDate !== undefined && !DATE_RE.test(input.dueDate))
  ) {
    throw new InvoiceError('INVALID_INVOICE', 'issue and due dates are YYYY-MM-DD');
  }
  const customer = await trx
    .selectFrom('app.party_role')
    .select('active')
    .where('company_id', '=', companyId)
    .where('party_id', '=', input.partyId)
    .where('role', '=', 'customer')
    .executeTakeFirst();
  if (!customer?.active) {
    throw new InvoiceError('INVALID_INVOICE', `party ${input.partyId} is not an active customer`);
  }
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();

  const lines: (LineRow & {
    description: string;
    quantity: string;
    unit_price: string;
    product_id: string | null;
  })[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    if (
      !DECIMAL_RE.test(l.quantity) ||
      new Decimal(l.quantity).isZero() ||
      !DECIMAL_RE.test(l.unitPrice)
    ) {
      throw new InvoiceError(
        'INVALID_INVOICE',
        `line ${String(n)}: quantity > 0 and unit price ≥ 0, ≤ 4 decimals`,
      );
    }
    let profileId = l.productProfileId;
    let taxCode = l.taxCode ?? null;
    if (l.productId) {
      const p = await trx
        .selectFrom('app.product')
        .select(['product_profile_id', 'tax_code', 'status'])
        .where('company_id', '=', companyId)
        .where('id', '=', l.productId)
        .executeTakeFirst();
      if (!p || p.status !== 'active') {
        throw new InvoiceError(
          'INVALID_INVOICE',
          `line ${String(n)}: product ${l.productId} is not active`,
        );
      }
      profileId = profileId ?? p.product_profile_id;
      taxCode = taxCode ?? p.tax_code;
    }
    if (!profileId) {
      throw new InvoiceError(
        'INVALID_INVOICE',
        `line ${String(n)}: a product or a product profile is required`,
      );
    }
    lines.push({
      line_no: n,
      product_id: l.productId ?? null,
      product_profile_id: profileId,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      amount: numeric(cents(new Decimal(l.quantity).times(l.unitPrice))),
      tax_code: taxCode,
    });
  }

  const pricing = input.pricing ?? 'exclusive';
  const { priced, warnings } = await priceInvoiceLines(
    trx,
    companyId,
    { party_id: input.partyId, issue_date: input.issueDate, pricing },
    lines,
  );
  const header = await trx
    .insertInto('app.sales_invoice')
    .values({
      company_id: companyId,
      party_id: input.partyId,
      issue_date: input.issueDate,
      due_date: input.dueDate ?? addDays(input.issueDate, DEFAULT_TERMS_DAYS),
      pricing,
      currency: company.base_currency,
      reference: input.reference ?? null,
      source_key: input.sourceKey ?? null,
      kind: input.kind ?? 'standard',
      created_by: input.createdBy ?? null,
      warnings: JSON.stringify(warnings),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.sales_invoice_line')
    .values(
      lines.map((l) => ({
        company_id: companyId,
        invoice_id: header.id,
        line_no: l.line_no,
        product_id: l.product_id,
        product_profile_id: l.product_profile_id,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        amount: l.amount,
        tax_code: l.tax_code ?? priced?.lines.find((p) => p.lineNo === l.line_no)?.taxCode ?? null,
      })),
    )
    .execute();

  for (const depositId of input.depositInvoiceIds ?? []) {
    const dep = await trx
      .selectFrom('app.sales_invoice')
      .select(['party_id', 'status', 'kind', 'net_total', 'tax_total'])
      .where('company_id', '=', companyId)
      .where('id', '=', depositId)
      .executeTakeFirst();
    if (
      !dep ||
      dep.status !== 'posted' ||
      dep.kind !== 'deposit' ||
      dep.party_id !== input.partyId
    ) {
      throw new InvoiceError(
        'INVALID_INVOICE',
        `deposit ${depositId} is not a posted deposit invoice of this customer`,
      );
    }
    const depLine = await trx
      .selectFrom('app.sales_invoice_line')
      .select('tax_code_id')
      .where('invoice_id', '=', depositId)
      .orderBy('line_no')
      .executeTakeFirst();
    await trx
      .insertInto('app.sales_invoice_deposit')
      .values({
        company_id: companyId,
        invoice_id: header.id,
        deposit_invoice_id: depositId,
        net: dep.net_total ?? '0',
        tax: dep.tax_total ?? '0',
        tax_code_id: depLine?.tax_code_id ?? null,
      })
      .execute();
  }

  const draft = view(
    { id: header.id, status: 'draft', invoice_no: null, entry_id: null },
    { net: priced?.net ?? null, tax: priced?.tax ?? null, gross: priced?.gross ?? null },
    warnings,
  );
  if (!priced) return draft;
  const settings = await trx
    .selectFrom('app.ar_settings')
    .select(['auto_approve', 'auto_approve_threshold'])
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  const within =
    settings?.auto_approve === true &&
    settings.auto_approve_threshold !== null &&
    new Decimal(priced.gross).lte(settings.auto_approve_threshold);
  if (!within) return draft;
  try {
    return await approveInvoice(trx, { companyId, invoiceId: header.id }, deps);
  } catch (e) {
    // Auto-approval is best effort: a draft that cannot be approved (e.g. NO_BILLING_TO) stays a
    // draft for a person. These checks run before anything is written.
    if (e instanceof InvoiceError) return draft;
    throw e;
  }
}

/** Approve a draft invoice and post it through the posting engine (same transaction). */
export async function approveInvoice(
  trx: Trx,
  c: { companyId: string; invoiceId: string; approvedBy?: string },
  deps: InvoiceDeps,
): Promise<InvoiceView> {
  const companyId = c.companyId.toLowerCase();
  const { inv, lines } = await loadInvoice(trx, companyId, c.invoiceId, true);
  if (inv.status !== 'draft') {
    throw new InvoiceError('NOT_DRAFT', `invoice ${inv.invoice_no ?? inv.id} is ${inv.status}`);
  }
  const recipients = (
    await sql<{ email: string }>`
      SELECT c.email FROM app.party_contact_role r
        JOIN app.party_contact c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
       WHERE r.company_id = ${companyId} AND r.party_id = ${inv.party_id}::uuid
         AND r.role = 'billing_to' AND r.active AND c.status = 'active' AND c.email IS NOT NULL
       ORDER BY c.email`.execute(trx)
  ).rows.map((r) => r.email);
  if (recipients.length === 0) {
    throw new InvoiceError(
      'NO_BILLING_TO',
      'the customer has no active Billing To contact with an email address',
    );
  }
  const resolved = await priceInvoiceLines(trx, companyId, inv, lines);
  if (!resolved.priced) {
    throw new InvoiceError(
      'PROFILE_GAP',
      resolved.warnings.map((w) => `line ${String(w.line)}: ${w.message}`).join('; '),
    );
  }
  let priced: Priced = resolved.priced;
  // Deposit invoices credit customer prepayments instead of revenue (GP-014, Q10).
  if (inv.kind === 'deposit') {
    const prepayments = await trx
      .selectFrom('app.account_system_role')
      .select('account_id')
      .where('company_id', '=', companyId)
      .where('role', '=', 'CUSTOMER_PREPAYMENTS')
      .executeTakeFirstOrThrow();
    priced = {
      ...priced,
      lines: priced.lines.map((l) => ({ ...l, accountId: prepayments.account_id })),
    };
  }
  // Deposits this final invoice nets off (GP-015): Dr customer prepayments, less GST.
  const deposits = await trx
    .selectFrom('app.sales_invoice_deposit')
    .select(['net', 'tax', 'tax_code_id'])
    .where('invoice_id', '=', inv.id)
    .execute();
  const depNet = deposits.reduce((s, d) => s.plus(d.net), new Decimal(0));
  const depTax = deposits.reduce((s, d) => s.plus(d.tax), new Decimal(0));
  const totals = {
    net: numeric(new Decimal(priced.net).minus(depNet)),
    tax: numeric(new Decimal(priced.tax).minus(depTax)),
    gross: numeric(new Decimal(priced.gross).minus(depNet).minus(depTax)),
  };
  if (!new Decimal(totals.gross).gt(0) || new Decimal(totals.tax).isNegative()) {
    throw new InvoiceError('INVALID_INVOICE', 'deposits applied exceed the invoice');
  }
  await creditHold(trx, companyId, inv.party_id, totals.gross);

  const invoiceNo = await nextNumber(trx, companyId, INVOICE_NUMBER_SERIES);
  const revenue = new Map<
    string,
    { accountId: string; taxCodeId: string; net: Decimal; tax: Decimal }
  >();
  for (const l of priced.lines) {
    const key = `${l.accountId}:${l.taxCodeId}`;
    const cur = revenue.get(key) ?? {
      accountId: l.accountId,
      taxCodeId: l.taxCodeId,
      net: new Decimal(0),
      tax: new Decimal(0),
    };
    cur.net = cur.net.plus(l.net);
    cur.tax = cur.tax.plus(l.tax);
    revenue.set(key, cur);
  }
  const journal: PostingLineInput[] = [
    {
      account: { id: priced.controlAccountId },
      debit: totals.gross,
      partyId: inv.party_id,
      dueDate: inv.due_date,
    },
    ...deposits.map((d) => ({
      account: { role: 'CUSTOMER_PREPAYMENTS' },
      debit: numeric(d.net),
      ...(d.tax_code_id ? { taxCodeId: d.tax_code_id, taxAmount: numeric(d.tax) } : {}),
      partyId: inv.party_id,
    })),
    ...[...revenue.values()]
      .filter((r) => !r.net.isZero())
      .map((r) => ({
        account: { id: r.accountId },
        credit: numeric(r.net),
        taxCodeId: r.taxCodeId,
        taxAmount: numeric(r.tax),
        partyId: inv.party_id,
      })),
    ...(new Decimal(totals.tax).isZero()
      ? []
      : [{ account: { role: 'GST_COLLECTED' }, credit: totals.tax }]),
  ];
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-invoice:${inv.id}`,
      entryDate: inv.issue_date,
      sourceType: 'ar_invoice',
      sourceId: inv.id,
      memo: `Invoice ${invoiceNo}`,
      ...(inv.created_by ? { createdBy: inv.created_by } : {}),
      ...(c.approvedBy ? { approvedBy: c.approvedBy } : {}),
      lines: journal,
    },
    deps.posting ?? {},
  );

  for (const l of priced.lines) {
    await trx
      .updateTable('app.sales_invoice_line')
      .set({
        net: l.net,
        tax: l.tax,
        gross: l.gross,
        tax_code: l.taxCode,
        account_id: l.accountId,
        tax_code_id: l.taxCodeId,
      })
      .where('invoice_id', '=', inv.id)
      .where('line_no', '=', l.lineNo)
      .execute();
  }
  await trx
    .updateTable('app.sales_invoice')
    .set({
      status: 'posted',
      invoice_no: invoiceNo,
      entry_id: posted.entryId,
      net_total: totals.net,
      tax_total: totals.tax,
      gross_total: totals.gross,
      warnings: '[]',
      approved_by: c.approvedBy ?? null,
      approved_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', inv.id)
    .execute();
  await deps.outbox.publish(trx, {
    companyId,
    topic: INVOICE_POSTED,
    aggregateType: 'sales_invoice',
    aggregateId: inv.id,
    payload: {
      invoiceId: inv.id,
      invoiceNo,
      entryId: posted.entryId,
      partyId: inv.party_id,
      gross: totals.gross,
      recipients,
    },
  });
  return view(
    { id: inv.id, status: 'posted', invoice_no: invoiceNo, entry_id: posted.entryId },
    totals,
    [],
  );
}

/** Credit-hold hook (design §4.2): open AR plus this invoice must not exceed the credit limit. */
export async function creditHold(
  trx: Trx,
  companyId: string,
  partyId: string,
  gross: string,
): Promise<void> {
  const party = await trx
    .selectFrom('app.party')
    .select('credit_limit')
    .where('company_id', '=', companyId)
    .where('id', '=', partyId)
    .executeTakeFirst();
  if (party?.credit_limit === null || party?.credit_limit === undefined) return;
  const open =
    (
      await sql<{ open: string }>`
      SELECT coalesce(sum(base_open_amount), 0)::text AS open FROM app.subledger_entry
       WHERE company_id = ${companyId} AND party_id = ${partyId}::uuid AND control_role = 'AR_CONTROL'`.execute(
        trx,
      )
    ).rows[0]?.open ?? '0';
  const exposure = new Decimal(open).plus(gross);
  if (exposure.gt(party.credit_limit)) {
    throw new InvoiceError(
      'CREDIT_HOLD',
      `open receivables ${numeric(open)} plus this invoice ${numeric(gross)} exceed the credit limit ${numeric(party.credit_limit)}`,
    );
  }
}

/** AR settings (UC-01): auto-approve on/off and its gross threshold. */
export async function setArSettings(
  trx: Trx,
  companyId: string,
  s: { autoApprove: boolean; autoApproveThreshold?: string | null },
): Promise<void> {
  if (s.autoApproveThreshold != null && !DECIMAL_RE.test(s.autoApproveThreshold)) {
    throw new InvoiceError(
      'INVALID_INVOICE',
      'the auto-approve threshold is a non-negative amount',
    );
  }
  const values = {
    auto_approve: s.autoApprove,
    ...(s.autoApproveThreshold !== undefined
      ? { auto_approve_threshold: s.autoApproveThreshold }
      : {}),
  };
  await trx
    .insertInto('app.ar_settings')
    .values({ company_id: companyId, ...values })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'company_id'])
        .doUpdateSet({ ...values, updated_at: sql`clock_timestamp()` }),
    )
    .execute();
}
