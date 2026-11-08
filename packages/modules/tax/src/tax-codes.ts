/**
 * Effective-dated tax codes (design §3.6, migration 0031). Codes are data (design principle 3):
 * a country template ships them and loadTaxCodes() writes them for a company inside the caller's
 * tenant transaction. A rate change is a new row with a later valid_from; the database refuses
 * overlaps and any edit other than closing valid_to (or renaming).
 *
 * Account bindings are by system role (T-0018): a code names GST_COLLECTED / GST_PAID, and the
 * account is resolved through app.account_system_role at the time of use, so re-binding a role
 * moves every code with it.
 *
 * Kinds (T-0035, migration 0036, RQ-0102 finding 6): migration 0031's `kind` CHECK cannot be
 * widened forward-only, so the two newer kinds are stored as a `subkind` refining a compatible
 * stored kind — adjustment_decreasing (ADJ-BD, DL-0257) as taxable, payg_withholding (BAS-W1/W2)
 * as bas_excluded. Everything above the database sees the effective kind coalesce(subkind, kind).
 * The template also carries the BAS label map (design §3.6), loaded with the codes.
 */
import type { BasLabel, Database, TaxCodeKind, TaxCodeSubkind, TaxRounding } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import auTaxCodesV1Json from '../templates/au-tax-codes.v1.json' with { type: 'json' };
import auTaxCodesJson from '../templates/au-tax-codes.json' with { type: 'json' };

/** The kind code sees: the stored kind, refined by the subkind where one is set. */
export type TaxKind = TaxCodeKind | TaxCodeSubkind;

/** Stored (kind, subkind) of each effective kind. */
const STORED_KIND: Readonly<
  Record<TaxKind, { kind: TaxCodeKind; subkind: TaxCodeSubkind | null }>
> = Object.freeze({
  taxable: { kind: 'taxable', subkind: null },
  gst_free: { kind: 'gst_free', subkind: null },
  input_taxed: { kind: 'input_taxed', subkind: null },
  bas_excluded: { kind: 'bas_excluded', subkind: null },
  imports: { kind: 'imports', subkind: null },
  capital: { kind: 'capital', subkind: null },
  adjustment_decreasing: { kind: 'taxable', subkind: 'adjustment_decreasing' },
  payg_withholding: { kind: 'bas_excluded', subkind: 'payg_withholding' },
});

export type BasFlow = 'sales' | 'purchases' | 'any';
export type BasAmount = 'gross' | 'net' | 'tax';
export type BasBasisScope = 'both' | 'accruals' | 'cash';

/** One row of the template's BAS label map (see the template's $basLabelsComment). */
export interface TemplateBasLabel {
  code: string;
  flow: BasFlow;
  label: BasLabel;
  amount: BasAmount;
  positiveSide: 'debit' | 'credit';
  basis: BasBasisScope;
  validFrom: string;
}

export interface TemplateTaxCode {
  code: string;
  name: string;
  kind: TaxKind;
  /** Decimal string, e.g. "0.10" — never a JS number. */
  rate: string;
  collectedRole?: 'GST_COLLECTED' | undefined;
  paidRole?: 'GST_PAID' | undefined;
  validFrom: string;
}

export interface TaxCodeTemplate {
  id: string;
  country: string;
  version: number;
  codes: TemplateTaxCode[];
  /** Absent in a template without a BAS mapping. */
  basLabels?: TemplateBasLabel[];
}

export const auTaxCodes: TaxCodeTemplate = auTaxCodesJson as TaxCodeTemplate;
/** au-gst v1 (T-0034), superseded by v2 (T-0035, T-0121); kept for companies set up with it (DL-0340). */
export const auTaxCodesV1: TaxCodeTemplate = auTaxCodesV1Json as TaxCodeTemplate;

export class TaxCodeNotFoundError extends Error {
  constructor(code: string, on: string) {
    super(`tax code ${code} has no version valid on ${on}`);
    this.name = 'TaxCodeNotFoundError';
  }
}

/** One version of a tax code, with its GST accounts resolved through the system roles. */
export interface TaxCodeVersion {
  id: string;
  code: string;
  name: string;
  kind: TaxKind;
  /** NUMERIC(18,8) text, e.g. "0.10000000". */
  rate: string;
  collectedAccountId: string | null;
  paidAccountId: string | null;
  validFrom: string;
  validTo: string | null;
}

export async function loadTaxCodes(
  trx: Transaction<Database>,
  companyId: string,
  template: TaxCodeTemplate,
): Promise<void> {
  await trx
    .insertInto('app.tax_code')
    .values(
      template.codes.map((c) => ({
        company_id: companyId,
        code: c.code,
        name: c.name,
        kind: STORED_KIND[c.kind].kind,
        subkind: STORED_KIND[c.kind].subkind,
        rate: c.rate,
        collected_role: c.collectedRole ?? null,
        paid_role: c.paidRole ?? null,
        valid_from: c.validFrom,
      })),
    )
    .execute();
  const labels = template.basLabels ?? [];
  if (labels.length > 0) {
    await trx
      .insertInto('app.bas_label_map')
      .values(
        labels.map((l) => ({
          company_id: companyId,
          tax_code: l.code,
          flow: l.flow,
          label: l.label,
          amount: l.amount,
          positive_side: l.positiveSide,
          basis: l.basis,
          valid_from: l.validFrom,
        })),
      )
      .execute();
  }
}

/** The version of `code` valid on `on` (YYYY-MM-DD; valid_to is the last valid day). */
export async function findTaxCode(
  trx: Transaction<Database>,
  q: { companyId: string; code: string; on: string },
): Promise<TaxCodeVersion> {
  const row = await trx
    .selectFrom('app.tax_code as t')
    .leftJoin('app.account_system_role as c', (j) =>
      j
        .onRef('c.tenant_id', '=', 't.tenant_id')
        .onRef('c.company_id', '=', 't.company_id')
        .onRef('c.role', '=', 't.collected_role'),
    )
    .leftJoin('app.account_system_role as p', (j) =>
      j
        .onRef('p.tenant_id', '=', 't.tenant_id')
        .onRef('p.company_id', '=', 't.company_id')
        .onRef('p.role', '=', 't.paid_role'),
    )
    .select([
      't.id',
      't.code',
      't.name',
      sql<TaxKind>`coalesce(t.subkind, t.kind)`.as('kind'),
      't.rate',
      sql<string>`t.valid_from::text`.as('valid_from'),
      sql<string | null>`t.valid_to::text`.as('valid_to'),
      'c.account_id as collected_account_id',
      'p.account_id as paid_account_id',
    ])
    .where('t.company_id', '=', q.companyId)
    .where('t.code', '=', q.code)
    .where('t.valid_from', '<=', q.on)
    .where((eb) => eb.or([eb('t.valid_to', 'is', null), eb('t.valid_to', '>=', q.on)]))
    .executeTakeFirst();
  if (!row) throw new TaxCodeNotFoundError(q.code, q.on);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    rate: row.rate,
    collectedAccountId: row.collected_account_id,
    paidAccountId: row.paid_account_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

export async function getTaxRounding(
  trx: Transaction<Database>,
  companyId: string,
): Promise<TaxRounding> {
  const row = await trx
    .selectFrom('app.company')
    .select('tax_rounding')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  return row.tax_rounding;
}
