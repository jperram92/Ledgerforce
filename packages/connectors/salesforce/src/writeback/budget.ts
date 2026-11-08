/**
 * The API budget share of a Salesforce connection (design §5.6 rule 3, T-0071, migration 0030):
 * the share of the org's daily API allocation the write-back may use, stored on the connection
 * (NUMERIC(5,4), default 0.2500). Read and written as exact decimal text, never a float.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { SalesforceConnectionNotFound } from '../connection-store.ts';
import { shareBasisPoints } from './collections.ts';

/** The connection's share as `0.2500`-style text. */
export async function getApiBudgetShare(
  trx: Transaction<Database>,
  connectionId: string,
): Promise<string> {
  const { rows } = await sql<{ share: string }>`
    SELECT api_budget_share::text AS share FROM app.salesforce_connection
     WHERE id = ${connectionId}`.execute(trx);
  const share = rows[0]?.share;
  if (share === undefined) throw new SalesforceConnectionNotFound();
  return share;
}

/** Set the share: in (0, 1], at most four decimals (the database checks the range again). */
export async function setApiBudgetShare(
  trx: Transaction<Database>,
  connectionId: string,
  share: string,
): Promise<void> {
  const bp = shareBasisPoints(share);
  const text = `${String(Math.trunc(bp / 10_000))}.${String(bp % 10_000).padStart(4, '0')}`;
  const r = await sql`
    UPDATE app.salesforce_connection SET api_budget_share = ${text}::numeric
     WHERE id = ${connectionId}`.execute(trx);
  if (Number(r.numAffectedRows ?? 0n) === 0) throw new SalesforceConnectionNotFound();
}
