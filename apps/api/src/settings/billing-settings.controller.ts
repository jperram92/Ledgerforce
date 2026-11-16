/**
 * Numbering and billing over HTTP: setup wizard step 8 (T-0186, SS-PLAT-131, ADR-0085, RQ-0167).
 * Thin routes over the owners of each setting:
 * - `GET /setup/billing?company_id=` (settings.read): the invoice and credit-note number series
 *   (ledger), the billing formats (documents), the invoice settings (ar), the Stripe clearing
 *   account (Stripe connector) and the accounts that may be it.
 * - `PUT /setup/billing/series` (ledger defineNumberSeries), `POST /setup/billing/formats/standard`
 *   (documents seedBillingFormats), `PUT /setup/billing/invoice` (ar setInvoiceSettings),
 *   `PUT /setup/billing/stripe` (connector setStripeSettings; payout fields untouched). Each needs
 *   settings.setup.manage and an Idempotency-Key, is replay-safe by state (DL-0642) and is audited
 *   only when it changed something.
 * The remittance account of step 8 has its own route (T-0180, T-0183).
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
  Post,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CREDIT_NOTE_NUMBER_SERIES,
  INVOICE_NUMBER_SERIES,
  InvoiceSettingsError,
  invoiceSettingsOf,
  setInvoiceSettings,
  type InvoiceSettings,
  type PaymentMethod,
} from '@ledgerforce/ar';
import { setStripeSettings } from '@ledgerforce/connector-stripe';
import type { Database } from '@ledgerforce/db';
import { seedBillingFormats } from '@ledgerforce/documents';
import {
  defineNumberSeries,
  NumberSeriesError,
  numberSeriesOf,
  type NumberSeriesView,
} from '@ledgerforce/ledger';
import type { Response } from 'express';
import type { Transaction } from 'kysely';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { bad, bodyOf, companyOf, requireKey, uuid } from './settings-common.ts';

/** The series step 8 sets up (RQ-0167 finding 1). */
const SERIES = [CREDIT_NOTE_NUMBER_SERIES, INVOICE_NUMBER_SERIES] as const;

const seriesView = (s: NumberSeriesView) => ({
  code: s.code,
  prefix: s.prefix,
  pad_width: s.padWidth,
  next_number: s.nextNumber,
  issued: s.issued,
  status: s.status,
});

const invoiceView = (s: InvoiceSettings) => ({
  brand_colour: s.brandColour,
  brand_accent_colour: s.brandAccentColour,
  default_payment_terms_days: s.defaultPaymentTermsDays,
  accepted_payment_methods: s.acceptedPaymentMethods,
  has_logo: s.logo !== null,
});

/** Active, postable, non-control, debit-normal asset accounts (RQ-0167 finding 2). */
const clearingAccounts = (trx: Transaction<Database>, companyId: string) =>
  trx
    .selectFrom('app.account')
    .select(['id', 'code', 'name'])
    .where('company_id', '=', companyId)
    .where('type', '=', 'asset')
    .where('normal_balance', '=', 'debit')
    .where('postable', '=', true)
    .where('is_control', '=', false)
    .where('status', '=', 'active')
    .orderBy('code')
    .execute();

const stripeOf = async (trx: Transaction<Database>, companyId: string) => {
  const r = await trx
    .selectFrom('app.stripe_settings')
    .select('clearing_account_id')
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  return r ? { clearing_account_id: r.clearing_account_id } : null;
};

const seriesRefusal = (e: unknown): never => {
  if (e instanceof NumberSeriesError) {
    if (e.code === 'NUMBER_SERIES_IN_USE')
      throw new ConflictException({ error: e.code, message: e.message });
    if (e.code === 'UNKNOWN_COMPANY')
      throw new NotFoundException({ error: e.code, message: e.message });
    throw new BadRequestException({ error: e.code, message: e.message });
  }
  throw e;
};

const invoiceRefusal = (e: unknown): never => {
  if (e instanceof InvoiceSettingsError) {
    if (e.code === 'UNKNOWN_COMPANY')
      throw new NotFoundException({ error: e.code, message: e.message });
    throw new BadRequestException({ error: e.code, message: e.message });
  }
  throw e;
};

@Controller('setup/billing')
export class BillingSettingsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission('settings.read')
  async get(@Query('company_id') companyIdIn: unknown) {
    const companyId = uuid(companyIdIn, 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const formats = await trx
      .selectFrom('app.billing_format')
      .select(['code', 'name', 'posted', 'status'])
      .where('company_id', '=', companyId)
      .orderBy('code')
      .execute();
    return {
      company_id: companyId,
      series: (await numberSeriesOf(trx, companyId, SERIES)).map(seriesView),
      formats,
      invoice: invoiceView(await invoiceSettingsOf(trx, companyId)),
      stripe: await stripeOf(trx, companyId),
      clearing_accounts: await clearingAccounts(trx, companyId),
    };
  }

  @Put('series')
  @RequirePermission('settings.setup.manage')
  async series(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const code = b['code'];
    if (typeof code !== 'string' || !(SERIES as readonly string[]).includes(code))
      bad(`code must be ${INVOICE_NUMBER_SERIES} or ${CREDIT_NOTE_NUMBER_SERIES}`);
    const prefix = b['prefix'];
    const padWidth = b['pad_width'];
    if (typeof prefix !== 'string') bad('prefix must be text (it may be empty)');
    if (typeof padWidth !== 'number') bad('pad_width must be a whole number');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const before = (await numberSeriesOf(trx, companyId, [code as string]))[0];
    const r = await defineNumberSeries(trx, {
      companyId,
      code: code as string,
      prefix: prefix as string,
      padWidth: padWidth as number,
    }).catch(seriesRefusal);
    if (r.changed)
      this.audit.describe({
        entityType: 'number_series',
        entityId: `${companyId}:${r.series.code}`,
        before: before ? seriesView(before) : null,
        after: seriesView(r.series),
      });
    return { series: seriesView(r.series), changed: r.changed };
  }

  @Post('formats/standard')
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  async formats(
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const companyId = uuid(bodyOf(body)['company_id'], 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const inserted = await seedBillingFormats(trx, companyId);
    if (inserted === 0) {
      res.status(200);
      return { inserted };
    }
    this.audit.describe({ entityType: 'billing_format', entityId: companyId, after: { inserted } });
    return { inserted };
  }

  @Put('invoice')
  @RequirePermission('settings.setup.manage')
  async invoice(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const colour = b['brand_colour'];
    const terms = b['default_payment_terms_days'];
    const methods = b['accepted_payment_methods'];
    const accent = b['brand_accent_colour'];
    if (typeof colour !== 'string') bad('brand_colour is required (#RRGGBB)');
    if (typeof terms !== 'number') bad('default_payment_terms_days is required (whole days)');
    if (!Array.isArray(methods)) bad('accepted_payment_methods is required (a list)');
    if (accent !== undefined && accent !== null && typeof accent !== 'string')
      bad('brand_accent_colour must be #RRGGBB or null');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const before = invoiceView(await invoiceSettingsOf(trx, companyId));
    await setInvoiceSettings(trx, companyId, {
      brandColour: colour as string,
      defaultPaymentTermsDays: terms as number,
      acceptedPaymentMethods: methods as PaymentMethod[],
      ...(accent === undefined ? {} : { brandAccentColour: accent as string | null }),
    }).catch(invoiceRefusal);
    const after = invoiceView(await invoiceSettingsOf(trx, companyId));
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed)
      this.audit.describe({ entityType: 'ar_settings', entityId: companyId, before, after });
    return { invoice: after, changed };
  }

  @Put('stripe')
  @RequirePermission('settings.setup.manage')
  async stripe(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const accountId = uuid(b['clearing_account_id'], 'clearing_account_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    // Checked before writing: a foreign-key error would abort the request transaction.
    if (!(await clearingAccounts(trx, companyId)).some((a) => a.id === accountId))
      throw new UnprocessableEntityException({
        error: 'INVALID_CLEARING_ACCOUNT',
        message:
          'the Stripe clearing account must be an active asset account of this company that takes postings and is not a control account',
      });
    const before = await stripeOf(trx, companyId);
    const changed = before?.clearing_account_id !== accountId;
    if (changed) {
      await setStripeSettings(trx, companyId, { clearingAccountId: accountId });
      this.audit.describe({
        entityType: 'stripe_settings',
        entityId: companyId,
        before,
        after: { clearing_account_id: accountId },
      });
    }
    return { stripe: { clearing_account_id: accountId }, changed };
  }
}
