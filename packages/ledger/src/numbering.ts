/**
 * Gapless document numbers (design §3.4). The counter is a row per company and series,
 * advanced by app.next_document_number() inside the caller's transaction. The row lock
 * serialises concurrent writers, and a rollback (including a failure at commit) returns the
 * number, so committed documents never leave gaps. Never use a database sequence for these.
 */
import type { Database } from '@ledgerforce/db';
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
