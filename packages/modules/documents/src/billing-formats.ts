/**
 * Billing formats (design §4.3, T-0041, DL-0269): each format is a template record — line source,
 * grouping, tax treatment, numbering series, PDF layout, email template and payment-link
 * behaviour. Tenants clone and adjust records instead of writing code (design principle 3).
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

export const LINE_SOURCES = [
  'opportunity_line_items',
  'order_items',
  'selection',
  'billing_plan',
  'milestones',
  'usage_records',
  'manual',
] as const;
export const GROUPINGS = ['per_account', 'per_opportunity'] as const;
export const PDF_LAYOUTS = ['invoice-v1', 'credit-note-v1', 'proforma-v1'] as const;
export const PAYMENT_LINKS = ['none', 'stripe'] as const;

export interface BillingFormat {
  code: string;
  name: string;
  /** False only for pro-forma / quote: never touches the GL. */
  posted: boolean;
  lineSource: (typeof LINE_SOURCES)[number];
  grouping: (typeof GROUPINGS)[number];
  taxTreatment: 'exclusive' | 'inclusive';
  /** Number series code (app.number_series); null only when not posted. */
  numberSeries: string | null;
  pdfLayout: string;
  emailTemplate: string;
  paymentLink: (typeof PAYMENT_LINKS)[number];
  /** Phase in which the format is available (design §4.3). */
  phase: 'MVP' | 'Phase 1' | 'Phase 2';
}

const f = (x: BillingFormat) => x;

/** Design §4.3 table, AU defaults. */
export const AU_BILLING_FORMATS: readonly BillingFormat[] = Object.freeze([
  f({
    code: 'STANDARD',
    name: 'Standard invoice',
    posted: true,
    lineSource: 'opportunity_line_items',
    grouping: 'per_opportunity',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'MVP',
  }),
  f({
    code: 'BATCH',
    name: 'Batch billing run',
    posted: true,
    lineSource: 'selection',
    grouping: 'per_account',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'MVP',
  }),
  f({
    code: 'RECURRING',
    name: 'Recurring / subscription',
    posted: true,
    lineSource: 'billing_plan',
    grouping: 'per_account',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'Phase 1',
  }),
  f({
    code: 'MILESTONE',
    name: 'Milestone / progress',
    posted: true,
    lineSource: 'milestones',
    grouping: 'per_opportunity',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'MVP',
  }),
  f({
    code: 'DEPOSIT',
    name: 'Deposit / prepayment',
    posted: true,
    lineSource: 'opportunity_line_items',
    grouping: 'per_opportunity',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'MVP',
  }),
  f({
    code: 'USAGE',
    name: 'Usage-based',
    posted: true,
    lineSource: 'usage_records',
    grouping: 'per_account',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_invoice_document',
    pdfLayout: 'invoice-v1',
    emailTemplate: 'invoice',
    paymentLink: 'stripe',
    phase: 'Phase 2',
  }),
  f({
    code: 'CREDIT_NOTE',
    name: 'Credit note (adjustment note)',
    posted: true,
    lineSource: 'manual',
    grouping: 'per_account',
    taxTreatment: 'exclusive',
    numberSeries: 'ar_credit_note_document',
    pdfLayout: 'credit-note-v1',
    emailTemplate: 'credit_note',
    paymentLink: 'none',
    phase: 'MVP',
  }),
  f({
    code: 'PROFORMA',
    name: 'Pro-forma / quote',
    posted: false,
    lineSource: 'opportunity_line_items',
    grouping: 'per_opportunity',
    taxTreatment: 'exclusive',
    numberSeries: null,
    pdfLayout: 'proforma-v1',
    emailTemplate: 'quote',
    paymentLink: 'none',
    phase: 'MVP',
  }),
]);

/** Every problem with a format, as readable lines; [] means valid. */
export function validateBillingFormat(x: BillingFormat): string[] {
  const errors: string[] = [];
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(x.code)) errors.push(`code ${x.code} must be UPPER_SNAKE`);
  if (!(LINE_SOURCES as readonly string[]).includes(x.lineSource))
    errors.push(`unknown line source ${x.lineSource}`);
  if (!(PDF_LAYOUTS as readonly string[]).includes(x.pdfLayout))
    errors.push(`unknown PDF layout ${x.pdfLayout}`);
  if (x.posted && !x.numberSeries) errors.push(`a posted format needs a number series`);
  if (x.numberSeries !== null && !/^[a-z][a-z0-9_]{0,39}$/.test(x.numberSeries)) {
    errors.push(`number series ${x.numberSeries} is not a series code`);
  }
  if (!(GROUPINGS as readonly string[]).includes(x.grouping))
    errors.push(`unknown grouping ${x.grouping}`);
  if (x.taxTreatment !== 'exclusive' && x.taxTreatment !== 'inclusive')
    errors.push(`unknown tax treatment`);
  if (!(PAYMENT_LINKS as readonly string[]).includes(x.paymentLink))
    errors.push(`unknown payment link ${x.paymentLink}`);
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(x.emailTemplate))
    errors.push(`email template ${x.emailTemplate} is not a template code`);
  return errors;
}

/** Seed a company's billing formats from a catalogue (skips codes it already has). */
export async function seedBillingFormats(
  trx: Transaction<Database>,
  companyId: string,
  catalogue: readonly BillingFormat[] = AU_BILLING_FORMATS,
): Promise<number> {
  const have = new Set(
    (
      await trx
        .selectFrom('app.billing_format')
        .select('code')
        .where('company_id', '=', companyId)
        .execute()
    ).map((r) => r.code),
  );
  const missing = catalogue.filter((x) => !have.has(x.code));
  for (const x of missing) {
    const problems = validateBillingFormat(x);
    if (problems.length > 0) throw new Error(`billing format ${x.code}: ${problems.join('; ')}`);
  }
  if (missing.length === 0) return 0;
  await trx
    .insertInto('app.billing_format')
    .values(
      missing.map((x) => ({
        company_id: companyId,
        code: x.code,
        name: x.name,
        posted: x.posted,
        line_source: x.lineSource,
        grouping: x.grouping,
        tax_treatment: x.taxTreatment,
        number_series: x.numberSeries,
        pdf_layout: x.pdfLayout,
        email_template: x.emailTemplate,
        payment_link: x.paymentLink,
      })),
    )
    .execute();
  return missing.length;
}
