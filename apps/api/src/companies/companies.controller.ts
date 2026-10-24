import { Controller, Get } from '@nestjs/common';
import { TenantTx } from '../tenancy/tenant-tx.ts';

/** Read-only list of the tenant's companies; RLS does the filtering (no tenant_id in the query). */
@Controller('companies')
export class CompaniesController {
  constructor(private readonly tx: TenantTx) {}

  @Get()
  list(): Promise<{ name: string; base_currency: string }[]> {
    return this.tx
      .get()
      .selectFrom('app.company')
      .select(['name', 'base_currency'])
      .orderBy('name')
      .execute();
  }
}
