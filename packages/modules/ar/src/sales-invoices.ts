/**
 * Sales invoices (T-0040, design §3.8 row 1, §3.4, §4.2, §4.3, UC-01; RQ-0104; golden postings
 * GP-001 and GP-018, Approved per DL-0253). Workflow, enforced here and by migration 0037:
 *
 *   draft ──approve (user)──▶ approved ──post──▶ posted
 *     └────autoApprove (on, total ≤ threshold, no credit hold)──▶ approved ──▶ posted
 *
 * - create stores a draft (header + lines); a repeat with the same key returns it.
 * - The journal is built from the document every time (preview, approve, post) by the same code:
 *   party × product → revenue account and tax code (posting-profile matrix, T-0039), tax-code
 *   version on the invoice date (T-0034), GST with the company rounding setting, then
 *   buildInvoiceJournal. Approval also runs the engine's preview, so every check post() makes
 *   (period, accounts, control account, approver) is made before the invoice is approved.
 * - approve refuses with a clear reason: NO_BILLING_TO (design §4.2), NOT_A_CUSTOMER,
 *   PARTY_ARCHIVED, a posting-profile refusal (PROFILE_GAP, TAX_CODE_CONFLICT — set an explicit
 *   tax code on the line, DL-0260 — NO_TAX_CODE, …). The approver is recorded on the invoice
 *   and on the journal entry. The design names no SoD rule for invoices (RQ-0104 Q3, T-0117).
 * - post takes the invoice number (series ar_invoice, gapless) and posts through post() with the
 *   key ar_invoice:<id>, inside one savepoint: a refusal leaves no number, entry or status change.
 *   The engine opens the AR item (subledger, due date). The notifier queues the email (T-0042).
 *
 * This module never writes ledger tables; it calls packages/ledger.
 */
import type { Database, TaxRounding } from '@ledgerforce/db';
import {
  nextNumber,
  post,
  preview,
  type BuiltEntry,
  type PostingCommand,
  type PostingOutbox,
} from '@ledgerforce/ledger';
import { billingRecipients, invoiceApprovalBlockers } from '@ledgerforce/parties';
import { PostingProfileResolutionError, resolvePartyProductPosting } from '@ledgerforce/products';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import {
  TaxCodeNotFoundError,
  findTaxCode,
  getTaxRounding,
  type AmountsAre,
} from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import {
  InvoiceJournalError,
  buildInvoiceJournal,
  type InvoiceJournalLine,
} from './invoice-journal.ts';
import { recordInvoiceLinePostings } from './invoice-line-posting.ts';
import { NO_NOTIFIER, type InvoiceNotifier } from './notifier.ts';

type Trx = Transaction<Database>;

export type SalesInvoiceStatus = 'draft' | 'approved' | 'posted';

export type SalesInvoiceErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'INVALID_INVOICE'
  | 'NO_BILLING_TO'
  | 'NOT_A_CUSTOMER'
  | 'PARTY_ARCHIVED'
  | 'UNKNOWN_APPROVER'
  | 'NO_TAX_CODE_VERSION'
  | 'TAX_ACCOUNT_MISSING'
  | PostingProfileResolutionError['code'];

/** A workflow or document refusal. Engine refusals (PERIOD_*, …) stay PostingError. */
export class SalesInvoiceError extends DomainError {
  declare readonly code: SalesInvoiceErrorCode;
}

/** Number series of invoice numbers (INV-…, design §3.4); journal entries use je_ar_invoice. */
export const INVOICE_SERIES = 'ar_invoice';
export const INVOICE_SOURCE_TYPE = 'ar_invoice';
/** The posting-engine idempotency key of an invoice: one entry per invoice, ever. */
export const postingKeyOf = (id: string) => `ar_invoice:${id}`;

export interface SalesInvoiceLineInput {
  productId: string;
  description?: string;
  /** Plain decimal, > 0, at most cents; tax-exclusive or -inclusive per amountsAre. */
  amount: string;
  /** Explicit tax code (e.g. GST); wins over the posting-profile defaults (DL-0260). */
  taxCode?: string;
}

export interface SalesInvoiceInput {
  companyId: string;
  partyId: string;
  /** YYYY-MM-DD; the journal's entry date. */
  invoiceDate: string;
  /** YYYY-MM-DD; the AR open item's due date. */
  dueDate: string;
  amountsAre?: AmountsAre;
  /** Default and only value accepted today: the company base currency (FX is later work). */
  currency?: string;
  memo?: string;
  lines: readonly SalesInvoiceLineInput[];
}

export interface SalesInvoiceLine {
  lineNo: number;
  productId: string;
  description: string | null;
  amount: string;
  taxCode: string | null;
}

export interface SalesInvoice {
  id: string;
  companyId: string;
  partyId: string;
  status: SalesInvoiceStatus;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate: string;
  amountsAre: AmountsAre;
  currency: string;
  memo: string | null;
  createdBy: string | null;
  approvalKind: 'user' | 'auto' | null;
  approvedBy: string | null;
  netTotal: string | null;
  taxTotal: string | null;
  total: string | null;
  postedBy: string | null;
  journalEntryId: string | null;
  lines: SalesInvoiceLine[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CENTS_RE = /^\d+(\.\d{1,2})?$/;

const refuse = (code: SalesInvoiceErrorCode, message: string): never => {
  throw new SalesInvoiceError(code, message);
};

interface HeaderRow {
  id: string;
  company_id: string;
  party_id: string;
  status: SalesInvoiceStatus;
  invoice_no: string | null;
  invoice_date: string;
  due_date: string;
  amounts_are: AmountsAre;
  currency: string;
  memo: string | null;
  created_by: string | null;
  approval_kind: 'user' | 'auto' | null;
  approved_by: string | null;
  net_total: string | null;
  tax_total: string | null;
  total: string | null;
  posted_by: string | null;
  journal_entry_id: string | null;
}

async function load(trx: Trx, id: string, lock: boolean): Promise<SalesInvoice> {
  if (!UUID_RE.test(id)) refuse('NOT_FOUND', `sales invoice ${id} not found`);
  const h = await sql<HeaderRow>`
    SELECT id::text, company_id::text, party_id::text, status, invoice_no,
           to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
           to_char(due_date, 'YYYY-MM-DD') AS due_date, amounts_are, currency, memo,
           created_by::text, approval_kind, approved_by::text, net_total::text, tax_total::text,
           total::text, posted_by::text, journal_entry_id::text
      FROM app.sales_invoice WHERE id = ${id.toLowerCase()}
      ${lock ? sql`FOR UPDATE` : sql``}`.execute(trx);
  const r = h.rows[0];
  if (!r) return refuse('NOT_FOUND', `sales invoice ${id} not found`);
  const lines = await sql<SalesInvoiceLine>`
    SELECT line_no AS "lineNo", product_id::text AS "productId", description,
           amount::text AS amount, tax_code AS "taxCode"
      FROM app.sales_invoice_line WHERE invoice_id = ${r.id} ORDER BY line_no`.execute(trx);
  return {
    id: r.id,
    companyId: r.company_id,
    partyId: r.party_id,
    status: r.status,
    invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    amountsAre: r.amounts_are,
    currency: r.currency,
    memo: r.memo,
    createdBy: r.created_by,
    approvalKind: r.approval_kind,
    approvedBy: r.approved_by,
    netTotal: r.net_total,
    taxTotal: r.tax_total,
    total: r.total,
    postedBy: r.posted_by,
    journalEntryId: r.journal_entry_id,
    lines: lines.rows,
  };
}

export const getSalesInvoice = (trx: Trx, id: string) => load(trx, id, false);

function expectStatus(doc: SalesInvoice, allowed: readonly SalesInvoiceStatus[], action: string) {
  if (!allowed.includes(doc.status)) {
    refuse(
      'WRONG_STATUS',
      `sales invoice ${doc.id} is ${doc.status}; ${action} needs ${allowed.join(' or ')}`,
    );
  }
}

async function checkInput(trx: Trx, input: SalesInvoiceInput): Promise<string> {
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', input.companyId)
    .executeTakeFirst();
  if (!company) return refuse('INVALID_INVOICE', `company ${input.companyId} not found`);
  const currency = input.currency ?? company.base_currency;
  if (currency !== company.base_currency) {
    refuse(
      'INVALID_INVOICE',
      `currency ${currency}: only the base currency ${company.base_currency} is invoiced today`,
    );
  }
  for (const d of [input.invoiceDate, input.dueDate]) {
    if (!DATE_RE.test(d)) refuse('INVALID_INVOICE', `date ${JSON.stringify(d)} is not YYYY-MM-DD`);
  }
  if (input.dueDate < input.invoiceDate) {
    refuse('INVALID_INVOICE', `due date ${input.dueDate} is before the invoice date`);
  }
  if (input.lines.length === 0) refuse('INVALID_INVOICE', 'an invoice needs at least one line');
  input.lines.forEach((l, i) => {
    if (!CENTS_RE.test(l.amount) || Money.of(l.amount, currency).isZero()) {
      refuse(
        'INVALID_INVOICE',
        `line ${String(i + 1)}: amount ${JSON.stringify(l.amount)} must be a positive amount in cents`,
      );
    }
  });
  return currency;
}

/** Create a draft. A repeat with the same (company, key) returns the first invoice. */
export async function createSalesInvoice(
  trx: Trx,
  opts: { input: SalesInvoiceInput; createdBy: string | null; idempotencyKey: string },
): Promise<{ id: string; replayed: boolean }> {
  const { input } = opts;
  const currency = await checkInput(trx, input);
  const r = await sql<{ id: string; inserted: boolean }>`
    WITH ins AS (
      INSERT INTO app.sales_invoice (company_id, party_id, invoice_date, due_date, amounts_are,
                                     currency, memo, idempotency_key, created_by)
      VALUES (${input.companyId}, ${input.partyId}, ${input.invoiceDate}, ${input.dueDate},
              ${input.amountsAre ?? 'exclusive'}, ${currency}, ${input.memo ?? null},
              ${opts.idempotencyKey}, ${opts.createdBy})
      ON CONFLICT (tenant_id, company_id, idempotency_key) DO NOTHING
      RETURNING id::text)
    SELECT id, true AS inserted FROM ins
    UNION ALL
    SELECT id::text, false FROM app.sales_invoice
     WHERE company_id = ${input.companyId} AND idempotency_key = ${opts.idempotencyKey}
       AND NOT EXISTS (SELECT 1 FROM ins)`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new Error('sales invoice insert returned nothing');
  if (!row.inserted) return { id: row.id, replayed: true };
  await trx
    .insertInto('app.sales_invoice_line')
    .values(
      input.lines.map((l, i) => ({
        company_id: input.companyId,
        invoice_id: row.id,
        line_no: i + 1,
        product_id: l.productId,
        description: l.description ?? null,
        amount: l.amount,
        tax_code: l.taxCode ?? null,
      })),
    )
    .execute();
  return { id: row.id, replayed: false };
}

export interface BuiltInvoice {
  command: PostingCommand;
  netTotal: string;
  taxTotal: string;
  total: string;
  residue: string;
  /** Per invoice line, in order: the resolved journal input (recorded at post, T-0045). */
  resolvedLines: (InvoiceJournalLine & { lineNo: number })[];
  rounding: TaxRounding;
}

/** The posting command of the document (RQ-0104 finding 1). Reads only. */
async function buildCommand(
  trx: Trx,
  doc: SalesInvoice,
  extra: Partial<PostingCommand> = {},
): Promise<BuiltInvoice> {
  const rounding: TaxRounding = await getTaxRounding(trx, doc.companyId);
  let controlRole: string | undefined;
  const lines: (InvoiceJournalLine & { lineNo: number })[] = [];
  for (const l of doc.lines) {
    let resolved;
    try {
      resolved = await resolvePartyProductPosting(trx, {
        companyId: doc.companyId,
        partyId: doc.partyId,
        productId: l.productId,
        direction: 'sale',
        slot: 'revenue',
        lineTaxCode: l.taxCode,
      });
    } catch (e) {
      if (e instanceof PostingProfileResolutionError) {
        const hint =
          e.code === 'TAX_CODE_CONFLICT' || e.code === 'NO_TAX_CODE'
            ? ' — set an explicit tax code on the invoice line to approve it'
            : '';
        throw new SalesInvoiceError(e.code, `line ${String(l.lineNo)}: ${e.message}${hint}`);
      }
      throw e;
    }
    controlRole = resolved.controlRole;
    let code;
    try {
      code = await findTaxCode(trx, {
        companyId: doc.companyId,
        code: resolved.taxCode,
        on: doc.invoiceDate,
      });
    } catch (e) {
      if (e instanceof TaxCodeNotFoundError) {
        throw new SalesInvoiceError(
          'NO_TAX_CODE_VERSION',
          `line ${String(l.lineNo)}: ${e.message}`,
        );
      }
      throw e;
    }
    lines.push({
      lineNo: l.lineNo,
      // NUMERIC(19,4) text; checkInput admitted at most cents, and the tax engine counts only
      // significant decimals, so "1000.0000" is accepted as 1000.00.
      amount: l.amount,
      accountId: resolved.account.id,
      taxCode: {
        id: code.id,
        code: code.code,
        rate: code.rate,
        collectedAccountId: code.collectedAccountId,
      },
    });
  }
  let journal;
  try {
    journal = buildInvoiceJournal({
      companyId: doc.companyId,
      invoiceId: doc.id,
      partyId: doc.partyId,
      controlRole: controlRole ?? 'AR_CONTROL',
      currency: doc.currency,
      amountsAre: doc.amountsAre,
      rounding,
      dueDate: doc.dueDate,
      lines,
    });
  } catch (e) {
    if (e instanceof InvoiceJournalError) throw new SalesInvoiceError(e.code, e.message);
    throw e;
  }
  return {
    command: {
      companyId: doc.companyId,
      idempotencyKey: postingKeyOf(doc.id),
      entryDate: doc.invoiceDate,
      sourceType: INVOICE_SOURCE_TYPE,
      sourceId: doc.id,
      memo: doc.memo ?? `Sales invoice${doc.invoiceNo === null ? '' : ` ${doc.invoiceNo}`}`,
      lines: journal.lines,
      ...extra,
    },
    netTotal: journal.netTotal,
    taxTotal: journal.taxTotal,
    total: journal.total,
    residue: journal.residue,
    resolvedLines: lines,
    rounding,
  };
}

const BLOCKERS = {
  no_billing_to_contact: [
    'NO_BILLING_TO',
    'the customer has no active Billing To contact with an email (design §4.2)',
  ],
  not_a_customer: ['NOT_A_CUSTOMER', 'the party has no active customer role'],
  party_archived: ['PARTY_ARCHIVED', 'the party is archived'],
} as const;

/** Party-side refusals first (Billing To, design §4.2), then the journal through preview. */
async function approvalCheck(
  trx: Trx,
  doc: SalesInvoice,
  approvedBy: string | null,
): Promise<BuiltInvoice> {
  const blockers = await invoiceApprovalBlockers(trx, doc.partyId);
  const first = (['no_billing_to_contact', 'not_a_customer', 'party_archived'] as const).find((b) =>
    blockers.includes(b),
  );
  if (first !== undefined) {
    const [code, why] = BLOCKERS[first];
    refuse(code, `sales invoice ${doc.id} cannot be approved: ${why}`);
  }
  if (approvedBy !== null) {
    const u = await sql<{ status: string }>`
      SELECT status FROM app.app_user WHERE id = ${approvedBy}`.execute(trx);
    if (u.rows[0]?.status !== 'active') {
      refuse('UNKNOWN_APPROVER', `approver ${approvedBy} is not an active user of this tenant`);
    }
  }
  const built = await buildCommand(trx, doc, approvedBy === null ? {} : { approvedBy });
  // Every check post() makes (period, accounts, control account, approver) — writes nothing.
  await preview(trx, built.command);
  return built;
}

async function markApproved(
  trx: Trx,
  doc: SalesInvoice,
  kind: 'user' | 'auto',
  approvedBy: string | null,
  built: BuiltInvoice,
): Promise<void> {
  await sql`
    UPDATE app.sales_invoice
       SET status = 'approved', approval_kind = ${kind}, approved_by = ${approvedBy},
           approved_at = clock_timestamp(), net_total = ${built.netTotal},
           tax_total = ${built.taxTotal}, total = ${built.total}
     WHERE id = ${doc.id}`.execute(trx);
}

export interface ApproveResult {
  id: string;
  status: 'approved';
  netTotal: string;
  taxTotal: string;
  total: string;
}

/** Approve a draft (user approval). Refusals are SalesInvoiceError or the engine's PostingError. */
export async function approveSalesInvoice(
  trx: Trx,
  opts: { id: string; approvedBy: string },
): Promise<ApproveResult> {
  const doc = await load(trx, opts.id, true);
  expectStatus(doc, ['draft'], 'approving');
  const built = await approvalCheck(trx, doc, opts.approvedBy);
  await markApproved(trx, doc, 'user', opts.approvedBy, built);
  return {
    id: doc.id,
    status: 'approved',
    netTotal: built.netTotal,
    taxTotal: built.taxTotal,
    total: built.total,
  };
}

export interface PostInvoiceResult {
  id: string;
  status: 'posted';
  invoiceNo: string;
  entryId: string;
  entryNo: string;
  /** True when the invoice was already posted: the same entry, nothing written. */
  replayed: boolean;
}

export interface PostInvoiceOptions {
  /** The posting user; null for an automatic posting (auto-approve, integration). */
  postedBy?: string | null;
  outbox?: PostingOutbox;
  notifier?: InvoiceNotifier;
}

async function postLoaded(
  trx: Trx,
  doc: SalesInvoice,
  opts: PostInvoiceOptions,
): Promise<PostInvoiceResult> {
  if (doc.status === 'posted' && doc.journalEntryId !== null) {
    const e = await sql<{ entry_no: string }>`
      SELECT entry_no FROM app.journal_entry WHERE id = ${doc.journalEntryId}`.execute(trx);
    return {
      id: doc.id,
      status: 'posted',
      invoiceNo: doc.invoiceNo ?? '',
      entryId: doc.journalEntryId,
      entryNo: e.rows[0]?.entry_no ?? '',
      replayed: true,
    };
  }
  expectStatus(doc, ['approved'], 'posting');
  const postedBy = opts.postedBy ?? null;
  // One savepoint: a refusal returns the invoice number and leaves the invoice approved.
  await sql`SAVEPOINT lf_invoice_post`.execute(trx);
  try {
    const invoiceNo = await nextNumber(trx, doc.companyId, INVOICE_SERIES);
    const built = await buildCommand(
      trx,
      { ...doc, invoiceNo },
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
    // How each line posted, for credit notes (T-0045, ADR-0044 W6: never re-resolved).
    await recordInvoiceLinePostings(trx, {
      companyId: doc.companyId,
      invoiceId: doc.id,
      currency: doc.currency,
      amountsAre: doc.amountsAre,
      rounding: built.rounding,
      lines: built.resolvedLines,
    });
    await sql`
      UPDATE app.sales_invoice
         SET status = 'posted', invoice_no = ${invoiceNo}, posted_by = ${postedBy},
             posted_at = clock_timestamp(), journal_entry_id = ${r.entryId}
       WHERE id = ${doc.id}`.execute(trx);
    const recipients = await billingRecipients(trx, doc.partyId);
    await (opts.notifier ?? NO_NOTIFIER).invoicePosted(trx, {
      companyId: doc.companyId,
      invoiceId: doc.id,
      invoiceNo,
      entryId: r.entryId,
      partyId: doc.partyId,
      to: recipients.to,
      cc: recipients.cc,
      total: built.total,
    });
    await sql`RELEASE SAVEPOINT lf_invoice_post`.execute(trx);
    return {
      id: doc.id,
      status: 'posted',
      invoiceNo,
      entryId: r.entryId,
      entryNo: r.entryNo,
      replayed: false,
    };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_invoice_post`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_invoice_post`.execute(trx);
    throw error;
  }
}

/** Post an approved invoice through the posting engine; a posted invoice returns its entry. */
export async function postSalesInvoice(
  trx: Trx,
  opts: { id: string } & PostInvoiceOptions,
): Promise<PostInvoiceResult> {
  return postLoaded(trx, await load(trx, opts.id, true), opts);
}

export interface InvoiceSettings {
  autoApprove: boolean;
  /** NUMERIC(19,4) text; auto-approve when total ≤ threshold (UC-01). */
  threshold: string;
}

export type AutoApproveReason =
  'AUTO_APPROVE_OFF' | 'ABOVE_THRESHOLD' | 'CREDIT_HOLD' | SalesInvoiceErrorCode;

export type AutoApproveResult =
  { outcome: 'draft'; reason: AutoApproveReason } | ({ outcome: 'posted' } & PostInvoiceResult);

/** Credit-hold hook (Phase 1, design §8 UC-04): a reason when the party is on hold, else null. */
export type CreditHoldCheck = (trx: Trx, partyId: string) => Promise<string | null>;

/**
 * UC-01 main flow 6: when auto-approve is on, the total is ≤ the threshold and the party is not
 * on credit hold, approve (kind auto) and post. Otherwise the draft stays, with the reason (A1,
 * A2, A6). Only refusals of the document itself become reasons; database errors propagate.
 */
export async function autoApproveSalesInvoice(
  trx: Trx,
  opts: {
    id: string;
    settings: InvoiceSettings;
    creditHold?: CreditHoldCheck;
    outbox?: PostingOutbox;
    notifier?: InvoiceNotifier;
  },
): Promise<AutoApproveResult> {
  const doc = await load(trx, opts.id, true);
  expectStatus(doc, ['draft'], 'auto-approval');
  if (!opts.settings.autoApprove) return { outcome: 'draft', reason: 'AUTO_APPROVE_OFF' };
  let built: BuiltInvoice;
  try {
    built = await buildCommand(trx, doc);
    if (
      Money.of(built.total, doc.currency).compare(Money.of(opts.settings.threshold, doc.currency)) >
      0
    ) {
      return { outcome: 'draft', reason: 'ABOVE_THRESHOLD' };
    }
    if (opts.creditHold && (await opts.creditHold(trx, doc.partyId)) !== null) {
      return { outcome: 'draft', reason: 'CREDIT_HOLD' };
    }
    built = await approvalCheck(trx, doc, null);
  } catch (e) {
    if (e instanceof SalesInvoiceError) return { outcome: 'draft', reason: e.code };
    throw e;
  }
  await markApproved(trx, doc, 'auto', null, built);
  const r = await postLoaded(
    trx,
    { ...doc, status: 'approved', approvalKind: 'auto', approvedBy: null },
    { postedBy: null, ...opts },
  );
  return { outcome: 'posted', ...r };
}

/** "Show me the journal" (design §3.9): the entry post() would write, from the engine; no writes. */
export async function previewSalesInvoice(
  trx: Trx,
  id: string,
): Promise<BuiltEntry & { netTotal: string; taxTotal: string; residue: string }> {
  const doc = await load(trx, id, false);
  const built = await buildCommand(trx, doc);
  const entry = await preview(trx, built.command);
  return { ...entry, netTotal: built.netTotal, taxTotal: built.taxTotal, residue: built.residue };
}

/** The company's current auto-approve setting (latest row); off with threshold 0 by default. */
export async function loadInvoiceSettings(trx: Trx, companyId: string): Promise<InvoiceSettings> {
  const r = await sql<{ auto_approve: boolean; threshold: string }>`
    SELECT auto_approve, auto_approve_threshold::text AS threshold FROM app.ar_invoice_settings
     WHERE company_id = ${companyId} ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  return row
    ? { autoApprove: row.auto_approve, threshold: row.threshold }
    : { autoApprove: false, threshold: '0.0000' };
}

/** Record a new auto-approve setting (history; who may call it is the API's check, T-0116). */
export async function setInvoiceSettings(
  trx: Trx,
  s: { companyId: string; autoApprove: boolean; threshold: string; setBy: string; reason: string },
): Promise<void> {
  const threshold = Money.of(s.threshold, 'XXX').toNumericString();
  await sql`
    INSERT INTO app.ar_invoice_settings (company_id, auto_approve, auto_approve_threshold, set_by, reason)
    VALUES (${s.companyId}, ${s.autoApprove}, ${threshold}, ${s.setBy}, ${s.reason})`.execute(trx);
}
