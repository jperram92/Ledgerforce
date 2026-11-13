/**
 * GST accounting basis and BAS reporting frequency per company (T-0158, design §3.6, §4.1 step 3,
 * RQ-0153, ADR-0071). Effective-dated from the 1st of a month; the setting in force on a date is
 * the row with the latest effective_from on or before it. Saving the same date again corrects
 * that row; a new date adds a row, so earlier periods keep theirs.
 *
 * ATO guidance the UI shows, not enforced here (LedgerForce holds no turnover, registration or ATO
 * direction, RQ-0153): the cash basis is for small business entities (aggregated turnover under
 * $10 million) or with ATO permission; monthly reporting is required at GST turnover of $20 million
 * or more; annual reporting is for voluntary registrants under $75,000 ($150,000 not-for-profit).
 */
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';
import type { GstBasis } from './bas.ts';

type Trx = Transaction<Database>;

export const GST_BASES: readonly GstBasis[] = ['cash', 'accrual'];
export const BAS_FREQUENCIES = ['monthly', 'quarterly', 'annual'] as const;
export type BasFrequency = (typeof BAS_FREQUENCIES)[number];

export type TaxSettingsErrorCode = 'INVALID_TAX_SETTINGS' | 'UNKNOWN_COMPANY';

/** A tax-settings request refused; nothing was written. */
export class TaxSettingsError extends DomainError {
  declare readonly code: TaxSettingsErrorCode;
}

export interface SetTaxSettings {
  readonly companyId: string;
  /** YYYY-MM-DD, the 1st of a month. */
  readonly effectiveFrom: string;
  readonly gstBasis: GstBasis;
  readonly basFrequency: BasFrequency;
  readonly setBy?: string | null;
}

export interface TaxSettings {
  readonly companyId: string;
  readonly effectiveFrom: string;
  readonly gstBasis: GstBasis;
  readonly basFrequency: BasFrequency;
  readonly setBy: string | null;
  readonly setAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_START = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string) => new TaxSettingsError('INVALID_TAX_SETTINGS', message);

const columns = [
  'company_id',
  sql<string>`to_char(effective_from, 'YYYY-MM-DD')`.as('effective_from'),
  'gst_basis',
  'bas_frequency',
  'set_by',
  'set_at',
] as const;

const toView = (r: {
  company_id: string;
  effective_from: string;
  gst_basis: GstBasis;
  bas_frequency: BasFrequency;
  set_by: string | null;
  set_at: Date;
}): TaxSettings => ({
  companyId: r.company_id,
  effectiveFrom: r.effective_from,
  gstBasis: r.gst_basis,
  basFrequency: r.bas_frequency,
  setBy: r.set_by,
  setAt: r.set_at,
});

/** Save the company's GST basis and BAS frequency from a month start. */
export async function setTaxSettings(trx: Trx, s: SetTaxSettings): Promise<TaxSettings> {
  if (!UUID.test(s.companyId)) throw invalid('companyId must be a UUID');
  if (!MONTH_START.test(s.effectiveFrom))
    throw invalid('effectiveFrom must be the 1st of a month (YYYY-MM-01)');
  if (!GST_BASES.includes(s.gstBasis)) throw invalid('gstBasis must be cash or accrual');
  if (!(BAS_FREQUENCIES as readonly string[]).includes(s.basFrequency))
    throw invalid('basFrequency must be monthly, quarterly or annual');
  const company = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', s.companyId)
    .executeTakeFirst();
  if (!company) throw new TaxSettingsError('UNKNOWN_COMPANY', 'company not found');
  const values = {
    gst_basis: s.gstBasis,
    bas_frequency: s.basFrequency,
    set_by: s.setBy ?? null,
  };
  const row = await trx
    .insertInto('app.tax_settings')
    .values({ company_id: s.companyId, effective_from: s.effectiveFrom, ...values })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'company_id', 'effective_from'])
        .doUpdateSet({ ...values, set_at: sql<Date>`clock_timestamp()` }),
    )
    .returning(columns)
    .executeTakeFirstOrThrow();
  return toView(row);
}

/** The setting in force on `asOf` (YYYY-MM-DD), or null when none is. */
export async function taxSettingsOf(
  trx: Trx,
  companyId: string,
  asOf: string,
): Promise<TaxSettings | null> {
  if (!UUID.test(companyId)) throw invalid('companyId must be a UUID');
  if (!DATE.test(asOf)) throw invalid('asOf must be a date (YYYY-MM-DD)');
  const row = await trx
    .selectFrom('app.tax_settings')
    .select(columns)
    .where('company_id', '=', companyId)
    .where('effective_from', '<=', sql<Date>`${asOf}::date`)
    .orderBy('effective_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toView(row) : null;
}
