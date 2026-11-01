/**
 * Reversal (void) of a posted entry — T-0032, design §3.3 and principle 2, GP-019, postings.md
 * Q11 (DL-0259).
 *
 * A posted entry is never edited. reverse() posts a new entry (source type ledger_reversal,
 * source_id and reversal_of_id = the original) whose lines mirror the original's — same
 * account, dimension set, party, tax code, currency, amounts and rate, debit and credit
 * swapped — then allocates its AR/AP open items to the original's so both close at zero, and
 * finally marks the original `reversed` through app.journal_mark_reversed(), which re-checks the
 * mirror in the database. All in the caller's tenant transaction; any failure writes nothing.
 *
 * Refused: an entry that is not posted, is already reversed, or is itself a reversal
 * (NOT_REVERSIBLE); a document with allocations — void only when every open item still equals
 * its original amount, otherwise issue a credit note (ALLOCATED, Q11). The period rules of the
 * reversal class apply to the reversal's own date (design §3.5): it is never back-dated.
 */
import { Money } from '@ledgerforce/shared/money';
import { sql } from 'kysely';
import { markReversed } from './journal.ts';
import { storedSourceType } from './period-matrix.ts';
import { PostingError, type PostingCommand, type PostingLineInput } from './posting-command.ts';
import { postReversal, type PostOptions, type PostResult } from './posting-engine.ts';
import { allocate, subledgerEntriesOf } from './subledger.ts';

type Trx = Parameters<typeof postReversal>[0];

export interface ReverseCommand {
  readonly companyId: string;
  /** The posted entry to reverse. */
  readonly entryId: string;
  /** 1..200 characters; unique per company. A repeat returns the first reversal. */
  readonly idempotencyKey: string;
  /** YYYY-MM-DD: the reversal's own date (never the original's locked period). */
  readonly entryDate: string;
  readonly createdBy?: string;
  readonly memo?: string;
  readonly periodOverride?: { readonly reason: string };
}

const REVERSAL = storedSourceType('ledger.reversal');

interface OriginalLine {
  line_no: number;
  account_id: string;
  debit: string;
  credit: string;
  txn_currency: string;
  txn_amount: string;
  fx_rate: string;
  tax_code_id: string | null;
  tax_amount: string | null;
  party_id: string | null;
  memo: string | null;
  value_ids: string[];
}

const zero = (v: string) => Money.of(v, 'XXX').isZero();

export async function reverse(
  trx: Trx,
  c: ReverseCommand,
  opts: PostOptions = {},
): Promise<PostResult> {
  const companyId = c.companyId.toLowerCase();
  const entryId = c.entryId.toLowerCase();

  // One reversal of an entry at a time. lf_app cannot take row locks on the ledger (no UPDATE
  // privilege), so serialise on a transaction advisory lock; a second caller waits, then sees the
  // committed `reversed` status. app.journal_mark_reversed() locks the row itself (definer).
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'lf.reverse:' || current_setting('app.tenant_id', true) || ':' || ${entryId}::text, 0))`.execute(
    trx,
  );
  const original = (
    await sql<{ status: string; source_type: string; entry_no: string | null }>`
      SELECT status, source_type, entry_no FROM app.journal_entry
       WHERE company_id = ${companyId} AND id = ${entryId}`.execute(trx)
  ).rows[0];
  if (!original) {
    throw new PostingError('NOT_REVERSIBLE', `entry ${entryId} is not in company ${companyId}`);
  }
  const keyUsed =
    (
      await sql<{ n: number }>`
        SELECT 1 AS n FROM app.journal_entry
         WHERE company_id = ${companyId} AND idempotency_key = ${c.idempotencyKey}`.execute(trx)
    ).rows.length > 0;

  if (!keyUsed) {
    if (original.source_type === REVERSAL) {
      throw new PostingError(
        'NOT_REVERSIBLE',
        `entry ${original.entry_no ?? entryId} is itself a reversal; post a new document instead`,
      );
    }
    if (original.status !== 'posted') {
      throw new PostingError(
        'NOT_REVERSIBLE',
        `entry ${original.entry_no ?? entryId} is ${original.status}, not posted`,
      );
    }
    for (const item of await subledgerEntriesOf(trx, entryId)) {
      if (!Money.of(item.openAmount, 'XXX').equals(Money.of(item.originalAmount, 'XXX'))) {
        throw new PostingError(
          'ALLOCATED',
          `entry ${original.entry_no ?? entryId} has allocations (open ${item.openAmount} of ` +
            `${item.originalAmount}); issue a credit note instead of voiding (postings.md Q11)`,
        );
      }
    }
  }

  const lines = (
    await sql<OriginalLine>`
      SELECT l.line_no, l.account_id::text, l.debit::text, l.credit::text, l.txn_currency,
             l.txn_amount::text, l.fx_rate::text, l.tax_code_id::text, l.tax_amount::text,
             l.party_id::text, l.memo, ds.value_ids::text[] AS value_ids
        FROM app.journal_line l
        JOIN app.dimension_set ds ON ds.id = l.dimension_set_id
       WHERE l.entry_id = ${entryId}
       ORDER BY l.line_no`.execute(trx)
  ).rows;

  const mirrored: PostingLineInput[] = lines.map((l) => ({
    account: { id: l.account_id },
    ...(zero(l.debit) ? { debit: l.credit } : { credit: l.debit }),
    txnCurrency: l.txn_currency,
    txnAmount: l.txn_amount,
    fxRate: l.fx_rate,
    ...(l.tax_code_id ? { taxCodeId: l.tax_code_id } : {}),
    ...(l.tax_amount !== null ? { taxAmount: l.tax_amount } : {}),
    ...(l.value_ids.length > 0 ? { dimensions: l.value_ids } : {}),
    ...(l.party_id ? { partyId: l.party_id } : {}),
    ...(l.memo !== null ? { memo: l.memo } : {}),
  }));

  const command: PostingCommand = {
    companyId,
    idempotencyKey: c.idempotencyKey,
    entryDate: c.entryDate,
    sourceType: REVERSAL,
    sourceId: entryId,
    memo: c.memo ?? `Reversal of ${original.entry_no ?? entryId}`,
    ...(c.createdBy ? { createdBy: c.createdBy } : {}),
    ...(c.periodOverride ? { periodOverride: c.periodOverride } : {}),
    lines: mirrored,
  };
  const result = await postReversal(trx, command, entryId, opts);
  if (result.replayed) return result;

  // Close the open items: each reversal item is allocated to the original's.
  // Lines are mirrored in order, so the reversal's open item on line n pairs with the original's.
  const originalItems = await subledgerEntriesOf(trx, entryId);
  const reversalItems = await subledgerEntriesOf(trx, result.entryId);
  for (const item of originalItems) {
    const mirror = reversalItems.find((r) => r.lineNo === item.lineNo);
    if (!mirror) {
      throw new PostingError(
        'NOT_REVERSIBLE',
        `no mirrored open item for line ${String(item.lineNo)}`,
      );
    }
    await allocate(trx, {
      companyId,
      idempotencyKey: `reversal:${result.entryId}:${String(item.lineNo)}`,
      fromEntryId: mirror.id,
      toEntryId: item.id,
      amount: Money.of(item.openAmount, 'XXX').abs().toNumericString(),
      allocationDate: result.entryDate,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      memo: `Void of ${original.entry_no ?? entryId}`,
    });
  }
  await markReversed(trx, entryId, result.entryId);
  return result;
}
