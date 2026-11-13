/**
 * Close checklist and period list over HTTP (T-0148, UC-10, SS-UC10-01; split from T-0090).
 * Routes:
 * - `GET  /periods?company_id=&from=&to=` lists the fiscal periods overlapping the range, with
 *   their status (reports.run).
 * - `GET  /periods/:periodId/close-checklist?company_id=` lists the seven steps, who completed
 *   them and when, and the period (reports.run).
 * - `POST /periods/:periodId/close-checklist/:step {company_id}` completes one step (period.lock,
 *   Idempotency-Key, audited).
 *   - Status steps also pass the database's period permission checks (setPeriodStatus).
 *   - A replay by the same user is 200 with the stored row; another user gets 409 ALREADY_DONE.
 *   - Order and gate refusals are 422 with the module's message (and the bank accounts).
 * The checklist row's primary key (period, step) makes the stored state the replay record, like
 * the reopen routes (DL-0420); no new column is needed.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
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
  UnprocessableEntityException,
} from '@nestjs/common';
import { unreconciledBankAccounts } from '@ledgerforce/bank';
import { PeriodLockedError } from '@ledgerforce/ledger';
import {
  CLOSE_STEPS,
  closeChecklist,
  CloseError,
  completeCloseStep,
  type CloseStep,
} from '@ledgerforce/reporting';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const day = (v: unknown, name: string): string =>
  typeof v === 'string' && DATE.test(v) ? v : bad(`${name} must be YYYY-MM-DD`);

interface PeriodRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

@Controller('periods')
export class CloseChecklistController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  private async period(companyId: string, periodId: string): Promise<PeriodRow> {
    const { rows } = await sql<PeriodRow>`
      SELECT id::text, name, to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date, 'YYYY-MM-DD') AS end_date, status
        FROM app.fiscal_period WHERE company_id = ${companyId} AND id = ${periodId}`.execute(
      this.tx.get(),
    );
    const p = rows[0];
    if (!p) throw new NotFoundException({ error: 'not_found', message: 'period not found' });
    return p;
  }

  private async steps(companyId: string, periodId: string) {
    const trx = this.tx.get();
    const list = await closeChecklist(trx, { companyId, periodId });
    const ids = [...new Set(list.flatMap((s) => (s.completedBy ? [s.completedBy] : [])))];
    const names = new Map(
      ids.length === 0
        ? []
        : (
            await trx
              .selectFrom('app.app_user')
              .select(['id', 'display_name'])
              .where('id', 'in', ids)
              .execute()
          ).map((u) => [u.id, u.display_name] as const),
    );
    return list.map((s) => ({
      step: s.step,
      completed_by: s.completedBy,
      completed_by_name: s.completedBy ? (names.get(s.completedBy) ?? null) : null,
      completed_at: s.completedAt ? s.completedAt.toISOString() : null,
      period_status: s.periodStatus,
    }));
  }

  @Get()
  @RequirePermission('reports.run')
  async list(
    @Query('company_id') companyId: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    const company = uuid(companyId, 'company_id');
    const a = day(from, 'from');
    const b = day(to, 'to');
    if (a > b) bad('from must not be after to');
    const { rows } = await sql<PeriodRow>`
      SELECT id::text, name, to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date, 'YYYY-MM-DD') AS end_date, status
        FROM app.fiscal_period
       WHERE company_id = ${company} AND start_date <= ${b}::date AND end_date >= ${a}::date
       ORDER BY start_date`.execute(this.tx.get());
    return { periods: rows };
  }

  @Get(':periodId/close-checklist')
  @RequirePermission('reports.run')
  async checklist(@Param('periodId') periodId: string, @Query('company_id') companyId: unknown) {
    const company = uuid(companyId, 'company_id');
    const period = await this.period(company, uuid(periodId, 'periodId'));
    return { period, steps: await this.steps(company, period.id) };
  }

  @Post(':periodId/close-checklist/:step')
  @HttpCode(201)
  @RequirePermission('period.lock')
  async complete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('periodId') periodIdParam: string,
    @Param('step') stepParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const company = uuid(b['company_id'], 'company_id');
    if (!(CLOSE_STEPS as readonly string[]).includes(stepParam)) {
      bad(`step must be one of ${CLOSE_STEPS.join(', ')}`);
    }
    const step = stepParam as CloseStep;
    const actor = principalOf(req)?.userId;
    if (!actor) bad('a user is required');
    const period = await this.period(company, uuid(periodIdParam, 'periodId'));
    const trx = this.tx.get();
    try {
      const done = await completeCloseStep(
        trx,
        { companyId: company, periodId: period.id, step, by: actor as string },
        { unreconciledBank: unreconciledBankAccounts },
      );
      const view = {
        step: done.step,
        completed_by: done.completedBy,
        completed_at: done.completedAt.toISOString(),
        period_status: done.periodStatus,
      };
      this.audit.describe({
        entityType: 'close_checklist_step',
        entityId: `${period.id}:${step}`,
        after: view,
      });
      return { ...view, replayed: false };
    } catch (e) {
      if (e instanceof CloseError && e.code === 'ALREADY_DONE') {
        const stored = (await this.steps(company, period.id)).find((s) => s.step === step);
        if (stored?.completed_by === actor) {
          res.status(200);
          return {
            step,
            completed_by: stored.completed_by,
            completed_at: stored.completed_at,
            period_status: stored.period_status,
            replayed: true,
          };
        }
        throw new ConflictException({ error: e.code, message: e.message });
      }
      if (e instanceof CloseError) {
        throw new UnprocessableEntityException({
          error: e.code,
          message: e.message,
          ...(e.accounts ? { accounts: e.accounts } : {}),
        });
      }
      if (e instanceof PeriodLockedError) {
        throw new UnprocessableEntityException({ error: 'PERIOD_REFUSED', message: e.message });
      }
      throw e;
    }
  }
}
