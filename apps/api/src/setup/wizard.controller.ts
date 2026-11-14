/**
 * The setup wizard over HTTP (T-0157, SS-PLAT-120, design §4.1, ADR-0067 rule 6, ADR-0075).
 * Routes:
 * - `GET  /setup/wizard?company_id=&as_of=` returns the ten derived steps and `complete`
 *   (settings.read, which every settings.setup.manage holder also has; DL-0590).
 * - `POST /setup/wizard/steps/:n/complete {company_id, as_of?, no_history_reason?}` completes one
 *   step (settings.setup.manage, ADR-0072; Idempotency-Key; audited). 201 new, 200 replay.
 * `as_of` defaults to today in the tenant's report time zone. The wizard never accepts a status:
 * the module derives it from the completion record and the validators.
 * Refusals: 400 malformed request, 404 unknown company (including another tenant's), 409
 * STEP_LOCKED, 422 STEP_INVALID (with `missing`) or NO_HISTORY_NOT_ALLOWED.
 * The completion record's primary key (company, step) is the replay record, as for the close
 * checklist (DL-0420): a repeat of a completed step writes nothing and answers 200 with it.
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
import {
  completeWizardStep,
  WizardError,
  wizardOf,
  type CompleteWizardStep,
  type WizardStepView,
} from '@ledgerforce/setup';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEP = /^[1-9]\d?$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const day = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    ? v
    : bad('as_of must be YYYY-MM-DD');
};

/** The module's refusals as HTTP answers; anything else propagates (500). */
const refusal = (e: unknown): never => {
  if (e instanceof WizardError) {
    const body = { error: e.code, message: e.message };
    switch (e.code) {
      case 'INVALID_COMMAND':
        throw new BadRequestException({ ...body, error: 'invalid_request' });
      case 'UNKNOWN_COMPANY':
        throw new NotFoundException(body);
      case 'STEP_LOCKED':
        throw new ConflictException(body);
      case 'STEP_INVALID':
        throw new UnprocessableEntityException({ ...body, missing: e.missing });
      case 'NO_HISTORY_NOT_ALLOWED':
        throw new UnprocessableEntityException(body);
    }
  }
  throw e;
};

const stepOf = (s: WizardStepView) => ({
  step: s.step,
  title: s.title,
  status: s.status,
  locked: s.locked,
  valid: s.valid,
  missing: s.missing,
  outcome: s.outcome,
  reason: s.reason,
  completed_at: s.completedAt ? s.completedAt.toISOString() : null,
  completed_by: s.completedBy,
});

@Controller('setup/wizard')
export class SetupWizardController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  /** Today in the tenant's report time zone (app.sod_report_timezone, ADR-0026). */
  private async today(): Promise<string> {
    const { rows } = await sql<{ d: string }>`
      SELECT to_char(now() AT TIME ZONE app.sod_report_timezone(), 'YYYY-MM-DD') AS d`.execute(
      this.tx.get(),
    );
    return rows[0]?.d ?? bad('as_of is required');
  }

  @Get()
  @RequirePermission('settings.read')
  async get(@Query('company_id') companyId: unknown, @Query('as_of') asOfIn: unknown) {
    const company = uuid(companyId, 'company_id');
    const asOf = day(asOfIn) ?? (await this.today());
    const w = await wizardOf(this.tx.get(), company, { asOf }).catch(refusal);
    return {
      company_id: w.companyId,
      as_of: asOf,
      complete: w.complete,
      steps: w.steps.map(stepOf),
    };
  }

  @Post('steps/:n/complete')
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  async complete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('n') n: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    if (!STEP.test(n)) bad('the step must be a whole number 1–10');
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const company = uuid(b['company_id'], 'company_id');
    const reason = b['no_history_reason'];
    if (reason !== undefined && typeof reason !== 'string')
      bad('no_history_reason must be a string');
    const asOf = day(b['as_of']) ?? (await this.today());
    const by = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
    const command: CompleteWizardStep = {
      companyId: company,
      step: Number(n),
      asOf,
      ...(by ? { completedBy: by } : {}),
      ...(typeof reason === 'string' ? { noHistoryReason: reason } : {}),
    };
    const r = await completeWizardStep(this.tx.get(), command).catch(refusal);
    const view = stepOf(r.step);
    if (r.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'setup_wizard_step',
        entityId: `${company}:${String(view.step)}`,
        after: { company_id: company, ...view },
      });
    return { ...view, replayed: r.replayed };
  }
}
