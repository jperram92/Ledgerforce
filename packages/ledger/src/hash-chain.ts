/**
 * Hash-chain verifier (design §3.3 invariant 4, ADR-0004 rule 5, ADR-0017, RQ-0016).
 *
 * The database computes each posted entry's hash at commit. This module recomputes it
 * independently from the stored rows, following canonical form v1 exactly as written in
 * RQ-0016 (it shares no code with the SQL), and reports the first broken entry. Dates,
 * timestamps and numerics are read as explicitly formatted text: node-postgres would turn
 * timestamptz into a millisecond Date and date into a local-time Date (RQ-0016, Finding 5).
 */
import type { Database } from '@ledgerforce/db';
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';

export const CANONICAL_VERSION = 'lf-journal-v1';

/** Entry header columns, as text in the canonical renderings (null = SQL NULL). */
export interface ChainEntry {
  id: string;
  tenant_id: string;
  company_id: string;
  chain_seq: string | null;
  prev_hash: string | null;
  hash: string | null;
  entry_no: string | null;
  entry_date: string;
  period_id: string | null;
  source_type: string;
  source_id: string | null;
  reversal_of_id: string | null;
  idempotency_key: string;
  memo: string | null;
  created_by: string | null;
  approved_by: string | null;
  posted_at: string | null;
}

export interface ChainLine {
  line_no: string;
  account_id: string;
  debit: string;
  credit: string;
  txn_currency: string;
  txn_amount: string;
  fx_rate: string;
  tax_code_id: string | null;
  tax_amount: string | null;
  dimension_set_id: string;
  party_id: string | null;
  memo: string | null;
}

export type BreakReason =
  'unchained' | 'sequence_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch';

export type ChainReport =
  | { ok: true; entries: number }
  | {
      ok: false;
      entries: number;
      /** chainSeq as a decimal string (bigint in the database). */
      firstBroken: { chainSeq: string; entryId: string | null; reason: BreakReason };
    };

/** Netstring field: NULL → "~", else "<UTF-8 byte length>:<value>,". */
const field = (v: string | null): string =>
  v === null ? '~' : `${String(Buffer.byteLength(v, 'utf8'))}:${v},`;

/** Canonical form v1 of an entry and its lines (RQ-0016 Conclusion). */
export function canonicalV1(e: ChainEntry, lines: readonly ChainLine[]): string {
  const ordered = [...lines].sort((a, b) => {
    const x = BigInt(a.line_no);
    const y = BigInt(b.line_no);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const header = [
    CANONICAL_VERSION,
    e.tenant_id,
    e.company_id,
    e.id,
    e.chain_seq,
    e.prev_hash,
    e.entry_no,
    e.entry_date,
    e.period_id,
    e.source_type,
    e.source_id,
    e.reversal_of_id,
    e.idempotency_key,
    e.memo,
    e.created_by,
    e.approved_by,
    e.posted_at,
    String(ordered.length),
  ];
  const body = ordered.flatMap((l) => [
    l.line_no,
    l.account_id,
    l.debit,
    l.credit,
    l.txn_currency,
    l.txn_amount,
    l.fx_rate,
    l.tax_code_id,
    l.tax_amount,
    l.dimension_set_id,
    l.party_id,
    l.memo,
  ]);
  return [...header, ...body].map(field).join('');
}

export const hashV1 = (canonical: string): string =>
  createHash('sha256').update(canonical, 'utf8').digest('hex');

/** The company's chained (posted or reversed) entries in chain order, their lines, and the head. */
export async function readChain(
  trx: Transaction<Database>,
  companyId: string,
): Promise<{
  entries: ChainEntry[];
  lines: Map<string, ChainLine[]>;
  head: { last_seq: string; last_hash: string | null } | undefined;
}> {
  const entries = await sql<ChainEntry>`
    SELECT id::text, tenant_id::text, company_id::text, chain_seq::text, prev_hash, hash, entry_no,
           to_char(entry_date, 'YYYY-MM-DD') AS entry_date, period_id::text, source_type, source_id,
           reversal_of_id::text, idempotency_key, memo, created_by::text, approved_by::text,
           to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at
      FROM app.journal_entry e
     WHERE e.company_id = ${companyId} AND e.status IN ('posted', 'reversed')
     -- e.chain_seq, not the output column chain_seq (text): "10" sorts before "2".
     ORDER BY e.chain_seq NULLS LAST, e.id`.execute(trx);
  const lineRows = await sql<ChainLine & { entry_id: string }>`
    SELECT l.entry_id::text, l.line_no::text, l.account_id::text, l.debit::text, l.credit::text,
           l.txn_currency, l.txn_amount::text, l.fx_rate::text, l.tax_code_id::text,
           l.tax_amount::text, l.dimension_set_id::text, l.party_id::text, l.memo
      FROM app.journal_line l
      JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
     WHERE e.company_id = ${companyId} AND e.status IN ('posted', 'reversed')`.execute(trx);
  const lines = new Map<string, ChainLine[]>();
  for (const { entry_id, ...line } of lineRows.rows) {
    const list = lines.get(entry_id) ?? [];
    list.push(line);
    lines.set(entry_id, list);
  }
  const head = await sql<{ last_seq: string; last_hash: string | null }>`
    SELECT last_seq::text, last_hash FROM app.journal_chain_head WHERE company_id = ${companyId}`.execute(
    trx,
  );
  return { entries: entries.rows, lines, head: head.rows[0] };
}

/** Walk the company's chain from seq 1; report the first entry that does not verify. */
export async function verifyChain(
  trx: Transaction<Database>,
  companyId: string,
): Promise<ChainReport> {
  const { entries, lines, head } = await readChain(trx, companyId);
  const broken = (chainSeq: bigint, entryId: string | null, reason: BreakReason): ChainReport => ({
    ok: false,
    entries: entries.length,
    firstBroken: { chainSeq: chainSeq.toString(), entryId, reason },
  });
  let expectedSeq = 1n;
  let prev: string | null = null;
  for (const e of entries) {
    if (e.chain_seq === null || e.hash === null) return broken(expectedSeq, e.id, 'unchained');
    const seq = BigInt(e.chain_seq);
    if (seq !== expectedSeq) return broken(seq, e.id, 'sequence_gap');
    if (e.prev_hash !== prev) return broken(seq, e.id, 'prev_hash_mismatch');
    if (hashV1(canonicalV1(e, lines.get(e.id) ?? [])) !== e.hash) {
      return broken(seq, e.id, 'hash_mismatch');
    }
    prev = e.hash;
    expectedSeq += 1n;
  }
  const lastSeq = expectedSeq - 1n;
  const headSeq = head ? BigInt(head.last_seq) : 0n;
  if (headSeq !== lastSeq || (head?.last_hash ?? null) !== prev) {
    return broken(headSeq > lastSeq ? headSeq : lastSeq, null, 'head_mismatch');
  }
  return { ok: true, entries: entries.length };
}
