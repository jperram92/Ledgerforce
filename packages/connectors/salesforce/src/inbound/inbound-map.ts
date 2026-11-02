/**
 * Inbound field map and CDC body semantics (T-0065; design §5.5; ADR-0006; RQ-0101).
 *
 * INBOUND_FIELD_MAP is the single list of Salesforce-owned fields LedgerForce reads; the
 * write-back FIELD_MAP (writeback/mapping.ts) is the single list of LedgerForce-owned fields.
 * Together they are field ownership as data: `ownershipClashes()` must stay empty, and a change
 * that touches a LedgerForce-owned field reports it as a conflict and never maps it.
 *
 * Body semantics (RQ-0101): CREATE and UNDELETE carry the record's values; UPDATE changed only the
 * fields in `changedFields` (cleared ones may also be in `nulledFields`) and an empty body value
 * of any other field means "unchanged"; DELETE carries no values. Compound fields are nested
 * (`BillingAddress.City`, `Name.LastName`); a flat name is accepted as a fallback.
 */
import type { DecodedEvent } from '../pubsub/avro.ts';
import { FIELD_MAP } from '../writeback/mapping.ts';

export type InboundTarget = 'party' | 'contact' | 'product';
export type InboundChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';

export interface InboundFieldRule {
  /** Mapping target key (a column or a mapping hook, e.g. `billing.city`, `family`). */
  to: string;
  /** Salesforce paths, first match wins: nested compound path, then flat field. */
  from: readonly string[];
  /** Needed to create the target; clearing it on an update is unmappable. */
  required?: boolean;
}

export interface InboundObjectMap {
  entity: string;
  target: InboundTarget;
  fields: readonly InboundFieldRule[];
}

export const INBOUND_FIELD_MAP: readonly InboundObjectMap[] = Object.freeze([
  {
    entity: 'Account',
    target: 'party',
    fields: [
      { to: 'legal_name', from: ['Name'], required: true },
      { to: 'currency', from: ['CurrencyIsoCode'] },
      { to: 'account_type', from: ['Type'] },
      { to: 'billing.line1', from: ['BillingAddress.Street', 'BillingStreet'] },
      { to: 'billing.city', from: ['BillingAddress.City', 'BillingCity'] },
      {
        to: 'billing.state',
        from: [
          'BillingAddress.StateCode',
          'BillingStateCode',
          'BillingAddress.State',
          'BillingState',
        ],
      },
      { to: 'billing.postcode', from: ['BillingAddress.PostalCode', 'BillingPostalCode'] },
      { to: 'billing.country', from: ['BillingAddress.CountryCode', 'BillingCountryCode'] },
    ],
  },
  {
    entity: 'Contact',
    target: 'contact',
    fields: [
      { to: 'account', from: ['AccountId'], required: true },
      { to: 'first_name', from: ['Name.FirstName', 'FirstName'] },
      { to: 'last_name', from: ['Name.LastName', 'LastName'], required: true },
      { to: 'email', from: ['Email'] },
      { to: 'phone', from: ['Phone'] },
    ],
  },
  {
    entity: 'Product2',
    target: 'product',
    fields: [
      { to: 'name', from: ['Name'], required: true },
      { to: 'sku', from: ['ProductCode'], required: true },
      { to: 'description', from: ['Description'] },
      { to: 'family', from: ['Family'], required: true },
      { to: 'active', from: ['IsActive'] },
    ],
  },
]);

export const inboundMapFor = (entity: string): InboundObjectMap | undefined =>
  INBOUND_FIELD_MAP.find((m) => m.entity === entity);

/** Salesforce fields of `entity` that LedgerForce owns (written by the write-back). */
export function lfOwnedFields(entity: string): ReadonlySet<string> {
  return new Set(
    FIELD_MAP.filter((s) => s.sobject === entity).flatMap((s) => s.fields.map((f) => f.to)),
  );
}

/** `<object>.<field>` owned twice: by both sides, or twice by the write-back. [] = one owner each. */
export function ownershipClashes(): string[] {
  const clashes: string[] = [];
  const outbound = new Set<string>();
  for (const s of FIELD_MAP) {
    for (const f of s.fields) {
      const key = `${s.sobject}.${f.to}`;
      if (outbound.has(key)) clashes.push(key);
      outbound.add(key);
    }
  }
  for (const m of INBOUND_FIELD_MAP) {
    for (const r of m.fields) {
      for (const p of r.from) {
        const key = `${m.entity}.${topField(p)}`;
        if (outbound.has(key)) clashes.push(key);
      }
    }
  }
  return clashes;
}

/** One record's change, from CDC or any other inbound source (polling, reconcile). */
export interface InboundChange {
  /** Channel or source name, e.g. `/data/AccountChangeEvent`, `reconcile`. */
  source: string;
  entityName: string;
  recordId: string;
  changeType: InboundChangeType;
  commitNumber: bigint;
  sequenceNumber: number;
  transactionKey: string;
  /** Epoch milliseconds. */
  commitTimestamp: bigint;
  changedFields: string[];
  nulledFields: string[];
  fields: Record<string, unknown>;
  /**
   * The record's full current state as of `commitTimestamp` (a polled or reconciled row, T-0066),
   * not a CDC diff. Snapshots and CDC changes converge by timestamp (apply.ts, RQ-0103).
   */
  snapshot?: boolean;
}

const CHANGE_TYPES: ReadonlySet<string> = new Set(['CREATE', 'UPDATE', 'DELETE', 'UNDELETE']);

/** One change per record id of a CDC change event (gap, overflow and platform events: none). */
export function inboundChanges(
  source: string,
  e: DecodedEvent,
  recordIds: readonly string[],
): InboundChange[] {
  const h = e.header;
  if (!h || !CHANGE_TYPES.has(h.changeType)) return [];
  return recordIds.map((recordId) => ({
    source,
    entityName: h.entityName,
    recordId,
    changeType: h.changeType as InboundChangeType,
    commitNumber: h.commitNumber,
    sequenceNumber: h.sequenceNumber,
    transactionKey: h.transactionKey,
    commitTimestamp: h.commitTimestamp,
    changedFields: h.changedFields,
    nulledFields: h.nulledFields,
    fields: e.fields,
  }));
}

export type InboundValue = string | boolean | null;

export interface PlannedChange {
  /** False when the entity has no inbound map (nothing to do). */
  mapped: boolean;
  /** Target key → new value (null clears) for the fields this change sets. */
  values: Map<string, InboundValue>;
  /** LedgerForce-owned Salesforce fields this change touched (ignored, reported). */
  conflicts: string[];
  /** Required target keys this change clears (UPDATE) or lacks (CREATE/UNDELETE). */
  missing: string[];
}

const topField = (path: string) => path.split('.')[0] ?? path;

function valueAt(fields: Record<string, unknown>, path: string): unknown {
  let v: unknown = fields;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function normalise(v: unknown): InboundValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

/** What a change sets, per RQ-0101 body semantics; pure. */
export function planChange(c: InboundChange): PlannedChange {
  const map = inboundMapFor(c.entityName);
  if (!map) return { mapped: false, values: new Map(), conflicts: [], missing: [] };
  const changed = new Set(c.changedFields);
  const nulled = new Set(c.nulledFields);
  const touched =
    c.changeType === 'UPDATE'
      ? [...changed, ...nulled].map(topField)
      : c.changeType === 'DELETE'
        ? []
        : Object.keys(c.fields).filter((k) => c.fields[k] !== null && c.fields[k] !== undefined);
  const owned = lfOwnedFields(c.entityName);
  const conflicts = [...new Set(touched.filter((f) => owned.has(f)))];

  const values = new Map<string, InboundValue>();
  const missing: string[] = [];
  for (const rule of map.fields) {
    if (c.changeType === 'DELETE') break;
    if (c.changeType === 'UPDATE') {
      const path = rule.from.find(
        (p) => changed.has(p) || nulled.has(p) || (p.includes('.') && changed.has(topField(p))),
      );
      if (path === undefined) continue;
      const v = nulled.has(path) ? null : normalise(valueAt(c.fields, path));
      values.set(rule.to, v);
      if (rule.required && v === null) missing.push(rule.to);
    } else {
      const v = rule.from.map((p) => normalise(valueAt(c.fields, p))).find((x) => x !== null);
      if (v !== undefined) values.set(rule.to, v);
      else if (rule.required) missing.push(rule.to);
    }
  }
  return { mapped: true, values, conflicts, missing };
}
