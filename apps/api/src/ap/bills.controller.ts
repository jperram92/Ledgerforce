/**
 * Supplier bills over HTTP (T-0052, design §6.5 rule 3, UC-05, DL-0290). Thin: validates and calls
 * @ledgerforce/ap. PUT /ap/bills/:id enters a draft with a client-chosen id (SoD step bill.enter
 * recorded against it); POST /ap/bills/:id/submit routes it to the Approver queue;
 * POST /ap/bills/:id/approve posts it after SOD_BILL_SELF_APPROVAL (with small-team exceptions)
 * is checked against the stored gross; GET /ap/bills?queue=awaiting_approval is the queue.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  approveBill,
  BillError,
  billsAwaitingApproval,
  createBill,
  getBill,
  submitBill,
  type BillView,
} from '@ledgerforce/ap';
import { PeriodLockedError, PostingError } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_bill', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof BillError || e instanceof PostingError || e instanceof PeriodLockedError) {
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

const idFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

/** The bill and its gross from the database (the amount the threshold applies to). */
const idWithAmount: SubjectFrom = async (req, trx) => {
  const { id } = await idFromParam(req, trx, 'bill.approve');
  const companyId = req.query['company_id'];
  if (typeof companyId !== 'string' || !UUID.test(companyId)) throw new InvalidSodSubject();
  const b = await getBill(trx, companyId.toLowerCase(), id).catch(() => null);
  return { id, amount: b?.gross ?? null };
};

const viewOf = (b: BillView & { submittedAt?: Date | null }) => ({
  id: b.billId,
  status: b.status,
  bill_no: b.billNo,
  entry_id: b.entryId,
  net: b.net,
  tax: b.tax,
  gross: b.gross,
  ...(b.submittedAt !== undefined
    ? { awaiting_approval: b.status === 'draft' && b.submittedAt !== null }
    : {}),
});

@Controller('ap/bills')
export class ApBillsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Put(':id')
  @HttpCode(201)
  @RequirePermission('ap.bill.enter')
  @SoD('bill.enter', idFromParam)
  async enter(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = obj(body);
    const billId = uuid(id, 'id');
    const companyId = uuid(b['company_id'], 'company_id');
    const billDate = str(b['bill_date'], 'bill_date must be YYYY-MM-DD');
    if (!DATE.test(billDate)) bad('bill_date must be YYYY-MM-DD');
    const supplierRef = str(b['supplier_ref'], 'supplier_ref is required');
    const lines = Array.isArray(b['lines']) ? (b['lines'] as unknown[]) : bad('lines are required');
    const existed = await getBill(this.tx.get(), companyId, billId).then(
      () => true,
      () => false,
    );
    const createdBy = actorOf(req);
    const bill = await createBill(this.tx.get(), {
      companyId,
      id: billId,
      partyId: uuid(b['party_id'], 'party_id'),
      supplierRef,
      billDate,
      ...(typeof b['due_date'] === 'string' ? { dueDate: b['due_date'] } : {}),
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
    if (existed) res.status(200);
    else
      this.audit.describe({
        entityType: 'supplier_bill',
        entityId: bill.billId,
        after: viewOf(bill),
      });
    return viewOf(bill);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('ap.bill.enter')
  async submit(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const by = actorOf(req);
    const b = await submitBill(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      billId: uuid(id, 'id'),
      ...(by ? { submittedBy: by } : {}),
    }).catch(refusal);
    this.audit.describe({ entityType: 'supplier_bill', entityId: b.billId, after: viewOf(b) });
    return viewOf(b);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('ap.bill.approve')
  @SoD('bill.approve', idWithAmount)
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const by = actorOf(req);
    const b = await approveBill(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      billId: uuid(id, 'id'),
      ...(by ? { approvedBy: by } : {}),
    }).catch(refusal);
    this.audit.describe({ entityType: 'supplier_bill', entityId: b.billId, after: viewOf(b) });
    return viewOf(b);
  }

  @Get()
  @RequirePermission('ap.read')
  async queue(
    @Query('company_id') companyId: string | undefined,
    @Query('queue') queue: string | undefined,
  ) {
    if (queue !== 'awaiting_approval') bad('queue=awaiting_approval is the only queue');
    const rows = await billsAwaitingApproval(this.tx.get(), uuid(companyId, 'company_id'));
    return { items: rows.map(viewOf) };
  }
}
