/**
 * BAS label mapping and the tax report query (T-0035, design §3.6, RQ-0102).
 *
 * Each tax code maps to BAS labels through the effective-dated data table app.bas_label_map
 * (migration 0036), loaded from the country template. The report is a query: it reads only the
 * ledger's posted journal lines and subledger allocations, through the read API of
 * packages/ledger (the only package that touches ledger tables), and writes nothing.
 */
import type { BasLabel, Database, GstBasis } from '@ledgerforce/db';
import { allocationReleases, taxedLines, type TaxedLine } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';
import {
  BasReportError,
  cashAttribution,
  computeBas,
  type BasFormat,
  type BasLine,
  type DocumentShare,
} from './bas-compute.ts';
import type { BasAmount, BasBasisScope, BasFlow } from './tax-codes.ts';

export interface BasLabelMapRow {
  taxCode: string;
  flow: BasFlow;
  label: BasLabel;
  amount: BasAmount;
  positiveSide: 'debit' | 'credit';
  basis: BasBasisScope;
  validFrom: string;
  validTo: string | null;
}

interface MapDbRow {
  tax_code: string;
  flow: BasFlow;
  label: BasLabel;
  amount: BasAmount;
  positive_side: 'debit' | 'credit';
  basis: BasBasisScope;
  valid_from: string;
  valid_to: string | null;
}

const toMapRow = (r: MapDbRow): BasLabelMapRow => ({
  taxCode: r.tax_code,
  flow: r.flow,
  label: r.label,
  amount: r.amount,
  positiveSide: r.positive_side,
  basis: r.basis,
  validFrom: r.valid_from,
  validTo: r.valid_to,
});

/** The company's BAS label map rows in effect on `on` (YYYY-MM-DD). */
export async function basLabelMap(
  trx: Transaction<Database>,
  q: { companyId: string; on: string },
): Promise<BasLabelMapRow[]> {
  const rows = await trx
    .selectFrom('app.bas_label_map')
    .select([
      'tax_code',
      'flow',
      'label',
      'amount',
      'positive_side',
      'basis',
      sql<string>`valid_from::text`.as('valid_from'),
      sql<string | null>`valid_to::text`.as('valid_to'),
    ])
    .where('company_id', '=', q.companyId)
    .where('valid_from', '<=', q.on)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', q.on)]))
    .orderBy('tax_code')
    .orderBy('label')
    .execute();
  return rows.map(toMapRow);
}

export interface BasQuery {
  companyId: string;
  from: string;
  to: string;
  basis?: GstBasis;
  format?: BasFormat;
}

export interface BasReport {
  companyId: string;
  from: string;
  to: string;
  basis: GstBasis;
  format: BasFormat;
  /** Cents as "1375.00", signed; every label of the format, in BAS order. */
  labels: Partial<Record<BasLabel, string>>;
}

const GST_ACCOUNT_ROLES = new Set(['GST_COLLECTED', 'GST_PAID']);

/**
 * The BAS for a period (inclusive dates) on the given basis (default: the company setting) and
 * format (default full). Reads only the ledger (taxedLines, allocationReleases), the company's
 * tax codes and its label map; writes nothing. See bas-compute.ts for the rules.
 */
export async function basReport(trx: Transaction<Database>, q: BasQuery): Promise<BasReport> {
  const basis = q.basis ?? (await getGstBasis(trx, q.companyId));
  const format = q.format ?? 'full';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to) || q.from > q.to) {
    throw new BasReportError(`invalid period ${q.from} … ${q.to}`);
  }

  const codes = await trx
    .selectFrom('app.tax_code')
    .select(['id', 'code'])
    .where('company_id', '=', q.companyId)
    .execute();
  const codeOf = new Map(codes.map((c) => [c.id, c.code]));
  const map = await allBasLabelRows(trx, q.companyId);

  const toBasLines = (lines: TaxedLine[]): BasLine[] =>
    lines
      // The GST account line of a document carries no tax amount; its GST is reported through
      // the lines it belongs to.
      .filter((l) => !(l.taxAmount === null && l.systemRoles.some((r) => GST_ACCOUNT_ROLES.has(r))))
      .map((l) => {
        const code = codeOf.get(l.taxCodeId);
        if (code === undefined) {
          throw new BasReportError(
            `entry ${l.entryId} line ${String(l.lineNo)}: tax code ${l.taxCodeId} is not a tax code of the company`,
          );
        }
        return {
          entryId: l.entryId,
          entryDate: l.entryDate,
          accountType: l.accountType,
          debit: l.debit,
          credit: l.credit,
          taxCode: code,
          taxAmount: l.taxAmount,
        };
      });

  const inPeriod = await taxedLines(trx, { companyId: q.companyId, from: q.from, to: q.to });
  let labels;
  if (basis === 'accruals') {
    labels = computeBas({ basis, format, map, lines: toBasLines(inPeriod) });
  } else {
    const immediate = inPeriod.filter((l) => cashAttribution(l.classSourceType) !== 'document');
    const shares = new Map<string, DocumentShare>();
    for (const r of await allocationReleases(trx, q)) {
      if (cashAttribution(r.classSourceType) !== 'document') continue;
      if (cashAttribution(r.counterClassSourceType) !== 'settlement') continue;
      const s = shares.get(r.entryId);
      shares.set(r.entryId, {
        entryId: r.entryId,
        released: s
          ? Money.of(s.released, 'XXX').add(Money.of(r.baseReleased, 'XXX')).toNumericString()
          : r.baseReleased,
        original: r.entryBaseOriginal,
      });
    }
    const docLines = await taxedLines(trx, {
      companyId: q.companyId,
      entryIds: [...shares.keys()],
    });
    const documents = [...shares.values()].map((share) => ({
      share,
      lines: toBasLines(docLines.filter((l) => l.entryId === share.entryId)),
    }));
    labels = computeBas({ basis, format, map, lines: toBasLines(immediate), documents });
  }
  return { companyId: q.companyId, from: q.from, to: q.to, basis, format, labels };
}

/** Every label map row of the company, all versions (the line's date picks the version). */
async function allBasLabelRows(
  trx: Transaction<Database>,
  companyId: string,
): Promise<BasLabelMapRow[]> {
  const rows = await trx
    .selectFrom('app.bas_label_map')
    .select([
      'tax_code',
      'flow',
      'label',
      'amount',
      'positive_side',
      'basis',
      sql<string>`valid_from::text`.as('valid_from'),
      sql<string | null>`valid_to::text`.as('valid_to'),
    ])
    .where('company_id', '=', companyId)
    .execute();
  return rows.map(toMapRow);
}

/** The company's GST accounting basis (design §3.6): accruals (default) or cash. */
export async function getGstBasis(
  trx: Transaction<Database>,
  companyId: string,
): Promise<GstBasis> {
  const row = await trx
    .selectFrom('app.company')
    .select('gst_basis')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  return row.gst_basis;
}
