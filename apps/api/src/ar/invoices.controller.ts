/**
 * AR invoice read routes (T-0131, SS-UC01-10, DL-0406):
 *   GET /ar/invoices?company_id=&status=   — list (newest issue date first)
 *   GET /ar/invoices/:id?company_id=       — one invoice with its lines
 *   GET /ar/invoices/:id/journal?company_id= — "Show me the journal": the posting engine's preview of
 *     exactly what approving the draft would post; writes nothing (no number, no hold, no entry).
 * All require ar.read. Money is a decimal string. An invoice outside the caller's tenant or
 * company is 404 (RLS hides it; the module reports it as not in the company). Approving one invoice
 * over HTTP needs its own permission and is T-0132.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getInvoice, InvoiceError, listInvoices, previewInvoiceJournal } from '@ledgerforce/ar';
import { PostingError } from '@ledgerforce/ledger';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

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

@Controller('ar/invoices')
export class ArInvoicesController {
  constructor(private readonly tx: TenantTx) {}

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
  async detail(@Param('id') id: string, @Query('company_id') companyId: unknown) {
    const company = uuid(companyId, 'company_id');
    const inv = await getInvoice(this.tx.get(), {
      companyId: company,
      invoiceId: uuid(id, 'id'),
    }).catch(refusal);
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
}
