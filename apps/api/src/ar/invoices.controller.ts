/**
 * AR invoice read routes (T-0131, SS-UC01-10, DL-0406):
 *   GET /ar/invoices?company_id=&status=   — list (newest issue date first)
 *   GET /ar/invoices/:id?company_id=       — one invoice with its lines
 *   GET /ar/invoices/:id/journal?company_id= — "Show me the journal": the posting engine's preview of
 *     exactly what approving the draft would post; writes nothing (no number, no hold, no entry).
 * All require ar.read. Money is a decimal string. An invoice outside the caller's tenant or
 * company is 404 (RLS hides it; the module reports it as not in the company).
 *   POST /ar/invoices/:id/approve?company_id= — approve and post one draft (T-0132, ADR-0073):
 *     ar.invoice.approve; SoD SOD_INVOICE_SELF_APPROVAL with the creator read from the invoice;
 *     Idempotency-Key required; the posted invoice is the replay record (same approver → 200
 *     `replayed: true`, anyone else → 409 already_posted); audited; GP-001 via approveInvoice.
 */
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  approveInvoice,
  getInvoice,
  InvoiceError,
  listInvoices,
  previewInvoiceJournal,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { PostingError, type PostingOutbox } from '@ledgerforce/ledger';
import type { Request } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { sodOutlook } from '../sod/sod.service.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { DOCUMENT_OUTBOX, POSTING_OUTBOX } from '../tokens.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['draft', 'posted', 'void']);

const uuid = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw new BadRequestException({ error: 'invalid_request', message: `${field} must be a uuid` });
  }
  return v.toLowerCase();
};
const refusal = (e: unknown): never => {
  if (e instanceof InvoiceError && e.code === 'INVALID_INVOICE') {
    throw new NotFoundException({ error: 'not_found', message: 'invoice not found' });
  }
  if (e instanceof InvoiceError || e instanceof PostingError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};

const actorOf = (req: Request) => principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;

/**
 * The SoD subject of `invoice.approve` (ADR-0073): the invoice id and its creator, read from
 * app.sales_invoice in the request transaction (under RLS). An invoice the caller cannot see
 * reports no creator; the handler then answers 404.
 */
const invoiceWithCreator: SubjectFrom = async (req, trx) => {
  const id = req.params['id'];
  const companyId = req.query['company_id'];
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  if (typeof companyId !== 'string' || !UUID.test(companyId)) throw new InvalidSodSubject();
  const inv = await getInvoice(trx, { companyId, invoiceId: id.toLowerCase() }).catch(() => null);
  return { id: id.toLowerCase(), createdBy: inv?.createdBy ?? null };
};

interface Approved {
  id: string;
  status: string;
  invoiceNo: string | null;
  entryId: string | null;
  net: string | null;
  tax: string | null;
  gross: string | null;
}
const approvedView = (a: Approved, replayed: boolean) => ({
  id: a.id,
  status: a.status,
  invoice_no: a.invoiceNo,
  entry_id: a.entryId,
  net_total: a.net,
  tax_total: a.tax,
  gross_total: a.gross,
  replayed,
});

@Controller('ar/invoices')
export class ArInvoicesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(DOCUMENT_OUTBOX) private readonly documents: DocumentOutbox | null,
    @Inject(POSTING_OUTBOX) private readonly posting: PostingOutbox | null,
  ) {}

  @Get()
  @RequirePermission('ar.read')
  async list(@Query('company_id') companyId: unknown, @Query('status') status: unknown) {
    const company = uuid(companyId, 'company_id');
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) {
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'status must be draft, posted or void',
      });
    }
    const rows = await listInvoices(this.tx.get(), {
      companyId: company,
      ...(typeof status === 'string' ? { status: status as 'draft' | 'posted' | 'void' } : {}),
    });
    return {
      invoices: rows.map((r) => ({
        id: r.id,
        invoice_no: r.invoiceNo,
        status: r.status,
        party_id: r.partyId,
        party_name: r.partyName,
        issue_date: r.issueDate,
        due_date: r.dueDate,
        gross_total: r.grossTotal,
      })),
    };
  }

  @Get(':id')
  @RequirePermission('ar.read')
  async detail(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: unknown,
  ) {
    const company = uuid(companyId, 'company_id');
    const trx = this.tx.get();
    const inv = await getInvoice(trx, {
      companyId: company,
      invoiceId: uuid(id, 'id'),
    }).catch(refusal);
    // What the SoD rule would decide for this user if they approved now (ADR-0073); the
    // approve route still decides. Only drafts can be approved.
    const me = actorOf(req);
    const outlook =
      inv.status === 'draft' && me
        ? await sodOutlook(trx, {
            step: 'invoice.approve',
            actorId: me,
            permission: 'ar.invoice.approve',
            subject: { id: inv.id, createdBy: inv.createdBy },
          })
        : null;
    const denied = outlook?.decision.outcome === 'deny' ? outlook.decision : null;
    return {
      id: inv.id,
      invoice_no: inv.invoiceNo,
      status: inv.status,
      kind: inv.kind,
      pricing: inv.pricing,
      party_id: inv.partyId,
      party_name: inv.partyName,
      issue_date: inv.issueDate,
      due_date: inv.dueDate,
      entry_id: inv.entryId,
      net_total: inv.netTotal,
      tax_total: inv.taxTotal,
      gross_total: inv.grossTotal,
      warnings: inv.warnings,
      approval: outlook
        ? {
            allowed: denied === null,
            rule: denied?.rule ?? null,
            small_team_exception_required: denied?.smallTeamExceptionRequired ?? false,
          }
        : null,
      lines: inv.lines.map((l) => ({
        line_no: l.lineNo,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        tax_code: l.taxCode,
        net: l.net,
        tax: l.tax,
        gross: l.gross,
      })),
    };
  }

  @Get(':id/journal')
  @RequirePermission('ar.read')
  async journal(@Param('id') id: string, @Query('company_id') companyId: unknown) {
    const company = uuid(companyId, 'company_id');
    const p = await previewInvoiceJournal(this.tx.get(), {
      companyId: company,
      invoiceId: uuid(id, 'id'),
    }).catch(refusal);
    return {
      entry_date: p.entryDate,
      requested_date: p.requestedDate,
      redirected: p.redirected,
      needs_override: p.needsOverride,
      base_currency: p.baseCurrency,
      total: p.total,
      lines: p.lines.map((l) => ({
        line_no: l.lineNo,
        account_id: l.accountId,
        account_code: l.accountCode,
        account_name: l.accountName,
        account_type: l.accountType,
        debit: l.debit,
        credit: l.credit,
        party_id: l.partyId,
      })),
    };
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('ar.invoice.approve')
  @SoD('invoice.approve', invoiceWithCreator)
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const company = uuid(companyId, 'company_id');
    const invoiceId = uuid(id, 'id');
    if (!key || key.length > 200) {
      throw new BadRequestException({
        error: 'idempotency_key_required',
        message: 'send an Idempotency-Key header of 1 to 200 characters',
      });
    }
    const me = actorOf(req);
    if (!me) throw new BadRequestException({ error: 'invalid_request', message: 'no user' });
    const trx = this.tx.get();
    // The SoD check already holds the subject lock, so this read sees any approval that won.
    const current = await getInvoice(trx, { companyId: company, invoiceId }).catch(refusal);
    if (current.status === 'posted') {
      if (current.approvedBy !== me) {
        throw new ConflictException({
          error: 'already_posted',
          message: `invoice ${current.invoiceNo ?? current.id} was already approved and posted by someone else`,
        });
      }
      const view = approvedView(
        {
          id: current.id,
          status: current.status,
          invoiceNo: current.invoiceNo,
          entryId: current.entryId,
          net: current.netTotal,
          tax: current.taxTotal,
          gross: current.grossTotal,
        },
        true,
      );
      this.audit.describe({ entityType: 'sales_invoice', entityId: current.id, after: view });
      return view;
    }
    if (current.status !== 'draft') {
      throw new ConflictException({
        error: 'not_draft',
        message: `invoice ${current.invoiceNo ?? current.id} is ${current.status}`,
      });
    }
    // Approval publishes the invoice event and the ledger event; without the outboxes nothing
    // would reach the customer or the ledger consumers, so refuse rather than post silently.
    if (!this.documents || !this.posting) {
      throw new ServiceUnavailableException({
        error: 'outbox_unavailable',
        message: 'invoice approval needs the outboxes; nothing was posted',
      });
    }
    const posted = await approveInvoice(
      trx,
      { companyId: company, invoiceId, approvedBy: me },
      { outbox: this.documents, posting: { outbox: this.posting } },
    ).catch(refusal);
    const view = approvedView({ ...posted, id: posted.invoiceId }, false);
    this.audit.describe({ entityType: 'sales_invoice', entityId: posted.invoiceId, after: view });
    return view;
  }
}
