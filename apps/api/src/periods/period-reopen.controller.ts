/**
 * Reopening a hard-locked period over HTTP (T-0079, UC-10, design §3.5, §6.2, §6.5 rule 6,
 * ADR-0056). Thin: validates and calls @ledgerforce/ledger requestReopen / approveReopen, whose
 * SECURITY DEFINER functions (migration 0018) repeat every check and write the audit rows
 * `period.reopen_requested`, `period.reopen_approved` and `period.status_changed`.
 *
 *  - POST /periods/:periodId/reopen-requests {to_status, reason} — the first approver asks.
 *    period.reopen + fresh step-up (300 s); a written reason is required. 201 new; a replay by
 *    the same person with the same target and reason answers 200 with the pending request.
 *  - POST /periods/reopen-requests/:requestId/approve — a second, different holder of
 *    period.reopen with a fresh step-up approves; the period then moves to `to_status`. SoD
 *    SOD_PERIOD_REOPEN_SELF_APPROVAL refuses the requester (never excepted). A replay by the same
 *    approver answers 200 with the approved request; anyone else gets 409.
 *  - GET /periods/:periodId/reopen-requests — the period's requests (reports.run).
 *
 * Idempotency: the reopen request table has no idempotency-key column and this round may not add
 * migrations (DL-0409), so replays are recognised by state, as payment-batch release and
 * bank-detail verify do (ADR-0056).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { approveReopen, requestReopen, type PeriodStatus } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@ledgerforce/db';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SodSubject, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

type Trx = Transaction<Database>;

/** Step-up window for reopening a hard-locked period (design §6.2, ADR-0025). */
const STEP_UP_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses a hard-locked period may reopen to (migration 0018 CHECK). */
const REOPEN_TO: readonly PeriodStatus[] = ['open', 'ar_locked', 'ap_locked', 'soft_closed'];
const MAX_REASON = 2000;

/**
 * The request step's SoD subject. The database function chooses the request id, so the route
 * names a placeholder before the handler and the handler sets the real id; the interceptor records
 * `period_reopen_request.request` against it after the handler succeeds (sod.service recordSod
 * reads the same object). The request step has no rule of its own, so the check is unaffected.
 */
const plannedSubjects = new WeakMap<Request, SodSubject>();
const newRequest: SubjectFrom = async (req, trx) => {
  const r = await sql<{ id: string }>`SELECT app.uuid_generate_v7()::text AS id`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no id generated');
  const subject: SodSubject = { id };
  plannedSubjects.set(req, subject);
  return subject;
};

/** The request named by the route, canonical lower-case so SoD history matches. */
const requestFromParam: SubjectFrom = (req) => {
  const id = req.params.requestId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

interface RequestRow {
  id: string;
  period_id: string;
  company_id: string;
  to_status: PeriodStatus;
  reason: string;
  status: 'pending' | 'approved';
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  period_status: PeriodStatus;
}

export type ReopenRequestView = RequestRow;

const SELECT_REQUESTS = sql`
  SELECT r.id::text, r.period_id::text, r.company_id::text, r.to_status, r.reason, r.status,
         r.requested_by::text, to_char(r.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
         r.approved_by::text,
         to_char(r.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at,
         p.status AS period_status
    FROM app.period_reopen_request r
    JOIN app.fiscal_period p ON p.tenant_id = r.tenant_id AND p.id = r.period_id`;

async function loadRequest(trx: Trx, id: string): Promise<RequestRow | undefined> {
  const r = await sql<RequestRow>`${SELECT_REQUESTS} WHERE r.id = ${id}::uuid`.execute(trx);
  return r.rows[0];
}

async function loadPeriod(
  trx: Trx,
  id: string,
): Promise<{ id: string; status: PeriodStatus } | undefined> {
  const r = await sql<{ id: string; status: PeriodStatus }>`
    SELECT id::text, status FROM app.fiscal_period WHERE id = ${id}::uuid`.execute(trx);
  return r.rows[0];
}

const invalid = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_reopen_request', message });
};

function periodIdOf(v: string): string {
  return UUID.test(v) ? v.toLowerCase() : invalid('periodId must be a uuid');
}

/** Refusals of migration 0018's functions as HTTP answers (by SQLSTATE). */
function refusal(e: unknown): never {
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case 'P0002': // no_data_found: unknown (or other tenant's) period / request
      throw new NotFoundException({ error: 'not_found' });
    case '42501': // insufficient_privilege: not a holder of period.reopen
      throw new ForbiddenException({ error: 'forbidden', permission: 'period.reopen' });
    case '23505': // the one-pending-request-per-period index
      throw new ConflictException({ error: 'reopen_request_pending' });
    case '23514': // check_violation: no longer hard-locked, not pending, same approver …
      throw new ConflictException({ error: 'reopen_refused' });
    default:
      throw e;
  }
}

@Controller('periods')
export class PeriodReopenController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Post(':periodId/reopen-requests')
  @HttpCode(201)
  @RequirePermission('period.reopen')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('period_reopen_request.request', newRequest)
  async request(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('periodId') periodIdParam: string,
    @Body() body: unknown,
  ): Promise<ReopenRequestView> {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const periodId = periodIdOf(periodIdParam);
    const toStatus = b['to_status'];
    if (typeof toStatus !== 'string' || !(REOPEN_TO as readonly string[]).includes(toStatus)) {
      invalid(`to_status must be one of ${REOPEN_TO.join(', ')}`);
    }
    const rawReason = b['reason'];
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason === '' || reason.length > MAX_REASON) {
      throw new BadRequestException({
        error: 'reason_required',
        message: `a written reason (1–${String(MAX_REASON)} characters) is required to reopen a hard-locked period`,
      });
    }
    const actor = principalOf(req)?.userId;
    const subject = plannedSubjects.get(req);
    if (!actor || !subject) throw new ForbiddenException({ error: 'forbidden' });
    const trx = this.tx.get();

    const period = await loadPeriod(trx, periodId);
    if (!period) throw new NotFoundException({ error: 'not_found' });
    const pending = (
      await sql<RequestRow>`${SELECT_REQUESTS}
        WHERE r.period_id = ${periodId}::uuid AND r.status = 'pending'`.execute(trx)
    ).rows[0];
    if (pending) {
      if (
        pending.requested_by === actor &&
        pending.to_status === toStatus &&
        pending.reason === reason
      ) {
        subject.id = pending.id; // replay: the same request, recorded against the same subject
        res.status(200);
        return pending;
      }
      throw new ConflictException({ error: 'reopen_request_pending', request_id: pending.id });
    }
    if (period.status !== 'hard_locked') {
      throw new ConflictException({
        error: 'period_not_hard_locked',
        period_status: period.status,
      });
    }

    const id = await requestReopen(trx, {
      periodId,
      toStatus: toStatus as PeriodStatus,
      actorId: actor,
      reason,
    }).catch(refusal);
    subject.id = id;
    const view = await loadRequest(trx, id);
    if (!view) throw new Error('reopen request not readable after insert');
    this.audit.describe({
      entityType: 'period_reopen_request',
      entityId: id,
      after: { period_id: periodId, to_status: toStatus, reason, status: 'pending' },
    });
    return view;
  }

  @Post('reopen-requests/:requestId/approve')
  @HttpCode(200)
  @RequirePermission('period.reopen')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('period_reopen_request.approve', requestFromParam)
  async approve(
    @Req() req: Request,
    @Param('requestId') requestIdParam: string,
  ): Promise<ReopenRequestView> {
    const requestId = requestIdParam.toLowerCase();
    const actor = principalOf(req)?.userId;
    if (!actor) throw new ForbiddenException({ error: 'forbidden' });
    const trx = this.tx.get();
    const before = await loadRequest(trx, requestId);
    if (!before) throw new NotFoundException({ error: 'not_found' });
    if (before.status === 'approved') {
      if (before.approved_by === actor) return before; // replay
      throw new ConflictException({ error: 'reopen_request_not_pending' });
    }
    await approveReopen(trx, { requestId, actorId: actor }).catch(refusal);
    const after = await loadRequest(trx, requestId);
    if (!after) throw new Error('reopen request not readable after approval');
    this.audit.describe({
      entityType: 'period_reopen_request',
      entityId: requestId,
      before: { status: before.status, period_status: before.period_status },
      after: { status: after.status, period_status: after.period_status },
    });
    return after;
  }

  @Get(':periodId/reopen-requests')
  @RequirePermission('reports.run')
  async list(@Param('periodId') periodIdParam: string): Promise<{
    period_id: string;
    period_status: PeriodStatus;
    requests: ReopenRequestView[];
  }> {
    const periodId = periodIdOf(periodIdParam);
    const trx = this.tx.get();
    const period = await loadPeriod(trx, periodId);
    if (!period) throw new NotFoundException({ error: 'not_found' });
    const r = await sql<RequestRow>`${SELECT_REQUESTS}
      WHERE r.period_id = ${periodId}::uuid ORDER BY r.requested_at, r.id`.execute(trx);
    return { period_id: periodId, period_status: period.status, requests: r.rows };
  }
}
