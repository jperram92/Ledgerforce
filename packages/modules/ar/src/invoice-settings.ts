/**
 * Invoice branding, default payment terms and accepted payment methods per company (T-0158,
 * design §4.1 step 8, RQ-0153, ADR-0071). Stored on app.ar_settings (migration 0067). A patch
 * changes only the fields it names; once set, the brand colour, terms and methods can be changed
 * but not cleared (the wizard step that needs them stays satisfied). The logo is optional: PNG
 * or JPEG up to 512 KiB, checked by its magic bytes; SVG is refused because it can carry script.
 */
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const PAYMENT_METHODS = ['bank_transfer', 'stripe'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type LogoContentType = 'image/png' | 'image/jpeg';
export const MAX_LOGO_BYTES = 512 * 1024;

export type InvoiceSettingsErrorCode = 'INVALID_INVOICE_SETTINGS' | 'UNKNOWN_COMPANY';

/** An invoice-settings request refused; nothing was written. */
export class InvoiceSettingsError extends DomainError {
  declare readonly code: InvoiceSettingsErrorCode;
}

export interface InvoiceSettingsPatch {
  /** #RRGGBB (stored upper-case). */
  readonly brandColour?: string;
  /** #RRGGBB, or null to remove it. */
  readonly brandAccentColour?: string | null;
  /** The logo file, or null to remove it. */
  readonly logo?: { readonly contentType: LogoContentType; readonly content: Uint8Array } | null;
  /** Net days after the invoice date, 0–365. */
  readonly defaultPaymentTermsDays?: number;
  /** One or both of bank_transfer, stripe; stored in that order. */
  readonly acceptedPaymentMethods?: readonly PaymentMethod[];
}

export interface InvoiceSettings {
  readonly brandColour: string | null;
  readonly brandAccentColour: string | null;
  /** Logo metadata; the bytes are read only when an invoice is rendered. */
  readonly logo: { readonly contentType: LogoContentType; readonly sizeBytes: number } | null;
  readonly defaultPaymentTermsDays: number | null;
  readonly acceptedPaymentMethods: PaymentMethod[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOUR = /^#[0-9a-f]{6}$/i;
const MAGIC: Record<LogoContentType, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

const invalid = (message: string) => new InvoiceSettingsError('INVALID_INVOICE_SETTINGS', message);

function checkLogo(logo: NonNullable<InvoiceSettingsPatch['logo']>): Buffer {
  const magic = Object.hasOwn(MAGIC, logo.contentType) ? MAGIC[logo.contentType] : undefined;
  if (!magic) throw invalid('the logo must be a PNG or JPEG image');
  const bytes = logo.content;
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES)
    throw invalid(`the logo must be 1 byte to ${String(MAX_LOGO_BYTES / 1024)} KiB`);
  if (!magic.every((b, i) => bytes[i] === b))
    throw invalid(`the logo file is not a ${logo.contentType === 'image/png' ? 'PNG' : 'JPEG'}`);
  return Buffer.from(bytes);
}

function toValues(p: InvoiceSettingsPatch) {
  const v: {
    brand_colour?: string;
    brand_accent_colour?: string | null;
    logo?: Buffer | null;
    logo_content_type?: LogoContentType | null;
    default_payment_terms_days?: number;
    accepted_payment_methods?: PaymentMethod[];
  } = {};
  if (p.brandColour !== undefined) {
    if (typeof p.brandColour !== 'string' || !COLOUR.test(p.brandColour))
      throw invalid('the brand colour must be #RRGGBB');
    v.brand_colour = p.brandColour.toUpperCase();
  }
  if (p.brandAccentColour !== undefined) {
    if (p.brandAccentColour !== null && !COLOUR.test(p.brandAccentColour))
      throw invalid('the accent colour must be #RRGGBB');
    v.brand_accent_colour = p.brandAccentColour?.toUpperCase() ?? null;
  }
  if (p.logo !== undefined) {
    v.logo = p.logo === null ? null : checkLogo(p.logo);
    v.logo_content_type = p.logo === null ? null : p.logo.contentType;
  }
  if (p.defaultPaymentTermsDays !== undefined) {
    const d = p.defaultPaymentTermsDays;
    if (!Number.isInteger(d) || d < 0 || d > 365)
      throw invalid('the default payment terms must be 0 to 365 whole days');
    v.default_payment_terms_days = d;
  }
  if (p.acceptedPaymentMethods !== undefined) {
    const m = p.acceptedPaymentMethods as readonly string[] | null;
    if (
      !Array.isArray(m) ||
      m.length === 0 ||
      new Set(m).size !== m.length ||
      !m.every((x) => (PAYMENT_METHODS as readonly string[]).includes(x))
    )
      throw invalid('accepted payment methods must be one or both of bank_transfer, stripe');
    v.accepted_payment_methods = PAYMENT_METHODS.filter((x) => m.includes(x));
  }
  return v;
}

/** Save the fields the patch names; the others keep their values. */
export async function setInvoiceSettings(
  trx: Trx,
  companyId: string,
  patch: InvoiceSettingsPatch,
): Promise<void> {
  if (!UUID.test(companyId)) throw invalid('companyId must be a UUID');
  const values = toValues(patch);
  const company = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!company) throw new InvoiceSettingsError('UNKNOWN_COMPANY', 'company not found');
  if (Object.keys(values).length === 0) return;
  await trx
    .insertInto('app.ar_settings')
    .values({ company_id: companyId, ...values })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'company_id'])
        .doUpdateSet({ ...values, updated_at: sql<Date>`clock_timestamp()` }),
    )
    .execute();
}

/** The company's invoice settings; every field null when nothing has been saved. */
export async function invoiceSettingsOf(trx: Trx, companyId: string): Promise<InvoiceSettings> {
  if (!UUID.test(companyId)) throw invalid('companyId must be a UUID');
  const r = await trx
    .selectFrom('app.ar_settings')
    .select([
      'brand_colour',
      'brand_accent_colour',
      'logo_content_type',
      sql<number | null>`octet_length(logo)`.as('logo_size'),
      'default_payment_terms_days',
      'accepted_payment_methods',
    ])
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  return {
    brandColour: r?.brand_colour ?? null,
    brandAccentColour: r?.brand_accent_colour ?? null,
    logo:
      r?.logo_content_type && r.logo_size != null
        ? { contentType: r.logo_content_type, sizeBytes: r.logo_size }
        : null,
    defaultPaymentTermsDays: r?.default_payment_terms_days ?? null,
    acceptedPaymentMethods: r?.accepted_payment_methods ?? null,
  };
}
