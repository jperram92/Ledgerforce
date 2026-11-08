/**
 * Journal writes that are not plain inserts (ADR-0004 rule 1). The only change to a posted
 * entry is posted → reversed, made by the database function app.journal_mark_reversed() once
 * a posted reversal of the entry exists; lf_app has no UPDATE privilege on the journal.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

/** Mark `entryId` reversed by `reversalId` (a posted entry whose reversal_of_id is entryId). */
export async function markReversed(
  trx: Transaction<Database>,
  entryId: string,
  reversalId: string,
): Promise<void> {
  await sql`SELECT app.journal_mark_reversed(${entryId}, ${reversalId})`.execute(trx);
}
