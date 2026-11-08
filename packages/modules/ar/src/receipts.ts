/**
 * Customer receipts and allocations (T-0046, design §3.8 row 2, §3.2 allocation, UC-03 A1/A2;
 * RQ-0112; golden posting GP-002, Approved per DL-0253). Migration 0039.
 *
 * recordReceipt, in one savepoint (a refusal leaves no entry, receipt or allocation):
 *   1. key       — advisory lock on the key; a repeat returns the first receipt (a different
 *                  receipt under the same key is IDEMPOTENCY_CONFLICT)
 *   2. validate  — amount in cents > 0, method (eft/cheque/cash/other; card is Stripe, GP-003),
 *                  dates, base currency, deposit target: an active company bank account (its GL
 *                  account, `bank:OPERATING` in GP-002) or UNDEPOSITED_FUNDS (GP-002 variant)
 *   3. plan      — every invoice posted, same company, party and currency, dated on or before
 *                  the receipt; each allocation ≤ the invoice's open amount; Σ ≤ the amount;
 *                  at least one (no invoice = prepayment, RQ-0095 Q7 → T-0047)
 *   4. post      — Dr deposit / Cr AR_CONTROL (party) for the full amount, source type
 *                  ar_receipt, key ar_receipt:<receipt id>; the engine opens the receipt's credit
 *                  open item
 *   5. document  — app.ar_receipt row (immutable; the database checks it names this entry)
 *   6. allocate  — the ledger's allocate() per invoice, dated the receipt date (the date the
 *                  cash-basis BAS attributes the GST to). Any remainder stays an unallocated
 *                  customer credit on AR (RQ-0112 finding 4).
 * allocateReceipt allocates that credit later; unallocateReceipt undoes an allocation only by
 * the ledger's reversing allocation. previewReceipt runs the engine's preview and the plan and
 * writes nothing. An invoice's payment status is derived from its AR open item.
 *
 * This module never writes ledger tables; it calls packages/ledger (post, allocate,
 * reverseAllocation) and only reads allocations to list them.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import {
  AllocationError,
  allocate,
  post,
  preview,
  reverseAllocation,
  subledgerEntriesOf,
  type AccountRef,
  type AllocationResult,
  type BuiltEntry,
  type OpenItem,
  type PostingCommand,
  type PostingOutbox,
} from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { sql, type Transaction } from 'kysely';
import {
  ReceiptError,
  paymentStatusOf,
  planReceiptAllocations,
  positiveCents,
  refuseReceipt as refuse,
  type AllocationRequest,
  type PaymentStatus,
  type PlanInvoice,
  type PlannedAllocation,
} from './receipt-plan.ts';

export * from './receipt-plan.ts';

type Trx = Transaction<Database>;

export const RECEIPT_SOURCE_TYPE = 'ar_receipt';
/** The posting-engine idempotency key of a receipt: one entry per receipt, ever. */
export const receiptPostingKeyOf = (id: string) => `ar_receipt:${id}`;

export const RECEIPT_METHODS = ['eft', 'cheque', 'cash', 'other'] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

export type DepositTo = { kind: 'bank'; bankAccountId: string } | { kind: 'undeposited_funds' };

export interface ReceiptInput {
  companyId: string;
  partyId: string;
  /** YYYY-MM-DD: the entry date and the date of the allocations made with it. */
  receiptDate: string;
  /** Plain decimal, > 0, at most cents: the full amount received. */
  amount: string;
  /** Default and only value accepted today: the company base currency. */
  currency?: string;
  method: ReceiptMethod;
  depositTo: DepositTo;
  reference?: string;
  memo?: string;
  /** At least one; Σ ≤ amount, the rest stays an unallocated credit. */
  allocations: readonly AllocationRequest[];
}

export interface ReceiptAllocation {
  allocationId: string;
  invoiceId: string;
  amount: string;
  fxDifference: string;
  allocationDate: string;
  /** True once a reversing allocation undid it. */
  reversed: boolean;
}

export interface Receipt {
  id: string;
  companyId: string;
  partyId: string;
  receiptDate: string;
  amount: string;
  currency: string;
  method: ReceiptMethod;
  depositTo: DepositTo['kind'];
  bankAccountId: string | null;
  reference: string | null;
  memo: string | null;
  sourceEntryId: string;
  createdBy: string | null;
  /** The receipt's open credit: amount − live allocations. */
  unallocated: string;
  allocations: ReceiptAllocation[];
}

export interface RecordReceiptResult {
  receiptId: string;
  entryId: string;
  entryNo: string;
  allocations: { allocationId: string; invoiceId: string; amount: string }[];
  unallocated: string;
  /** True when the key had already recorded this receipt: nothing was written. */
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const X = 'XXX';
const lc = (s: string) => s.toLowerCase();

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > 160) {
    return refuse('INVALID_RECEIPT', 'idempotencyKey must be 1..160 characters');
  }
  return key;
}

interface CheckedReceipt {
  input: ReceiptInput;
  companyId: string;
  partyId: string;
  amount: string;
  currency: string;
  depositAccount: AccountRef;
  bankAccountId: string | null;
}

/** Step 2: validate the receipt and resolve its deposit account. Reads only. */
async function checkReceipt(trx: Trx, input: ReceiptInput): Promise<CheckedReceipt> {
  for (const [what, v] of [
    ['companyId', input.companyId],
    ['partyId', input.partyId],
  ] as const) {
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      refuse('INVALID_RECEIPT', `${what} ${JSON.stringify(v)} is not a uuid`);
    }
  }
  const companyId = lc(input.companyId);
  let amount: string;
  try {
    amount = positiveCents(input.amount, 'receipt amount');
  } catch (e) {
    if (e instanceof ReceiptError) throw new ReceiptError('INVALID_RECEIPT', e.message);
    throw e;
  }
  if (!validDate(input.receiptDate)) {
    refuse('INVALID_RECEIPT', `receipt date ${JSON.stringify(input.receiptDate)} is not a date`);
  }
  if (!(RECEIPT_METHODS as readonly string[]).includes(input.method)) {
    refuse(
      'INVALID_RECEIPT',
      `method ${JSON.stringify(input.method)}: one of ${RECEIPT_METHODS.join(', ')} (card payments are Stripe receipts, GP-003)`,
    );
  }
  if (
    input.reference !== undefined &&
    (input.reference.length < 1 || input.reference.length > 200)
  ) {
    refuse('INVALID_RECEIPT', 'reference must be 1..200 characters');
  }
  if (input.memo !== undefined && input.memo.length > 2000) {
    refuse('INVALID_RECEIPT', 'memo must be at most 2000 characters');
  }
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!company) return refuse('INVALID_RECEIPT', `company ${companyId} not found`);
  const currency = input.currency ?? company.base_currency;
  if (currency !== company.base_currency) {
    refuse(
      'INVALID_RECEIPT',
      `currency ${currency}: only the base currency ${company.base_currency} is received today`,
    );
  }
  const d = input.depositTo as DepositTo | undefined;
  if (d?.kind === 'undeposited_funds') {
    return {
      input,
      companyId,
      partyId: lc(input.partyId),
      amount,
      currency,
      depositAccount: { role: 'UNDEPOSITED_FUNDS' },
      bankAccountId: null,
    };
  }
  if (d?.kind !== 'bank') {
    return refuse('INVALID_RECEIPT', 'depositTo must be a bank account or undeposited funds');
  }
  const bank = UUID_RE.test(d.bankAccountId)
    ? await sql<{ gl_account_id: string }>`
        SELECT gl_account_id::text FROM app.bank_account
         WHERE company_id = ${companyId} AND id = ${lc(d.bankAccountId)}
           AND status = 'active' AND currency = ${currency}`.execute(trx)
    : { rows: [] };
  const gl = bank.rows[0]?.gl_account_id;
  if (gl === undefined) {
    return refuse(
      'UNKNOWN_BANK_ACCOUNT',
      `bank account ${d.bankAccountId} is not an active ${currency} bank account of the company`,
    );
  }
  return {
    input,
    companyId,
    partyId: lc(input.partyId),
    amount,
    currency,
    depositAccount: { id: gl },
    bankAccountId: lc(d.bankAccountId),
  };
}

interface InvoiceItem extends PlanInvoice {
  item: OpenItem;
}

/**
 * Step 3: the invoices' AR open items, checked against the receipt (posted, same company,
 * party and currency, dated on or before `date`), then the plan.
 */
async function planFor(
  trx: Trx,
  r: { companyId: string; partyId: string; currency: string },
  date: string,
  available: string,
  requests: readonly AllocationRequest[],
): Promise<{ plan: ReturnType<typeof planReceiptAllocations>; items: Map<string, InvoiceItem> }> {
  const items = new Map<string, InvoiceItem>();
  for (const req of requests) {
    const id = req.invoiceId;
    if (items.has(id)) continue;
    const row = UUID_RE.test(id)
      ? (
          await sql<{
            party_id: string;
            currency: string;
            invoice_date: string;
            status: string;
            journal_entry_id: string | null;
          }>`
            SELECT party_id::text, currency, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
                   status, journal_entry_id::text
              FROM app.sales_invoice WHERE company_id = ${r.companyId} AND id = ${lc(id)}`.execute(
            trx,
          )
        ).rows[0]
      : undefined;
    if (!row) return refuse('UNKNOWN_INVOICE', `no invoice ${id} in company ${r.companyId}`);
    if (row.status !== 'posted' || row.journal_entry_id === null) {
      refuse('INVOICE_NOT_POSTED', `invoice ${id} is ${row.status}; only a posted invoice is paid`);
    }
    if (row.party_id !== r.partyId) {
      refuse('PARTY_MISMATCH', `invoice ${id} belongs to another customer`);
    }
    if (row.currency !== r.currency) {
      refuse(
        'CURRENCY_MISMATCH',
        `invoice ${id} is in ${row.currency}, the receipt in ${r.currency}`,
      );
    }
    if (date < row.invoice_date) {
      refuse('DATE_BEFORE_INVOICE', `${date} is before invoice ${id}'s date ${row.invoice_date}`);
    }
    const item = (await subledgerEntriesOf(trx, row.journal_entry_id ?? '')).find(
      (s) => s.controlRole === 'AR_CONTROL',
    );
    if (!item) throw new Error(`invoice ${id}: its entry has no AR open item`);
    items.set(id, { invoiceId: id, total: item.originalAmount, openAmount: item.openAmount, item });
  }
  const plan = planReceiptAllocations({ available, invoices: [...items.values()], requests });
  return { plan, items };
}

function commandOf(c: CheckedReceipt, receiptId: string, createdBy: string | null): PostingCommand {
  const ref = c.input.reference;
  return {
    companyId: c.companyId,
    idempotencyKey: receiptPostingKeyOf(receiptId),
    entryDate: c.input.receiptDate,
    sourceType: RECEIPT_SOURCE_TYPE,
    sourceId: receiptId,
    memo: c.input.memo ?? `Customer receipt${ref === undefined ? '' : ` ${ref}`}`,
    ...(createdBy === null ? {} : { createdBy }),
    lines: [
      { account: c.depositAccount, debit: c.amount },
      {
        account: { role: 'AR_CONTROL' },
        credit: c.amount,
        partyId: c.partyId,
        dueDate: c.input.receiptDate,
      },
    ],
  };
}

async function lockKey(trx: Trx, scope: string, companyId: string, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${scope} || ':' || current_setting('app.tenant_id', true) || ':' || ${companyId}::text
        || ':' || ${key}::text, 0))`.execute(trx);
}

/** The receipt's AR credit open item. */
async function receiptItem(trx: Trx, entryId: string): Promise<OpenItem> {
  const item = (await subledgerEntriesOf(trx, entryId)).find((s) => s.controlRole === 'AR_CONTROL');
  if (!item) throw new Error(`receipt entry ${entryId} has no AR open item`);
  return item;
}

interface ReceiptRow {
  id: string;
  company_id: string;
  party_id: string;
  receipt_date: string;
  amount: string;
  currency: string;
  method: ReceiptMethod;
  deposit_to: DepositTo['kind'];
  bank_account_id: string | null;
  reference: string | null;
  memo: string | null;
  idempotency_key: string;
  journal_entry_id: string;
  created_by: string | null;
}

const RECEIPT_COLUMNS = sql`
  id::text, company_id::text, party_id::text, to_char(receipt_date, 'YYYY-MM-DD') AS receipt_date,
  amount::text, currency, method, deposit_to, bank_account_id::text, reference, memo,
  idempotency_key, journal_entry_id::text, created_by::text`;

async function receiptRow(
  trx: Trx,
  where: { id: string } | { companyId: string; key: string },
): Promise<ReceiptRow | undefined> {
  if ('id' in where) {
    if (!UUID_RE.test(where.id)) return undefined;
    return (
      await sql<ReceiptRow>`SELECT ${RECEIPT_COLUMNS} FROM app.ar_receipt WHERE id = ${lc(where.id)}`.execute(
        trx,
      )
    ).rows[0];
  }
  return (
    await sql<ReceiptRow>`SELECT ${RECEIPT_COLUMNS} FROM app.ar_receipt
      WHERE company_id = ${where.companyId} AND idempotency_key = ${where.key}`.execute(trx)
  ).rows[0];
}

/** A receipt with its unallocated credit and its allocations (reads only). */
export async function getReceipt(trx: Trx, id: string): Promise<Receipt> {
  const r = await receiptRow(trx, { id });
  if (!r) return refuse('NOT_FOUND', `receipt ${id} not found`);
  const item = await receiptItem(trx, r.journal_entry_id);
  const allocations = await sql<{
    allocation_id: string;
    invoice_id: string;
    amount: string;
    fx_difference: string;
    allocation_date: string;
    reversed: boolean;
  }>`
    SELECT a.id::text AS allocation_id, si.id::text AS invoice_id, a.amount::text,
           a.fx_difference::text, to_char(a.allocation_date, 'YYYY-MM-DD') AS allocation_date,
           EXISTS (SELECT 1 FROM app.allocation x
                    WHERE x.tenant_id = a.tenant_id AND x.reversal_of_id = a.id) AS reversed
      FROM app.allocation a
      JOIN app.subledger_entry other ON other.tenant_id = a.tenant_id
           AND other.id = CASE WHEN a.from_entry_id = ${item.id} THEN a.to_entry_id ELSE a.from_entry_id END
      JOIN app.sales_invoice si ON si.tenant_id = other.tenant_id
           AND si.journal_entry_id = other.entry_id
     WHERE a.company_id = ${r.company_id} AND a.reversal_of_id IS NULL
       AND (a.from_entry_id = ${item.id} OR a.to_entry_id = ${item.id})
     ORDER BY a.allocation_date, a.id`.execute(trx);
  return {
    id: r.id,
    companyId: r.company_id,
    partyId: r.party_id,
    receiptDate: r.receipt_date,
    amount: r.amount,
    currency: r.currency,
    method: r.method,
    depositTo: r.deposit_to,
    bankAccountId: r.bank_account_id,
    reference: r.reference,
    memo: r.memo,
    sourceEntryId: r.journal_entry_id,
    createdBy: r.created_by,
    unallocated: Money.of(item.openAmount, X).negate().toNumericString(),
    allocations: allocations.rows.map((a) => ({
      allocationId: a.allocation_id,
      invoiceId: a.invoice_id,
      amount: a.amount,
      fxDifference: a.fx_difference,
      allocationDate: a.allocation_date,
      reversed: a.reversed,
    })),
  };
}

/** Steps 1–3 of a receipt that has not been recorded: the command and the plan. Reads only. */
async function prepare(trx: Trx, input: ReceiptInput, receiptId: string, createdBy: string | null) {
  const c = await checkReceipt(trx, input);
  const { plan, items } = await planFor(trx, c, input.receiptDate, c.amount, input.allocations);
  return { c, plan, items, command: commandOf(c, receiptId, createdBy) };
}

/** Record a receipt, post it and allocate it (see the file header). */
export async function recordReceipt(
  trx: Trx,
  opts: {
    input: ReceiptInput;
    idempotencyKey: string;
    createdBy?: string | null;
    outbox?: PostingOutbox;
  },
): Promise<RecordReceiptResult> {
  const key = checkKey(opts.idempotencyKey);
  const createdBy = opts.createdBy ?? null;
  const companyId =
    typeof opts.input.companyId === 'string' && UUID_RE.test(opts.input.companyId)
      ? lc(opts.input.companyId)
      : refuse('INVALID_RECEIPT', 'companyId is not a uuid');
  await lockKey(trx, 'lf.ar_receipt_idem', companyId, key);
  const existing = await receiptRow(trx, { companyId, key });
  if (existing) return replay(trx, existing, opts.input);

  await sql`SAVEPOINT lf_receipt`.execute(trx);
  try {
    const ids = await sql<{ id: string }>`SELECT app.uuid_generate_v7()::text AS id`.execute(trx);
    const receiptId = ids.rows[0]?.id ?? '';
    const { c, plan, items, command } = await prepare(trx, opts.input, receiptId, createdBy);
    const posted = await post(
      trx,
      command,
      opts.outbox === undefined ? {} : { outbox: opts.outbox },
    );
    await sql`
      INSERT INTO app.ar_receipt (id, company_id, party_id, receipt_date, amount, currency, method,
                                  deposit_to, bank_account_id, reference, memo, idempotency_key,
                                  journal_entry_id, created_by)
      VALUES (${receiptId}, ${companyId}, ${c.partyId}, ${opts.input.receiptDate}, ${c.amount},
              ${c.currency}, ${opts.input.method}, ${opts.input.depositTo.kind}, ${c.bankAccountId},
              ${opts.input.reference ?? null}, ${opts.input.memo ?? null}, ${key},
              ${posted.entryId}, ${createdBy})`.execute(trx);
    const from = await receiptItem(trx, posted.entryId);
    const allocations = await allocateAll(trx, {
      companyId,
      from,
      plan: plan.rows,
      items,
      date: opts.input.receiptDate,
      keyPrefix: receiptPostingKeyOf(receiptId),
      createdBy,
    });
    await sql`RELEASE SAVEPOINT lf_receipt`.execute(trx);
    return {
      receiptId,
      entryId: posted.entryId,
      entryNo: posted.entryNo,
      allocations,
      unallocated: plan.unallocated,
      replayed: false,
    };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_receipt`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_receipt`.execute(trx);
    throw error;
  }
}

async function allocateAll(
  trx: Trx,
  a: {
    companyId: string;
    from: OpenItem;
    plan: readonly PlannedAllocation[];
    items: Map<string, InvoiceItem>;
    date: string;
    keyPrefix: string;
    createdBy: string | null;
  },
): Promise<RecordReceiptResult['allocations']> {
  const out: RecordReceiptResult['allocations'] = [];
  for (const [i, row] of a.plan.entries()) {
    const to = a.items.get(row.invoiceId);
    if (!to) throw new Error(`plan row for unknown invoice ${row.invoiceId}`);
    const r = await allocate(trx, {
      companyId: a.companyId,
      idempotencyKey: `${a.keyPrefix}:${String(i + 1)}`,
      fromEntryId: a.from.id,
      toEntryId: to.item.id,
      amount: row.amount,
      allocationDate: a.date,
      ...(a.createdBy === null ? {} : { createdBy: a.createdBy }),
    });
    out.push({ allocationId: r.allocationId, invoiceId: row.invoiceId, amount: r.amount });
  }
  return out;
}

/** A repeat of a key: the first receipt, if the request is the same receipt. */
async function replay(trx: Trx, r: ReceiptRow, input: ReceiptInput): Promise<RecordReceiptResult> {
  let same: boolean;
  try {
    same =
      r.party_id === lc(input.partyId) &&
      r.receipt_date === input.receiptDate &&
      Money.of(r.amount, X).compare(Money.of(input.amount, X)) === 0 &&
      r.deposit_to === input.depositTo.kind;
  } catch {
    same = false;
  }
  if (!same) {
    refuse(
      'IDEMPOTENCY_CONFLICT',
      `the idempotency key already recorded receipt ${r.id} with different details`,
    );
  }
  const doc = await getReceipt(trx, r.id);
  const entry = await sql<{ entry_no: string }>`
    SELECT entry_no FROM app.journal_entry WHERE id = ${r.journal_entry_id}`.execute(trx);
  return {
    receiptId: r.id,
    entryId: r.journal_entry_id,
    entryNo: entry.rows[0]?.entry_no ?? '',
    allocations: doc.allocations.map((a) => ({
      allocationId: a.allocationId,
      invoiceId: a.invoiceId,
      amount: a.amount,
    })),
    unallocated: doc.unallocated,
    replayed: true,
  };
}

export interface ReceiptPreview {
  /** The entry post() would write (engine preview: period, accounts, control account). */
  entry: BuiltEntry;
  allocations: PlannedAllocation[];
  unallocated: string;
}

/** "Show me the journal" for a receipt: the entry and the allocation plan; writes nothing. */
export async function previewReceipt(trx: Trx, input: ReceiptInput): Promise<ReceiptPreview> {
  const { plan, command } = await prepare(trx, input, randomUUID(), null);
  const entry = await preview(trx, command);
  return { entry, allocations: plan.rows, unallocated: plan.unallocated };
}

/** Allocate a receipt's unallocated credit to invoices (e.g. after an over-payment). */
export async function allocateReceipt(
  trx: Trx,
  opts: {
    receiptId: string;
    allocations: readonly AllocationRequest[];
    /** YYYY-MM-DD, not before the receipt or the invoices. */
    allocationDate: string;
    idempotencyKey: string;
    createdBy?: string | null;
  },
): Promise<{
  allocations: RecordReceiptResult['allocations'];
  unallocated: string;
  replayed: boolean;
}> {
  const key = checkKey(opts.idempotencyKey);
  const r = await receiptRow(trx, { id: opts.receiptId });
  if (!r) return refuse('NOT_FOUND', `receipt ${opts.receiptId} not found`);
  if (!validDate(opts.allocationDate)) {
    refuse(
      'INVALID_RECEIPT',
      `allocation date ${JSON.stringify(opts.allocationDate)} is not a date`,
    );
  }
  if (opts.allocationDate < r.receipt_date) {
    refuse(
      'DATE_BEFORE_ALLOCATION',
      `allocation date ${opts.allocationDate} is before the receipt date ${r.receipt_date}`,
    );
  }
  const prefix = `ar_receipt_allocation:${key}`;
  await lockKey(trx, 'lf.ar_receipt_alloc_idem', r.company_id, key);
  const done = await sql<{ id: string }>`
    SELECT id::text FROM app.allocation
     WHERE company_id = ${r.company_id} AND idempotency_key = ${`${prefix}:1`}`.execute(trx);
  if (done.rows.length > 0) {
    const doc = await getReceipt(trx, r.id);
    const mine = doc.allocations.filter((a) => done.rows.some((d) => d.id === a.allocationId));
    return {
      allocations: mine.map((a) => ({
        allocationId: a.allocationId,
        invoiceId: a.invoiceId,
        amount: a.amount,
      })),
      unallocated: doc.unallocated,
      replayed: true,
    };
  }
  const from = await receiptItem(trx, r.journal_entry_id);
  const available = Money.of(from.openAmount, X).negate().toNumericString();
  await sql`SAVEPOINT lf_receipt_allocate`.execute(trx);
  try {
    const { plan, items } = await planFor(
      trx,
      { companyId: r.company_id, partyId: r.party_id, currency: r.currency },
      opts.allocationDate,
      available,
      opts.allocations,
    );
    const allocations = await allocateAll(trx, {
      companyId: r.company_id,
      from,
      plan: plan.rows,
      items,
      date: opts.allocationDate,
      keyPrefix: prefix,
      createdBy: opts.createdBy ?? null,
    });
    await sql`RELEASE SAVEPOINT lf_receipt_allocate`.execute(trx);
    return { allocations, unallocated: plan.unallocated, replayed: false };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_receipt_allocate`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_receipt_allocate`.execute(trx);
    throw error;
  }
}

/** Undo one of the receipt's allocations by the ledger's reversing allocation (never a delete). */
export async function unallocateReceipt(
  trx: Trx,
  opts: {
    receiptId: string;
    allocationId: string;
    /** YYYY-MM-DD, not before the allocation. */
    date: string;
    idempotencyKey: string;
    createdBy?: string | null;
  },
): Promise<AllocationResult> {
  const key = checkKey(opts.idempotencyKey);
  const r = await receiptRow(trx, { id: opts.receiptId });
  if (!r) return refuse('NOT_FOUND', `receipt ${opts.receiptId} not found`);
  const item = await receiptItem(trx, r.journal_entry_id);
  const own = UUID_RE.test(opts.allocationId)
    ? await sql<{ id: string }>`
        SELECT id::text FROM app.allocation
         WHERE company_id = ${r.company_id} AND id = ${lc(opts.allocationId)}
           AND reversal_of_id IS NULL
           AND (from_entry_id = ${item.id} OR to_entry_id = ${item.id})`.execute(trx)
    : { rows: [] };
  if (own.rows.length === 0) {
    refuse(
      'NOT_THIS_RECEIPT',
      `allocation ${opts.allocationId} is not an allocation of receipt ${r.id}`,
    );
  }
  try {
    return await reverseAllocation(trx, {
      companyId: r.company_id,
      idempotencyKey: `ar_receipt_unallocation:${key}`,
      allocationId: lc(opts.allocationId),
      allocationDate: opts.date,
      ...(opts.createdBy === undefined || opts.createdBy === null
        ? {}
        : { createdBy: opts.createdBy }),
    });
  } catch (e) {
    if (e instanceof AllocationError) {
      if (e.code === 'ALREADY_REVERSED' || e.code === 'DATE_BEFORE_ALLOCATION') {
        throw new ReceiptError(e.code, e.message, { cause: e });
      }
      if (e.code === 'INVALID_COMMAND')
        throw new ReceiptError('INVALID_RECEIPT', e.message, { cause: e });
      if (e.code === 'IDEMPOTENCY_CONFLICT')
        throw new ReceiptError(e.code, e.message, { cause: e });
    }
    throw e;
  }
}

export interface InvoicePaymentStatus {
  invoiceId: string;
  status: PaymentStatus;
  /** The invoice's AR amount. */
  total: string;
  openAmount: string;
}

/** Paid / Partially paid / Unpaid, derived from the invoice's AR open item (RQ-0112 finding 3). */
export async function invoicePaymentStatus(
  trx: Trx,
  invoiceId: string,
): Promise<InvoicePaymentStatus> {
  const row = UUID_RE.test(invoiceId)
    ? (
        await sql<{ id: string; status: string; journal_entry_id: string | null }>`
          SELECT id::text, status, journal_entry_id::text FROM app.sales_invoice
           WHERE id = ${lc(invoiceId)}`.execute(trx)
      ).rows[0]
    : undefined;
  if (!row) return refuse('UNKNOWN_INVOICE', `no invoice ${invoiceId}`);
  if (row.journal_entry_id === null) {
    return refuse('INVOICE_NOT_POSTED', `invoice ${invoiceId} is ${row.status}`);
  }
  const item = (await subledgerEntriesOf(trx, row.journal_entry_id)).find(
    (s) => s.controlRole === 'AR_CONTROL',
  );
  if (!item) throw new Error(`invoice ${invoiceId}: its entry has no AR open item`);
  return {
    invoiceId: row.id,
    status: paymentStatusOf(item.originalAmount, item.openAmount),
    total: item.originalAmount,
    openAmount: item.openAmount,
  };
}
