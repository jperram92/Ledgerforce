/**
 * Batcher for the write-back (design §5.4, RQ-0040 F1–F4, ADR-0036). Turns mapped records into
 * sObject Collections requests:
 *  - mirrors (`op: 'upsert'`): one request per object type and ≤ 200 records, matched on the
 *    external ID field; types in first-seen order (the invoice before the payment that refers
 *    to it);
 *  - Salesforce-owned records (`op: 'update'`): ≤ 200 per request, sorted by type so each
 *    request has as few type chunks as possible (Salesforce allows 10);
 *  - each record once per request (Salesforce refuses duplicate keys): repeated records merge,
 *    later fields win;
 *  - `allOrNone: false`: records are independent, every result is read (RQ-0040 F3).
 * The JSON text is built here so money goes out as exact decimal literals (`1375.00`), never
 * through a JavaScript number.
 */
import { MAX_COLLECTION_RECORDS } from './collections.ts';

/** A JSON number written exactly as given (already validated as a decimal literal). */
export class SfNumber {
  readonly literal: string;
  constructor(literal: string) {
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(literal)) {
      throw new TypeError(`not a decimal literal: ${JSON.stringify(literal)}`);
    }
    this.literal = literal;
  }
}

/** A lookup set through the parent's external ID: `"LF_Invoice__r": { "LF_Id__c": "…" }`. */
export class SfReference {
  readonly field: string;
  readonly value: string;
  constructor(field: string, value: string) {
    this.field = field;
    this.value = value;
  }
}

export type SfValue = string | null | SfNumber | SfReference;

export type WriteBackRecord =
  | {
      op: 'upsert';
      sobject: string;
      externalIdField: string;
      key: string;
      fields: Record<string, SfValue>;
    }
  | { op: 'update'; sobject: string; key: string; fields: Record<string, SfValue> };

export interface CollectionRequest {
  /** Relative to `/services/data/vXX.X`. */
  path: string;
  op: 'upsert' | 'update';
  /** Object type and key of each record, in request order (for error reports). */
  records: { sobject: string; key: string }[];
  /** The exact request body. */
  text: string;
  /** The same body, parsed (for inspection and tests). */
  body: { allOrNone: false; records: Record<string, unknown>[] };
}

const value = (v: SfValue): string => {
  if (v instanceof SfNumber) return v.literal;
  if (v instanceof SfReference) return `{${JSON.stringify(v.field)}:${JSON.stringify(v.value)}}`;
  return JSON.stringify(v);
};

function recordJson(r: WriteBackRecord): string {
  const parts = [`"attributes":{"type":${JSON.stringify(r.sobject)}}`];
  parts.push(
    r.op === 'upsert'
      ? `${JSON.stringify(r.externalIdField)}:${JSON.stringify(r.key)}`
      : `"id":${JSON.stringify(r.key)}`,
  );
  for (const [f, v] of Object.entries(r.fields)) parts.push(`${JSON.stringify(f)}:${value(v)}`);
  return `{${parts.join(',')}}`;
}

function request(op: 'upsert' | 'update', path: string, rs: WriteBackRecord[]): CollectionRequest {
  const text = `{"allOrNone":false,"records":[${rs.map(recordJson).join(',')}]}`;
  return {
    path,
    op,
    records: rs.map((r) => ({ sobject: r.sobject, key: r.key })),
    text,
    body: JSON.parse(text) as CollectionRequest['body'],
  };
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_COLLECTION_RECORDS) {
    out.push(items.slice(i, i + MAX_COLLECTION_RECORDS));
  }
  return out;
}

/** Plan the requests for one delivery: upserts first (by type), then updates. */
export function planBatches(records: readonly WriteBackRecord[]): CollectionRequest[] {
  const merged = new Map<string, WriteBackRecord>();
  for (const r of records) {
    const id = `${r.op}|${r.sobject}|${r.op === 'upsert' ? r.externalIdField : 'Id'}|${r.key}`;
    const prev = merged.get(id);
    merged.set(id, prev ? { ...prev, fields: { ...prev.fields, ...r.fields } } : r);
  }
  const all = [...merged.values()];
  const out: CollectionRequest[] = [];

  const upsertGroups = new Map<string, WriteBackRecord[]>();
  for (const r of all) {
    if (r.op !== 'upsert') continue;
    const g = `${r.sobject}/${r.externalIdField}`;
    const group = upsertGroups.get(g) ?? [];
    group.push(r);
    upsertGroups.set(g, group);
  }
  for (const [g, rs] of upsertGroups) {
    for (const c of chunks(rs)) out.push(request('upsert', `/composite/sobjects/${g}`, c));
  }

  const updates = all
    .filter((r) => r.op === 'update')
    .sort((a, b) => (a.sobject < b.sobject ? -1 : a.sobject > b.sobject ? 1 : 0));
  for (const c of chunks(updates)) out.push(request('update', '/composite/sobjects', c));
  return out;
}
