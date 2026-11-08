/**
 * Reversal (void) of a posted entry (T-0032, design §3.3 principle 2, ADR-0004 rule 1, GP-019).
 *
 * A posted entry is never edited. reverse() posts a new entry through the posting engine:
 *   - source type ledger_reversal, source_id and reversal_of_id = the original entry;
 *   - every line of the original with debit and credit swapped, and the same account, tax code,
 *     tax amount (unsigned — the side carries the direction; RQ-0095 F5), party, dimension set,
 *     currency, transaction amount, rate and memo;
 *   - dated as requested, under the period matrix for the reversal class (an override under any
 *     lock, never into a hard-locked period) and the tenant lock-date policy (design §3.5);
 * and, in the same savepoint, marks the original posted → reversed (app.journal_mark_reversed,
 * which refuses unless the lines mirror exactly) and closes every open item of the original by
 * allocating the reversal's mirrored item against it (GP-019 subledger: both open 0.00).
 *
 * Void rules (RQ-0095 Q11, GP-019 Tax/BAS; DL-0270):
 *   - no allocations: every open item of the original is still fully open (open = original);
 *   - same BAS period: for an entry that carries a tax code or an open item, the reversal must
 *     fall in the original's fiscal period. Periods are calendar months, and a month never
 *     spans two BAS periods (monthly, quarterly or annual), so the check is conservative until
 *     the company's BAS frequency exists (design §4.1 step 3). A later cancellation is a credit
 *     note (GP-005 mechanics with an adjustment note).
 * Both refusals name the credit note. Nothing is written when anything is refused.
 *
 * previewReversal() returns the journal reverse() would write and writes nothing (design §3.9).
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { sql, type Transaction } from 'kysely';
import { PostingError, type PostingErrorCode, type PostingLineInput } from './posting-command.ts';
import {
  postReversal,
  previewReversalPlan,
  type BuiltEntry,
  type PostOptions,
  type PostResult,
  type ReversalHead,
  type ReversalPlan,
} from './posting-engine.ts';
import { allocate, subledgerEntriesOf } from './subledger.ts';

type Trx = Transaction<Database>;

/** The stored source type of every reversal (golden `ledger.reversal`). */
export const REVERSAL_SOURCE_TYPE = 'ledger_reversal';

export interface ReversalCommand {
  readonly companyId: string;
  /** 1..200 characters; unique per company. A repeat returns the first reversal. */
  readonly idempotencyKey: string;
  /** The posted entry to reverse. */
  readonly entryId: string;
  /** YYYY-MM-DD, not before the original. The lock-date policy may move it forward. */
  readonly entryDate: string;
  /** Why it is reversed; appended to the reversal's memo. */
  readonly memo?: string;
  readonly createdBy?: string;
  readonly approvedBy?: string;
  /** Reverse into a period whose cell is "override"; createdBy must hold period.lock.override. */
  readonly periodOverride?: { readonly reason: string };
}

export interface ReversalResult extends PostResult {
  /** The entry this reversal reverses (now status reversed). */
  reversalOfId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const X = 'XXX';

function fail(code: PostingErrorCode, message: string): never {
  throw new PostingError(code, message);
}

interface OriginalRow {
  id: string;
  entry_no: string | null;
  entry_date: string;
  period_id: string | null;
  source_type: string;
  status: string;
  reversal_of_id: string | null;
  base_currency: string;
}

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
  value_ids: string[];
  party_id: string | null;
  memo: string | null;
}

function checkHead(c: ReversalCommand): ReversalHead {
  if (typeof c.entryId !== 'string' || !UUID_RE.test(c.entryId)) {
    fail('INVALID_COMMAND', `entryId ${JSON.stringify(c.entryId)} is not a uuid`);
  }
  if (typeof c.companyId !== 'string' || !UUID_RE.test(c.companyId)) {
    fail('INVALID_COMMAND', `companyId ${JSON.stringify(c.companyId)} is not a uuid`);
  }
  const key: unknown = c.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    fail('INVALID_COMMAND', 'idempotencyKey must be 1..200 characters');
  }
  if (typeof c.entryDate !== 'string' || !DATE_RE.test(c.entryDate)) {
    fail('INVALID_COMMAND', `entryDate ${JSON.stringify(c.entryDate)} is not a YYYY-MM-DD date`);
  }
  return {
    companyId: c.companyId.toLowerCase(),
    idempotencyKey: c.idempotencyKey,
    sourceType: REVERSAL_SOURCE_TYPE,
    sourceId: c.entryId.toLowerCase(),
  };
}

/** Serialises reversals of one entry, and (via the open-item keys) allocations against it. */
async function lockOriginal(trx: Trx, companyId: string, entryId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'lf.reversal:' || current_setting('app.tenant_id', true) || ':' || ${companyId}::text
        || ':' || ${entryId}::text, 0))`.execute(trx);
}

/** The same advisory keys allocate() takes (subledger.ts), in id order. */
async function lockOpenItems(trx: Trx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('lf.open_item:' || ${id}::text, 0))`.execute(
      trx,
    );
  }
}

async function planReversal(
  trx: Trx,
  c: ReversalCommand,
  head: ReversalHead,
  opts: { lock: boolean },
): Promise<ReversalPlan> {
  const { companyId, sourceId: entryId } = head;
  if (opts.lock) await lockOriginal(trx, companyId, entryId);

  const o = (
    await sql<OriginalRow>`
      SELECT e.id::text, e.entry_no, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
             e.period_id::text, e.source_type, e.status, e.reversal_of_id::text,
             c.base_currency
        FROM app.journal_entry e
        JOIN app.company c ON c.tenant_id = e.tenant_id AND c.id = e.company_id
       WHERE e.company_id = ${companyId} AND e.id = ${entryId}`.execute(trx)
  ).rows[0];
  if (!o) fail('UNKNOWN_ENTRY', `no journal entry ${entryId} in company ${companyId}`);
  const name = o.entry_no ?? o.id;
  if (o.reversal_of_id !== null || o.source_type === REVERSAL_SOURCE_TYPE) {
    fail(
      'REVERSAL_OF_REVERSAL',
      `entry ${name} is itself a reversal (of ${String(o.reversal_of_id)}); post the document again instead`,
    );
  }
  if (o.status === 'reversed') fail('ALREADY_REVERSED', `entry ${name} is already reversed`);
  if (o.status !== 'posted') fail('NOT_POSTED', `entry ${name} is ${o.status}, not posted`);
  if (c.entryDate < o.entry_date) {
    fail(
      'REVERSAL_BEFORE_ORIGINAL',
      `a reversal dated ${c.entryDate} cannot precede entry ${name} (${o.entry_date})`,
    );
  }

  const items = await subledgerEntriesOf(trx, entryId);
  if (opts.lock)
    await lockOpenItems(
      trx,
      items.map((i) => i.id),
    );
  const allocated = items.find(
    (i) =>
      !Money.of(i.openAmount, X).equals(Money.of(i.originalAmount, X)) ||
      !Money.of(i.baseOpenAmount, X).equals(Money.of(i.baseOriginalAmount, X)),
  );
  if (allocated !== undefined) {
    fail(
      'VOID_HAS_ALLOCATIONS',
      `entry ${name} cannot be voided: its open item (line ${String(allocated.lineNo)}) has ` +
        `allocations (open ${allocated.openAmount} of ${allocated.originalAmount}). ` +
        'Issue a credit note instead (RQ-0095 Q11).',
    );
  }

  const lines = (
    await sql<OriginalLine>`
      SELECT l.line_no, l.account_id::text, l.debit::text, l.credit::text, l.txn_currency,
             l.txn_amount::text, l.fx_rate::text, l.tax_code_id::text, l.tax_amount::text,
             ds.value_ids::text[] AS value_ids, l.party_id::text, l.memo
        FROM app.journal_line l
        JOIN app.dimension_set ds ON ds.tenant_id = l.tenant_id AND ds.id = l.dimension_set_id
       WHERE l.company_id = ${companyId} AND l.entry_id = ${entryId}
       ORDER BY l.line_no`.execute(trx)
  ).rows;

  const mirrored = lines.map((l): PostingLineInput => {
    const isDebit = !Money.of(l.debit, X).isZero();
    const base = isDebit ? l.debit : l.credit;
    return {
      account: { id: l.account_id },
      ...(isDebit ? { credit: base } : { debit: base }),
      ...(l.txn_currency === o.base_currency
        ? {}
        : { txnCurrency: l.txn_currency, txnAmount: l.txn_amount, fxRate: l.fx_rate }),
      ...(l.tax_code_id === null ? {} : { taxCodeId: l.tax_code_id }),
      ...(l.tax_amount === null ? {} : { taxAmount: l.tax_amount }),
      ...(l.value_ids.length === 0 ? {} : { dimensions: l.value_ids }),
      ...(l.party_id === null ? {} : { partyId: l.party_id }),
      ...(l.memo === null ? {} : { memo: l.memo }),
    };
  });
  // Q11 applies to what reaches the BAS or the subledger: a tax-coded line or an open item.
  const sameBasPeriod = items.length > 0 || lines.some((l) => l.tax_code_id !== null);

  return {
    command: {
      companyId,
      idempotencyKey: c.idempotencyKey,
      entryDate: c.entryDate,
      sourceType: REVERSAL_SOURCE_TYPE,
      sourceId: entryId,
      memo: c.memo ? `Reversal of ${name}: ${c.memo}` : `Reversal of ${name}`,
      ...(c.createdBy === undefined ? {} : { createdBy: c.createdBy }),
      ...(c.approvedBy === undefined ? {} : { approvedBy: c.approvedBy }),
      ...(c.periodOverride === undefined ? {} : { periodOverride: c.periodOverride }),
      lines: mirrored,
    },
    reversalOfId: entryId,
    originalSourceType: o.source_type,
    checkBuilt(built: BuiltEntry) {
      if (sameBasPeriod && built.periodId !== o.period_id) {
        fail(
          'VOID_OTHER_PERIOD',
          `entry ${name} (${o.entry_date}) cannot be voided on ${built.entryDate}: a void must ` +
            'fall in the same BAS period as the original. Issue a credit note instead ' +
            '(adjustment note; RQ-0095 Q11).',
        );
      }
    },
    async afterWrite(t, written) {
      if (items.length === 0) return;
      const reversed = new Map(
        (await subledgerEntriesOf(t, written.entryId)).map((i) => [i.lineNo, i]),
      );
      for (const item of items) {
        const mirror = reversed.get(item.lineNo);
        if (!mirror)
          throw new Error(`reversal: no mirrored open item for line ${String(item.lineNo)}`);
        await allocate(t, {
          companyId,
          idempotencyKey: `lf.void:${written.entryId}:${String(item.lineNo)}`,
          fromEntryId: item.id,
          toEntryId: mirror.id,
          amount: Money.of(item.openAmount, X).abs().toNumericString(),
          allocationDate: written.entryDate,
          ...(c.createdBy === undefined ? {} : { createdBy: c.createdBy }),
          memo: `Void of ${name}`,
        });
      }
    },
  };
}

/**
 * Reverse (void) a posted entry. Call inside a Read Committed tenant transaction (withTenant).
 * A repeat of the key returns the first reversal (`replayed: true`) and writes nothing.
 */
export async function reverse(
  trx: Trx,
  c: ReversalCommand,
  opts: PostOptions = {},
): Promise<ReversalResult> {
  const head = checkHead(c);
  const r = await postReversal(trx, head, () => planReversal(trx, c, head, { lock: true }), opts);
  return { ...r, reversalOfId: head.sourceId };
}

/** The journal reverse() would write, or the error it would throw. Reads only; takes no lock. */
export async function previewReversal(trx: Trx, c: ReversalCommand): Promise<BuiltEntry> {
  const head = checkHead(c);
  return previewReversalPlan(trx, head, () => planReversal(trx, c, head, { lock: false }));
}
