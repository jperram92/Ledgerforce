/**
 * SS-PLAT-75 — the Pub/Sub API contract (RQ-0036, ADR-0032): the vendored proto is the published
 * one byte for byte, its message layout is what the subscriber relies on, and CDC payloads decode
 * from Avro binary with the schema from GetSchema (lossless longs, field bitmaps, gap and overflow
 * events, idempotency keys). Fixtures are *documented*, not recorded: no org was contacted.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { status as GrpcStatus, Metadata, type ServiceError } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import {
  bitmapFieldNames,
  changeKind,
  decodeConsumerEvent,
  idempotencyKeys,
  parseEventSchema,
} from './avro.ts';
import { classifyPubSubError, REPLAY_ID_CORRUPTED } from './errors.ts';
import { loadPubSubPackage, PUBSUB_PROTO_PATH, PUBSUB_PROTO_SHA256 } from './proto.ts';

interface Fixture {
  topic: string;
  schemaId: string;
  schema: unknown;
  events: { name: string; replayIdHex: string; eventId: string; payloadBase64: string }[];
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/pubsub-account-change-events.json', import.meta.url),
    'utf8',
  ),
) as Fixture;
const schema = parseEventSchema(JSON.stringify(fixture.schema));
const raw = (name: string) => {
  const e = fixture.events.find((x) => x.name === name);
  if (!e) throw new Error(name);
  return {
    replayId: Buffer.from(e.replayIdHex, 'hex'),
    event: {
      id: e.eventId,
      schemaId: fixture.schemaId,
      payload: Buffer.from(e.payloadBase64, 'base64'),
      headers: [],
    },
  };
};

describe('SS-PLAT-75: Pub/Sub API proto pinned to the published contract', () => {
  it('vendors pubsub_api.proto byte for byte (SHA-256 of the forcedotcom file, RQ-0036 S1)', () => {
    const sha = createHash('sha256').update(readFileSync(PUBSUB_PROTO_PATH)).digest('hex');
    expect(PUBSUB_PROTO_SHA256).toBe(
      '0a651295ff3ff13551b3ae7cb6fe87cf91b749a8ae33b6079617dbc62f304eb5',
    );
    expect(sha).toBe(PUBSUB_PROTO_SHA256);
  });

  // Field names as the client sees them (proto-loader camelCases); numbers and types are the wire.
  it('exposes Subscribe as a bidi stream and GetSchema as unary, with the documented fields', () => {
    const { definition } = loadPubSubPackage();
    const service = definition['eventbus.v1.PubSub'] as Record<
      string,
      { requestStream: boolean; responseStream: boolean; path: string }
    >;
    expect(service['Subscribe']).toMatchObject({
      requestStream: true,
      responseStream: true,
      path: '/eventbus.v1.PubSub/Subscribe',
    });
    expect(service['GetSchema']).toMatchObject({ requestStream: false, responseStream: false });
    const fields = (name: string) =>
      Object.fromEntries(
        (
          definition[`eventbus.v1.${name}`] as {
            type: { field: { name: string; number: number; type: string }[] };
          }
        ).type.field.map((f) => [f.name, [f.number, f.type]]),
      );
    expect(fields('FetchRequest')).toEqual({
      topicName: [1, 'TYPE_STRING'],
      replayPreset: [2, 'TYPE_ENUM'],
      replayId: [3, 'TYPE_BYTES'],
      numRequested: [4, 'TYPE_INT32'],
      authRefresh: [5, 'TYPE_STRING'],
    });
    expect(fields('FetchResponse')).toEqual({
      events: [1, 'TYPE_MESSAGE'],
      latestReplayId: [2, 'TYPE_BYTES'],
      rpcId: [3, 'TYPE_STRING'],
      pendingNumRequested: [4, 'TYPE_INT32'],
    });
    expect(fields('ConsumerEvent')).toEqual({
      event: [1, 'TYPE_MESSAGE'],
      replayId: [2, 'TYPE_BYTES'],
    });
    expect(fields('ProducerEvent')).toMatchObject({
      id: [1, 'TYPE_STRING'],
      schemaId: [2, 'TYPE_STRING'],
      payload: [3, 'TYPE_BYTES'],
    });
    const preset = definition['eventbus.v1.ReplayPreset'] as {
      type: { value: { name: string; number: number }[] };
    };
    expect(preset.type.value.map((v) => [v.name, v.number])).toEqual([
      ['LATEST', 0],
      ['EARLIEST', 1],
      ['CUSTOM', 2],
    ]);
  });
});

describe('SS-PLAT-75: CDC payloads decode from Avro with the GetSchema schema', () => {
  it('decodes a CREATE change event: header, record fields, opaque replay id', () => {
    const e = decodeConsumerEvent(schema, raw('create'));
    expect(e.replayId.toString('hex')).toBe('0000000000004e21');
    expect(e.eventId).toBe('e0000000-0000-4000-8000-000000000001');
    expect(e.schemaId).toBe(fixture.schemaId);
    expect(e.header).toMatchObject({
      entityName: 'Account',
      recordIds: ['001TEST00000001AAA'],
      changeType: 'CREATE',
      transactionKey: '0001a-tx-create',
      sequenceNumber: 1,
      commitNumber: 1082985383811n,
      commitTimestamp: 1761350000000n,
      commitUser: '005TEST00000001AAA',
    });
    expect(e.fields).toMatchObject({
      Name: 'Harbour Freight Pty Ltd',
      Type: 'Customer - Direct',
      BillingCity: 'Sydney',
      Phone: null,
      CreatedDate: 1761350000000n,
    });
    expect(e.fields).not.toHaveProperty('ChangeEventHeader');
    expect(changeKind(e)).toBe('change');
  });

  it('keeps a commitNumber above 2^53 exact and expands the field bitmaps to names', () => {
    const e = decodeConsumerEvent(schema, raw('update'));
    expect(e.header?.commitNumber).toBe(9007199254740993n);
    expect(e.header?.changedFields).toEqual(['Name', 'BillingCity', 'LastModifiedDate']);
    expect(e.header?.nulledFields).toEqual(['Phone']);
    expect(e.header?.diffFields).toEqual([]);
    expect(e.header?.recordIds).toEqual(['001TEST00000001AAA', '001TEST00000002AAA']);
  });

  it('classifies gap and overflow events (they carry no field data to apply)', () => {
    expect(changeKind(decodeConsumerEvent(schema, raw('gap_update')))).toBe('gap');
    expect(changeKind(decodeConsumerEvent(schema, raw('gap_overflow')))).toBe('overflow');
  });

  it('rejects a payload that does not match its schema rather than guessing', () => {
    const bad = raw('create');
    bad.event.payload = bad.event.payload.subarray(0, 20);
    expect(() => decodeConsumerEvent(schema, bad)).toThrow();
  });

  it('bitmaps: bit i names field i; compound entries "<index>-0x.." name child fields', () => {
    const fields = ['ChangeEventHeader', 'Name', 'Type', 'BillingAddress', 'Phone'];
    expect(bitmapFieldNames(fields, ['0x16'], () => [])).toEqual(['Name', 'Type', 'Phone']);
    expect(bitmapFieldNames(fields, [], () => [])).toEqual([]);
    expect(
      bitmapFieldNames(fields, ['0x08', '3-0x05'], (i) =>
        i === 3 ? ['Street', 'City', 'PostalCode'] : [],
      ),
    ).toEqual(['BillingAddress', 'BillingAddress.Street', 'BillingAddress.PostalCode']);
    expect(() => bitmapFieldNames(fields, ['0xG1'], () => [])).toThrow(/bitmap/);
    expect(() => bitmapFieldNames(fields, ['0x08', '9-0x01'], () => [])).toThrow(/bitmap/);
  });
});

describe('SS-PLAT-75: idempotency keys (design §5.6 rule 1)', () => {
  it('one key per record: entity, record id, commit number and sequence number', () => {
    expect(idempotencyKeys(decodeConsumerEvent(schema, raw('update')))).toEqual([
      'cdc:Account:001TEST00000001AAA:9007199254740993:1',
      'cdc:Account:001TEST00000002AAA:9007199254740993:1',
    ]);
  });

  it('overflow: one key per entity and transaction (the record id is a placeholder)', () => {
    expect(idempotencyKeys(decodeConsumerEvent(schema, raw('gap_overflow')))).toEqual([
      'cdc:Account:overflow:0001d-tx-overflow:1',
    ]);
  });

  it('a non-CDC event (platform event) is keyed by its event uuid', () => {
    const e = { ...decodeConsumerEvent(schema, raw('create')), header: null };
    expect(idempotencyKeys(e)).toEqual(['event:e0000000-0000-4000-8000-000000000001']);
  });
});

describe('SS-PLAT-75: Pub/Sub errors are classified from the error-code trailer (RQ-0036 F4)', () => {
  const err = (code: number, trailer?: string): ServiceError => {
    const metadata = new Metadata();
    if (trailer) metadata.set('error-code', trailer);
    return Object.assign(new Error('x rpcId: 6b1f'), { code, details: 'x', metadata });
  };

  it('the replay-id family means "resubscribe elsewhere and reconcile"', () => {
    expect(REPLAY_ID_CORRUPTED).toBe(
      'sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted',
    );
    expect(
      classifyPubSubError(err(GrpcStatus.INVALID_ARGUMENT, REPLAY_ID_CORRUPTED)),
    ).toMatchObject({ kind: 'replay_id_invalid', errorCode: REPLAY_ID_CORRUPTED, rpcId: '6b1f' });
    expect(
      classifyPubSubError(
        err(
          GrpcStatus.INVALID_ARGUMENT,
          'sfdc.platform.eventbus.grpc.subscription.fetch.replayid.expired',
        ),
      ).kind,
    ).toBe('replay_id_invalid');
  });

  it('auth, transient and other failures', () => {
    expect(classifyPubSubError(err(GrpcStatus.UNAUTHENTICATED)).kind).toBe('auth');
    expect(classifyPubSubError(err(GrpcStatus.UNAVAILABLE)).kind).toBe('transient');
    expect(classifyPubSubError(err(GrpcStatus.INTERNAL)).kind).toBe('transient');
    expect(classifyPubSubError(err(GrpcStatus.CANCELLED)).kind).toBe('cancelled');
    expect(classifyPubSubError(err(GrpcStatus.INVALID_ARGUMENT, 'sfdc.other')).kind).toBe('fatal');
  });
});
