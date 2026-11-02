/**
 * SystemModstamp delta query and polled-row → inbound change (T-0066, design §5.3, RQ-0103).
 *
 * A polled row is a snapshot: the record's current Salesforce-owned values as of its
 * SystemModstamp. It enters the T-0065 mapping as one InboundChange (`snapshot: true`):
 *  - `IsDeleted = true` (queryAll) → DELETE; a live row whose last applied change was a DELETE →
 *    UNDELETE; otherwise an UPDATE naming every mapped field (one path per rule, the first
 *    non-null alternative), so a null clears the optional column it maps to.
 *  - idempotency key: commit number = SystemModstamp in epoch ms; sequence number =
 *    POLL_SEQUENCE_BASE + a hash of the change type and values. CDC sequence numbers are positions
 *    inside one transaction (far below 2^24), so polled keys never meet CDC keys; the same
 *    snapshot read twice is the same key (a logged duplicate); two edits within the same
 *    whole-second stamp differ in values and so in key.
 * Only fields of INBOUND_FIELD_MAP are selected: the poll never reads a LedgerForce-owned field.
 */
import { createHash } from 'node:crypto';
import {
  inboundMapFor,
  type InboundChange,
  type InboundChangeType,
} from '../inbound/inbound-map.ts';
import type { SfRecord } from './query-client.ts';

/** Lowest sequence number of a polled change (CDC transactions stay far below: ≤ 10,000 rows). */
export const POLL_SEQUENCE_BASE = 2 ** 24;
const SEQUENCE_SPAN = 2 ** 31 - 1 - POLL_SEQUENCE_BASE;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** SOQL dateTime literal, whole seconds, UTC (`YYYY-MM-DDThh:mm:ssZ`). */
export function soqlDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function deltaSoql(entity: string, fields: readonly string[], since: Date): string {
  for (const n of [entity, ...fields]) {
    if (!NAME_RE.test(n)) throw new RangeError(`not a Salesforce API name: ${n}`);
  }
  return (
    `SELECT ${['Id', 'SystemModstamp', 'IsDeleted', ...fields].join(', ')} FROM ${entity} ` +
    `WHERE SystemModstamp >= ${soqlDateTime(since)} ORDER BY SystemModstamp, Id`
  );
}

/** Flat Salesforce fields the inbound map reads for `entity`, limited to those the org has. */
export function pollFields(entity: string, available?: ReadonlySet<string>): string[] {
  const map = inboundMapFor(entity);
  if (!map) return [];
  const out: string[] = [];
  for (const rule of map.fields) {
    for (const p of rule.from) {
      if (p.includes('.') || out.includes(p)) continue;
      if (available && !available.has(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/** `2026-10-30T01:02:03.000+0000` → Date. */
export function parseModstamp(v: unknown): Date {
  const text = typeof v === 'string' ? v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '';
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new RangeError(`not a SystemModstamp: ${String(v)}`);
  return new Date(ms);
}

const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function polledChange(
  source: string,
  entity: string,
  row: SfRecord,
  opts: { lastAppliedChangeType?: InboundChangeType | null } = {},
): InboundChange {
  const recordId = row['Id'];
  if (typeof recordId !== 'string') throw new RangeError('polled row without Id');
  const stamp = BigInt(parseModstamp(row['SystemModstamp']).getTime());
  const deleted = row['IsDeleted'] === true;
  const changeType: InboundChangeType = deleted
    ? 'DELETE'
    : opts.lastAppliedChangeType === 'DELETE'
      ? 'UNDELETE'
      : 'UPDATE';
  const fields: Record<string, unknown> = {};
  const changedFields: string[] = [];
  if (!deleted) {
    for (const rule of inboundMapFor(entity)?.fields ?? []) {
      const present = rule.from.filter((p) => !p.includes('.') && p in row);
      const path = present.find((p) => !blank(row[p])) ?? present[0];
      if (path === undefined) continue;
      changedFields.push(path);
      fields[path] = row[path] ?? null;
    }
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([changeType, changedFields.map((p) => [p, fields[p]])]))
    .digest();
  return {
    source,
    entityName: entity,
    recordId,
    changeType,
    commitNumber: stamp,
    sequenceNumber: POLL_SEQUENCE_BASE + (digest.readUInt32BE(0) % SEQUENCE_SPAN),
    transactionKey: '',
    commitTimestamp: stamp,
    changedFields,
    nulledFields: changedFields.filter((p) => blank(fields[p])),
    fields,
    snapshot: true,
  };
}
