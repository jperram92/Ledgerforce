import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BankAccountValidationError,
  BankDetailChangeRefused,
  listBankAccounts,
  rejectBankDetailChange,
  requestBankDetailChange,
  verifyBankDetailChange,
} from '@ledgerforce/parties';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Request } from 'express';
import { sql } from 'kysely';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { StepUpRequired } from '../authz/mfa.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { KMS } from '../tokens.ts';

/** Step-up window for bank-detail changes (design §6.2, ADR-0025); the database checks 300 s too. */
const STEP_UP_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The change id chosen before the handler runs, so the SoD step names its subject (ADR-0026). */
const plannedIds = new WeakMap<Request, string>();

const newChange: SubjectFrom = async (req, trx) => {
  const r = await sql<{ id: string }>`SELECT app.uuid_generate_v7()::text AS id`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no id generated');
  plannedIds.set(req, id);
  return { id };
};

/** The change named by the route, in canonical (lower-case) form so SoD history matches. */
const changeFromParam: SubjectFrom = (req) => {
  const id = req.params.changeId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

function text(body: unknown, field: string, max: number): string | null {
  const v = (body as Record<string, unknown> | null | undefined)?.[field];
  return typeof v === 'string' && v.length <= max ? v : null;
}

/** Workflow refusals of the database (migration 0025) as HTTP answers. */
function refusal(e: unknown): never {
  if (e instanceof BankDetailChangeRefused) {
    switch (e.reason) {
      case 'NOT_FOUND':
        throw new NotFoundException({ error: 'not_found' });
      case 'NOT_PERMITTED':
        throw new ForbiddenException({ error: 'forbidden' });
      case 'STEP_UP_REQUIRED':
        throw new StepUpRequired(STEP_UP_SECONDS);
      case 'CONFIRMATION_NOTE_REQUIRED':
        throw new BadRequestException({ error: 'confirmation_note_required' });
      case 'NOT_PENDING':
        throw new ConflictException({ error: 'bank_detail_change_not_pending' });
      case 'OPEN_CHANGE_EXISTS':
        throw new ConflictException({ error: 'bank_detail_change_open' });
    }
  }
  if (e instanceof BankAccountValidationError) {
    throw new BadRequestException({ error: 'invalid_bank_details', message: e.message });
  }
  throw e;
}

/**
 * Supplier and employee bank-detail changes (design §6.1, §6.5 rule 2, ADR-0030). Requesting
 * needs parties.bank_account.change_request, verifying parties.bank_account.verify; both need a
 * fresh step-up and pass the SoD engine (requester ≠ verifier, SOD_BANK_DETAIL_SELF_VERIFY).
 * The database repeats every check (migration 0025). Responses mask the account number.
 */
@Controller()
export class BankDetailChangesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(KMS) private readonly kms: Kms | null,
  ) {}

  @Post('parties/:partyId/bank-accounts')
  @HttpCode(201)
  @RequirePermission('parties.bank_account.change_request')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('bank_detail_change.request', newChange)
  async request(
    @Req() req: Request,
    @Param('partyId') partyId: string,
    @Body() body: unknown,
  ): Promise<{
    id: string;
    party_id: string;
    status: 'requested';
    bank_account: {
      id: string;
      bsb: string;
      account_name: string;
      account_number: string;
      status: string;
    };
  }> {
    if (!this.kms) throw new ServiceUnavailableException({ error: 'kms_not_configured' });
    const bsb = text(body, 'bsb', 16);
    const accountNumber = text(body, 'account_number', 32);
    const accountName = text(body, 'account_name', 200);
    if (!UUID.test(partyId) || bsb === null || accountNumber === null || accountName === null) {
      throw new BadRequestException({ error: 'invalid_bank_details' });
    }
    const principal = principalOf(req);
    const changeId = plannedIds.get(req);
    if (!principal || !changeId) throw new ForbiddenException({ error: 'forbidden' });
    const trx = this.tx.get();
    const { bankAccountId } = await requestBankDetailChange(trx, this.kms, {
      changeId,
      partyId,
      account: { bsb, accountNumber, accountName, source: 'api' },
      requestedBy: principal.userId,
      sessionId: principal.sessionId,
    }).catch(refusal);
    const account = (await listBankAccounts(trx, partyId)).find((a) => a.id === bankAccountId);
    if (!account) throw new Error('requested bank account not readable');
    const masked = {
      id: account.id,
      bsb: account.bsb,
      account_name: account.accountName,
      account_number: account.accountNumber,
      status: account.status,
    };
    this.audit.describe({
      entityType: 'bank_detail_change',
      entityId: changeId,
      after: { party_id: partyId, bank_account: masked },
    });
    return { id: changeId, party_id: partyId, status: 'requested', bank_account: masked };
  }

  @Post('bank-detail-changes/:changeId/verify')
  @HttpCode(200)
  @RequirePermission('parties.bank_account.verify')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('bank_detail_change.verify', changeFromParam)
  async verify(
    @Req() req: Request,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: 'verified'; payable_from: string }> {
    const note = text(body, 'confirmation_note', 2000);
    if (note === null || note.trim() === '') {
      throw new BadRequestException({ error: 'confirmation_note_required' });
    }
    const principal = principalOf(req);
    if (!principal) throw new ForbiddenException({ error: 'forbidden' });
    const id = changeId.toLowerCase();
    const { payableFrom } = await verifyBankDetailChange(this.tx.get(), {
      changeId: id,
      verifiedBy: principal.userId,
      sessionId: principal.sessionId,
      confirmationNote: note,
    }).catch(refusal);
    this.audit.describe({
      entityType: 'bank_detail_change',
      entityId: id,
      after: { status: 'verified', payable_from: payableFrom.toISOString() },
    });
    return { id, status: 'verified', payable_from: payableFrom.toISOString() };
  }

  @Post('bank-detail-changes/:changeId/reject')
  @HttpCode(200)
  @RequirePermission('parties.bank_account.verify')
  async reject(
    @Req() req: Request,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: 'rejected' }> {
    const reason = text(body, 'reason', 2000);
    if (!UUID.test(changeId) || reason === null || reason.trim() === '') {
      throw new BadRequestException({ error: 'invalid_rejection' });
    }
    const principal = principalOf(req);
    if (!principal) throw new ForbiddenException({ error: 'forbidden' });
    const id = changeId.toLowerCase();
    await rejectBankDetailChange(this.tx.get(), {
      changeId: id,
      rejectedBy: principal.userId,
      reason,
    }).catch(refusal);
    this.audit.describe({
      entityType: 'bank_detail_change',
      entityId: id,
      after: { status: 'rejected' },
    });
    return { id, status: 'rejected' };
  }
}
