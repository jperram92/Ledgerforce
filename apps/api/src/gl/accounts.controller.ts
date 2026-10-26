import { Controller, Get } from '@nestjs/common';
import { listChart } from '@ledgerforce/gl';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

/**
 * The chart of accounts (design §3.2, T-0082, RQ-0046): the tenant's companies and every account
 * with its system roles, in code order. Read-only; RLS limits it to the caller's tenant. Changing
 * the chart (settings.chart.manage) is not part of this route.
 */
@Controller('accounts')
export class AccountsController {
  constructor(private readonly tx: TenantTx) {}

  @Get()
  @RequirePermission('gl.account.read')
  list() {
    return listChart(this.tx.get());
  }
}
