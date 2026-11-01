/**
 * Supplier bills (T-0050, design §3.8 row 6, UC-05, GP-008, DL-0278).
 *
 * createBill records a draft from the supplier's tax invoice: per line an expense or asset
 * account, an amount ex GST and a tax code (GST, GST-CAP for capital acquisitions, GST-FREE …);
 * GST by computeTax with the company's rounding. The supplier's invoice number is unique per
 * supplier (DUPLICATE_BILL). approveBill posts through the engine (source ap_bill):
 *   Dr account per (account, tax code) (net, tax code + tax, party) / Dr GST paid (tax)
 *   / Cr AP control (gross, party, due date)
 * — exactly GP-008 — with a BILL- number from the gapless ap_bill_document series. Period rules
 * apply (an AP-locked period refuses the bill: PERIOD_LOCKED). suggestCoding proposes the most
 * used account and tax code of the supplier's last three posted bills (SS-UC05-02).
 * The approval workflow with segregation of duties is T-0052.
 */
import type { Database } from '@ledgerforce/db';
import { nextNumber, post, type PostingLineInput, type PostOptions } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { computeTax } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const BILL_NUMBER_SERIES = 'ap_bill_document';
const DEFAULT_TERMS_DAYS = 30;

export type BillErrorCode = 'INVALID_BILL' | 'DUPLICATE_BILL' | 'NOT_DRAFT' | 'NOT_SUBMITTED';

export class BillError extends Error {
  readonly code: BillErrorCode;
  constructor(code: BillErrorCode, message: string) {
    super(message);
    this.name = 'BillError';
    this.code = code;
  }
}

export interface Coding {
  readonly accountId: string;
  readonly taxCode: string;
}

/**
 * The most used (account, tax code) among the last three bills (newest first by bill date); a tie
 * goes to the coding found first scanning from the newest bill. Undefined without history.
 */
export function suggestFromHistory(
  history: readonly { billDate: string; lines: readonly Coding[] }[],
): Coding | undefined {
  const recent = [...history]
    .sort((a, b) => (a.billDate < b.billDate ? 1 : a.billDate > b.billDate ? -1 : 0))
    .slice(0, 3);
  const counts = new Map<string, { coding: Coding; n: number; first: number }>();
  let order = 0;
  for (const bill of recent) {
    for (const l of bill.lines) {
      const key = `${l.accountId}|${l.taxCode}`;
      const cur = counts.get(key) ?? {
        coding: { accountId: l.accountId, taxCode: l.taxCode },
        n: 0,
        first: order++,
      };
      cur.n += 1;
      counts.set(key, cur);
    }
  }
  let best: { coding: Coding; n: number; first: number } | undefined;
  for (const c of counts.values()) {
    if (!best || c.n > best.n || (c.n === best.n && c.first < best.first)) best = c;
  }
  return best?.coding;
}

export async function suggestCoding(
  trx: Trx,
  q: { companyId: string; partyId: string },
): Promise<Coding | undefined> {
  const bills = await sql<{ id: string; bill_date: string }>`
    SELECT id::text, to_char(bill_date, 'YYYY-MM-DD') AS bill_date FROM app.supplier_bill
     WHERE company_id = ${q.companyId.toLowerCase()} AND party_id = ${q.partyId}::uuid AND status = 'posted'
     ORDER BY bill_date DESC, created_at DESC LIMIT 3`.execute(trx);
  const history = [];
  for (const b of bills.rows) {
    const lines = await trx
      .selectFrom('app.supplier_bill_line')
      .select(['account_id', 'tax_code'])
      .where('bill_id', '=', b.id)
      .orderBy('line_no')
      .execute();
    history.push({
      billDate: b.bill_date,
      lines: lines.map((l) => ({ accountId: l.account_id, taxCode: l.tax_code })),
    });
  }
  return suggestFromHistory(history);
}

export interface BillLineInput {
  readonly accountId: string;
  readonly description: string;
  /** Ex GST, decimal string ≥ 0, ≤ 2 decimals. */
  readonly amount: string;
  readonly taxCode: string;
}

export interface BillInput {
  readonly companyId: string;
  /** Client-chosen id (the API's PUT /ap/bills/:id); a repeat returns the existing bill. */
  readonly id?: string;
  readonly partyId: string;
  readonly supplierRef: string;
  readonly billDate: string;
  readonly dueDate?: string;
  readonly createdBy?: string;
  readonly lines: readonly BillLineInput[];
}

export interface BillView {
  readonly billId: string;
  readonly status: 'draft' | 'posted' | 'void';
  readonly billNo: string | null;
  readonly entryId: string | null;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function priceLines(
  trx: Trx,
  companyId: string,
  billDate: string,
  lines: readonly BillLineInput[],
) {
  const codes = [...new Set(lines.map((l) => l.taxCode))];
  const rates = new Map(
    (
      await sql<{ code: string; id: string; rate: string }>`
        SELECT code, id::text, rate::text FROM app.tax_code
         WHERE company_id = ${companyId} AND status = 'active' AND code = ANY(${sql.val(codes)}::text[])
           AND effective_from <= ${billDate}::date AND (effective_to IS NULL OR effective_to >= ${billDate}::date)`.execute(
        trx,
      )
    ).rows.map((r) => [r.code, r]),
  );
  for (const [i, l] of lines.entries()) {
    if (!rates.has(l.taxCode)) {
      throw new BillError(
        'INVALID_BILL',
        `line ${String(i + 1)}: tax code ${l.taxCode} is not in force on ${billDate}`,
      );
    }
  }
  const company = await trx
    .selectFrom('app.company')
    .select('tax_rounding')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const taxed = computeTax({
    pricing: 'exclusive',
    rounding: company.tax_rounding,
    lines: lines.map((l) => ({
      amount: l.amount,
      rate: new Decimal(rates.get(l.taxCode)?.rate ?? '0').toString(),
    })),
  });
  return { taxed, rates };
}

export async function createBill(trx: Trx, c: BillInput): Promise<BillView> {
  const companyId = c.companyId.toLowerCase();
  if (c.id) {
    const existing = await getBill(trx, companyId, c.id).catch(() => null);
    if (existing) return existing;
  }
  if (!DATE_RE.test(c.billDate) || (c.dueDate !== undefined && !DATE_RE.test(c.dueDate))) {
    throw new BillError('INVALID_BILL', 'bill and due dates are YYYY-MM-DD');
  }
  if (c.lines.length === 0) throw new BillError('INVALID_BILL', 'a bill needs at least one line');
  const role = await trx
    .selectFrom('app.party_role')
    .select('active')
    .where('company_id', '=', companyId)
    .where('party_id', '=', c.partyId)
    .where('role', '=', 'supplier')
    .executeTakeFirst();
  if (!role?.active)
    throw new BillError('INVALID_BILL', `party ${c.partyId} is not an active supplier`);
  const dup = await trx
    .selectFrom('app.supplier_bill')
    .select(['id', 'bill_no'])
    .where('company_id', '=', companyId)
    .where('party_id', '=', c.partyId)
    .where('supplier_ref', '=', c.supplierRef.trim())
    .executeTakeFirst();
  if (dup) {
    throw new BillError(
      'DUPLICATE_BILL',
      `supplier invoice ${c.supplierRef} is already entered (${dup.bill_no ?? dup.id})`,
    );
  }
  for (const [i, l] of c.lines.entries()) {
    if (!AMOUNT_RE.test(l.amount))
      throw new BillError('INVALID_BILL', `line ${String(i + 1)}: amount ≥ 0 with ≤ 2 decimals`);
    const a = await trx
      .selectFrom('app.account')
      .select(['type', 'postable', 'is_control', 'status'])
      .where('company_id', '=', companyId)
      .where('id', '=', l.accountId)
      .executeTakeFirst();
    if (
      !a ||
      a.status !== 'active' ||
      !a.postable ||
      a.is_control ||
      !['expense', 'asset'].includes(a.type)
    ) {
      throw new BillError(
        'INVALID_BILL',
        `line ${String(i + 1)}: account must be an active postable expense or asset account`,
      );
    }
  }
  const { taxed, rates } = await priceLines(trx, companyId, c.billDate, c.lines);
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const header = await trx
    .insertInto('app.supplier_bill')
    .values({
      ...(c.id ? { id: c.id.toLowerCase() } : {}),
      company_id: companyId,
      party_id: c.partyId,
      supplier_ref: c.supplierRef.trim(),
      bill_date: c.billDate,
      due_date: c.dueDate ?? addDays(c.billDate, DEFAULT_TERMS_DAYS),
      currency: company.base_currency,
      net_total: taxed.net,
      tax_total: taxed.tax,
      gross_total: taxed.gross,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.supplier_bill_line')
    .values(
      c.lines.map((l, i) => ({
        company_id: companyId,
        bill_id: header.id,
        line_no: i + 1,
        account_id: l.accountId,
        description: l.description,
        amount: l.amount,
        tax_code: l.taxCode,
        tax_code_id: rates.get(l.taxCode)?.id ?? null,
      })),
    )
    .execute();
  return {
    billId: header.id,
    status: 'draft',
    billNo: null,
    entryId: null,
    net: taxed.net,
    tax: taxed.tax,
    gross: taxed.gross,
  };
}

/** Approve a draft bill and post it (GP-008). */
export async function approveBill(
  trx: Trx,
  c: { companyId: string; billId: string; approvedBy?: string },
  opts: PostOptions = {},
): Promise<BillView> {
  const companyId = c.companyId.toLowerCase();
  const h = (
    await sql<{
      id: string;
      status: string;
      party_id: string;
      bill_date: string;
      due_date: string;
      supplier_ref: string;
      created_by: string | null;
      submitted_at: Date | null;
    }>`
      SELECT id::text, status, party_id::text, submitted_at, to_char(bill_date, 'YYYY-MM-DD') AS bill_date,
             to_char(due_date, 'YYYY-MM-DD') AS due_date, supplier_ref, created_by::text
        FROM app.supplier_bill WHERE company_id = ${companyId} AND id = ${c.billId}::uuid FOR UPDATE`.execute(
      trx,
    )
  ).rows[0];
  if (!h) throw new BillError('INVALID_BILL', `bill ${c.billId} is not in company ${companyId}`);
  if (h.status !== 'draft') throw new BillError('NOT_DRAFT', `bill ${c.billId} is ${h.status}`);
  if (!h.submitted_at) {
    throw new BillError('NOT_SUBMITTED', `bill ${c.billId} has not been submitted for approval`);
  }
  const rows = await trx
    .selectFrom('app.supplier_bill_line')
    .select(['line_no', 'account_id', 'description', 'amount', 'tax_code'])
    .where('bill_id', '=', h.id)
    .orderBy('line_no')
    .execute();
  const lines = rows.map((r) => ({
    accountId: r.account_id,
    description: r.description,
    amount: new Decimal(r.amount).toString(),
    taxCode: r.tax_code,
  }));
  const { taxed, rates } = await priceLines(trx, companyId, h.bill_date, lines);
  const groups = new Map<
    string,
    { accountId: string; taxCodeId: string; net: Decimal; tax: Decimal }
  >();
  lines.forEach((l, i) => {
    const taxCodeId = rates.get(l.taxCode)?.id ?? '';
    const key = `${l.accountId}:${taxCodeId}`;
    const g = groups.get(key) ?? {
      accountId: l.accountId,
      taxCodeId,
      net: new Decimal(0),
      tax: new Decimal(0),
    };
    g.net = g.net.plus(taxed.lines[i]?.net ?? '0');
    g.tax = g.tax.plus(taxed.lines[i]?.tax ?? '0');
    groups.set(key, g);
  });
  const journal: PostingLineInput[] = [
    ...[...groups.values()]
      .filter((g) => !g.net.isZero())
      .map((g) => ({
        account: { id: g.accountId },
        debit: numeric(g.net),
        taxCodeId: g.taxCodeId,
        taxAmount: numeric(g.tax),
        partyId: h.party_id,
      })),
    ...(new Decimal(taxed.tax).isZero()
      ? []
      : [{ account: { role: 'GST_PAID' }, debit: taxed.tax }]),
    {
      account: { role: 'AP_CONTROL' },
      credit: taxed.gross,
      partyId: h.party_id,
      dueDate: h.due_date,
    },
  ];
  const billNo = await nextNumber(trx, companyId, BILL_NUMBER_SERIES);
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ap-bill:${h.id}`,
      entryDate: h.bill_date,
      sourceType: 'ap_bill',
      sourceId: h.id,
      memo: `Bill ${billNo} (${h.supplier_ref})`,
      ...(h.created_by ? { createdBy: h.created_by } : {}),
      ...(c.approvedBy ? { approvedBy: c.approvedBy } : {}),
      lines: journal,
    },
    opts,
  );
  for (const [i, r] of rows.entries()) {
    await trx
      .updateTable('app.supplier_bill_line')
      .set({
        net: taxed.lines[i]?.net ?? '0',
        tax: taxed.lines[i]?.tax ?? '0',
        gross: taxed.lines[i]?.gross ?? '0',
      })
      .where('bill_id', '=', h.id)
      .where('line_no', '=', r.line_no)
      .execute();
  }
  await trx
    .updateTable('app.supplier_bill')
    .set({
      status: 'posted',
      bill_no: billNo,
      entry_id: posted.entryId,
      net_total: taxed.net,
      tax_total: taxed.tax,
      gross_total: taxed.gross,
      approved_by: c.approvedBy ?? null,
      approved_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', h.id)
    .execute();
  return {
    billId: h.id,
    status: 'posted',
    billNo,
    entryId: posted.entryId,
    net: taxed.net,
    tax: taxed.tax,
    gross: taxed.gross,
  };
}

export interface BillSummary extends BillView {
  readonly partyId: string;
  readonly supplierRef: string;
  readonly billDate: string;
  readonly submittedAt: Date | null;
  readonly createdBy: string | null;
}

/** One bill of the company. */
export async function getBill(trx: Trx, companyId: string, billId: string): Promise<BillSummary> {
  const r = (
    await sql<{
      id: string;
      status: 'draft' | 'posted' | 'void';
      bill_no: string | null;
      entry_id: string | null;
      net_total: string;
      tax_total: string;
      gross_total: string;
      party_id: string;
      supplier_ref: string;
      bill_date: string;
      submitted_at: Date | null;
      created_by: string | null;
    }>`
      SELECT id::text, status, bill_no, entry_id::text, net_total::text, tax_total::text, gross_total::text,
             party_id::text, supplier_ref, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, submitted_at, created_by::text
        FROM app.supplier_bill WHERE company_id = ${companyId.toLowerCase()} AND id = ${billId}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!r) throw new BillError('INVALID_BILL', `bill ${billId} is not in company ${companyId}`);
  return {
    billId: r.id,
    status: r.status,
    billNo: r.bill_no,
    entryId: r.entry_id,
    net: r.net_total,
    tax: r.tax_total,
    gross: r.gross_total,
    partyId: r.party_id,
    supplierRef: r.supplier_ref,
    billDate: r.bill_date,
    submittedAt: r.submitted_at,
    createdBy: r.created_by,
  };
}

/** Submit a coded draft for approval (UC-05: AP Clerk → Approver queue). Nothing posts. */
export async function submitBill(
  trx: Trx,
  c: { companyId: string; billId: string; submittedBy?: string },
): Promise<BillSummary> {
  const companyId = c.companyId.toLowerCase();
  const r = await trx
    .updateTable('app.supplier_bill')
    .set({
      submitted_by: c.submittedBy ?? null,
      submitted_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('company_id', '=', companyId)
    .where('id', '=', c.billId)
    .where('status', '=', 'draft')
    .where('submitted_at', 'is', null)
    .executeTakeFirst();
  if (r.numUpdatedRows !== 1n) {
    throw new BillError('NOT_DRAFT', `bill ${c.billId} is not an unsubmitted draft`);
  }
  return getBill(trx, companyId, c.billId);
}

/** The Approver's queue: submitted drafts, oldest first. */
export async function billsAwaitingApproval(trx: Trx, companyId: string): Promise<BillSummary[]> {
  const ids = await trx
    .selectFrom('app.supplier_bill')
    .select('id')
    .where('company_id', '=', companyId.toLowerCase())
    .where('status', '=', 'draft')
    .where('submitted_at', 'is not', null)
    .orderBy('submitted_at')
    .execute();
  const out: BillSummary[] = [];
  for (const r of ids) out.push(await getBill(trx, companyId, r.id));
  return out;
}
