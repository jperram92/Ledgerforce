/**
 * Inbound changes (T-0065, design §5.5, §5.6 rule 1; RQ-0098). A change is one record's patch of
 * Salesforce-owned field values plus a version that orders it against every other change of that
 * record, whatever the path: a CDC event (commit number + sequence number) or a polled snapshot
 * (SystemModstamp, T-0066 / T-0070 reconcile).
 *
 * CDC UPDATE bodies carry only what changed; a null that the header does not name means
 * "unchanged" (RQ-0098 F1), so the patch is built from the header's changedFields/nulledFields,
 * never from null-ness. Compound fields are flattened to "Parent.Child" keys.
 */
import { changeKind, type DecodedEvent } from '../pubsub/avro.ts';

export type InboundEntity = 'Account' | 'Contact' | 'Product2';
export const INBOUND_ENTITIES: readonly InboundEntity[] = ['Account', 'Contact', 'Product2'];

/** Flat Salesforce field state: 'Name', 'BillingAddress.City' → string | boolean | null. */
export type SfState = Record<string, unknown>;

export interface RecordVersion {
  /** CDC commit number; null for a polled snapshot. */
  commitNumber: bigint | null;
  /** CDC sequence number within the transaction; 0 for a polled snapshot. */
  sequenceNumber: number;
  /** CDC commit timestamp or the record's SystemModstamp. */
  at: Date;
}

export interface InboundChange {
  entity: InboundEntity;
  /** Salesforce record Id as delivered (validated when applied). */
  recordId: string;
  op: 'upsert' | 'delete' | 'undelete';
  /** The patch: only keys present are written; null clears. */
  fields: SfState;
  version: RecordVersion;
  /** Idempotency key (design §5.6 rule 1), as the T-0064 inbox writes it for CDC. */
  key: string;
}

const isEntity = (e: string): e is InboundEntity => (INBOUND_ENTITIES as string[]).includes(e);

/** JSON-safe leaf value: Avro longs (BigInt) become decimal strings. */
const leaf = (v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : (v ?? null));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);

/** Every non-null field of a body, compound components as Parent.Child. */
function nonNullFields(body: Record<string, unknown>): SfState {
  const out: SfState = {};
  for (const [name, v] of Object.entries(body)) {
    if (isRecord(v)) {
      for (const [child, cv] of Object.entries(v)) {
        if (cv !== null && cv !== undefined) out[`${name}.${child}`] = leaf(cv);
      }
    } else if (v !== null && v !== undefined) {
      out[name] = leaf(v);
    }
  }
  return out;
}

function valueAt(body: Record<string, unknown>, path: string): unknown {
  const [parent, child] = path.split('.') as [string, string | undefined];
  const v = body[parent];
  if (child === undefined) return v;
  return isRecord(v) ? v[child] : null;
}

/** The patch of an UPDATE: header-named fields only (RQ-0098 F1–F2). */
function namedFields(body: Record<string, unknown>, changed: string[], nulled: string[]): SfState {
  const out: SfState = {};
  for (const name of changed) {
    const v = valueAt(body, name);
    if (!name.includes('.') && isRecord(v)) Object.assign(out, nonNullFields({ [name]: v }));
    else out[name] = leaf(v);
  }
  for (const name of nulled) out[name] = null;
  return out;
}

/**
 * One change per record of a CDC change event. `recordIds` are the event's records the subscriber
 * has not applied before (T-0064 inbox). Gap and overflow events, platform events and entities
 * this mapper does not own give no changes.
 */
export function changesFromCdcEvent(
  e: DecodedEvent,
  recordIds: readonly string[],
): InboundChange[] {
  const h = e.header;
  if (!h || changeKind(e) !== 'change' || !isEntity(h.entityName)) return [];
  const entity = h.entityName;
  let op: InboundChange['op'];
  let fields: SfState;
  switch (h.changeType) {
    case 'CREATE':
      op = 'upsert';
      fields = nonNullFields(e.fields);
      break;
    case 'UPDATE':
      op = 'upsert';
      fields = namedFields(e.fields, h.changedFields, h.nulledFields);
      break;
    case 'DELETE':
      op = 'delete';
      fields = {};
      break;
    case 'UNDELETE':
      op = 'undelete';
      fields = nonNullFields(e.fields);
      break;
    default:
      return [];
  }
  const version: RecordVersion = {
    commitNumber: h.commitNumber,
    sequenceNumber: h.sequenceNumber,
    at: new Date(Number(h.commitTimestamp)),
  };
  return h.recordIds
    .filter((id) => recordIds.includes(id))
    .map((recordId) => ({
      entity,
      recordId,
      op,
      fields: { ...fields },
      version,
      key: `cdc:${entity}:${recordId}:${h.commitNumber.toString()}:${String(h.sequenceNumber)}`,
    }));
}

/**
 * A polled full record (SystemModstamp delta query or a reconcile re-read): every field the query
 * selected, nulls included, keyed on the record Id + SystemModstamp (design §5.6 rule 1).
 */
export function changeFromSnapshot(
  entity: InboundEntity,
  recordId: string,
  fields: SfState,
  systemModstamp: Date,
): InboundChange {
  return {
    entity,
    recordId,
    op: 'upsert',
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, leaf(v)])),
    version: { commitNumber: null, sequenceNumber: 0, at: systemModstamp },
    key: `poll:${entity}:${recordId}:${systemModstamp.toISOString()}`,
  };
}

/**
 * Order of `a` against `b`: two CDC versions by (commit number, sequence number) — commit numbers
 * increase system-wide (RQ-0098 F3); anything involving a polled snapshot by time.
 */
export function compareVersion(a: RecordVersion, b: RecordVersion): 'newer' | 'same' | 'older' {
  if (a.commitNumber !== null && b.commitNumber !== null) {
    if (a.commitNumber !== b.commitNumber)
      return a.commitNumber > b.commitNumber ? 'newer' : 'older';
    if (a.sequenceNumber !== b.sequenceNumber)
      return a.sequenceNumber > b.sequenceNumber ? 'newer' : 'older';
    return 'same';
  }
  const d = a.at.getTime() - b.at.getTime();
  return d === 0 ? 'same' : d > 0 ? 'newer' : 'older';
}

/** The state after a patch; a nulled compound parent clears all of its components. */
export function mergeState(state: SfState, patch: SfState): SfState {
  const out = new Map(Object.entries(state));
  for (const [k, v] of Object.entries(patch)) {
    const components = [...out.keys()].filter((key) => key.startsWith(`${k}.`));
    if (!k.includes('.') && v === null && components.length > 0) {
      for (const key of components) out.delete(key);
      continue;
    }
    out.set(k, v);
  }
  return Object.fromEntries(out);
}
