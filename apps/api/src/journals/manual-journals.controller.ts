import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ManualJournalError,
  approveManualJournal,
  createManualJournal,
  getManualJournal,
  listManualJournals,
  MANUAL_JOURNAL_STATUSES,
  peopleOf,
  postManualJournal,
  previewManualJournal,
  rejectManualJournal,
  submitManualJournal,
  updateManualJournal,
  type ManualJournal,
  type ManualJournalInput,
  type ManualJournalStatus,
} from '@ledgerforce/journals';
import { PeriodLockedError, PostingError, type PostingLineInput } from '@ledgerforce/ledger';
import type { PostingOutbox } from '@ledgerforce/ledger';
import { POSTING_OUTBOX } from '../tokens.ts';
import type { Request } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { loadSodSettings } from '../sod/sod.service.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 1000;

/** The journal named by the route, canonical (lower-case) so SoD history matches. */
const journalFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

/**
 * The journal and its approval facts (design §6.5 rule 4) for SOD_JOURNAL_SELF_APPROVAL: total
 * and whether it touches a control, tax or equity account, as frozen at submit.
 */
const journalWithFacts: SubjectFrom = async (req, trx) => {
  const { id } = await journalFromParam(req, trx, 'manual_journal.approve');
  const doc = await getManualJournal(trx, id).catch(() => null);
  if (!doc) return { id, amount: null };
  return {
    id,
    amount: doc.total,
    ...(doc.sensitiveAccounts === null ? {} : { controlTaxOrEquity: doc.sensitiveAccounts }),
  };
};

function actorOf(req: Request): string {
  const id = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
  if (!id) throw new ForbiddenException({ error: 'forbidden' });
  return id;
}

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_manual_journal', message });
};

const optString = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') bad(`${k} must be a string`);
  return v as string;
};

/** A request line (snake_case, amounts as decimal strings) → a posting-command line. */
function lineOf(raw: unknown, i: number): PostingLineInput {
  if (typeof raw !== 'object' || raw === null) bad(`line ${String(i + 1)} must be an object`);
  const o = raw as Record<string, unknown>;
  const accountId = optString(o, 'account_id');
  const accountRole = optString(o, 'account_role');
  if ((accountId === undefined) === (accountRole === undefined)) {
    bad(`line ${String(i + 1)} needs exactly one of account_id and account_role`);
  }
  const dims = o.dimensions;
  if (dims !== undefined && (!Array.isArray(dims) || dims.some((d) => typeof d !== 'string'))) {
    bad(`line ${String(i + 1)}: dimensions must be a list of value ids`);
  }
  const pick: Record<string, string | undefined> = {
    debit: optString(o, 'debit'),
    credit: optString(o, 'credit'),
    txnCurrency: optString(o, 'txn_currency'),
    txnAmount: optString(o, 'txn_amount'),
    fxRate: optString(o, 'fx_rate'),
    taxCodeId: optString(o, 'tax_code_id'),
    taxAmount: optString(o, 'tax_amount'),
    partyId: optString(o, 'party_id'),
    memo: optString(o, 'memo'),
  };
  return {
    account: accountId !== undefined ? { id: accountId } : { role: accountRole ?? '' },
    ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)),
    ...(dims === undefined ? {} : { dimensions: dims as string[] }),
  };
}

function inputOf(body: unknown): ManualJournalInput {
  if (typeof body !== 'object' || body === null) bad('body must be a JSON object');
  const o = body as Record<string, unknown>;
  const companyId = optString(o, 'company_id');
  const entryDate = optString(o, 'entry_date');
  const memo = optString(o, 'memo');
  if (companyId === undefined || !UUID.test(companyId)) bad('company_id must be a uuid');
  if (entryDate === undefined) bad('entry_date is required (YYYY-MM-DD)');
  if (memo !== undefined && memo.length > 2000) bad('memo is at most 2000 characters');
  if (!Array.isArray(o.lines) || o.lines.length > MAX_LINES) {
    bad(`lines must be a list of at most ${String(MAX_LINES)} lines`);
  }
  return {
    companyId: (companyId ?? '').toLowerCase(),
    entryDate: entryDate ?? '',
    ...(memo === undefined ? {} : { memo }),
    lines: (o.lines as unknown[]).map(lineOf),
  };
}

/** Module and engine refusals as HTTP answers. Nothing was written. */
function refusal(e: unknown): never {
  if (e instanceof ManualJournalError) {
    switch (e.code) {
      case 'NOT_FOUND':
        throw new NotFoundException({ error: 'not_found' });
      case 'WRONG_STATUS':
        throw new ConflictException({
          error: 'manual_journal_wrong_status',
          status: e.status ?? null,
          message: e.message,
        });
      case 'APPROVAL_REQUIRED':
        throw new ConflictException({ error: 'approval_required', message: e.message });
    }
  }
  if (e instanceof PostingError || e instanceof PeriodLockedError) {
    throw new UnprocessableEntityException({
      error: 'posting_refused',
      code: e.code,
      line: e instanceof PostingError ? (e.line ?? null) : null,
      message: e.message,
      // ALREADY_POSTED (preview only): the entry this document posted as.
      ...(e instanceof PostingError && e.entryNo !== undefined
        ? { entry_id: e.entryId ?? null, entry_no: e.entryNo }
        : {}),
    });
  }
  throw e;
}

/** Response body: snake_case, money as decimal strings. */
function viewOf(d: ManualJournal) {
  return {
    id: d.id,
    company_id: d.companyId,
    status: d.status,
    entry_date: d.entryDate,
    memo: d.memo,
    lines: d.lines,
    created_by: d.createdBy,
    submitted_by: d.submittedBy,
    total: d.total,
    approval_required: d.approvalRequired,
    sensitive_accounts: d.sensitiveAccounts,
    approved_by: d.approvedBy,
    rejected_by: d.rejectedBy,
    rejection_reason: d.rejectionReason,
    posted_by: d.postedBy,
    journal_entry_id: d.journalEntryId,
    entry_no: d.entryNo,
  };
}

/**
 * Manual journals (design §6.4, §6.5 rule 4, RQ-0043, ADR-0039): draft → submit → approve →
 * post, posted only through the posting engine. Preparing, submitting and posting need
 * gl.journal.post; approving and rejecting gl.journal.approve. Submitting is the SoD step
 * `manual_journal.post`; approving is `manual_journal.approve`, refused for the preparer when
 * approval is required (SOD_JOURNAL_SELF_APPROVAL; the database re-checks at commit). No
 * step-up: the design lists none for journals (§6.2). Control-account lines are refused by the
 * engine with CONTROL_ACCOUNT (422).
 */
@Controller('manual-journals')
export class ManualJournalsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(POSTING_OUTBOX) private readonly outbox: PostingOutbox | null,
  ) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('gl.journal.post')
  async create(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
      throw new BadRequestException({ error: 'idempotency_key_required' });
    }
    const input = inputOf(body);
    const trx = this.tx.get();
    const { id, replayed } = await createManualJournal(trx, {
      input,
      createdBy: actorOf(req),
      idempotencyKey: key,
    }).catch(refusal);
    const doc = await getManualJournal(trx, id);
    if (!replayed) {
      this.audit.describe({ entityType: 'manual_journal', entityId: id, after: viewOf(doc) });
    }
    return { ...viewOf(doc), replayed };
  }

  /** The newest manual journals (at most 200), optionally of one status (T-0082). */
  @Get()
  @RequirePermission('gl.journal.read')
  async list(@Query('status') status: unknown) {
    if (
      status !== undefined &&
      !(typeof status === 'string' && (MANUAL_JOURNAL_STATUSES as string[]).includes(status))
    ) {
      throw new BadRequestException({
        error: 'invalid_filter',
        message: `status must be one of ${MANUAL_JOURNAL_STATUSES.join(', ')}`,
      });
    }
    const rows = await listManualJournals(
      this.tx.get(),
      status === undefined ? {} : { status: status as ManualJournalStatus },
    );
    return {
      journals: rows.map((r) => ({
        id: r.id,
        company_id: r.companyId,
        status: r.status,
        entry_date: r.entryDate,
        memo: r.memo,
        line_count: r.lineCount,
        amount: r.amount,
        total: r.total,
        approval_required: r.approvalRequired,
        created_by: r.createdBy,
        created_by_name: r.createdByName,
        submitted_by_name: r.submittedByName,
        approved_by_name: r.approvedByName,
        posted_by_name: r.postedByName,
        entry_no: r.entryNo,
      })),
    };
  }

  @Get(':id')
  @RequirePermission('gl.journal.read')
  async get(@Param('id') id: string) {
    const trx = this.tx.get();
    const doc = await getManualJournal(trx, id).catch(refusal);
    return { ...viewOf(doc), people: await peopleOf(trx, doc) };
  }

  /**
   * "Show me the journal" (design §3.9, T-0082): the posting engine's preview of this journal,
   * exactly what submit and post would run, with account names. Writes nothing; a refusal is
   * the same 422 posting_refused submit would answer.
   */
  @Get(':id/preview')
  @RequirePermission('gl.journal.read')
  async preview(@Param('id') id: string) {
    const p = await previewManualJournal(this.tx.get(), id).catch(refusal);
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
        memo: l.memo,
      })),
    };
  }

  @Put(':id')
  @HttpCode(200)
  @RequirePermission('gl.journal.post')
  async update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = inputOf(body);
    const trx = this.tx.get();
    const before = await getManualJournal(trx, id).catch(refusal);
    await updateManualJournal(trx, { id: before.id, input, updatedBy: actorOf(req) }).catch(
      refusal,
    );
    const after = await getManualJournal(trx, before.id);
    this.audit.describe({
      entityType: 'manual_journal',
      entityId: before.id,
      before: viewOf(before),
      after: viewOf(after),
    });
    return viewOf(after);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('gl.journal.post')
  @SoD('manual_journal.post', journalFromParam)
  async submit(@Req() req: Request, @Param('id') id: string) {
    const trx = this.tx.get();
    const { settings } = await loadSodSettings(trx);
    const r = await submitManualJournal(trx, {
      id: id.toLowerCase(),
      submittedBy: actorOf(req),
      settings,
    }).catch(refusal);
    this.audit.describe({
      entityType: 'manual_journal',
      entityId: r.id,
      after: { status: r.status, total: r.total, approval_required: r.approvalRequired },
    });
    return {
      id: r.id,
      status: r.status,
      total: r.total,
      approval_required: r.approvalRequired,
      sensitive_accounts: r.sensitiveAccounts,
    };
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('gl.journal.approve')
  @SoD('manual_journal.approve', journalWithFacts)
  async approve(@Req() req: Request, @Param('id') id: string) {
    const r = await approveManualJournal(this.tx.get(), {
      id: id.toLowerCase(),
      approvedBy: actorOf(req),
    }).catch(refusal);
    this.audit.describe({ entityType: 'manual_journal', entityId: r.id, after: r });
    return r;
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('gl.journal.approve')
  async reject(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000) {
      throw new BadRequestException({ error: 'rejection_reason_required' });
    }
    const r = await rejectManualJournal(this.tx.get(), {
      id: id.toLowerCase(),
      rejectedBy: actorOf(req),
      reason: reason.trim(),
    }).catch(refusal);
    this.audit.describe({
      entityType: 'manual_journal',
      entityId: r.id,
      after: { status: r.status, reason: reason.trim() },
    });
    return r;
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('gl.journal.post')
  async post(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    if (!this.outbox) throw new ServiceUnavailableException({ error: 'queue_not_configured' });
    const raw = (body as { period_override?: unknown } | null)?.period_override;
    let periodOverride: { reason: string } | undefined;
    if (raw !== undefined && raw !== null) {
      const reason = (raw as { reason?: unknown }).reason;
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000) {
        throw new BadRequestException({ error: 'period_override_reason_required' });
      }
      periodOverride = { reason: reason.trim() };
    }
    const trx = this.tx.get();
    const { settings } = await loadSodSettings(trx);
    const r = await postManualJournal(trx, {
      outbox: this.outbox,
      id: id.toLowerCase(),
      postedBy: actorOf(req),
      settings,
      ...(periodOverride === undefined ? {} : { periodOverride }),
    }).catch(refusal);
    if (!r.replayed) {
      this.audit.describe({
        entityType: 'manual_journal',
        entityId: r.id,
        after: { status: r.status, entry_id: r.entryId, entry_no: r.entryNo },
      });
    }
    return {
      id: r.id,
      status: r.status,
      entry_id: r.entryId,
      entry_no: r.entryNo,
      entry_date: r.entryDate,
      replayed: r.replayed,
    };
  }
}
