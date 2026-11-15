/**
 * Shared request checks of the setup settings routes (T-0176, ADR-0081): uuid and key checks, the
 * company lookup that makes another tenant's company 404, and today in the tenant's time zone.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const bad = (message: string, error = 'invalid_request'): never => {
  throw new BadRequestException({ error, message });
};

export const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);

export const bodyOf = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

/** Every settings write needs an Idempotency-Key (apps/api rules, DL-0642). */
export function requireKey(key: string | undefined): void {
  if (!key || key.length > 200)
    throw new BadRequestException({ error: 'idempotency_key_required' });
}

/** The company row (RLS hides other tenants' companies: they are 404 too). */
export async function companyOf(trx: Transaction<Database>, companyId: string) {
  const c = await trx
    .selectFrom('app.company')
    .select(['id', 'name', 'legal_name', 'abn', 'base_currency'])
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!c) throw new NotFoundException({ error: 'UNKNOWN_COMPANY', message: 'company not found' });
  return c;
}

/** Today in the tenant's report time zone (app.sod_report_timezone, ADR-0026). */
export async function todayIn(trx: Transaction<Database>): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    SELECT to_char(now() AT TIME ZONE app.sod_report_timezone(), 'YYYY-MM-DD') AS d`.execute(trx);
  const d = rows[0]?.d;
  if (!d) throw new Error('no current date');
  return d;
}
