/**
 * Effective-dated tax codes (design §3.6, migration 0031). Codes are data (design principle 3):
 * a country template ships them and loadTaxCodes() writes them for a company inside the caller's
 * tenant transaction. A rate change is a new row with a later valid_from; the database refuses
 * overlaps and any edit other than closing valid_to (or renaming).
 *
 * Account bindings are by system role (T-0018): a code names GST_COLLECTED / GST_PAID, and the
 * account is resolved through app.account_system_role at the time of use, so re-binding a role
 * moves every code with it.
 */
import type { Database, TaxCodeKind, TaxRounding } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import auTaxCodesJson from '../templates/au-tax-codes.json' with { type: 'json' };

export interface TemplateTaxCode {
  code: string;
  name: string;
  kind: TaxCodeKind;
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
}

export const auTaxCodes: TaxCodeTemplate = auTaxCodesJson as TaxCodeTemplate;

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
  kind: TaxCodeKind;
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
        kind: c.kind,
        rate: c.rate,
        collected_role: c.collectedRole ?? null,
        paid_role: c.paidRole ?? null,
        valid_from: c.validFrom,
      })),
    )
    .execute();
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
      't.kind',
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
