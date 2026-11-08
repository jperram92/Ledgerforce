/**
 * Test-only: Avro-encoded Account / Contact / Product2 change events with the documented fixture
 * schemas (RQ-0098; fixtures/documented/pubsub-master-data-change-events.json). The header field
 * lists are real Pub/Sub hex bitmaps computed from field names, so decoding goes through the same
 * `bitmapFieldNames` path as production. Not used in production.
 */
import { readFileSync } from 'node:fs';
import { toSalesforceId18 } from '@ledgerforce/parties';
import { parseEventSchema, type ChangeType, type EventSchema } from '../pubsub/avro.ts';

export type MasterDataEntity = 'Account' | 'Contact' | 'Product2';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/pubsub-master-data-change-events.json', import.meta.url),
    'utf8',
  ),
) as { schemas: Record<MasterDataEntity, { topic: string; schemaId: string; schema: unknown }> };

export const MASTER_DATA_TOPICS: Record<MasterDataEntity, string> = {
  Account: fixture.schemas.Account.topic,
  Contact: fixture.schemas.Contact.topic,
  Product2: fixture.schemas.Product2.topic,
};
export const MASTER_DATA_SCHEMA_IDS: Record<MasterDataEntity, string> = {
  Account: fixture.schemas.Account.schemaId,
  Contact: fixture.schemas.Contact.schemaId,
  Product2: fixture.schemas.Product2.schemaId,
};
export const masterDataSchemaJson = (e: MasterDataEntity): string =>
  JSON.stringify(fixture.schemas[e].schema);

const schemas = new Map<MasterDataEntity, EventSchema>(
  (['Account', 'Contact', 'Product2'] as const).map((e) => [
    e,
    parseEventSchema(masterDataSchemaJson(e)),
  ]),
);

/** A valid 18-character test Id: key prefix + "TEST" + n (15 chars) + checksum suffix. */
export function sfId(prefix: '001' | '003' | '01t', n: number): string {
  return toSalesforceId18(`${prefix}TEST${String(n).padStart(8, '0')}`);
}

/** Hex bitmap entries for field names (inverse of bitmapFieldNames). */
function bitmaps(schema: EventSchema, names: readonly string[]): string[] {
  let top = 0n;
  const children = new Map<number, bigint>();
  for (const name of names) {
    const [parent, child] = name.split('.') as [string, string | undefined];
    const i = schema.fieldNames.indexOf(parent);
    if (i < 0) throw new TypeError(`unknown field ${name}`);
    if (child === undefined) {
      top |= 1n << BigInt(i);
      continue;
    }
    const j = schema.childFieldNames(i).indexOf(child);
    if (j < 0) throw new TypeError(`unknown field ${name}`);
    children.set(i, (children.get(i) ?? 0n) | (1n << BigInt(j)));
  }
  const out: string[] = [];
  if (top > 0n || children.size === 0) out.push(`0x${top.toString(16).toUpperCase()}`);
  for (const [i, bits] of [...children].sort((a, b) => a[0] - b[0])) {
    out.push(`${String(i)}-0x${bits.toString(16).toUpperCase()}`);
  }
  return out;
}

export interface MasterDataChange {
  entity: MasterDataEntity;
  recordIds: string[];
  changeType: ChangeType;
  commitNumber: bigint;
  sequenceNumber?: number;
  /** Body fields; compound fields as nested objects ({ BillingAddress: { City: 'Sydney' } }). */
  fields?: Record<string, unknown>;
  /** Header changedFields as names ('Name', 'BillingAddress.City'). */
  changed?: string[];
  /** Header nulledFields as names. */
  nulled?: string[];
}

/** Encode one change event as the Avro payload Pub/Sub would deliver. */
export function encodeMasterDataChange(c: MasterDataChange): Buffer {
  const schema = schemas.get(c.entity);
  if (!schema) throw new TypeError(`no schema for ${c.entity}`);
  const value: Record<string, unknown> = {
    ChangeEventHeader: {
      entityName: c.entity,
      recordIds: c.recordIds,
      changeType: c.changeType,
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: `tx-${c.commitNumber.toString()}`,
      sequenceNumber: c.sequenceNumber ?? 1,
      commitTimestamp: 1_761_350_000_000n + c.commitNumber,
      commitNumber: c.commitNumber,
      commitUser: '005TEST00000001AAA',
      nulledFields: c.nulled && c.nulled.length > 0 ? bitmaps(schema, c.nulled) : [],
      diffFields: [],
      changedFields: c.changed && c.changed.length > 0 ? bitmaps(schema, c.changed) : [],
    },
  };
  for (const [i, name] of schema.fieldNames.entries()) {
    if (name === 'ChangeEventHeader') continue;
    const v = c.fields?.[name];
    const kids = schema.childFieldNames(i);
    if (kids.length > 0 && v && typeof v === 'object') {
      value[name] = Object.fromEntries(
        kids.map((k) => [k, (v as Record<string, unknown>)[k] ?? null]),
      );
    } else {
      value[name] = v ?? null;
    }
  }
  return schema.type.toBuffer(value);
}

/** The commit timestamp encodeMasterDataChange gives a commit number. */
export const commitTimeOf = (commitNumber: bigint): Date =>
  new Date(Number(1_761_350_000_000n + commitNumber));
