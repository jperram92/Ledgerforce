import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { listBankAccounts } from '@ledgerforce/parties';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

/**
 * Bank details of a party, masked to the last 3 characters (design §6.6, ADR-0018). This
 * endpoint can never decrypt: it has no KMS. RLS limits it to the caller's tenant.
 */
@Controller('parties/:partyId/bank-accounts')
export class PartyBankAccountsController {
  constructor(private readonly tx: TenantTx) {}

  @Get()
  @RequirePermission('parties.bank_account.read')
  async list(
    @Param('partyId', new ParseUUIDPipe()) partyId: string,
  ): Promise<
    { id: string; bsb: string; account_name: string; account_number: string; status: string }[]
  > {
    const rows = await listBankAccounts(this.tx.get(), partyId);
    return rows.map((r) => ({
      id: r.id,
      bsb: r.bsb,
      account_name: r.accountName,
      account_number: r.accountNumber,
      status: r.status,
    }));
  }
}
