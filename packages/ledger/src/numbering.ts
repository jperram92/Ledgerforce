/**
 * Gapless document numbers (design §3.4). The counter is a row per company and series,
 * advanced by app.next_document_number() inside the caller's transaction. The row lock
 * serialises concurrent writers, and a rollback (including a failure at commit) returns the
 * number, so committed documents never leave gaps. Never use a database sequence for these.
 *
 * T-0186 (DL-0713, RQ-0167): defineNumberSeries creates a series or changes its prefix and width
 * while no number has been issued; numberSeriesOf lists series with the next number they issue.
 */
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';

/** Take the next number of `series` for `companyId`, e.g. "INV-000123". */
export async function nextNumber(
  trx: Transaction<Database>,
  companyId: string,
  series: string,
): Promise<string> {
  const r = await sql<{ no: string }>`
    SELECT app.next_document_number(${companyId}, ${series}) AS no`.execute(trx);
  const no = r.rows[0]?.no;
  if (no === undefined) throw new Error(`next_document_number returned nothing for ${series}`);
  return no;
}

export type NumberSeriesErrorCode =
  'INVALID_NUMBER_SERIES' | 'NUMBER_SERIES_IN_USE' | 'UNKNOWN_COMPANY';

/** A number-series definition refused; nothing was written. */
export class NumberSeriesError extends DomainError {
  declare readonly code: NumberSeriesErrorCode;
}

export interface NumberSeriesView {
  readonly code: string;
  readonly prefix: string;
  readonly padWidth: number;
  /** The number the next document will get, e.g. "INV-000001". */
  readonly nextNumber: string;
  /** True once a number has been issued: prefix and width are then fixed (migration 0010). */
  readonly issued: boolean;
  readonly status: 'active' | 'archived';
}

export interface NumberSeriesDefinition {
  readonly companyId: string;
  readonly code: string;
  /** 0–20 of A–Z a–z 0–9 - / _ . (DL-0713). */
  readonly prefix: string;
  /** 1–18 digits. */
  readonly padWidth: number;
}

const SERIES_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const PREFIX = /^[A-Za-z0-9\-/_.]{0,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As app.next_document_number formats it: padded to the width, never truncated. */
const format = (prefix: string, value: string, width: number) =>
  `${prefix}${value.length >= width ? value : value.padStart(width, '0')}`;

interface SeriesRow {
  code: string;
  prefix: string;
  pad_width: number;
  next_value: string;
  status: 'active' | 'archived';
}

const toView = (r: SeriesRow): NumberSeriesView => ({
  code: r.code,
  prefix: r.prefix,
  padWidth: r.pad_width,
  nextNumber: format(r.prefix, r.next_value, r.pad_width),
  issued: r.next_value !== '1',
  status: r.status,
});

const seriesQuery = (trx: Transaction<Database>, companyId: string) =>
  trx
    .selectFrom('app.number_series')
    .select([
      'code',
      'prefix',
      'pad_width',
      sql<string>`next_value::text`.as('next_value'),
      'status',
    ])
    .where('company_id', '=', companyId);

/** The company's series with the given codes (all when omitted), in code order. */
export async function numberSeriesOf(
  trx: Transaction<Database>,
  companyId: string,
  codes?: readonly string[],
): Promise<NumberSeriesView[]> {
  if (!UUID.test(companyId) || codes?.length === 0) return [];
  let q = seriesQuery(trx, companyId);
  if (codes) q = q.where('code', 'in', [...codes]);
  return (await q.orderBy('code').execute()).map(toView);
}

/**
 * Create a series, or change its prefix and width while no number has been issued (design §3.4,
 * DL-0713). The same values again change nothing. An archived series is re-activated. Once a
 * number has been issued, different values are refused with NUMBER_SERIES_IN_USE: the row is
 * locked first, so a concurrent first issue cannot slip past this check (the 0010 guard trigger
 * remains the backstop).
 */
export async function defineNumberSeries(
  trx: Transaction<Database>,
  d: NumberSeriesDefinition,
): Promise<{ series: NumberSeriesView; changed: boolean }> {
  const invalid = (m: string) => new NumberSeriesError('INVALID_NUMBER_SERIES', m);
  if (typeof d.companyId !== 'string' || !UUID.test(d.companyId))
    throw invalid('companyId must be a UUID');
  if (typeof d.code !== 'string' || !SERIES_CODE.test(d.code))
    throw invalid(`${String(d.code)} is not a series code`);
  if (typeof d.prefix !== 'string' || !PREFIX.test(d.prefix))
    throw invalid(
      'the prefix must be up to 20 letters, digits or the characters - / _ . (no spaces)',
    );
  if (!Number.isInteger(d.padWidth) || d.padWidth < 1 || d.padWidth > 18)
    throw invalid('the number of digits must be a whole number from 1 to 18');
  const company = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', d.companyId)
    .executeTakeFirst();
  if (!company) throw new NumberSeriesError('UNKNOWN_COMPANY', 'company not found');

  const inserted = await trx
    .insertInto('app.number_series')
    .values({ company_id: d.companyId, code: d.code, prefix: d.prefix, pad_width: d.padWidth })
    .onConflict((oc) => oc.doNothing())
    .returning(['code'])
    .executeTakeFirst();
  const read = async () =>
    toView(
      await seriesQuery(trx, d.companyId)
        .where('code', '=', d.code)
        .forUpdate()
        .executeTakeFirstOrThrow(),
    );
  const before = await read();
  if (inserted) return { series: before, changed: true };
  const sameShape = before.prefix === d.prefix && before.padWidth === d.padWidth;
  if (sameShape && before.status === 'active') return { series: before, changed: false };
  if (before.issued && !sameShape)
    throw new NumberSeriesError(
      'NUMBER_SERIES_IN_USE',
      `series ${d.code} has already issued numbers (the next is ${before.nextNumber}): its prefix and number of digits can no longer change`,
    );
  await trx
    .updateTable('app.number_series')
    .set({ prefix: d.prefix, pad_width: d.padWidth, status: 'active' })
    .where('company_id', '=', d.companyId)
    .where('code', '=', d.code)
    .execute();
  return { series: await read(), changed: true };
}
