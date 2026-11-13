/**
 * Bills inbox over HTTP (T-0136, UC-05, SS-UC05-09, RQ-0148, DL-0510–DL-0512). Thin: validates and
 * calls @ledgerforce/ap (T-0051 inbox).
 * - `GET  /ap/inbox?company_id=` lists the emailed bills, newest first: status, sender, subject,
 *   the suggested supplier and the PDFs (ap.read).
 * - `GET  /ap/inbox/:id/attachments/:n?company_id=` downloads the n-th PDF (ap.read). RQ-0148:
 *   `application/pdf`, `Content-Disposition: attachment` (Express's encoder), nosniff, no-store
 *   and a `sandbox` CSP; no inline viewer (that would loosen ADR-0054's framing headers).
 * - `POST /ap/inbox/:id/code` `{company_id, bill_id, party_id?, supplier_ref, bill_date, due_date?,
 *   lines}` codes the item into a draft bill under the client-chosen bill id (ap.bill.enter,
 *   Idempotency-Key, SoD step `bill.enter` on the bill, audited). The item's stored bill id is the
 *   replay record (as PUT /ap/bills/:id and DL-0420): the same bill id again is 200 with that bill,
 *   any other coding of a coded item is 422 NOT_CODABLE.
 * Another tenant's item is invisible under RLS, so it is 404.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BillError,
  codeInboxItem,
  getBill,
  inboxAttachment,
  InboxError,
  listInboxItems,
  type BillView,
  type InboxListItem,
} from '@ledgerforce/ap';
import { PeriodLockedError, PostingError } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { fromBody, SoD } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PDF_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const notFound = (what: string): never => {
  throw new NotFoundException({ error: 'not_found', message: `${what} not found` });
};
const refusal = (e: unknown): never => {
  if (
    e instanceof InboxError ||
    e instanceof BillError ||
    e instanceof PostingError ||
    e instanceof PeriodLockedError
  ) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};
const obj = (v: unknown) =>
  (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const str = (v: unknown, name: string): string => (typeof v === 'string' ? v : bad(name));
const actorOf = (req: Request) => principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;

const itemView = (i: InboxListItem) => ({
  id: i.id,
  status: i.status,
  from_address: i.fromAddress,
  subject: i.subject,
  received_at: i.receivedAt.toISOString(),
  party_id: i.partyId,
  supplier_name: i.supplierName,
  bill_id: i.billId,
  attachments: i.attachments.map((a) => ({
    n: a.n,
    file_name: a.fileName,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
  })),
});

const billView = (b: BillView) => ({
  id: b.billId,
  status: b.status,
  bill_no: b.billNo,
  entry_id: b.entryId,
  net: b.net,
  tax: b.tax,
  gross: b.gross,
});

@Controller('ap/inbox')
export class ApInboxController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission('ap.read')
  async list(@Query('company_id') companyId: unknown) {
    const items = await listInboxItems(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
    });
    return { items: items.map(itemView) };
  }

  @Get(':id/attachments/:n')
  @RequirePermission('ap.read')
  async attachment(
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Param('n') n: string,
    @Query('company_id') companyId: unknown,
  ): Promise<StreamableFile> {
    const company = uuid(companyId, 'company_id');
    if (!UUID.test(id)) notFound('inbox item');
    if (!/^[1-9]\d{0,2}$/.test(n)) notFound('attachment');
    const file = await inboxAttachment(this.tx.get(), {
      companyId: company,
      itemId: id,
      n: Number(n),
    });
    if (!file) return notFound('attachment');
    // Express's content-disposition encoder: quotes escaped, path stripped, non-ASCII in filename*.
    // eslint-disable-next-line no-control-regex
    res.attachment(file.fileName.replace(/[\x00-\x1f\x7f]/g, '_'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', PDF_CSP);
    return new StreamableFile(file.content);
  }

  @Post(':id/code')
  @HttpCode(201)
  @RequirePermission('ap.bill.enter')
  @SoD('bill.enter', fromBody('bill_id'))
  async code(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = obj(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const billId = uuid(b['bill_id'], 'bill_id');
    if (!UUID.test(id)) notFound('inbox item');
    const itemId = id.toLowerCase();
    const trx = this.tx.get();
    const [item] = await listInboxItems(trx, { companyId, itemId });
    if (!item) return notFound('inbox item');
    if (item.status === 'coded' && item.billId === billId) {
      const bill = await getBill(trx, companyId, billId).catch(refusal);
      res.status(200);
      return { item_id: itemId, status: 'coded', replayed: true, bill: billView(bill) };
    }
    const billDate = str(b['bill_date'], 'bill_date must be YYYY-MM-DD');
    if (!DATE.test(billDate)) bad('bill_date must be YYYY-MM-DD');
    const dueDate = b['due_date'];
    if (dueDate !== undefined && (typeof dueDate !== 'string' || !DATE.test(dueDate)))
      bad('due_date must be YYYY-MM-DD');
    const supplierRef = str(b['supplier_ref'], 'supplier_ref is required');
    const lines = Array.isArray(b['lines']) ? (b['lines'] as unknown[]) : bad('lines are required');
    const partyId =
      b['party_id'] === undefined || b['party_id'] === null
        ? undefined
        : uuid(b['party_id'], 'party_id');
    const createdBy = actorOf(req);
    const bill = await codeInboxItem(trx, {
      companyId,
      itemId,
      billId,
      ...(partyId ? { partyId } : {}),
      supplierRef,
      billDate,
      ...(typeof dueDate === 'string' ? { dueDate } : {}),
      ...(createdBy ? { createdBy } : {}),
      lines: lines.map((l) => {
        const o = obj(l);
        return {
          accountId: uuid(o['account_id'], 'lines[].account_id'),
          description: str(o['description'], 'lines[].description is required'),
          amount: str(o['amount'], 'lines[].amount must be a decimal string'),
          taxCode: str(o['tax_code'], 'lines[].tax_code is required'),
        };
      }),
    }).catch(refusal);
    const view = { item_id: itemId, status: 'coded' as const, bill: billView(bill) };
    this.audit.describe({
      entityType: 'bill_inbox_item',
      entityId: itemId,
      before: { status: item.status, bill_id: null },
      after: view,
    });
    return { ...view, replayed: false };
  }
}
