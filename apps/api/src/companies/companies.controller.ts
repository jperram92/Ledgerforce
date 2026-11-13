import { Controller, Get } from '@nestjs/common';
import { AnyMember } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

/**
 * Read-only list of the tenant's companies; RLS does the filtering (no tenant_id in the query).
 * `id` (T-0083, DL-0407) lets screens pass company_id to company-scoped routes such as /ar/invoices.
 */
@Controller('companies')
export class CompaniesController {
  constructor(private readonly tx: TenantTx) {}

  @Get()
  @AnyMember()
  list(): Promise<{ id: string; name: string; base_currency: string }[]> {
    return this.tx
      .get()
      .selectFrom('app.company')
      .select(['id', 'name', 'base_currency'])
      .orderBy('name')
      .execute();
  }
}
