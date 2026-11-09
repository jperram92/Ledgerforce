/**
 * Supplier bills (T-0050, UC-05, design §3.8 row 6, §3.9, migration 0038, RQ-0106).
 *
 *  createBill            draft bill + lines, gapless number from series 'bill'; duplicates of the
 *                        supplier's invoice number are returned as a warning (UC-05 A3)
 *  suggestBillLineCoding supplier history first, then the product posting profile (DL-0291)
 *  billCommand           the bill as a posting command: validate, resolve, build (pipeline 2–4)
 *  previewBill           the journal the bill would post; writes nothing (design §3.9)
 *  postBill              posts an APPROVED bill through the posting engine (the only ledger
 *                        writer) and marks it posted; the AP_CONTROL line becomes the AP open
 *                        item (T-0028); the bill's approver is the journal entry's approver
 *
 * Every function runs inside the caller's tenant transaction (withTenant). This module never
 * writes a ledger table. Submit / approve / reject with SoD are in bill-approval.ts (T-0052;
 * DL-0292 tightened by DL-0330: only approved bills post).
 */
import type { Database } from '@ledgerforce/db';
import {
  post,
  preview,
  type BuiltEntry,
  type PostingCommand,
  type PostingOutbox,
} from '@ledgerforce/ledger';
import {
  PostingProfileResolutionError,
  resolvePartyProductPosting,
  type PostingSlot,
} from '@ledgerforce/products';
import { minorUnits, currency as toCurrency } from '@ledgerforce/shared';
import {
  findTaxCode,
  getTaxRounding,
  TaxCodeNotFoundError,
  type AmountsAre,
} from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import { buildBillLines, type BillTaxCode } from './bill-journal.ts';
import {
  suggestCoding,
  type CodingHistoryLine,
  type CodingSuggestion,
  type ProfileCoding,
} from './coding.suggest.ts';
import { BillError } from './errors.ts';

export { BillError, type BillErrorCode } from './errors.ts';

type Trx = Transaction<Database>;

/** Placeholder line tax code: resolve the profile account only (its tax code is discarded). */
const ACCOUNT_ONLY = '(account only)';

/** Number series of bill documents (app.number_series.code). */
export const BILL_SERIES = 'bill';
/** Stored source type of a bill's journal entry (period matrix 'ap.bill'). */
export const BILL_SOURCE_TYPE = 'ap_bill';

export type CodingSourceKind = 'manual' | 'supplier_history' | 'product_profile';

export interface BillLineInput {
  description: string;
  /** Plain positive decimal at most at the currency minor unit; ex or inc tax per amountsAre. */
  amount: string;
  /** An account chosen on the line (GP-008 "expense: Office expenses"). */
  accountId?: string | null;
  /** Or a product: the posting profile gives the account (purchase direction). */
  productId?: string | null;
  postingSlot?: 'expense' | 'asset';
  taxCode?: string | null;
  /** Default 'manual' when the line is coded. */
  codingSource?: CodingSourceKind;
}

export interface CreateBillInput {
  companyId: string;
  supplierId: string;
  supplierRef: string;
  billDate: string;
  dueDate: string;
  /** Default: the company base currency (the only one accepted until FX bills exist). */
  currency?: string;
  amountsAre?: AmountsAre;
  memo?: string | null;
  enteredBy?: string | null;
  lines: readonly BillLineInput[];
}

export interface DuplicateBill {
  id: string;
  billNo: string;
  status: string;
  billDate: string;
}

export interface CreatedBill {
  id: string;
  billNo: string;
  /** Other bills of this supplier with the same normalised invoice number (warning only). */
  duplicates: DuplicateBill[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d+(?:\.(\d+))?$/;

/** Upper-case ASCII letters and digits — the same key as app.bill.supplier_ref_key. */
export const supplierRefKey = (ref: string): string =>
  ref.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

async function baseCurrency(trx: Trx, companyId: string): Promise<string> {
  const c = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!c) throw new BillError('INVALID_BILL', `company ${companyId} not found`);
  return c.base_currency;
}

async function assertSupplier(trx: Trx, companyId: string, partyId: string): Promise<void> {
  const r = await trx
    .selectFrom('app.party as p')
    .innerJoin('app.party_role as r', (j) =>
      j.onRef('r.tenant_id', '=', 'p.tenant_id').onRef('r.party_id', '=', 'p.id'),
    )
    .select('p.id')
    .where('p.company_id', '=', companyId)
    .where('p.id', '=', partyId)
    .where('p.status', '=', 'active')
    .where('r.role', '=', 'supplier')
    .where('r.active', '=', true)
    .executeTakeFirst();
  if (!r) throw new BillError('NOT_A_SUPPLIER', `party ${partyId} is not an active supplier`);
}

function validateInput(input: CreateBillInput, scale: number): void {
  const bad = (m: string, line?: number): never => {
    throw new BillError('INVALID_BILL', m, line === undefined ? {} : { line });
  };
  if (input.supplierRef.trim() === '' || supplierRefKey(input.supplierRef) === '') {
    bad('the supplier invoice number needs at least one letter or digit');
  }
  if (!DATE_RE.test(input.billDate) || !DATE_RE.test(input.dueDate)) bad('dates are YYYY-MM-DD');
  if (input.dueDate < input.billDate) bad('the due date is before the bill date');
  if (input.lines.length === 0) bad('a bill needs at least one line');
  input.lines.forEach((l, i) => {
    const m = AMOUNT_RE.exec(l.amount);
    if (!m || /^0*(\.0*)?$/.test(l.amount)) {
      bad(
        `amount ${JSON.stringify(l.amount)} must be a positive plain decimal (a credit is a supplier credit note)`,
        i + 1,
      );
    }
    if ((m?.[1] ?? '').replace(/0+$/, '').length > scale) {
      bad(`amount ${l.amount} has more than ${String(scale)} decimals`, i + 1);
    }
    if (l.description.trim() === '') bad('a line needs a description', i + 1);
  });
}

export async function findDuplicateBills(
  trx: Trx,
  q: { companyId: string; supplierId: string; supplierRef: string; excludeBillId?: string },
): Promise<DuplicateBill[]> {
  let query = trx
    .selectFrom('app.bill')
    .select(['id', 'bill_no', 'status', sql<string>`bill_date::text`.as('bill_date')])
    .where('company_id', '=', q.companyId)
    .where('supplier_id', '=', q.supplierId)
    .where('supplier_ref_key', '=', supplierRefKey(q.supplierRef))
    .where('status', '<>', 'void');
  if (q.excludeBillId !== undefined) query = query.where('id', '<>', q.excludeBillId);
  const rows = await query.orderBy('bill_no').execute();
  return rows.map((r) => ({
    id: r.id,
    billNo: r.bill_no,
    status: r.status,
    billDate: r.bill_date,
  }));
}

export async function createBill(trx: Trx, input: CreateBillInput): Promise<CreatedBill> {
  const base = await baseCurrency(trx, input.companyId);
  const cur = input.currency ?? base;
  if (cur !== base) {
    throw new BillError(
      'BILL_CURRENCY',
      `bills in ${cur} need FX support; the base currency is ${base}`,
    );
  }
  validateInput(input, minorUnits(toCurrency(cur)));
  await assertSupplier(trx, input.companyId, input.supplierId);
  const duplicates = await findDuplicateBills(trx, input);
  let billNo: string;
  try {
    const r = await sql<{ no: string }>`
      SELECT app.next_document_number(${input.companyId}, ${BILL_SERIES}) AS no`.execute(trx);
    billNo = r.rows[0]?.no ?? '';
  } catch (e) {
    throw new BillError(
      'NO_BILL_SERIES',
      `no active number series '${BILL_SERIES}' for this company`,
      {
        cause: e,
      },
    );
  }
  const bill = await trx
    .insertInto('app.bill')
    .values({
      company_id: input.companyId,
      bill_no: billNo,
      supplier_id: input.supplierId,
      supplier_ref: input.supplierRef.trim(),
      bill_date: input.billDate,
      due_date: input.dueDate,
      currency: cur,
      amounts_are: input.amountsAre ?? 'exclusive',
      memo: input.memo ?? null,
      entered_by: input.enteredBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.bill_line')
    .values(
      input.lines.map((l, i) => {
        const coded = (l.accountId ?? l.productId ?? null) !== null;
        return {
          company_id: input.companyId,
          bill_id: bill.id,
          line_no: i + 1,
          description: l.description.trim(),
          amount: l.amount,
          account_id: l.accountId ?? null,
          product_id: l.productId ?? null,
          posting_slot: l.postingSlot ?? 'expense',
          tax_code: l.taxCode ?? null,
          coding_source: coded ? (l.codingSource ?? 'manual') : null,
        };
      }),
    )
    .execute();
  if (input.enteredBy !== undefined && input.enteredBy !== null) {
    await recordBillEnter(trx, bill.id, input.enteredBy);
  }
  return { id: bill.id, billNo, duplicates };
}

/**
 * SoD step `bill.enter` (design §6.5 rule 3, ADR-0026): whoever enters or edits a bill is its
 * enterer for SOD_BILL_SELF_APPROVAL (RQ-0116 F4).
 */
export async function recordBillEnter(trx: Trx, billId: string, actorId: string): Promise<void> {
  await sql`
    INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id)
    VALUES ('bill', ${billId}, 'bill.enter', ${actorId})`.execute(trx);
}

/** Lines of the supplier's posted bills, newest bills first (the history suggestCoding reads). */
async function supplierHistory(
  trx: Trx,
  q: { companyId: string; supplierId: string; productId?: string | null | undefined },
): Promise<CodingHistoryLine[]> {
  const bills = await trx
    .selectFrom('app.bill as b')
    .select(['b.id'])
    .where('b.company_id', '=', q.companyId)
    .where('b.supplier_id', '=', q.supplierId)
    .where('b.status', '=', 'posted')
    .$if(q.productId !== undefined && q.productId !== null, (qb) =>
      qb.where((eb) =>
        eb.exists(
          eb
            .selectFrom('app.bill_line as x')
            .select('x.id')
            .whereRef('x.tenant_id', '=', 'b.tenant_id')
            .whereRef('x.bill_id', '=', 'b.id')
            .where('x.product_id', '=', q.productId ?? ''),
        ),
      ),
    )
    .orderBy('b.bill_date', 'desc')
    .orderBy('b.bill_no', 'desc')
    .limit(50)
    .execute();
  if (bills.length === 0) return [];
  const rows = await trx
    .selectFrom('app.bill_line as l')
    .innerJoin('app.bill as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.bill_id'),
    )
    .select([
      'b.id as bill_id',
      'b.bill_no',
      sql<string>`b.bill_date::text`.as('bill_date'),
      'l.line_no',
      'l.product_id',
      'l.account_id',
      'l.tax_code',
    ])
    .where(
      'l.bill_id',
      'in',
      bills.map((b) => b.id),
    )
    .execute();
  // A posted bill's lines carry the coding they posted with (frozen by postBill).
  const out: CodingHistoryLine[] = [];
  for (const r of rows) {
    if (r.account_id === null || r.tax_code === null) continue;
    out.push({
      billId: r.bill_id,
      billNo: r.bill_no,
      billDate: r.bill_date,
      lineNo: r.line_no,
      productId: r.product_id,
      accountId: r.account_id,
      taxCode: r.tax_code,
    });
  }
  return out;
}

/**
 * Suggested coding for a new line of this supplier (UC-05 step 2): history of the supplier's posted
 * bills, then the product posting profile; null when there is nothing to go on.
 */
export async function suggestBillLineCoding(
  trx: Trx,
  q: {
    companyId: string;
    supplierId: string;
    productId?: string | null;
    slot?: PostingSlot;
    /** The bill date (YYYY-MM-DD); reserved for date-effective profiles. */
    on: string;
  },
): Promise<CodingSuggestion | null> {
  const history = await supplierHistory(trx, q);
  let profile: ProfileCoding | null = null;
  if (q.productId !== undefined && q.productId !== null) {
    const query = {
      companyId: q.companyId,
      partyId: q.supplierId,
      productId: q.productId,
      direction: 'purchase' as const,
      slot: q.slot ?? 'expense',
    };
    try {
      const r = await resolvePartyProductPosting(trx, query);
      profile = {
        accountId: r.account.id,
        taxCode: r.taxCode,
        basis: `product profile ${r.productProfile} (${r.source}), tax code from ${r.taxCodeSource}`,
      };
    } catch (e) {
      if (
        e instanceof PostingProfileResolutionError &&
        (e.code === 'TAX_CODE_CONFLICT' || e.code === 'NO_TAX_CODE')
      ) {
        // The account resolves; the clerk must choose the tax code (DL-0260).
        // A line tax code skips the tax-code step (it is not validated there); only the account is used.
        const r = await resolvePartyProductPosting(trx, { ...query, lineTaxCode: ACCOUNT_ONLY });
        profile = {
          accountId: r.account.id,
          taxCode: null,
          basis: `product profile ${r.productProfile} (${r.source}); ${e.code}: choose the tax code`,
        };
      } else if (!(e instanceof PostingProfileResolutionError)) {
        throw e;
      }
    }
  }
  return suggestCoding({ history, productId: q.productId ?? null, profile });
}

interface BillRow {
  id: string;
  company_id: string;
  bill_no: string;
  supplier_id: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  currency: string;
  amounts_are: AmountsAre;
  status: string;
  approved_by: string | null;
  journal_entry_id: string | null;
}

async function loadBill(trx: Trx, billId: string, lock: boolean): Promise<BillRow> {
  const q = trx
    .selectFrom('app.bill')
    .select([
      'id',
      'company_id',
      'bill_no',
      'supplier_id',
      'supplier_ref',
      sql<string>`bill_date::text`.as('bill_date'),
      sql<string>`due_date::text`.as('due_date'),
      'currency',
      'amounts_are',
      'status',
      'approved_by',
      'journal_entry_id',
    ])
    .where('id', '=', billId);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new BillError('BILL_NOT_FOUND', `bill ${billId} not found`);
  return row;
}

/** Idempotency key of a bill's posting: one journal entry per bill. */
export const billIdempotencyKey = (billId: string): string => `ap.bill:${billId}`;

/**
 * The bill as a posting command (pipeline steps validate → resolve → build): every line coded,
 * accounts by chosen account or posting profile, tax codes by the bill date, amounts by the tax
 * engine. Reads only.
 */
export async function billCommand(
  trx: Trx,
  billId: string,
  opts: { createdBy?: string; approvedBy?: string; periodOverride?: { reason: string } } = {},
): Promise<PostingCommand> {
  return (await resolveBill(trx, billId, opts)).command;
}

interface ResolvedBill {
  command: PostingCommand;
  lines: { lineNo: number; accountId: string; taxCode: string; amount: string }[];
}

async function resolveBill(
  trx: Trx,
  billId: string,
  opts: { createdBy?: string; approvedBy?: string; periodOverride?: { reason: string } },
): Promise<ResolvedBill> {
  const bill = await loadBill(trx, billId, false);
  await assertSupplier(trx, bill.company_id, bill.supplier_id);
  const lines = await trx
    .selectFrom('app.bill_line')
    .select(['line_no', 'amount', 'account_id', 'product_id', 'posting_slot', 'tax_code'])
    .where('bill_id', '=', billId)
    .orderBy('line_no')
    .execute();
  const resolved: ResolvedBill['lines'] = [];
  for (const l of lines) {
    let accountId = l.account_id;
    let taxCode = l.tax_code;
    if (l.product_id !== null && (accountId === null || taxCode === null)) {
      try {
        const r = await resolvePartyProductPosting(trx, {
          companyId: bill.company_id,
          partyId: bill.supplier_id,
          productId: l.product_id,
          direction: 'purchase',
          slot: l.posting_slot,
          lineTaxCode: taxCode,
        });
        accountId ??= r.account.id;
        taxCode = r.taxCode;
      } catch (e) {
        if (
          e instanceof PostingProfileResolutionError &&
          (e.code === 'TAX_CODE_CONFLICT' || e.code === 'NO_TAX_CODE')
        ) {
          throw new BillError('TAX_CODE_REQUIRED', `${e.message} (DL-0260)`, {
            line: l.line_no,
            cause: e,
          });
        }
        if (e instanceof PostingProfileResolutionError) {
          throw new BillError('BILL_LINE_UNCODED', e.message, { line: l.line_no, cause: e });
        }
        throw e;
      }
    }
    if (accountId === null) {
      throw new BillError('BILL_LINE_UNCODED', 'choose an account or a product for the line', {
        line: l.line_no,
      });
    }
    if (taxCode === null) {
      const party = await trx
        .selectFrom('app.party as p')
        .leftJoin('app.party_posting_profile as pp', (j) =>
          j
            .onRef('pp.tenant_id', '=', 'p.tenant_id')
            .onRef('pp.id', '=', 'p.supplier_posting_profile_id'),
        )
        .select('pp.default_tax_code')
        .where('p.id', '=', bill.supplier_id)
        .executeTakeFirst();
      taxCode = party?.default_tax_code ?? null;
      if (taxCode === null) {
        throw new BillError(
          'TAX_CODE_REQUIRED',
          'the line has no tax code and the supplier no default',
          {
            line: l.line_no,
          },
        );
      }
    }
    resolved.push({ lineNo: l.line_no, accountId, taxCode, amount: l.amount });
  }

  const taxCodes = new Map<string, BillTaxCode>();
  for (const key of new Set(resolved.map((r) => r.taxCode))) {
    try {
      const v = await findTaxCode(trx, {
        companyId: bill.company_id,
        code: key,
        on: bill.bill_date,
      });
      taxCodes.set(key, { id: v.id, rate: v.rate, paidAccountId: v.paidAccountId });
    } catch (e) {
      if (e instanceof TaxCodeNotFoundError) {
        throw new BillError('TAX_CODE_REQUIRED', e.message, { cause: e });
      }
      throw e;
    }
  }

  const postingLines = buildBillLines({
    currency: bill.currency,
    amountsAre: bill.amounts_are,
    rounding: await getTaxRounding(trx, bill.company_id),
    supplierId: bill.supplier_id,
    dueDate: bill.due_date,
    taxCodes,
    lines: resolved,
  });
  const approvedBy = opts.approvedBy ?? bill.approved_by ?? undefined;
  const command: PostingCommand = {
    companyId: bill.company_id,
    idempotencyKey: billIdempotencyKey(bill.id),
    entryDate: bill.bill_date,
    sourceType: BILL_SOURCE_TYPE,
    sourceId: bill.id,
    memo: `Bill ${bill.bill_no} — supplier invoice ${bill.supplier_ref}`,
    ...(opts.createdBy === undefined ? {} : { createdBy: opts.createdBy }),
    ...(approvedBy === undefined ? {} : { approvedBy }),
    ...(opts.periodOverride === undefined ? {} : { periodOverride: opts.periodOverride }),
    lines: postingLines,
  };
  return { command, lines: resolved };
}

/** Only an approved bill posts (design §6.5 rule 3, UC-05 step 4; DL-0330 tightens DL-0292). */
const POSTABLE = new Set(['approved']);
/** A bill not yet posted can be previewed (and is previewed at submit). */
const PREVIEWABLE = new Set(['draft', 'awaiting_approval', 'approved']);

async function assertPostable(trx: Trx, bill: BillRow): Promise<void> {
  if (!POSTABLE.has(bill.status)) {
    throw new BillError(
      'BILL_NOT_POSTABLE',
      `bill ${bill.bill_no} is ${bill.status}; only an approved bill posts`,
    );
  }
  await assertNotDuplicate(trx, bill);
}

async function assertPreviewable(trx: Trx, bill: BillRow): Promise<void> {
  if (!PREVIEWABLE.has(bill.status)) {
    throw new BillError('BILL_NOT_POSTABLE', `bill ${bill.bill_no} is ${bill.status}`);
  }
  await assertNotDuplicate(trx, bill);
}

async function assertNotDuplicate(trx: Trx, bill: BillRow): Promise<void> {
  const posted = (
    await findDuplicateBills(trx, {
      companyId: bill.company_id,
      supplierId: bill.supplier_id,
      supplierRef: bill.supplier_ref,
      excludeBillId: bill.id,
    })
  ).filter((d) => d.status === 'posted');
  if (posted.length > 0) {
    throw new BillError(
      'DUPLICATE_SUPPLIER_REF',
      `supplier invoice ${bill.supplier_ref} is already posted as ${posted.map((p) => p.billNo).join(', ')}`,
    );
  }
}

export interface BillPreview {
  command: PostingCommand;
  entry: BuiltEntry;
}

/** "Show me the journal": what postBill would post. Writes nothing. */
export async function previewBill(
  trx: Trx,
  billId: string,
  opts: { createdBy?: string; approvedBy?: string; periodOverride?: { reason: string } } = {},
): Promise<BillPreview> {
  const bill = await loadBill(trx, billId, false);
  await assertPreviewable(trx, bill);
  const command = await billCommand(trx, billId, opts);
  return { command, entry: await preview(trx, command) };
}

async function freezeLines(trx: Trx, billId: string, lines: ResolvedBill['lines']): Promise<void> {
  for (const l of lines) {
    await trx
      .updateTable('app.bill_line')
      .set({ account_id: l.accountId, tax_code: l.taxCode })
      .where('bill_id', '=', billId)
      .where('line_no', '=', l.lineNo)
      .where((eb) => eb.or([eb('account_id', 'is', null), eb('tax_code', 'is', null)]))
      .execute();
  }
}

/**
 * Write the resolved coding (account, tax code) onto lines coded by product or by the supplier's
 * default tax code, while the bill is still draft (lines change only in draft, 0038). Called at
 * submit so the approver approves exactly the coding that will post (T-0052).
 */
export async function freezeBillCoding(trx: Trx, billId: string): Promise<void> {
  const { lines } = await resolveBill(trx, billId, {});
  await freezeLines(trx, billId, lines);
}

export interface PostedBill {
  billId: string;
  billNo: string;
  entryId: string;
  entryNo: string;
  /** True when the bill was already posted: its entry is returned and nothing is written. */
  replayed: boolean;
}

/**
 * Post the bill through the posting engine and mark it posted, in the caller's transaction (a
 * refusal anywhere leaves nothing written once the caller's transaction rolls back).
 */
export async function postBill(
  trx: Trx,
  billId: string,
  opts: {
    createdBy?: string;
    periodOverride?: { reason: string };
    outbox?: PostingOutbox;
  } = {},
): Promise<PostedBill> {
  const bill = await loadBill(trx, billId, true);
  if (bill.status === 'posted' && bill.journal_entry_id !== null) {
    const e = await trx
      .selectFrom('app.journal_entry')
      .select(['id', 'entry_no'])
      .where('id', '=', bill.journal_entry_id)
      .executeTakeFirstOrThrow();
    return {
      billId,
      billNo: bill.bill_no,
      entryId: e.id,
      entryNo: e.entry_no ?? '',
      replayed: true,
    };
  }
  await assertPostable(trx, bill);
  // The approver is the bill's (frozen at approval); the journal entry carries it.
  const { command, lines } = await resolveBill(trx, billId, {
    ...(opts.createdBy === undefined ? {} : { createdBy: opts.createdBy }),
    ...(opts.periodOverride === undefined ? {} : { periodOverride: opts.periodOverride }),
  });
  const r = await post(trx, command, opts.outbox === undefined ? {} : { outbox: opts.outbox });
  // The coding was frozen at submit (freezeBillCoding, while the bill was draft); this matches
  // no line then, and keeps the supplier history complete for any line still uncoded.
  await freezeLines(trx, billId, lines);
  await trx
    .updateTable('app.bill')
    .set({ status: 'posted', journal_entry_id: r.entryId, posted_at: new Date() })
    .where('id', '=', billId)
    .execute();
  return {
    billId,
    billNo: bill.bill_no,
    entryId: r.entryId,
    entryNo: r.entryNo,
    replayed: r.replayed,
  };
}
