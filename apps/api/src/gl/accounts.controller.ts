import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { listChart, rebindSystemRole, RebindError } from '@ledgerforce/gl';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The chart of accounts (design §3.2, T-0082, RQ-0046): the tenant's companies and every account
 * with its system roles, in code order. Read-only; RLS limits it to the caller's tenant. Changing
 * the chart (settings.chart.manage) is not part of this route.
 */
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission('gl.account.read')
  list() {
    return listChart(this.tx.get());
  }

  /**
   * Re-bind a system role to another account (T-0146, design §3.2). Needs settings.chart.manage and
   * an Idempotency-Key. The role already on that account answers 200 with changed:false and writes
   * nothing. The database decides whether the account fits the role (422 REBIND_REFUSED with its
   * message). An account outside the company, or a role that is not bound, is 404.
   */
  @Put('system-roles/:role')
  @RequirePermission('settings.chart.manage')
  async rebind(
    @Param('role') role: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200) {
      throw new BadRequestException({ error: 'idempotency_key_required' });
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const companyId = b['company_id'];
    const accountId = b['account_id'];
    if (typeof companyId !== 'string' || !UUID.test(companyId)) {
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'company_id must be a uuid',
      });
    }
    if (typeof accountId !== 'string') {
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'account_id is required',
      });
    }
    try {
      const r = await rebindSystemRole(this.tx.get(), { companyId, role, accountId });
      const view = {
        role: r.role,
        account_id: r.accountId,
        previous_account_id: r.previousAccountId,
        changed: r.changed,
      };
      if (r.changed) {
        this.audit.describe({
          entityType: 'system_role_binding',
          entityId: `${companyId.toLowerCase()}:${r.role}`,
          before: { account_id: r.previousAccountId },
          after: { account_id: r.accountId },
        });
      }
      return view;
    } catch (e) {
      if (e instanceof RebindError) {
        if (e.code === 'REBIND_REFUSED') {
          throw new UnprocessableEntityException({ error: e.code, message: e.message });
        }
        throw new NotFoundException({ error: e.code, message: e.message });
      }
      throw e;
    }
  }
}
