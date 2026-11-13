/**
 * Per-party overdue-reminder pause (T-0129, SS-UC04-07, UC-04 "AR Clerk can pause reminders per
 * party (audited)", RQ-0144):
 *   POST /ar/parties/:id/reminder-pause {company_id, paused, reason} — pause (true) or resume
 *     (false). Needs ar.dunning.run and an Idempotency-Key: 201 new, 200 replay, 409 no change or
 *     key reused for another request, 422 missing reason or unknown party. Audited.
 *   GET  /ar/parties/:id/reminder-pause?company_id= — current state and history (ar.read).
 * No ledger effect.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  reminderPauseHistory,
  ReminderPauseError,
  setReminderPause,
  type ReminderPause,
} from '@ledgerforce/ar';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const refusal = (e: unknown): never => {
  if (e instanceof ReminderPauseError) {
    if (e.code === 'NO_CHANGE' || e.code === 'IDEMPOTENCY_CONFLICT') {
      throw new ConflictException({ error: e.code, message: e.message });
    }
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};
const viewOf = (p: ReminderPause) => ({
  id: p.id,
  party_id: p.partyId,
  paused: p.paused,
  reason: p.reason,
  set_by: p.setBy,
  set_at: p.setAt.toISOString(),
});

@Controller('ar/parties')
export class ArReminderPauseController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Post(':id/reminder-pause')
  @HttpCode(201)
  @RequirePermission('ar.dunning.run')
  async set(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof b['paused'] !== 'boolean') bad('paused must be true or false');
    const by = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
    if (!by) bad('a user is required');
    const r = await setReminderPause(this.tx.get(), {
      companyId: uuid(b['company_id'], 'company_id'),
      partyId: uuid(id, 'id'),
      paused: b['paused'] as boolean,
      reason: typeof b['reason'] === 'string' ? b['reason'] : '',
      by: by as string,
      idempotencyKey: key,
    }).catch(refusal);
    if (r.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'ar_reminder_pause',
        entityId: r.pause.id,
        after: viewOf(r.pause),
      });
    return { ...viewOf(r.pause), replayed: r.replayed };
  }

  @Get(':id/reminder-pause')
  @RequirePermission('ar.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: unknown) {
    const history = await reminderPauseHistory(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      partyId: uuid(id, 'id'),
    });
    return { paused: history.at(-1)?.paused ?? false, history: history.map(viewOf) };
  }
}
