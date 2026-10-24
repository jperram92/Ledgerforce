/**
 * Duplicate keys for statement lines (RQ-0019, DL-0082). Unique per bank account in the database.
 *  - The bank's own id when given: "id:<id>"; its n-th reuse inside one file "id#n:<id>", so a bank
 *    that reuses an id never makes us drop a genuine line.
 *  - Otherwise "h:" + SHA-256 of date, amount, currency, description and the occurrence number of
 *    that exact combination in the file: two identical coffees on one day are both kept, and the
 *    same file (or an overlapping one) produces the same keys again.
 * The reference is left out on purpose: a re-export may add or drop it.
 */
import { createHash } from 'node:crypto';
import type { StatementLine } from './types.ts';

export function dedupeKeys(lines: readonly StatementLine[]): string[] {
  const seen = new Map<string, number>();
  const occurrence = (key: string): number => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  };
  return lines.map((l) => {
    if (l.bankTxnId !== null) {
      const n = occurrence(JSON.stringify(['id', l.bankTxnId]));
      return n === 1 ? `id:${l.bankTxnId}` : `id#${String(n)}:${l.bankTxnId}`;
    }
    const base = [l.postedOn, l.amount.toNumericString(), l.amount.currency, l.description];
    const n = occurrence(JSON.stringify(['h', ...base]));
    const digest = createHash('sha256')
      .update(JSON.stringify([...base, n]))
      .digest('hex');
    return `h:${digest}`;
  });
}
