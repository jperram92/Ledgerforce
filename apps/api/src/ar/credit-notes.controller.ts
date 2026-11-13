/**
 * Customer credit notes over HTTP (T-0045, UC-11, DL-0273). Thin: validates and calls
 * @ledgerforce/ar. PUT /ar/credit-notes/:id creates a draft with a client-chosen id (idempotent;
 * the SoD step credit_note.create is recorded against that id); POST /ar/credit-notes/:id/approve
 * posts it after SOD_CREDIT_NOTE_SELF_APPROVAL is checked with the amount stored in the database.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  approveCreditNote,
  createCreditNote,
  CreditNoteError,
  getCreditNote,
  previewCreditNoteJournal,
  type CreditNoteView,
} from '@ledgerforce/ar';
import { PostingError } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_credit_note', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof CreditNoteError || e instanceof PostingError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};

const idFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

/** The credit note and its gross from the database (the amount the threshold applies to). */
const idWithAmount: SubjectFrom = async (req, trx) => {
  const { id } = await idFromParam(req, trx, 'credit_note.approve');
  const companyId = req.query['company_id'];
  if (typeof companyId !== 'string' || !UUID.test(companyId)) throw new InvalidSodSubject();
  const cn = await getCreditNote(trx, companyId, id).catch(() => null);
  return { id, amount: cn?.gross ?? null };
};

const actorOf = (req: Request) => principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;

function viewOf(c: CreditNoteView) {
  return {
    id: c.creditNoteId,
    replayed: c.replayed,
    status: c.status,
    credit_note_no: c.creditNoteNo,
    invoice_id: c.invoiceId,
    entry_id: c.entryId,
    net: c.net,
    tax: c.tax,
    gross: c.gross,
  };
}

@Controller('ar/credit-notes')
export class ArCreditNotesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Put(':id')
  @HttpCode(201)
  @RequirePermission('ar.credit_note.create')
  @SoD('credit_note.create', idFromParam)
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const companyId = b['company_id'];
    const invoiceId = b['invoice_id'];
    const issueDate = b['issue_date'];
    const reason = b['reason_code'];
    const lines = b['lines'];
    if (typeof companyId !== 'string' || !UUID.test(companyId)) bad('company_id must be a uuid');
    if (typeof invoiceId !== 'string' || !UUID.test(invoiceId)) bad('invoice_id must be a uuid');
    if (typeof issueDate !== 'string' || !DATE.test(issueDate))
      bad('issue_date must be YYYY-MM-DD');
    if (typeof reason !== 'string') bad('reason_code is required');
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 1000) bad('lines: 1..1000');
    const parsed = (lines as unknown[]).map((l) => {
      const o = (typeof l === 'object' && l !== null ? l : {}) as Record<string, unknown>;
      const no = o['invoice_line_no'];
      const amount = o['amount'];
      if (typeof no !== 'number' || !Number.isInteger(no) || no < 1)
        bad('invoice_line_no must be a positive integer');
      if (typeof amount !== 'string') bad('amount must be a decimal string');
      const description = o['description'];
      return {
        invoiceLineNo: no as number,
        amount: amount as string,
        ...(typeof description === 'string' ? { description } : {}),
      };
    });
    const createdBy = actorOf(req);
    const cn = await createCreditNote(this.tx.get(), {
      companyId: companyId as string,
      invoiceId: invoiceId as string,
      id,
      issueDate: issueDate as string,
      reasonCode: reason as string,
      ...(createdBy ? { createdBy } : {}),
      lines: parsed,
    }).catch(refusal);
    if (cn.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'credit_note',
        entityId: cn.creditNoteId,
        after: viewOf(cn),
      });
    return viewOf(cn);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('ar.credit_note.approve')
  @SoD('credit_note.approve', idWithAmount)
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string,
  ) {
    const approvedBy = actorOf(req);
    const cn = await approveCreditNote(this.tx.get(), {
      companyId,
      creditNoteId: id,
      ...(approvedBy ? { approvedBy } : {}),
    }).catch(refusal);
    this.audit.describe({
      entityType: 'credit_note',
      entityId: cn.creditNoteId,
      after: viewOf(cn),
    });
    return viewOf(cn);
  }

  /**
   * "Show me the journal" for a draft credit note (T-0151, SS-UC11-08): the posting engine's
   * preview of exactly what approval posts (GP-005); writes nothing. Not in the company → 404.
   */
  @Get(':id/journal')
  @RequirePermission('ar.read')
  async journal(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    if (!UUID.test(id)) bad('id must be a uuid');
    if (typeof companyId !== 'string' || !UUID.test(companyId)) bad('company_id must be a uuid');
    const p = await previewCreditNoteJournal(this.tx.get(), {
      companyId: companyId as string,
      creditNoteId: id,
    }).catch((e: unknown) => {
      if (e instanceof CreditNoteError && e.code === 'INVALID_CREDIT_NOTE')
        throw new NotFoundException({ error: 'not_found', message: 'credit note not found' });
      return refusal(e);
    });
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

  @Get(':id')
  @RequirePermission('ar.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    if (!UUID.test(id)) bad('id must be a uuid');
    if (typeof companyId !== 'string' || !UUID.test(companyId)) bad('company_id must be a uuid');
    return viewOf(await getCreditNote(this.tx.get(), companyId as string, id).catch(refusal));
  }
}
