/**
 * Customer credit notes (T-0045, design §3.8 row 4, §6.4, UC-11; RQ-0114; ADR-0044 R5/W6; golden
 * posting GP-005, Approved per DL-0253). Workflow, enforced here and by migration 0040:
 *
 *   draft ──approve (another user above the threshold)──▶ approved ──post──▶ posted
 *
 * - create stores a draft against one posted sales invoice: party, currency and price mode are
 *   the invoice's; each line names the invoice line it adjusts (invoice_line_id) and copies that
 *   line's revenue account and tax-code version from its posting snapshot
 *   (invoice-line-posting.ts) — never re-resolved (ADR-0044 W6). A repeat key returns the draft.
 * - The journal is built from the document every time (create check, preview, approve, post) by
 *   buildCreditNoteJournal: GST proportional at the invoice line's rate with the company rounding.
 * - Creditable amount (UC-11 A1): per invoice line and per invoice, approved and posted credits
 *   plus this one ≤ the invoice — CREDIT_EXCEEDS_INVOICE. Checked at create, approve and post.
 * - approve refuses SOD_CREDIT_NOTE_SELF_APPROVAL (design §6.4, rules.ts) when the creator
 *   approves a credit note above the tenant's threshold. The module fails closed: the small-team
 *   exception path belongs to the API's @SoD interceptor (follow-up). The engine's preview runs
 *   every posting check before the note is approved.
 * - post takes the number (series ar_credit_note, CN-…, gapless) and posts through post() with key
 *   ar_credit_note:<id>, in one savepoint; it records whether the note falls in a later BAS period
 *   than the invoice (company bas_frequency). The engine opens the credit open item on the
 *   invoice's AR control account; allocateCreditNote allocates it to the invoice.
 * - Every credit note is issued as an "Adjustment note" naming the original invoice number and
 *   date (GP-005, RQ-0095 Q4); later_bas_period marks the Div 19 adjustments (1B).
 *
 * This module never writes ledger tables; it calls packages/ledger.
 */
import type { Database, TaxRounding } from '@ledgerforce/db';
import {
  allocate,
  nextNumber,
  post,
  preview,
  subledgerEntriesOf,
  type AllocationResult,
  type BuiltEntry,
  type PostingCommand,
  type PostingOutbox,
} from '@ledgerforce/ledger';
import { DEFAULT_SOD_SETTINGS, evaluateSod } from '@ledgerforce/shared/sod';
import { getTaxRounding, type AmountsAre } from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import {
  CreditNoteError,
  basPeriodOf,
  buildCreditNoteJournal,
  checkCreditable,
  type BasFrequency,
  type CreditNoteErrorCode,
  type CreditNoteJournal,
  type CreditNoteTaxCode,
} from './credit-note-journal.ts';

export { invoiceLinePostings, type InvoiceLinePosting } from './invoice-line-posting.ts';

type Trx = Transaction<Database>;

export type CreditNoteStatus = 'draft' | 'approved' | 'posted';

export const CREDIT_NOTE_SERIES = 'ar_credit_note';
export const CREDIT_NOTE_SOURCE_TYPE = 'ar_credit_note';
/** The posting-engine idempotency key of a credit note: one entry per credit note, ever. */
export const creditNotePostingKeyOf = (id: string) => `ar_credit_note:${id}`;
/** GP-005 / RQ-0095 Q4: every credit note is issued as an adjustment note. */
export const CREDIT_NOTE_TITLE = 'Adjustment note';

export interface CreditNoteLineInput {
  /** The sales invoice line adjusted (ADR-0044 W6 link). */
  invoiceLineId: string;
  /** Plain decimal > 0, at most cents; tax-exclusive or -inclusive like the invoice. */
  amount: string;
  description?: string;
}

export interface CreditNoteInput {
  companyId: string;
  invoiceId: string;
  /** YYYY-MM-DD, not before the invoice date; the journal's entry date. */
  creditNoteDate: string;
  /** Why the supply changed (shown on the adjustment note). */
  reason: string;
  memo?: string;
  lines: readonly CreditNoteLineInput[];
}

export interface CreditNoteLine {
  lineNo: number;
  invoiceLineId: string;
  description: string | null;
  amount: string;
  accountId: string;
  taxCodeId: string;
  netAmount: string | null;
  taxAmount: string | null;
}

export interface CreditNote {
  id: string;
  companyId: string;
  partyId: string;
  invoiceId: string;
  status: CreditNoteStatus;
  creditNoteNo: string | null;
  creditNoteDate: string;
  amountsAre: AmountsAre;
  currency: string;
  reason: string;
  memo: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  netTotal: string | null;
  taxTotal: string | null;
  total: string | null;
  postedBy: string | null;
  journalEntryId: string | null;
  laterBasPeriod: boolean | null;
  lines: CreditNoteLine[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const refuse = (code: CreditNoteErrorCode, message: string): never => {
  throw new CreditNoteError(code, message);
};

async function load(trx: Trx, id: string, lock: boolean): Promise<CreditNote> {
  if (!UUID_RE.test(id)) refuse('NOT_FOUND', `credit note ${id} not found`);
  const h = await sql<Omit<CreditNote, 'lines'>>`
    SELECT id::text, company_id::text AS "companyId", party_id::text AS "partyId",
           invoice_id::text AS "invoiceId", status, credit_note_no AS "creditNoteNo",
           to_char(credit_note_date, 'YYYY-MM-DD') AS "creditNoteDate", amounts_are AS "amountsAre",
           currency, reason, memo, created_by::text AS "createdBy", approved_by::text AS "approvedBy",
           net_total::text AS "netTotal", tax_total::text AS "taxTotal", total::text AS total,
           posted_by::text AS "postedBy", journal_entry_id::text AS "journalEntryId",
           later_bas_period AS "laterBasPeriod"
      FROM app.credit_note WHERE id = ${id.toLowerCase()}
      ${lock ? sql`FOR UPDATE` : sql``}`.execute(trx);
  const r = h.rows[0];
  if (!r) return refuse('NOT_FOUND', `credit note ${id} not found`);
  const lines = await sql<CreditNoteLine>`
    SELECT line_no AS "lineNo", invoice_line_id::text AS "invoiceLineId", description,
           amount::text AS amount, account_id::text AS "accountId", tax_code_id::text AS "taxCodeId",
           net_amount::text AS "netAmount", tax_amount::text AS "taxAmount"
      FROM app.credit_note_line WHERE credit_note_id = ${r.id} ORDER BY line_no`.execute(trx);
  return { ...r, lines: lines.rows };
}

export const getCreditNote = (trx: Trx, id: string) => load(trx, id, false);

function expectStatus(doc: CreditNote, allowed: readonly CreditNoteStatus[], action: string) {
  if (!allowed.includes(doc.status)) {
    refuse(
      'WRONG_STATUS',
      `credit note ${doc.id} is ${doc.status}; ${action} needs ${allowed.join(' or ')}`,
    );
  }
}

interface InvoiceFacts {
  id: string;
  status: string;
  invoiceNo: string | null;
  invoiceDate: string;
  partyId: string;
  currency: string;
  amountsAre: AmountsAre;
  total: string | null;
  entryId: string | null;
}

async function invoiceFacts(trx: Trx, companyId: string, invoiceId: string): Promise<InvoiceFacts> {
  if (!UUID_RE.test(invoiceId))
    refuse('INVOICE_NOT_POSTED', `sales invoice ${invoiceId} not found`);
  const r = await sql<InvoiceFacts>`
    SELECT id::text, status, invoice_no AS "invoiceNo",
           to_char(invoice_date, 'YYYY-MM-DD') AS "invoiceDate", party_id::text AS "partyId",
           currency, amounts_are AS "amountsAre", total::text AS total,
           journal_entry_id::text AS "entryId"
      FROM app.sales_invoice WHERE company_id = ${companyId} AND id = ${invoiceId.toLowerCase()}`.execute(
    trx,
  );
  const inv = r.rows[0];
  if (!inv || inv.status !== 'posted' || inv.entryId === null || inv.total === null) {
    return refuse(
      'INVOICE_NOT_POSTED',
      `sales invoice ${invoiceId} is not a posted invoice of the company`,
    );
  }
  return inv;
}

interface LinePostingRow {
  invoiceLineId: string;
  accountId: string;
  taxCodeId: string;
  netAmount: string;
  taxAmount: string;
}

async function linePostings(trx: Trx, invoiceId: string): Promise<Map<string, LinePostingRow>> {
  const r = await sql<LinePostingRow>`
    SELECT invoice_line_id::text AS "invoiceLineId", account_id::text AS "accountId",
           tax_code_id::text AS "taxCodeId", net_amount::text AS "netAmount",
           tax_amount::text AS "taxAmount"
      FROM app.sales_invoice_line_posting WHERE invoice_id = ${invoiceId}`.execute(trx);
  return new Map(r.rows.map((x) => [x.invoiceLineId, x]));
}

/** A tax-code version by id with its collected account (the invoice line's, ADR-0044 W6). */
async function taxCodeVersion(trx: Trx, companyId: string, id: string): Promise<CreditNoteTaxCode> {
  const r = await sql<CreditNoteTaxCode>`
    SELECT t.id::text, t.code, t.rate::text AS rate, c.account_id::text AS "collectedAccountId"
      FROM app.tax_code t
      LEFT JOIN app.account_system_role c
        ON c.tenant_id = t.tenant_id AND c.company_id = t.company_id AND c.role = t.collected_role
     WHERE t.company_id = ${companyId} AND t.id = ${id}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new Error(`tax code version ${id} missing`);
  return row;
}

/** The invoice's AR open item (the credit note credits the same control account). */
async function invoiceItem(trx: Trx, entryId: string) {
  const items = await subledgerEntriesOf(trx, entryId);
  const item = items.find((i) => i.controlRole === 'AR_CONTROL');
  if (!item) throw new Error(`invoice entry ${entryId} has no AR open item`);
  return item;
}

interface Built {
  command: PostingCommand;
  journal: CreditNoteJournal;
}

/** The posting command of the document and the creditable check. Reads only. */
async function build(
  trx: Trx,
  doc: Pick<
    CreditNote,
    | 'id'
    | 'companyId'
    | 'invoiceId'
    | 'creditNoteDate'
    | 'amountsAre'
    | 'currency'
    | 'memo'
    | 'creditNoteNo'
  > & {
    lines: readonly Pick<CreditNoteLine, 'invoiceLineId' | 'amount' | 'accountId' | 'taxCodeId'>[];
  },
  extra: Partial<PostingCommand> = {},
): Promise<Built & { invoice: InvoiceFacts }> {
  const invoice = await invoiceFacts(trx, doc.companyId, doc.invoiceId);
  const rounding: TaxRounding = await getTaxRounding(trx, doc.companyId);
  const control = await invoiceItem(trx, invoice.entryId ?? '');
  const codes = new Map<string, CreditNoteTaxCode>();
  for (const l of doc.lines) {
    if (!codes.has(l.taxCodeId))
      codes.set(l.taxCodeId, await taxCodeVersion(trx, doc.companyId, l.taxCodeId));
  }
  const journal = buildCreditNoteJournal({
    partyId: invoice.partyId,
    controlAccountId: control.accountId,
    currency: doc.currency,
    amountsAre: doc.amountsAre,
    rounding,
    dueDate: doc.creditNoteDate,
    lines: doc.lines.map((l) => ({
      amount: l.amount,
      accountId: l.accountId,
      taxCode:
        codes.get(l.taxCodeId) ?? refuse('NO_LINE_POSTING', `tax code ${l.taxCodeId} missing`),
    })),
  });
  await creditable(trx, doc.id, invoice, doc.lines, journal);
  return {
    invoice,
    journal,
    command: {
      companyId: doc.companyId,
      idempotencyKey: creditNotePostingKeyOf(doc.id),
      entryDate: doc.creditNoteDate,
      sourceType: CREDIT_NOTE_SOURCE_TYPE,
      sourceId: doc.id,
      memo:
        doc.memo ??
        `${CREDIT_NOTE_TITLE}${doc.creditNoteNo === null ? '' : ` ${doc.creditNoteNo}`} for ${invoice.invoiceNo ?? invoice.id}`,
      lines: journal.lines,
      ...extra,
    },
  };
}

/** UC-11 A1: approved and posted credits of the invoice (other than `selfId`) + this one. */
async function creditable(
  trx: Trx,
  selfId: string,
  invoice: InvoiceFacts,
  lines: readonly Pick<CreditNoteLine, 'invoiceLineId'>[],
  journal: CreditNoteJournal,
): Promise<void> {
  const postings = await linePostings(trx, invoice.id);
  const credited = await sql<{ invoiceLineId: string; net: string; tax: string }>`
    SELECT l.invoice_line_id::text AS "invoiceLineId", sum(l.net_amount)::text AS net,
           sum(l.tax_amount)::text AS tax
      FROM app.credit_note_line l
      JOIN app.credit_note c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
     WHERE c.invoice_id = ${invoice.id} AND c.status IN ('approved', 'posted') AND c.id::text <> ${selfId}
     GROUP BY l.invoice_line_id`.execute(trx);
  const totals = await sql<{ total: string }>`
    SELECT coalesce(sum(total), 0)::text AS total FROM app.credit_note
     WHERE invoice_id = ${invoice.id} AND status IN ('approved', 'posted') AND id::text <> ${selfId}`.execute(
    trx,
  );
  const by = new Map(credited.rows.map((r) => [r.invoiceLineId, r]));
  checkCreditable({
    currency: invoice.currency,
    invoiceTotal: invoice.total ?? '0',
    creditedTotal: totals.rows[0]?.total ?? '0',
    invoiceLines: [...postings.values()].map((p) => ({
      invoiceLineId: p.invoiceLineId,
      net: p.netAmount,
      tax: p.taxAmount,
      creditedNet: by.get(p.invoiceLineId)?.net ?? '0',
      creditedTax: by.get(p.invoiceLineId)?.tax ?? '0',
    })),
    request: {
      total: journal.total,
      lines: lines.map((l, i) => ({
        invoiceLineId: l.invoiceLineId,
        net: journal.lineResults[i]?.net ?? '0',
        tax: journal.lineResults[i]?.tax ?? '0',
      })),
    },
  });
}

/** Create a draft. A repeat with the same (company, key) returns the first credit note. */
export async function createCreditNote(
  trx: Trx,
  opts: { input: CreditNoteInput; createdBy: string | null; idempotencyKey: string },
): Promise<{ id: string; replayed: boolean }> {
  const { input } = opts;
  const existing = await sql<{ id: string }>`
    SELECT id::text FROM app.credit_note
     WHERE company_id = ${input.companyId} AND idempotency_key = ${opts.idempotencyKey}`.execute(
    trx,
  );
  const first = existing.rows[0];
  if (first) return { id: first.id, replayed: true };

  if (!DATE_RE.test(input.creditNoteDate)) {
    refuse('INVALID_CREDIT_NOTE', `date ${JSON.stringify(input.creditNoteDate)} is not YYYY-MM-DD`);
  }
  if (input.reason.trim() === '') refuse('INVALID_CREDIT_NOTE', 'a credit note needs a reason');
  if (input.lines.length === 0)
    refuse('INVALID_CREDIT_NOTE', 'a credit note needs at least one line');
  const invoice = await invoiceFacts(trx, input.companyId, input.invoiceId);
  if (input.creditNoteDate < invoice.invoiceDate) {
    refuse(
      'INVALID_CREDIT_NOTE',
      `credit note date ${input.creditNoteDate} is before the invoice date ${invoice.invoiceDate}`,
    );
  }
  const postings = await linePostings(trx, invoice.id);
  if (postings.size === 0) {
    refuse(
      'NO_LINE_POSTING',
      `sales invoice ${invoice.invoiceNo ?? invoice.id} has no recorded line postings (posted before migration 0040)`,
    );
  }
  const lines = input.lines.map((l, i) => {
    const p = postings.get(l.invoiceLineId.toLowerCase());
    if (!p) {
      return refuse(
        'LINE_NOT_ON_INVOICE',
        `line ${String(i + 1)}: invoice line ${l.invoiceLineId} is not a posted line of ${invoice.invoiceNo ?? invoice.id}`,
      );
    }
    return {
      lineNo: i + 1,
      invoiceLineId: p.invoiceLineId,
      description: l.description ?? null,
      amount: l.amount,
      accountId: p.accountId,
      taxCodeId: p.taxCodeId,
    };
  });
  // Validates amounts and the creditable amount before anything is written.
  await build(trx, {
    id: '00000000-0000-0000-0000-000000000000',
    companyId: input.companyId,
    invoiceId: invoice.id,
    creditNoteDate: input.creditNoteDate,
    amountsAre: invoice.amountsAre,
    currency: invoice.currency,
    memo: input.memo ?? null,
    creditNoteNo: null,
    lines,
  });

  const r = await sql<{ id: string }>`
    INSERT INTO app.credit_note (company_id, party_id, invoice_id, credit_note_date, amounts_are,
                                 currency, reason, memo, idempotency_key, created_by)
    VALUES (${input.companyId}, ${invoice.partyId}, ${invoice.id}, ${input.creditNoteDate},
            ${invoice.amountsAre}, ${invoice.currency}, ${input.reason.trim()}, ${input.memo ?? null},
            ${opts.idempotencyKey}, ${opts.createdBy})
    RETURNING id::text`.execute(trx);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('credit note insert returned nothing');
  for (const l of lines) {
    await sql`
      INSERT INTO app.credit_note_line (company_id, credit_note_id, line_no, invoice_line_id,
                                        description, amount, account_id, tax_code_id)
      VALUES (${input.companyId}, ${id}, ${l.lineNo}, ${l.invoiceLineId}, ${l.description},
              ${l.amount}, ${l.accountId}, ${l.taxCodeId})`.execute(trx);
  }
  return { id, replayed: false };
}

/** The tenant's SoD settings (latest row; none = the defaults, = migration 0021). */
async function sodSettings(trx: Trx) {
  const r = await sql<{ small_team_mode: boolean; credit_note: string }>`
    SELECT small_team_mode, credit_note_self_approval_threshold::text AS credit_note
      FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  if (!row) return DEFAULT_SOD_SETTINGS;
  return {
    ...DEFAULT_SOD_SETTINGS,
    smallTeamMode: row.small_team_mode,
    thresholds: { ...DEFAULT_SOD_SETTINGS.thresholds, credit_note_self_approval: row.credit_note },
  };
}

export interface ApproveCreditNoteResult {
  id: string;
  status: 'approved';
  netTotal: string;
  taxTotal: string;
  total: string;
}

/** Approve a draft. Refusals are CreditNoteError or the engine's PostingError. */
export async function approveCreditNote(
  trx: Trx,
  opts: { id: string; approvedBy: string },
): Promise<ApproveCreditNoteResult> {
  const doc = await load(trx, opts.id, true);
  expectStatus(doc, ['draft'], 'approving');
  const u = await sql<{ status: string }>`
    SELECT status FROM app.app_user WHERE id = ${opts.approvedBy}`.execute(trx);
  if (u.rows[0]?.status !== 'active') {
    refuse('UNKNOWN_APPROVER', `approver ${opts.approvedBy} is not an active user of this tenant`);
  }
  const built = await build(trx, doc, { approvedBy: opts.approvedBy });
  // Design §6.4 AR Clerk / SOD_CREDIT_NOTE_SELF_APPROVAL; no exception path here (fails closed).
  const decision = evaluateSod({
    step: 'credit_note.approve',
    actorId: opts.approvedBy,
    subject: { amount: built.journal.total },
    history: doc.createdBy === null ? [] : [{ step: 'credit_note.create', actorId: doc.createdBy }],
    settings: await sodSettings(trx),
    otherEligible: 0,
    exception: null,
  });
  if (decision.outcome !== 'allow') {
    refuse(
      'SOD_CREDIT_NOTE_SELF_APPROVAL',
      `credit note ${doc.id} (${built.journal.total}) is above the self-approval threshold and was created by the approver (design §6.4)`,
    );
  }
  await preview(trx, built.command);
  for (const [i, l] of doc.lines.entries()) {
    const r = built.journal.lineResults[i];
    await sql`
      UPDATE app.credit_note_line SET net_amount = ${r?.net ?? null}, tax_amount = ${r?.tax ?? null}
       WHERE credit_note_id = ${doc.id} AND line_no = ${l.lineNo}`.execute(trx);
  }
  await sql`
    UPDATE app.credit_note
       SET status = 'approved', approved_by = ${opts.approvedBy}, approved_at = clock_timestamp(),
           net_total = ${built.journal.netTotal}, tax_total = ${built.journal.taxTotal},
           total = ${built.journal.total}
     WHERE id = ${doc.id}`.execute(trx);
  return {
    id: doc.id,
    status: 'approved',
    netTotal: built.journal.netTotal,
    taxTotal: built.journal.taxTotal,
    total: built.journal.total,
  };
}

export interface PostCreditNoteResult {
  id: string;
  status: 'posted';
  creditNoteNo: string;
  entryId: string;
  entryNo: string;
  laterBasPeriod: boolean;
  /** True when the credit note was already posted: the same entry, nothing written. */
  replayed: boolean;
}

/** Post an approved credit note through the posting engine; a posted one returns its entry. */
export async function postCreditNote(
  trx: Trx,
  opts: { id: string; postedBy?: string | null; outbox?: PostingOutbox },
): Promise<PostCreditNoteResult> {
  const doc = await load(trx, opts.id, true);
  if (doc.status === 'posted' && doc.journalEntryId !== null) {
    const e = await sql<{ entry_no: string }>`
      SELECT entry_no FROM app.journal_entry WHERE id = ${doc.journalEntryId}`.execute(trx);
    return {
      id: doc.id,
      status: 'posted',
      creditNoteNo: doc.creditNoteNo ?? '',
      entryId: doc.journalEntryId,
      entryNo: e.rows[0]?.entry_no ?? '',
      laterBasPeriod: doc.laterBasPeriod ?? false,
      replayed: true,
    };
  }
  expectStatus(doc, ['approved'], 'posting');
  const postedBy = opts.postedBy ?? null;
  await sql`SAVEPOINT lf_credit_note_post`.execute(trx);
  try {
    const creditNoteNo = await nextNumber(trx, doc.companyId, CREDIT_NOTE_SERIES);
    const built = await build(
      trx,
      { ...doc, creditNoteNo },
      {
        ...(postedBy === null ? {} : { createdBy: postedBy }),
        ...(doc.approvedBy === null ? {} : { approvedBy: doc.approvedBy }),
      },
    );
    const r = await post(
      trx,
      built.command,
      opts.outbox === undefined ? {} : { outbox: opts.outbox },
    );
    const freq = await sql<{ bas_frequency: BasFrequency }>`
      SELECT bas_frequency FROM app.company WHERE id = ${doc.companyId}`.execute(trx);
    const frequency = freq.rows[0]?.bas_frequency ?? 'quarterly';
    const laterBasPeriod =
      basPeriodOf(doc.creditNoteDate, frequency) >
      basPeriodOf(built.invoice.invoiceDate, frequency);
    await sql`
      UPDATE app.credit_note
         SET status = 'posted', credit_note_no = ${creditNoteNo}, posted_by = ${postedBy},
             posted_at = clock_timestamp(), journal_entry_id = ${r.entryId},
             later_bas_period = ${laterBasPeriod}
       WHERE id = ${doc.id}`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_credit_note_post`.execute(trx);
    return {
      id: doc.id,
      status: 'posted',
      creditNoteNo,
      entryId: r.entryId,
      entryNo: r.entryNo,
      laterBasPeriod,
      replayed: false,
    };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_credit_note_post`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_credit_note_post`.execute(trx);
    throw error;
  }
}

/** "Show me the journal" (design §3.9): the entry post() would write; no writes. */
export async function previewCreditNote(
  trx: Trx,
  id: string,
): Promise<BuiltEntry & { netTotal: string; taxTotal: string; total: string }> {
  const doc = await load(trx, id, false);
  const built = await build(trx, doc);
  const entry = await preview(trx, built.command);
  return {
    ...entry,
    netTotal: built.journal.netTotal,
    taxTotal: built.journal.taxTotal,
    total: built.journal.total,
  };
}

/**
 * Allocate a posted credit note's open item to its invoice's open item (ledger allocate()).
 * Over-allocation (e.g. the invoice is already paid) is the ledger's OVER_ALLOCATION.
 */
export async function allocateCreditNote(
  trx: Trx,
  opts: {
    id: string;
    amount: string;
    allocationDate: string;
    idempotencyKey: string;
    createdBy?: string;
  },
): Promise<AllocationResult> {
  const doc = await load(trx, opts.id, false);
  expectStatus(doc, ['posted'], 'allocation');
  const invoice = await invoiceFacts(trx, doc.companyId, doc.invoiceId);
  const from = await invoiceItem(trx, doc.journalEntryId ?? '');
  const to = await invoiceItem(trx, invoice.entryId ?? '');
  return allocate(trx, {
    companyId: doc.companyId,
    idempotencyKey: opts.idempotencyKey,
    fromEntryId: from.id,
    toEntryId: to.id,
    amount: opts.amount,
    allocationDate: opts.allocationDate,
    ...(opts.createdBy === undefined ? {} : { createdBy: opts.createdBy }),
    memo: `Credit note ${doc.creditNoteNo ?? doc.id} → invoice ${invoice.invoiceNo ?? invoice.id}`,
  });
}

export interface CreditNoteDocument {
  title: typeof CREDIT_NOTE_TITLE;
  creditNoteNo: string | null;
  creditNoteDate: string;
  status: CreditNoteStatus;
  originalInvoiceNo: string | null;
  originalInvoiceDate: string;
  reason: string;
  /** The GST difference (ATO adjustment-note content, RQ-0114 S6). */
  gstDifference: string | null;
  netTotal: string | null;
  total: string | null;
  /** Posted only: a Div 19 decreasing adjustment (1B) when true (RQ-0095 Q4). */
  laterBasPeriod: boolean | null;
  lines: CreditNoteLine[];
}

/** The adjustment-note content (GP-005, RQ-0095 Q4); the PDF is the T-0041 family. */
export async function creditNoteDocument(trx: Trx, id: string): Promise<CreditNoteDocument> {
  const doc = await load(trx, id, false);
  const inv = await sql<{ invoice_no: string | null; invoice_date: string }>`
    SELECT invoice_no, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
      FROM app.sales_invoice WHERE id = ${doc.invoiceId}`.execute(trx);
  const i = inv.rows[0];
  return {
    title: CREDIT_NOTE_TITLE,
    creditNoteNo: doc.creditNoteNo,
    creditNoteDate: doc.creditNoteDate,
    status: doc.status,
    originalInvoiceNo: i?.invoice_no ?? null,
    originalInvoiceDate: i?.invoice_date ?? '',
    reason: doc.reason,
    gstDifference: doc.taxTotal,
    netTotal: doc.netTotal,
    total: doc.total,
    laterBasPeriod: doc.laterBasPeriod,
    lines: doc.lines,
  };
}

export interface CreditNoteAdjustmentLine {
  creditNoteId: string;
  creditNoteNo: string;
  creditNoteDate: string;
  entryId: string;
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceEntryId: string;
  invoiceLineId: string;
  lineNo: number;
  accountId: string;
  taxCodeId: string;
  netAmount: string;
  taxAmount: string;
  laterBasPeriod: boolean;
}

/**
 * Posted credit-note lines dated in [from, to] with the invoice line each adjusts (ADR-0044 W6
 * link; T-0035 follow-up): the BAS report uses it to put later-period credits at 1B.
 */
export async function creditNoteAdjustmentLines(
  trx: Trx,
  q: { companyId: string; from: string; to: string },
): Promise<CreditNoteAdjustmentLine[]> {
  for (const d of [q.from, q.to]) {
    if (!DATE_RE.test(d))
      refuse('INVALID_CREDIT_NOTE', `date ${JSON.stringify(d)} is not YYYY-MM-DD`);
  }
  const r = await sql<CreditNoteAdjustmentLine>`
    SELECT c.id::text AS "creditNoteId", c.credit_note_no AS "creditNoteNo",
           to_char(c.credit_note_date, 'YYYY-MM-DD') AS "creditNoteDate",
           c.journal_entry_id::text AS "entryId", i.id::text AS "invoiceId",
           i.invoice_no AS "invoiceNo", to_char(i.invoice_date, 'YYYY-MM-DD') AS "invoiceDate",
           i.journal_entry_id::text AS "invoiceEntryId", l.invoice_line_id::text AS "invoiceLineId",
           l.line_no AS "lineNo", l.account_id::text AS "accountId", l.tax_code_id::text AS "taxCodeId",
           l.net_amount::text AS "netAmount", l.tax_amount::text AS "taxAmount",
           c.later_bas_period AS "laterBasPeriod"
      FROM app.credit_note c
      JOIN app.credit_note_line l ON l.tenant_id = c.tenant_id AND l.credit_note_id = c.id
      JOIN app.sales_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
     WHERE c.company_id = ${q.companyId} AND c.status = 'posted'
       AND c.credit_note_date BETWEEN ${q.from}::date AND ${q.to}::date
     ORDER BY c.credit_note_date, c.credit_note_no, l.line_no`.execute(trx);
  return r.rows;
}

export { CreditNoteError, type CreditNoteErrorCode } from './credit-note-journal.ts';
