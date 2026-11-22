/**
 * Numbering and billing over HTTP: setup wizard step 8 (T-0186, SS-PLAT-131, ADR-0085, RQ-0167).
 * Thin routes over the owners of each setting:
 * - `GET /setup/billing?company_id=` (settings.read): the invoice and credit-note number series
 *   (ledger), the billing formats (documents), the invoice settings (ar), the Stripe clearing
 *   account (Stripe connector) and the accounts that may be it.
 * - `PUT /setup/billing/series` (ledger defineNumberSeries), `POST /setup/billing/formats/standard`
 *   (documents seedBillingFormats), `PUT /setup/billing/invoice` (ar setInvoiceSettings),
 *   `PUT /setup/billing/stripe` (connector setStripeSettings; T-0195: also the payout fields).
 *   Each needs settings.setup.manage and an Idempotency-Key, is replay-safe by state (DL-0642) and
 *   is audited only when it changed something.
 * - T-0195 (ADR-0100, RQ-0182): `PUT /setup/billing/logo` (base64 PNG/JPEG in JSON, read by the
 *   1 MiB route-scoped reader, cleaned by ar cleanInvoiceLogo before setInvoiceSettings) and
 *   `GET /setup/billing/logo` (settings.read; served so it can never run as a page). The GET
 *   overview also lists the accounts and parties the Stripe payout fields may name.
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
  StreamableFile,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  cleanInvoiceLogo,
  CREDIT_NOTE_NUMBER_SERIES,
  INVOICE_NUMBER_SERIES,
  invoiceLogoOf,
  InvoiceSettingsError,
  invoiceSettingsOf,
  setInvoiceSettings,
  type InvoiceSettings,
  type LogoContentType,
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

/** Active, postable, non-control, debit-normal expense accounts: Stripe fees (ADR-0100 item 4). */
const feeAccounts = (trx: Transaction<Database>, companyId: string) =>
  trx
    .selectFrom('app.account')
    .select(['id', 'code', 'name'])
    .where('company_id', '=', companyId)
    .where('type', '=', 'expense')
    .where('normal_balance', '=', 'debit')
    .where('postable', '=', true)
    .where('is_control', '=', false)
    .where('status', '=', 'active')
    .orderBy('code')
    .execute();

/** GL accounts of the company's active base-currency bank accounts: where payouts land. */
const payoutAccounts = (trx: Transaction<Database>, companyId: string) =>
  trx
    .selectFrom('app.bank_account as b')
    .innerJoin('app.account as a', (j) =>
      j.onRef('a.id', '=', 'b.gl_account_id').onRef('a.company_id', '=', 'b.company_id'),
    )
    .innerJoin('app.company as c', (j) =>
      j.onRef('c.id', '=', 'b.company_id').onRef('c.base_currency', '=', 'b.currency'),
    )
    .select(['a.id', 'a.code', 'a.name', 'b.name as bank_account_name'])
    .where('b.company_id', '=', companyId)
    .where('b.status', '=', 'active')
    .where('a.status', '=', 'active')
    .where('a.postable', '=', true)
    .where('a.is_control', '=', false)
    .orderBy('a.code')
    .execute();

/** Active parties with an active supplier role: Stripe invoices its fees. */
const stripeParties = (trx: Transaction<Database>, companyId: string) =>
  trx
    .selectFrom('app.party as p')
    .innerJoin('app.party_role as r', (j) =>
      j.onRef('r.party_id', '=', 'p.id').onRef('r.company_id', '=', 'p.company_id'),
    )
    .select(['p.id', 'p.legal_name as name'])
    .where('p.company_id', '=', companyId)
    .where('p.status', '=', 'active')
    .where('r.role', '=', 'supplier')
    .where('r.active', '=', true)
    .orderBy('p.legal_name')
    .orderBy('p.id')
    .execute();

interface StripeView {
  clearing_account_id: string;
  fee_account_id: string | null;
  payout_account_id: string | null;
  stripe_party_id: string | null;
}

const stripeOf = async (
  trx: Transaction<Database>,
  companyId: string,
): Promise<StripeView | null> => {
  const r = await trx
    .selectFrom('app.stripe_settings')
    .select(['clearing_account_id', 'fee_account_id', 'payout_account_id', 'stripe_party_id'])
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  return r
    ? {
        clearing_account_id: r.clearing_account_id,
        fee_account_id: r.fee_account_id,
        payout_account_id: r.payout_account_id,
        stripe_party_id: r.stripe_party_id,
      }
    : null;
};

const optionalUuid = (v: unknown, name: string): string | undefined =>
  v === undefined ? undefined : uuid(v, name);

const refuse = (error: string, message: string): never => {
  throw new UnprocessableEntityException({ error, message });
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** What the audit trail records of a logo: never its bytes. */
const logoMeta = (l: { contentType: LogoContentType; content: Uint8Array } | null) =>
  l
    ? {
        content_type: l.contentType,
        size_bytes: l.content.length,
        sha256: createHash('sha256').update(l.content).digest('hex'),
      }
    : null;

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
      fee_accounts: await feeAccounts(trx, companyId),
      payout_accounts: await payoutAccounts(trx, companyId),
      stripe_parties: await stripeParties(trx, companyId),
    };
  }

  @Get('logo')
  @RequirePermission('settings.read')
  async logo(
    @Res({ passthrough: true }) res: Response,
    @Query('company_id') companyIdIn: unknown,
  ): Promise<StreamableFile> {
    const companyId = uuid(companyIdIn, 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const l = await invoiceLogoOf(trx, companyId);
    if (!l)
      throw new NotFoundException({ error: 'LOGO_NOT_SET', message: 'no invoice logo is saved' });
    // Stored only after cleaning; checked again so nothing else is ever served (RQ-0182 finding 4).
    const { contentType, content } = cleanInvoiceLogo(l.contentType, l.content);
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="invoice-logo.${contentType === 'image/png' ? 'png' : 'jpg'}"`,
    );
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return new StreamableFile(Buffer.from(content));
  }

  @Put('logo')
  @RequirePermission('settings.setup.manage')
  async setLogo(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const input = b['logo'];
    let next: { contentType: LogoContentType; content: Uint8Array } | null = null;
    if (input !== null) {
      if (typeof input !== 'object' || input === undefined || Array.isArray(input))
        bad('logo must be {content_type, content_base64} or null');
      const l = input as Record<string, unknown>;
      const type = l['content_type'];
      const data = l['content_base64'];
      if (typeof data !== 'string' || !BASE64.test(data))
        bad('content_base64 must be the file in base64');
      if (typeof type !== 'string') bad('content_type must be image/png or image/jpeg');
      // An unknown type (SVG included) is refused by the cleaner in plain words.
      const clean = (() => {
        try {
          return cleanInvoiceLogo(type as LogoContentType, Buffer.from(data as string, 'base64'));
        } catch (e) {
          return invoiceRefusal(e);
        }
      })();
      next = { contentType: clean.contentType, content: clean.content };
    }
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const before = logoMeta(await invoiceLogoOf(trx, companyId));
    const after = logoMeta(next);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) {
      await setInvoiceSettings(trx, companyId, { logo: next }).catch(invoiceRefusal);
      this.audit.describe({
        entityType: 'ar_settings',
        entityId: companyId,
        before: { logo: before },
        after: { logo: after },
      });
    }
    return { invoice: invoiceView(await invoiceSettingsOf(trx, companyId)), changed };
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
    const feeId = optionalUuid(b['fee_account_id'], 'fee_account_id');
    const payoutId = optionalUuid(b['payout_account_id'], 'payout_account_id');
    const partyId = optionalUuid(b['stripe_party_id'], 'stripe_party_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    // Checked before writing: a foreign-key error would abort the request transaction.
    if (!(await clearingAccounts(trx, companyId)).some((a) => a.id === accountId))
      refuse(
        'INVALID_CLEARING_ACCOUNT',
        'the Stripe clearing account must be an active asset account of this company that takes postings and is not a control account',
      );
    if (feeId && !(await feeAccounts(trx, companyId)).some((a) => a.id === feeId))
      refuse(
        'INVALID_FEE_ACCOUNT',
        'the Stripe fees account must be an active expense account of this company that takes postings and is not a control account',
      );
    if (payoutId && !(await payoutAccounts(trx, companyId)).some((a) => a.id === payoutId))
      refuse(
        'INVALID_PAYOUT_ACCOUNT',
        "the Stripe payout account must be the ledger account of one of this company's active bank accounts in its base currency",
      );
    if (partyId && !(await stripeParties(trx, companyId)).some((p) => p.id === partyId))
      refuse('INVALID_STRIPE_PARTY', 'the Stripe party must be an active supplier of this company');
    const before = await stripeOf(trx, companyId);
    const after: StripeView = {
      clearing_account_id: accountId,
      fee_account_id: feeId ?? before?.fee_account_id ?? null,
      payout_account_id: payoutId ?? before?.payout_account_id ?? null,
      stripe_party_id: partyId ?? before?.stripe_party_id ?? null,
    };
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) {
      await setStripeSettings(trx, companyId, {
        clearingAccountId: accountId,
        ...(feeId ? { feeAccountId: feeId } : {}),
        ...(payoutId ? { payoutAccountId: payoutId } : {}),
        ...(partyId ? { stripePartyId: partyId } : {}),
      });
      this.audit.describe({ entityType: 'stripe_settings', entityId: companyId, before, after });
    }
    return { stripe: after, changed };
  }
}
