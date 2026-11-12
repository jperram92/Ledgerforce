/**
 * Bills inbox (T-0051, UC-05, RQ-0101, ADR-0048, DL-0289).
 *
 * ingestBillEmail takes a raw RFC 5322 message — from IMAP polling, a provider webhook or a test —
 * and records an inbox item (the draft bill awaiting coding) with its PDF attachments stored.
 * Idempotent per company on Message-ID (or the message's SHA-256 when absent). The sender address
 * suggests the supplier (an active supplier's contact email); nothing is posted. An email without
 * a PDF is kept as `no_attachment`. codeInboxItem turns an item into a draft supplier bill
 * (createBill) and copies the PDF to it; approval then follows the bill workflow.
 */
import { createHash } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import PostalMime from 'postal-mime';
import { createBill, type BillLineInput, type BillView } from './bills.ts';

type Trx = Transaction<Database>;

const MAX_ATTACHMENT = 10 * 1024 * 1024;

export type InboxErrorCode = 'INVALID_EMAIL' | 'NOT_CODABLE';

export class InboxError extends Error {
  readonly code: InboxErrorCode;
  constructor(code: InboxErrorCode, message: string) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

export interface InboxItemView {
  readonly id: string;
  readonly replayed: boolean;
  readonly status: 'new' | 'no_attachment' | 'coded' | 'rejected';
  readonly fromAddress: string | null;
  readonly subject: string | null;
  readonly partyId: string | null;
  readonly attachments: readonly {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }[];
}

async function viewOf(
  trx: Trx,
  companyId: string,
  id: string,
  replayed: boolean,
): Promise<InboxItemView> {
  const item = await trx
    .selectFrom('app.bill_inbox_item')
    .select(['id', 'status', 'from_address', 'subject', 'party_id'])
    .where('company_id', '=', companyId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const atts = await trx
    .selectFrom('app.document_attachment')
    .select(['file_name', 'content_type', 'size_bytes', 'sha256'])
    .where('owner_type', '=', 'bill_inbox_item')
    .where('owner_id', '=', id)
    .orderBy('created_at')
    .execute();
  return {
    id: item.id,
    replayed,
    status: item.status,
    fromAddress: item.from_address,
    subject: item.subject,
    partyId: item.party_id,
    attachments: atts.map((a) => ({
      fileName: a.file_name,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      sha256: a.sha256,
    })),
  };
}

const isPdf = (a: { filename?: string | null; mimeType?: string }) =>
  a.mimeType === 'application/pdf' ||
  (a.mimeType === 'application/octet-stream' && /\.pdf$/i.test(a.filename ?? ''));

export async function ingestBillEmail(
  trx: Trx,
  c: { companyId: string; raw: Uint8Array | string },
): Promise<InboxItemView> {
  const companyId = c.companyId.toLowerCase();
  const bytes = typeof c.raw === 'string' ? Buffer.from(c.raw, 'utf8') : Buffer.from(c.raw);
  if (bytes.length === 0) throw new InboxError('INVALID_EMAIL', 'empty message');
  const rawSha = createHash('sha256').update(bytes).digest('hex');
  const email = await PostalMime.parse(bytes);
  const messageId = (email.messageId ?? '').trim() || `<sha256:${rawSha}>`;
  const existing = await trx
    .selectFrom('app.bill_inbox_item')
    .select('id')
    .where('company_id', '=', companyId)
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  if (existing) return viewOf(trx, companyId, existing.id, true);

  const from = email.from?.address?.toLowerCase() ?? null;
  const supplier = from
    ? (
        await sql<{ party_id: string }>`
          SELECT DISTINCT c.party_id::text FROM app.party_contact c
            JOIN app.party_role r ON r.tenant_id = c.tenant_id AND r.party_id = c.party_id AND r.role = 'supplier' AND r.active
            JOIN app.party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id AND p.status = 'active'
           WHERE c.company_id = ${companyId} AND lower(c.email) = ${from} AND c.status = 'active'`.execute(
          trx,
        )
      ).rows
    : [];
  const pdfs = email.attachments.filter(isPdf);
  for (const a of pdfs) {
    const size =
      a.content instanceof ArrayBuffer
        ? a.content.byteLength
        : Buffer.byteLength(String(a.content));
    if (size > MAX_ATTACHMENT)
      throw new InboxError('INVALID_EMAIL', `attachment ${a.filename ?? ''} exceeds 10 MB`);
  }
  const item = await trx
    .insertInto('app.bill_inbox_item')
    .values({
      company_id: companyId,
      message_id: messageId.slice(0, 998),
      raw_sha256: rawSha,
      from_address: from,
      subject: email.subject?.slice(0, 998) ?? null,
      // Suggest the supplier only when the address belongs to exactly one.
      party_id: supplier.length === 1 ? (supplier[0]?.party_id ?? null) : null,
      status: pdfs.length > 0 ? 'new' : 'no_attachment',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [i, a] of pdfs.entries()) {
    const content =
      a.content instanceof ArrayBuffer
        ? Buffer.from(a.content)
        : Buffer.from(String(a.content), 'utf8');
    await trx
      .insertInto('app.document_attachment')
      .values({
        company_id: companyId,
        owner_type: 'bill_inbox_item',
        owner_id: item.id,
        file_name: (a.filename ?? `attachment-${String(i + 1)}.pdf`).slice(0, 255),
        content_type: 'application/pdf',
        size_bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
      })
      .execute();
  }
  return viewOf(trx, companyId, item.id, false);
}

/** Code an inbox item: create the draft supplier bill and copy the PDF to it. */
export async function codeInboxItem(
  trx: Trx,
  c: {
    companyId: string;
    itemId: string;
    /** Defaults to the supplier the sender address matched. */
    partyId?: string;
    supplierRef: string;
    billDate: string;
    dueDate?: string;
    createdBy?: string;
    lines: readonly BillLineInput[];
  },
): Promise<BillView> {
  const companyId = c.companyId.toLowerCase();
  const item = await sql<{ status: string; party_id: string | null }>`
    SELECT status, party_id::text FROM app.bill_inbox_item
     WHERE company_id = ${companyId} AND id = ${c.itemId}::uuid FOR UPDATE`.execute(trx);
  const it = item.rows[0];
  if (!it || it.status !== 'new') {
    throw new InboxError(
      'NOT_CODABLE',
      `inbox item ${c.itemId} is ${it?.status ?? 'missing'}; only new items with a PDF can be coded`,
    );
  }
  const partyId = c.partyId ?? it.party_id;
  if (!partyId)
    throw new InboxError('NOT_CODABLE', 'choose the supplier: the sender did not match one');
  const bill = await createBill(trx, {
    companyId,
    partyId,
    supplierRef: c.supplierRef,
    billDate: c.billDate,
    ...(c.dueDate ? { dueDate: c.dueDate } : {}),
    ...(c.createdBy ? { createdBy: c.createdBy } : {}),
    lines: c.lines,
  });
  await sql`
    INSERT INTO app.document_attachment (company_id, owner_type, owner_id, file_name, content_type, size_bytes, sha256, content)
    SELECT company_id, 'supplier_bill', ${bill.billId}::uuid, file_name, content_type, size_bytes, sha256, content
      FROM app.document_attachment WHERE owner_type = 'bill_inbox_item' AND owner_id = ${c.itemId}::uuid`.execute(
    trx,
  );
  await trx
    .updateTable('app.bill_inbox_item')
    .set({ status: 'coded', bill_id: bill.billId, party_id: partyId })
    .where('id', '=', c.itemId)
    .execute();
  return bill;
}
