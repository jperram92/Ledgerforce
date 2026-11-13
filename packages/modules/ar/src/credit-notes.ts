/**
 * Customer credit notes (adjustment notes) — T-0045, design §3.8 row 4, UC-11, GP-005, GP-029
 * (Q4: credit notes net into G1/1A, reason codes), DL-0273.
 *
 * A credit note credits lines of one posted invoice. Each line names the invoice line and an
 * amount in the invoice's pricing (ex GST for exclusive invoices); GST is proportional at that
 * invoice line's own tax code and rate (computeTax, company rounding), and it reverses to the
 * same revenue account the invoice line posted to (sales_invoice_line.account_id). The total may
 * not exceed what is still creditable: invoice gross less posted credit notes
 * (CREDIT_EXCEEDS_INVOICE). Reason codes: price_concession, return, scope_reduction,
 * billing_error, goodwill — `credit_loss` is a bad-debt write-off (GP-024), never a credit note.
 *
 * Approval posts through the engine (source ar_credit_note):
 *   Dr revenue (net, tax code + tax, party) / Dr GST collected (tax) / Cr AR control (gross, party)
 * — exactly GP-005 — then applies the credit to the invoice's open item if any is left;
 * otherwise (a paid invoice) the credit stays open as customer credit (refund: T-0055).
 * Segregation of duties (SOD_CREDIT_NOTE_SELF_APPROVAL) is applied by the API before approve.
 */
import type { Database } from '@ledgerforce/db';
import {
  allocate,
  nextNumber,
  post,
  preview,
  subledgerEntriesOf,
  type PostingLineInput,
  type PostOptions,
} from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { computeTax } from '@ledgerforce/tax';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import type { DocumentOutbox } from './invoices.ts';

type Trx = Transaction<Database>;

export const CREDIT_NOTE_NUMBER_SERIES = 'ar_credit_note_document';
export const CREDIT_NOTE_POSTED = 'ar.credit_note.posted';
export const CREDIT_NOTE_REASONS = [
  'price_concession',
  'return',
  'scope_reduction',
  'billing_error',
  'goodwill',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export type CreditNoteErrorCode = 'INVALID_CREDIT_NOTE' | 'CREDIT_EXCEEDS_INVOICE' | 'NOT_DRAFT';

export class CreditNoteError extends Error {
  readonly code: CreditNoteErrorCode;
  constructor(code: CreditNoteErrorCode, message: string) {
    super(message);
    this.name = 'CreditNoteError';
    this.code = code;
  }
}

const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SS-UC11-07: the amount still creditable after this credit (NUMERIC text). Throws
 * CREDIT_EXCEEDS_INVOICE when the request exceeds invoice gross less earlier credits.
 */
export function creditableAmount(c: {
  invoiceGross: string;
  creditedGross: string;
  requestedGross: string;
}): string {
  const requested = new Decimal(c.requestedGross);
  if (!requested.gt(0))
    throw new CreditNoteError('INVALID_CREDIT_NOTE', 'a credit note must be greater than zero');
  const left = new Decimal(c.invoiceGross).minus(c.creditedGross).minus(requested);
  if (left.isNegative()) {
    throw new CreditNoteError(
      'CREDIT_EXCEEDS_INVOICE',
      `credit ${numeric(requested)} exceeds the creditable ${numeric(new Decimal(c.invoiceGross).minus(c.creditedGross))} (CREDIT_EXCEEDS_INVOICE)`,
    );
  }
  return numeric(left);
}

export interface CreditNoteInput {
  readonly companyId: string;
  readonly invoiceId: string;
  /** Client-chosen id (the API's PUT /ar/credit-notes/:id); a repeat returns the same note. */
  readonly id?: string;
  readonly issueDate: string;
  readonly reasonCode: string;
  readonly memo?: string;
  readonly createdBy?: string;
  readonly lines: readonly {
    readonly invoiceLineNo: number;
    readonly amount: string;
    readonly description?: string;
  }[];
}

export interface CreditNoteView {
  readonly creditNoteId: string;
  readonly replayed: boolean;
  readonly status: 'draft' | 'posted' | 'void';
  readonly creditNoteNo: string | null;
  readonly invoiceId: string;
  readonly entryId: string | null;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
  readonly createdBy: string | null;
}

async function creditedGross(trx: Trx, companyId: string, invoiceId: string): Promise<string> {
  const r = await sql<{ g: string }>`
    SELECT coalesce(sum(gross_total), 0)::text AS g FROM app.credit_note
     WHERE company_id = ${companyId} AND invoice_id = ${invoiceId}::uuid AND status = 'posted'`.execute(
    trx,
  );
  return r.rows[0]?.g ?? '0';
}

export async function getCreditNote(
  trx: Trx,
  companyId: string,
  id: string,
  replayed = false,
): Promise<CreditNoteView> {
  const r = (
    await sql<{
      id: string;
      status: 'draft' | 'posted' | 'void';
      credit_note_no: string | null;
      invoice_id: string;
      entry_id: string | null;
      net_total: string;
      tax_total: string;
      gross_total: string;
      created_by: string | null;
    }>`
      SELECT id::text, status, credit_note_no, invoice_id::text, entry_id::text, net_total::text,
             tax_total::text, gross_total::text, created_by::text
        FROM app.credit_note WHERE company_id = ${companyId.toLowerCase()} AND id = ${id}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!r)
    throw new CreditNoteError(
      'INVALID_CREDIT_NOTE',
      `credit note ${id} is not in company ${companyId}`,
    );
  return {
    creditNoteId: r.id,
    replayed,
    status: r.status,
    creditNoteNo: r.credit_note_no,
    invoiceId: r.invoice_id,
    entryId: r.entry_id,
    net: r.net_total,
    tax: r.tax_total,
    gross: r.gross_total,
    createdBy: r.created_by,
  };
}

/** Create a draft credit note against a posted invoice. */
export async function createCreditNote(trx: Trx, c: CreditNoteInput): Promise<CreditNoteView> {
  const companyId = c.companyId.toLowerCase();
  if (c.id) {
    const existing = await trx
      .selectFrom('app.credit_note')
      .select('id')
      .where('company_id', '=', companyId)
      .where('id', '=', c.id.toLowerCase())
      .executeTakeFirst();
    if (existing) return getCreditNote(trx, companyId, existing.id, true);
  }
  if (!(CREDIT_NOTE_REASONS as readonly string[]).includes(c.reasonCode)) {
    throw new CreditNoteError(
      'INVALID_CREDIT_NOTE',
      `reason ${c.reasonCode} is not a credit-note reason (${CREDIT_NOTE_REASONS.join(', ')}); a credit loss is a write-off`,
    );
  }
  if (!DATE_RE.test(c.issueDate))
    throw new CreditNoteError('INVALID_CREDIT_NOTE', 'issue date is YYYY-MM-DD');
  if (c.lines.length === 0)
    throw new CreditNoteError('INVALID_CREDIT_NOTE', 'a credit note needs at least one line');
  const inv = (
    await sql<{
      party_id: string;
      status: string;
      pricing: 'exclusive' | 'inclusive';
      gross_total: string | null;
      issue_date: string;
    }>`
      SELECT party_id::text, status, pricing, gross_total::text, to_char(issue_date, 'YYYY-MM-DD') AS issue_date
        FROM app.sales_invoice WHERE company_id = ${companyId} AND id = ${c.invoiceId}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!inv || inv.status !== 'posted' || inv.gross_total === null) {
    throw new CreditNoteError(
      'INVALID_CREDIT_NOTE',
      `invoice ${c.invoiceId} is not a posted invoice of this company`,
    );
  }
  if (c.issueDate < inv.issue_date) {
    throw new CreditNoteError(
      'INVALID_CREDIT_NOTE',
      'a credit note cannot be dated before its invoice',
    );
  }
  const invLines = await sql<{
    line_no: number;
    description: string;
    account_id: string | null;
    tax_code_id: string | null;
    rate: string | null;
  }>`
    SELECT l.line_no, l.description, l.account_id::text, l.tax_code_id::text, t.rate::text
      FROM app.sales_invoice_line l
      LEFT JOIN app.tax_code t ON t.tenant_id = l.tenant_id AND t.id = l.tax_code_id
     WHERE l.invoice_id = ${c.invoiceId}::uuid`.execute(trx);
  const byNo = new Map(invLines.rows.map((l) => [l.line_no, l]));
  const picked = c.lines.map((l, i) => {
    const src = byNo.get(l.invoiceLineNo);
    if (!src?.account_id) {
      throw new CreditNoteError(
        'INVALID_CREDIT_NOTE',
        `line ${String(i + 1)}: invoice line ${String(l.invoiceLineNo)} does not exist or did not post`,
      );
    }
    if (!AMOUNT_RE.test(l.amount) || !new Decimal(l.amount).gt(0)) {
      throw new CreditNoteError(
        'INVALID_CREDIT_NOTE',
        `line ${String(i + 1)}: amount must be > 0 with ≤ 2 decimals`,
      );
    }
    return { src, amount: l.amount, description: l.description ?? src.description };
  });
  const company = await trx
    .selectFrom('app.company')
    .select('tax_rounding')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const taxed = computeTax({
    pricing: inv.pricing,
    rounding: company.tax_rounding,
    lines: picked.map((p) => ({
      amount: p.amount,
      rate: new Decimal(p.src.rate ?? '0').toString(),
    })),
  });
  creditableAmount({
    invoiceGross: inv.gross_total,
    creditedGross: await creditedGross(trx, companyId, c.invoiceId),
    requestedGross: taxed.gross,
  });
  const header = await trx
    .insertInto('app.credit_note')
    .values({
      ...(c.id ? { id: c.id.toLowerCase() } : {}),
      company_id: companyId,
      party_id: inv.party_id,
      invoice_id: c.invoiceId,
      issue_date: c.issueDate,
      reason_code: c.reasonCode as CreditNoteReason,
      memo: c.memo ?? null,
      net_total: taxed.net,
      tax_total: taxed.tax,
      gross_total: taxed.gross,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.credit_note_line')
    .values(
      picked.map((p, i) => ({
        company_id: companyId,
        credit_note_id: header.id,
        line_no: i + 1,
        invoice_line_no: p.src.line_no,
        description: p.description,
        account_id: p.src.account_id ?? '',
        tax_code_id: p.src.tax_code_id,
        net: taxed.lines[i]?.net ?? '0',
        tax: taxed.lines[i]?.tax ?? '0',
        gross: taxed.lines[i]?.gross ?? '0',
      })),
    )
    .execute();
  return getCreditNote(trx, companyId, header.id);
}

interface ApprovalHeader {
  id: string;
  status: string;
  party_id: string;
  invoice_id: string;
  issue_date: string;
  tax_total: string;
  gross_total: string;
  created_by: string | null;
  invoice_entry: string;
  invoice_gross: string;
}

/**
 * The draft credit note approval would post and its GP-005 journal. Shared by approveCreditNote
 * and previewCreditNoteJournal (T-0151) so the preview cannot drift from the posting. Refuses as
 * approval does: unknown note, not a draft, credit beyond the invoice.
 */
async function creditNoteJournal(
  trx: Trx,
  companyId: string,
  creditNoteId: string,
  lock: boolean,
): Promise<{ h: ApprovalHeader; journal: PostingLineInput[] }> {
  const h = (
    await sql<ApprovalHeader>`
      SELECT n.id::text, n.status, n.party_id::text, n.invoice_id::text,
             to_char(n.issue_date, 'YYYY-MM-DD') AS issue_date, n.tax_total::text, n.gross_total::text,
             n.created_by::text, i.entry_id::text AS invoice_entry, i.gross_total::text AS invoice_gross
        FROM app.credit_note n
        JOIN app.sales_invoice i ON i.tenant_id = n.tenant_id AND i.id = n.invoice_id
       WHERE n.company_id = ${companyId} AND n.id = ${creditNoteId}::uuid
       ${lock ? sql`FOR UPDATE OF n` : sql``}`.execute(trx)
  ).rows[0];
  if (!h)
    throw new CreditNoteError(
      'INVALID_CREDIT_NOTE',
      `credit note ${creditNoteId} is not in company ${companyId}`,
    );
  if (h.status !== 'draft')
    throw new CreditNoteError('NOT_DRAFT', `credit note ${creditNoteId} is ${h.status}`);
  creditableAmount({
    invoiceGross: h.invoice_gross,
    creditedGross: await creditedGross(trx, companyId, h.invoice_id),
    requestedGross: h.gross_total,
  });
  const lines = await trx
    .selectFrom('app.credit_note_line')
    .select(['account_id', 'tax_code_id', 'net', 'tax'])
    .where('credit_note_id', '=', h.id)
    .orderBy('line_no')
    .execute();
  const revenue = new Map<
    string,
    { accountId: string; taxCodeId: string | null; net: Decimal; tax: Decimal }
  >();
  for (const l of lines) {
    const key = `${l.account_id}:${String(l.tax_code_id)}`;
    const cur = revenue.get(key) ?? {
      accountId: l.account_id,
      taxCodeId: l.tax_code_id,
      net: new Decimal(0),
      tax: new Decimal(0),
    };
    cur.net = cur.net.plus(l.net);
    cur.tax = cur.tax.plus(l.tax);
    revenue.set(key, cur);
  }
  const journal: PostingLineInput[] = [
    ...[...revenue.values()]
      .filter((r) => !r.net.isZero())
      .map((r) => ({
        account: { id: r.accountId },
        debit: numeric(r.net),
        ...(r.taxCodeId ? { taxCodeId: r.taxCodeId, taxAmount: numeric(r.tax) } : {}),
        partyId: h.party_id,
      })),
    ...(new Decimal(h.tax_total).isZero()
      ? []
      : [{ account: { role: 'GST_COLLECTED' }, debit: h.tax_total }]),
    { account: { role: 'AR_CONTROL' }, credit: h.gross_total, partyId: h.party_id },
  ];
  return { h, journal };
}

export interface CreditNoteJournalPreview {
  readonly entryDate: string;
  readonly requestedDate: string;
  readonly redirected: boolean;
  readonly needsOverride: boolean;
  readonly baseCurrency: string;
  readonly total: string;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly accountId: string;
    readonly accountCode: string;
    readonly accountName: string;
    readonly accountType: string;
    readonly debit: string;
    readonly credit: string;
    readonly partyId: string | null;
  }[];
}

/**
 * "Show me the journal" for a draft credit note (T-0151, SS-UC11-08, design §3.9): the posting
 * engine's preview of the journal approveCreditNote would post (same builder, source type and
 * date). Writes nothing: no number is taken, nothing is allocated or stored.
 */
export async function previewCreditNoteJournal(
  trx: Trx,
  q: { companyId: string; creditNoteId: string },
): Promise<CreditNoteJournalPreview> {
  const companyId = q.companyId.toLowerCase();
  const { h, journal } = await creditNoteJournal(trx, companyId, q.creditNoteId, false);
  const built = await preview(trx, {
    companyId,
    idempotencyKey: `ar-credit-note:${h.id}`,
    entryDate: h.issue_date,
    sourceType: 'ar_credit_note',
    sourceId: h.id,
    memo: 'Credit note (draft preview)',
    lines: journal,
  });
  const ids = [...new Set(built.lines.map((l) => l.accountId))];
  const names = new Map(
    (
      await sql<{ id: string; name: string; type: string }>`
        SELECT id::text, name, type FROM app.account
         WHERE company_id = ${companyId} AND id = ANY(${sql.val(ids)}::uuid[])`.execute(trx)
    ).rows.map((a) => [a.id, a]),
  );
  return {
    entryDate: built.entryDate,
    requestedDate: built.requestedDate,
    redirected: built.redirected,
    needsOverride: built.needsOverride,
    baseCurrency: built.baseCurrency,
    total: built.total,
    lines: built.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: names.get(l.accountId)?.name ?? l.accountCode,
      accountType: names.get(l.accountId)?.type ?? '',
      debit: l.debit,
      credit: l.credit,
      partyId: l.partyId,
    })),
  };
}

/** Approve and post a draft credit note; apply it to its invoice while the invoice is open. */
export async function approveCreditNote(
  trx: Trx,
  c: { companyId: string; creditNoteId: string; approvedBy?: string },
  deps: { outbox?: DocumentOutbox; posting?: PostOptions } = {},
): Promise<CreditNoteView> {
  const companyId = c.companyId.toLowerCase();
  const { h, journal } = await creditNoteJournal(trx, companyId, c.creditNoteId, true);
  const creditNoteNo = await nextNumber(trx, companyId, CREDIT_NOTE_NUMBER_SERIES);
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-credit-note:${h.id}`,
      entryDate: h.issue_date,
      sourceType: 'ar_credit_note',
      sourceId: h.id,
      memo: `Credit note ${creditNoteNo}`,
      ...(h.created_by ? { createdBy: h.created_by } : {}),
      ...(c.approvedBy ? { approvedBy: c.approvedBy } : {}),
      lines: journal,
    },
    deps.posting ?? {},
  );
  // Apply to the invoice while it is still open; a paid invoice leaves customer credit (GP-005).
  const [credit] = await subledgerEntriesOf(trx, posted.entryId);
  const [invoiceItem] = await subledgerEntriesOf(trx, h.invoice_entry);
  if (credit && invoiceItem && new Decimal(invoiceItem.openAmount).gt(0)) {
    const amount = Decimal.min(new Decimal(invoiceItem.openAmount), new Decimal(h.gross_total));
    await allocate(trx, {
      companyId,
      idempotencyKey: `ar-credit-note-apply:${h.id}`,
      fromEntryId: credit.id,
      toEntryId: invoiceItem.id,
      amount: numeric(amount),
      allocationDate: h.issue_date,
      memo: `Credit note ${creditNoteNo}`,
    });
  }
  await trx
    .updateTable('app.credit_note')
    .set({
      status: 'posted',
      credit_note_no: creditNoteNo,
      entry_id: posted.entryId,
      approved_by: c.approvedBy ?? null,
      approved_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', h.id)
    .execute();
  await deps.outbox?.publish(trx, {
    companyId,
    topic: CREDIT_NOTE_POSTED,
    aggregateType: 'credit_note',
    aggregateId: h.id,
    payload: {
      creditNoteId: h.id,
      creditNoteNo,
      invoiceId: h.invoice_id,
      partyId: h.party_id,
      gross: h.gross_total,
    },
  });
  return getCreditNote(trx, companyId, h.id);
}
