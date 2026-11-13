/**
 * Read models for the bills screens (T-0086, UC-05, SS-UC05-08, DL-0440). Reads only — nothing
 * here writes a bill or the ledger:
 *   billCodingOptions — what an AP Clerk may code a bill to: active suppliers, active postable
 *     non-control expense/asset accounts (createBill's rule) and tax codes in force on a date;
 *   listBills         — every bill of the company with supplier and state, newest first;
 *   getBillDetail     — one bill with its coded lines and the people who entered, submitted and
 *     approved it (display names, times);
 *   billJournalView   — the journal behind a bill: the engine preview while it is a draft
 *     (previewBillJournal) and the posted entry once approved, as the same line shape.
 * Money stays NUMERIC text; the only arithmetic is decimal.js summing posted debits.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { BillError, previewBillJournal } from './bills.ts';

type Trx = Transaction<Database>;

export interface BillCodingOptions {
  readonly suppliers: readonly { id: string; name: string }[];
  readonly accounts: readonly { id: string; code: string; name: string; type: string }[];
  readonly taxCodes: readonly { code: string; name: string; rate: string }[];
}

export async function billCodingOptions(
  trx: Trx,
  q: { companyId: string; date: string },
): Promise<BillCodingOptions> {
  const companyId = q.companyId.toLowerCase();
  const suppliers = await sql<{ id: string; name: string }>`
    SELECT p.id::text, coalesce(p.trading_name, p.legal_name) AS name
      FROM app.party p JOIN app.party_role r ON r.company_id = p.company_id AND r.party_id = p.id
     WHERE p.company_id = ${companyId} AND r.role = 'supplier' AND r.active AND p.status = 'active'
     ORDER BY 2, 1`.execute(trx);
  const accounts = await sql<{ id: string; code: string; name: string; type: string }>`
    SELECT id::text, code, name, type FROM app.account
     WHERE company_id = ${companyId} AND status = 'active' AND postable AND NOT is_control
       AND type IN ('expense', 'asset')
     ORDER BY code`.execute(trx);
  const taxCodes = await sql<{ code: string; name: string; rate: string }>`
    SELECT code, name, rate::text FROM app.tax_code
     WHERE company_id = ${companyId} AND status = 'active'
       AND effective_from <= ${q.date}::date AND (effective_to IS NULL OR effective_to >= ${q.date}::date)
     ORDER BY code`.execute(trx);
  return { suppliers: suppliers.rows, accounts: accounts.rows, taxCodes: taxCodes.rows };
}

export interface BillListRow {
  readonly id: string;
  readonly billNo: string | null;
  readonly status: 'draft' | 'posted' | 'void';
  readonly awaitingApproval: boolean;
  readonly partyId: string;
  readonly supplierName: string;
  readonly supplierRef: string;
  readonly billDate: string;
  readonly dueDate: string;
  readonly gross: string;
}

interface HeaderRow {
  id: string;
  bill_no: string | null;
  status: 'draft' | 'posted' | 'void';
  submitted_at: Date | null;
  party_id: string;
  supplier_name: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  gross_total: string;
}

const HEADER = sql`
  b.id::text, b.bill_no, b.status, b.submitted_at, b.party_id::text,
  coalesce(p.trading_name, p.legal_name) AS supplier_name, b.supplier_ref,
  to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date, to_char(b.due_date, 'YYYY-MM-DD') AS due_date,
  b.gross_total::text`;

const rowOf = (r: HeaderRow): BillListRow => ({
  id: r.id,
  billNo: r.bill_no,
  status: r.status,
  awaitingApproval: r.status === 'draft' && r.submitted_at !== null,
  partyId: r.party_id,
  supplierName: r.supplier_name,
  supplierRef: r.supplier_ref,
  billDate: r.bill_date,
  dueDate: r.due_date,
  gross: r.gross_total,
});

/** Every bill of the company, newest bill date first. */
export async function listBills(trx: Trx, companyId: string): Promise<BillListRow[]> {
  const r = await sql<HeaderRow>`
    SELECT ${HEADER}
      FROM app.supplier_bill b JOIN app.party p ON p.company_id = b.company_id AND p.id = b.party_id
     WHERE b.company_id = ${companyId.toLowerCase()}
     ORDER BY b.bill_date DESC, b.created_at DESC, b.id`.execute(trx);
  return r.rows.map(rowOf);
}

export interface BillStep {
  /** The user id, or null when the step was taken by a service without a user. */
  readonly userId: string | null;
  readonly name: string;
  readonly at: Date;
}

export interface BillDetail extends BillListRow {
  readonly currency: string;
  readonly net: string;
  readonly tax: string;
  readonly entryId: string | null;
  readonly lines: readonly {
    lineNo: number;
    description: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    taxCode: string;
    amount: string;
    net: string | null;
    tax: string | null;
    gross: string | null;
  }[];
  readonly entered: BillStep;
  readonly submitted: BillStep | null;
  readonly approved: BillStep | null;
}

export async function getBillDetail(
  trx: Trx,
  q: { companyId: string; billId: string },
): Promise<BillDetail> {
  const companyId = q.companyId.toLowerCase();
  const h = (
    await sql<
      HeaderRow & {
        currency: string;
        net_total: string;
        tax_total: string;
        entry_id: string | null;
        created_by: string | null;
        created_at: Date;
        submitted_by: string | null;
        approved_by: string | null;
        approved_at: Date | null;
      }
    >`
      SELECT ${HEADER}, b.currency, b.net_total::text, b.tax_total::text, b.entry_id::text,
             b.created_by::text, b.created_at, b.submitted_by::text, b.approved_by::text, b.approved_at
        FROM app.supplier_bill b JOIN app.party p ON p.company_id = b.company_id AND p.id = b.party_id
       WHERE b.company_id = ${companyId} AND b.id = ${q.billId}::uuid`.execute(trx)
  ).rows[0];
  if (!h) throw new BillError('INVALID_BILL', `bill ${q.billId} is not in company ${companyId}`);
  const lines = await sql<{
    line_no: number;
    description: string;
    account_id: string;
    code: string;
    name: string;
    tax_code: string;
    amount: string;
    net: string | null;
    tax: string | null;
    gross: string | null;
  }>`
    SELECT l.line_no, l.description, l.account_id::text, a.code, a.name, l.tax_code,
           l.amount::text, l.net::text, l.tax::text, l.gross::text
      FROM app.supplier_bill_line l JOIN app.account a ON a.id = l.account_id
     WHERE l.bill_id = ${h.id}::uuid ORDER BY l.line_no`.execute(trx);
  const ids = [h.created_by, h.submitted_by, h.approved_by].filter((x): x is string => !!x);
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await sql<{ id: string; display_name: string }>`
            SELECT id::text, display_name FROM app.app_user WHERE id = ANY(${sql.val(ids)}::uuid[])`.execute(
            trx,
          )
        ).rows.map((u) => [u.id, u.display_name]),
  );
  const step = (userId: string | null, at: Date): BillStep => ({
    userId,
    name: userId ? (names.get(userId) ?? 'A former user') : 'LedgerForce',
    at,
  });
  return {
    ...rowOf(h),
    currency: h.currency,
    net: h.net_total,
    tax: h.tax_total,
    entryId: h.entry_id,
    lines: lines.rows.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      accountId: l.account_id,
      accountCode: l.code,
      accountName: l.name,
      taxCode: l.tax_code,
      amount: l.amount,
      net: l.net,
      tax: l.tax,
      gross: l.gross,
    })),
    entered: step(h.created_by, h.created_at),
    submitted: h.submitted_at ? step(h.submitted_by, h.submitted_at) : null,
    approved: h.approved_at ? step(h.approved_by, h.approved_at) : null,
  };
}

export interface BillJournalView {
  /** False: the engine's preview of what approval would post. True: the posted entry. */
  readonly posted: boolean;
  readonly entryNo: string | null;
  readonly entryDate: string;
  readonly requestedDate: string;
  readonly redirected: boolean;
  readonly baseCurrency: string;
  readonly total: string;
  readonly lines: readonly {
    lineNo: number;
    accountId: string;
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: string;
    credit: string;
    partyId: string | null;
  }[];
}

async function accountsById(trx: Trx, companyId: string, ids: readonly string[]) {
  const r = await sql<{ id: string; code: string; name: string; type: string }>`
    SELECT id::text, code, name, type FROM app.account
     WHERE company_id = ${companyId} AND id = ANY(${sql.val([...new Set(ids)])}::uuid[])`.execute(
    trx,
  );
  return new Map(r.rows.map((a) => [a.id, a]));
}

/** The journal behind a bill: engine preview for a draft, the posted entry once approved. */
export async function billJournalView(
  trx: Trx,
  q: { companyId: string; billId: string },
): Promise<BillJournalView> {
  const companyId = q.companyId.toLowerCase();
  const b = (
    await sql<{ status: string; entry_id: string | null }>`
      SELECT status, entry_id::text FROM app.supplier_bill
       WHERE company_id = ${companyId} AND id = ${q.billId}::uuid`.execute(trx)
  ).rows[0];
  if (!b) throw new BillError('INVALID_BILL', `bill ${q.billId} is not in company ${companyId}`);
  if (b.status === 'draft') {
    const p = await previewBillJournal(trx, q);
    const acc = await accountsById(
      trx,
      companyId,
      p.lines.map((l) => l.accountId),
    );
    return {
      posted: false,
      entryNo: null,
      entryDate: p.entryDate,
      requestedDate: p.requestedDate,
      redirected: p.redirected,
      baseCurrency: p.baseCurrency,
      total: p.total,
      lines: p.lines.map((l) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        accountCode: l.accountCode,
        accountName: acc.get(l.accountId)?.name ?? l.accountCode,
        accountType: acc.get(l.accountId)?.type ?? '',
        debit: l.debit,
        credit: l.credit,
        partyId: l.partyId,
      })),
    };
  }
  if (!b.entry_id) throw new BillError('INVALID_BILL', `bill ${q.billId} has no journal`);
  const e = (
    await sql<{ entry_no: string | null; entry_date: string; base_currency: string }>`
      SELECT e.entry_no, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, c.base_currency
        FROM app.journal_entry e JOIN app.company c ON c.id = e.company_id
       WHERE e.company_id = ${companyId} AND e.id = ${b.entry_id}::uuid`.execute(trx)
  ).rows[0];
  if (!e) throw new BillError('INVALID_BILL', `bill ${q.billId} has no journal`);
  const lines = await sql<{
    line_no: number;
    account_id: string;
    debit: string;
    credit: string;
    party_id: string | null;
  }>`
    SELECT line_no, account_id::text, debit::text, credit::text, party_id::text
      FROM app.journal_line WHERE company_id = ${companyId} AND entry_id = ${b.entry_id}::uuid
     ORDER BY line_no`.execute(trx);
  const acc = await accountsById(
    trx,
    companyId,
    lines.rows.map((l) => l.account_id),
  );
  const total = lines.rows.reduce((s, l) => s.plus(l.debit), new Decimal(0));
  return {
    posted: true,
    entryNo: e.entry_no,
    entryDate: e.entry_date,
    requestedDate: e.entry_date,
    redirected: false,
    baseCurrency: e.base_currency,
    total: Money.of(total, 'XXX').toNumericString(),
    lines: lines.rows.map((l) => ({
      lineNo: l.line_no,
      accountId: l.account_id,
      accountCode: acc.get(l.account_id)?.code ?? '',
      accountName: acc.get(l.account_id)?.name ?? '',
      accountType: acc.get(l.account_id)?.type ?? '',
      debit: l.debit,
      credit: l.credit,
      partyId: l.party_id,
    })),
  };
}
