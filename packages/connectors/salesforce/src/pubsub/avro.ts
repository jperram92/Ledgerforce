/**
 * Avro decoding of Pub/Sub events (RQ-0036 F5, F6; ADR-0032). The payload is Avro binary for the
 * writer schema named by `schema_id` (from GetSchema). Avro longs decode as BigInt so commit
 * numbers and timestamps stay exact; CDC field bitmaps expand to field names; gap and overflow
 * events are told apart from changes; every event gets idempotency keys (design §5.6 rule 1).
 */
import avro from 'avsc';
import type { ConsumerEventMessage } from './proto.ts';

const LongAsBigInt = avro.types.LongType.__with({
  fromBuffer: (buf: Buffer) => buf.readBigInt64LE(),
  toBuffer: (n: bigint) => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(n);
    return buf;
  },
  fromJSON: (v: unknown) => BigInt(v as string),
  toJSON: (n: bigint) => n.toString(),
  isValid: (n: unknown) => typeof n === 'bigint',
  compare: (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1),
});

export interface EventSchema {
  type: avro.Type;
  /** Top-level field names in schema order (bit i of a CDC bitmap names field i). */
  fieldNames: string[];
  /** Child field names of the record branch of top-level field i (compound fields). */
  childFieldNames: (index: number) => string[];
}

export function parseEventSchema(schemaJson: string): EventSchema {
  const type = avro.Type.forSchema(JSON.parse(schemaJson) as avro.Schema, {
    registry: { long: LongAsBigInt },
  });
  if (!(type instanceof avro.types.RecordType)) {
    throw new TypeError('pubsub: event schema must be an Avro record');
  }
  const fields = type.fields;
  return {
    type,
    fieldNames: fields.map((f) => f.name),
    childFieldNames: (index) => {
      const t = fields[index]?.type;
      const branches: avro.Type[] =
        t instanceof avro.types.UnwrappedUnionType || t instanceof avro.types.WrappedUnionType
          ? t.types
          : t
            ? [t]
            : [];
      return branches.flatMap((b) =>
        b instanceof avro.types.RecordType ? b.fields.map((f) => f.name) : [],
      );
    },
  };
}

export type ChangeType =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'UNDELETE'
  | 'GAP_CREATE'
  | 'GAP_UPDATE'
  | 'GAP_DELETE'
  | 'GAP_UNDELETE'
  | 'GAP_OVERFLOW'
  | 'SNAPSHOT';

export interface ChangeEventHeader {
  entityName: string;
  recordIds: string[];
  changeType: ChangeType;
  changeOrigin: string;
  transactionKey: string;
  sequenceNumber: number;
  commitTimestamp: bigint;
  commitNumber: bigint;
  commitUser: string;
  /** Field names, expanded from the hex bitmaps of the payload. */
  changedFields: string[];
  nulledFields: string[];
  diffFields: string[];
}

export interface DecodedEvent {
  /** Opaque Pub/Sub replay id (never interpreted). */
  replayId: Buffer;
  /** ProducerEvent id: the event uuid. */
  eventId: string;
  schemaId: string;
  /** Present for change events (CDC); null for platform events. */
  header: ChangeEventHeader | null;
  /** Record fields (everything except ChangeEventHeader); Avro longs are BigInt. */
  fields: Record<string, unknown>;
}

const HEX = /^0x[0-9A-Fa-f]+$/;

/** Names of the fields whose bit is set; bit 0 is the last hex digit's lowest bit. */
function namesFromHex(names: readonly string[], hex: string): string[] {
  if (!HEX.test(hex)) throw new TypeError(`pubsub: invalid field bitmap ${JSON.stringify(hex)}`);
  const bits = BigInt(hex);
  return names.filter((_, i) => (bits >> BigInt(i)) & 1n);
}

/**
 * Expand CDC field bitmaps (RQ-0036 S2): the first entry ("0x..") covers top-level fields; an
 * entry "<i>-0x.." covers the children of compound field i, named "<parent>.<child>".
 */
export function bitmapFieldNames(
  fieldNames: readonly string[],
  bitmaps: readonly string[],
  childFieldNames: (index: number) => string[],
): string[] {
  const out: string[] = [];
  for (const entry of bitmaps) {
    const dash = entry.indexOf('-');
    if (dash < 0) {
      out.push(...namesFromHex(fieldNames, entry));
      continue;
    }
    const index = Number(entry.slice(0, dash));
    const parent = fieldNames[index];
    if (!/^\d+$/.test(entry.slice(0, dash)) || parent === undefined) {
      throw new TypeError(`pubsub: invalid compound field bitmap ${JSON.stringify(entry)}`);
    }
    out.push(
      ...namesFromHex(childFieldNames(index), entry.slice(dash + 1)).map((c) => `${parent}.${c}`),
    );
  }
  return out;
}

type RawHeader = Omit<ChangeEventHeader, 'changedFields' | 'nulledFields' | 'diffFields'> & {
  changedFields?: string[];
  nulledFields?: string[];
  diffFields?: string[];
};

/** Decode one ConsumerEvent with its writer schema. Throws if the bytes do not fit the schema. */
export function decodeConsumerEvent(
  schema: EventSchema,
  consumer: Pick<ConsumerEventMessage, 'replayId'> & {
    event: { id: string; schemaId: string; payload: Buffer } | null;
  },
): DecodedEvent {
  if (!consumer.event) throw new TypeError('pubsub: consumer event without an event');
  const record = schema.type.fromBuffer(consumer.event.payload) as Record<string, unknown>;
  const { ChangeEventHeader: rawHeader, ...rest } = record;
  const fields = Object.fromEntries(Object.entries(rest));
  let header: ChangeEventHeader | null = null;
  if (rawHeader && typeof rawHeader === 'object') {
    const h = rawHeader as RawHeader;
    const expand = (b: string[] | undefined) =>
      bitmapFieldNames(schema.fieldNames, b ?? [], schema.childFieldNames);
    header = {
      entityName: h.entityName,
      recordIds: [...h.recordIds],
      changeType: h.changeType,
      changeOrigin: h.changeOrigin,
      transactionKey: h.transactionKey,
      sequenceNumber: h.sequenceNumber,
      commitTimestamp: h.commitTimestamp,
      commitNumber: h.commitNumber,
      commitUser: h.commitUser,
      changedFields: expand(h.changedFields),
      nulledFields: expand(h.nulledFields),
      diffFields: expand(h.diffFields),
    };
  }
  return {
    replayId: Buffer.from(consumer.replayId),
    eventId: consumer.event.id,
    schemaId: consumer.event.schemaId,
    header,
    fields,
  };
}

export type ChangeKind = 'change' | 'gap' | 'overflow' | 'event';

/** change: apply it; gap: re-read the named records; overflow: re-read the entity (RQ-0036 F6). */
export function changeKind(e: Pick<DecodedEvent, 'header'>): ChangeKind {
  if (!e.header) return 'event';
  if (e.header.changeType === 'GAP_OVERFLOW') return 'overflow';
  if (e.header.changeType.startsWith('GAP_')) return 'gap';
  return 'change';
}

/**
 * Idempotency keys (design §5.6 rule 1, DL-0169): per record, entity + record id + commit number
 * + sequence number (two events of one transaction for the same record stay distinct); overflow:
 * entity + transaction key; platform events: the event uuid.
 */
export function idempotencyKeys(e: DecodedEvent): string[] {
  const h = e.header;
  if (!h) return [`event:${e.eventId}`];
  if (changeKind(e) === 'overflow') {
    return [`cdc:${h.entityName}:overflow:${h.transactionKey}:${String(h.sequenceNumber)}`];
  }
  return h.recordIds.map(
    (id) => `cdc:${h.entityName}:${id}:${h.commitNumber.toString()}:${String(h.sequenceNumber)}`,
  );
}
