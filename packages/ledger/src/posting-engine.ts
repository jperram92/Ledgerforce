/**
 * Posting engine pipeline (design §3.9, packages/ledger/AGENTS.md, T-0025): the single write
 * path to the journal.
 *
 *   1. command  — checkCommand(): pure checks, incl. ≤ 4/8 decimals and balance, before any SQL
 *   2. idempotency — advisory lock on the key, then replay the first result if it exists (RQ-0030)
 *   3. validate + resolve — company, accounts by system role or id (active, postable, currency,
 *      control accounts only from their subledger), party, dimensions (required ones present),
 *      number series, period for the source type (resolvePostingDate, tenant lock-date policy)
 *   4. build    — journal lines as they will be stored (no tax, FX or posting rules here)
 *   5. check    — balance and line invariants again on the built lines, in memory
 *   6. write    — one savepoint in the caller's transaction: period override (if any), gapless
 *      entry number, entry, dimension sets, lines, outbox hook. Any failure rolls the savepoint
 *      back, so nothing is written.
 * preview() runs 1, 3, 4, 5 and writes nothing.
 *
 * Not here yet: subledger entries (AR/AP tasks), account_balance (T-0027), the real outbox
 * (T-0030 — PostingOutbox is the hook), approvals, event posting rules (golden postings Draft).
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import type { PostingCommand } from './posting-command.ts';

type Trx = Transaction<Database>;

export interface BuiltLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  debit: string;
  credit: string;
  txnCurrency: string;
  txnAmount: string;
  fxRate: string;
  taxCodeId: string | null;
  taxAmount: string | null;
  dimensionValueIds: string[];
  partyId: string | null;
  memo: string | null;
}

export interface BuiltEntry {
  companyId: string;
  baseCurrency: string;
  /** The date the entry gets (after the lock-date policy). */
  entryDate: string;
  requestedDate: string;
  periodId: string;
  redirected: boolean;
  needsOverride: boolean;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  numberSeries: string;
  lines: BuiltLine[];
  total: string;
}

export interface PostResult {
  entryId: string;
  entryNo: string;
  entryDate: string;
  periodId: string;
  memo: string | null;
  /** True when the key had already posted and this is the first result again. */
  replayed: boolean;
}

/** What T-0030's outbox will receive for every posted entry, inside the posting transaction. */
export interface PostedEvent {
  companyId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string;
}

/** Hook for the transactional outbox (T-0030). Runs inside the write; a throw undoes the post. */
export interface PostingOutbox {
  enqueue(trx: Trx, event: PostedEvent): Promise<void>;
}

/** Until T-0030: no outbox row is written. */
export const NO_OUTBOX: PostingOutbox = Object.freeze({
  enqueue: async () => {},
});

export interface PostOptions {
  outbox?: PostingOutbox;
}

/** Steps 1–5 only: the journal the command would post. Reads, never writes. */
export async function preview(trx: Trx, command: PostingCommand): Promise<BuiltEntry> {
  void trx;
  void command;
  throw new Error('not implemented: T-0025 preview');
}

/** Post a command (idempotent per company and key). Call inside a Read Committed tenant transaction. */
export async function post(
  trx: Trx,
  command: PostingCommand,
  opts: PostOptions = {},
): Promise<PostResult> {
  void trx;
  void command;
  void opts;
  throw new Error('not implemented: T-0025 post');
}
