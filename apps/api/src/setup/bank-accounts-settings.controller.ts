/**
 * Company bank accounts over HTTP: setup wizard step 4 (T-0185, SS-PLAT-130, ADR-0084, RQ-0166).
 * Thin: validates, then calls @ledgerforce/bank. Routes:
 * - `GET /setup/bank-accounts?company_id=` (settings.read): the accounts, numbers masked to `***`
 *   + the last 3 characters (design §6.6, ADR-0018), and the bank GL accounts that can take one.
 * - `POST /setup/bank-accounts` (settings.setup.manage + step-up 300 s, Idempotency-Key, audited
 *   masked): seals the number through createCompanyBankAccount. The GL account's active bank
 *   account is the replay record (DL-0700): the same request again is 200 `replayed:true`; a
 *   different one, or a lost race on the one-per-GL-account index, is 409 GL_ACCOUNT_IN_USE.
 *   Without a key service: 503 kms_not_configured (ADR-0030). No SoD step (DL-0701).
 * No response, message or audit row carries a clear account number; database errors are mapped
 * to fixed messages (DL-0702). Another tenant's company is 404 (RLS).
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BankAccountValidationError,
  createCompanyBankAccount,
  listCompanyBankAccounts,
  sameCompanyBankAccount,
  type CompanyBankAccountInput,
  type MaskedCompanyBankAccount,
  validateCompanyBankAccountInput,
} from '@ledgerforce/bank';
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Response } from 'express';
import type { Transaction } from 'kysely';
import { Authz } from '../authz/authz.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { bad, bodyOf, companyOf, requireKey, uuid } from '../settings/settings-common.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { KMS } from '../tokens.ts';

/** Step-up window, as for supplier bank-detail changes and the remittance account (ADR-0025). */
const STEP_UP_SECONDS = 300;

const IN_USE = (name: string) =>
  new ConflictException({
    error: 'GL_ACCOUNT_IN_USE',
    message: `this GL account already has a bank account (${name}); choose another GL account`,
  });

interface GlAccount {
  id: string;
  code: string;
  name: string;
  currency: string | null;
}

/** The company's accounts that can take a bank account (the database trigger decides finally). */
async function bankGlAccounts(trx: Transaction<Database>, companyId: string): Promise<GlAccount[]> {
  return trx
    .selectFrom('app.account')
    .select(['id', 'code', 'name', 'currency'])
    .where('company_id', '=', companyId)
    .where('type', '=', 'asset')
    .where('subtype', '=', 'bank')
    .where('status', '=', 'active')
    .where('postable', '=', true)
    .where('is_control', '=', false)
    .orderBy('code')
    .execute();
}

const viewOf = (a: MaskedCompanyBankAccount, gl: Map<string, { code: string; name: string }>) => ({
  id: a.id,
  name: a.name,
  gl_account_id: a.glAccountId,
  gl_account_code: gl.get(a.glAccountId)?.code ?? null,
  gl_account_name: gl.get(a.glAccountId)?.name ?? null,
  currency: a.currency,
  bsb: a.bsb,
  account_name: a.accountName,
  account_number: a.accountNumber,
  apca_user_id: a.apcaUserId,
  aba_user_name: a.abaUserName,
  aba_fi_mnemonic: a.abaFiMnemonic,
  status: a.status,
});

const text = (b: Record<string, unknown>, name: string): string => {
  const v = b[name];
  return typeof v === 'string' ? v : bad(`${name} is required`);
};
const optional = (b: Record<string, unknown>, name: string): string | undefined => {
  const v = b[name];
  if (v === undefined || v === null || v === '') return undefined;
  return typeof v === 'string' ? v : bad(`${name} must be text`);
};
const pgCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;

@Controller('setup/bank-accounts')
export class BankAccountsSettingsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
    @Inject(KMS) private readonly kms: Kms | null,
  ) {}

  /** Every GL account of the company by id (names of accounts already bound, any status). */
  private async glNames(companyId: string) {
    const rows = await this.tx
      .get()
      .selectFrom('app.account')
      .select(['id', 'code', 'name'])
      .where('company_id', '=', companyId)
      .execute();
    return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
  }

  @Get()
  @RequirePermission('settings.read')
  async list(@Query('company_id') companyIdParam: unknown) {
    const companyId = uuid(companyIdParam, 'company_id');
    const trx = this.tx.get();
    const c = await companyOf(trx, companyId);
    const accounts = await listCompanyBankAccounts(trx, companyId);
    const names = await this.glNames(companyId);
    const inUse = new Set(accounts.filter((a) => a.status === 'active').map((a) => a.glAccountId));
    return {
      company_id: c.id,
      base_currency: c.base_currency,
      kms_configured: this.kms !== null,
      accounts: accounts.map((a) => viewOf(a, names)),
      gl_accounts: (await bankGlAccounts(trx, companyId)).map((g) => ({
        ...g,
        in_use: inUse.has(g.id),
      })),
    };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  @RequireStepUp(STEP_UP_SECONDS)
  async add(
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const glAccountId = uuid(b['gl_account_id'], 'gl_account_id');
    const input: CompanyBankAccountInput = {
      glAccountId,
      name: text(b, 'name'),
      bsb: text(b, 'bsb'),
      accountNumber: text(b, 'account_number'),
      accountName: text(b, 'account_name'),
      currency: text(b, 'currency'),
    };
    const apca = optional(b, 'apca_user_id');
    const abaName = optional(b, 'aba_user_name');
    const mnemonic = optional(b, 'aba_fi_mnemonic');
    if (apca !== undefined) input.apcaUserId = apca;
    if (abaName !== undefined) input.abaUserName = abaName;
    if (mnemonic !== undefined) input.abaFiMnemonic = mnemonic;
    try {
      validateCompanyBankAccountInput(input);
    } catch (e) {
      if (e instanceof BankAccountValidationError) bad(e.message);
      throw e;
    }
    if (!this.kms) throw new ServiceUnavailableException({ error: 'kms_not_configured' });

    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const names = await this.glNames(companyId);
    if (!names.has(glAccountId))
      throw new NotFoundException({
        error: 'UNKNOWN_GL_ACCOUNT',
        message: 'the GL account is not one of this company’s accounts',
      });
    const existing = (await listCompanyBankAccounts(trx, companyId)).find(
      (a) => a.status === 'active' && a.glAccountId === glAccountId,
    );
    if (existing) {
      if (!sameCompanyBankAccount(existing, input)) throw IN_USE(existing.name);
      res.status(200);
      return { account: viewOf(existing, names), replayed: true };
    }

    let id: string;
    try {
      id = await createCompanyBankAccount(trx, this.kms, companyId, {
        ...input,
        createdBy: this.authz.userId(),
      });
    } catch (e) {
      if (e instanceof BankAccountValidationError) bad(e.message);
      if (pgCode(e) === '23505') throw IN_USE('added by another request just now');
      if (pgCode(e) === '23514')
        throw new UnprocessableEntityException({
          error: 'GL_ACCOUNT_NOT_BANK',
          message:
            'a bank account needs an active, postable bank GL account (an asset of subtype bank) in the same currency',
        });
      throw e;
    }
    const added = (await listCompanyBankAccounts(trx, companyId)).find((a) => a.id === id);
    if (!added) throw new Error('the added bank account is not readable');
    const view = viewOf(added, names);
    this.audit.describe({ entityType: 'bank_account', entityId: id, after: view });
    return { account: view, replayed: false };
  }
}
