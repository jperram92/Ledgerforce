// Generates the documented Pub/Sub fixture (RQ-0036). Usage: node gen.mjs <package.json of the connector> <out.json>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(process.argv[2]);
const avro = require('avsc');
const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
const LongType = avro.types.LongType.__with({
  fromBuffer: (b) => b.readBigInt64LE(),
  toBuffer: (n) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    return b;
  },
  fromJSON: BigInt,
  toJSON: Number,
  isValid: (n) => typeof n === 'bigint',
  compare: (a, b) => (a === b ? 0 : a < b ? -1 : 1),
});
const type = avro.Type.forSchema(schema, { registry: { long: LongType } });
const ACC1 = '001TEST00000001AAA';
const ACC2 = '001TEST00000002AAA';
const USER = '005TEST00000001AAA';
const h = (o) => ({
  changeOrigin: 'com/salesforce/api/soap/62.0;client=SfdcInternalAPI/',
  nulledFields: [],
  diffFields: [],
  changedFields: [],
  commitUser: USER,
  sequenceNumber: 1,
  ...o,
});
const empty = {
  Name: null,
  Type: null,
  BillingCity: null,
  Phone: null,
  OwnerId: null,
  CreatedDate: null,
  LastModifiedDate: null,
};
const events = [
  {
    name: 'create',
    replayId: '0000000000004e21',
    eventId: 'e0000000-0000-4000-8000-000000000001',
    value: {
      ChangeEventHeader: h({
        entityName: 'Account',
        recordIds: [ACC1],
        changeType: 'CREATE',
        transactionKey: '0001a-tx-create',
        commitTimestamp: 1761350000000n,
        commitNumber: 1082985383811n,
      }),
      Name: 'Harbour Freight Pty Ltd',
      Type: 'Customer - Direct',
      BillingCity: 'Sydney',
      Phone: null,
      OwnerId: USER,
      CreatedDate: 1761350000000n,
      LastModifiedDate: 1761350000000n,
    },
  },
  {
    name: 'update',
    replayId: '0000000000004e22',
    eventId: 'e0000000-0000-4000-8000-000000000002',
    value: {
      ChangeEventHeader: h({
        entityName: 'Account',
        recordIds: [ACC1, ACC2],
        changeType: 'UPDATE',
        transactionKey: '0001b-tx-update',
        commitTimestamp: 1761350060000n,
        commitNumber: 9007199254740993n,
        nulledFields: ['0x10'],
        changedFields: ['0x8A'],
      }),
      ...empty,
      Name: 'Harbour Freight Group',
      BillingCity: 'Newcastle',
      LastModifiedDate: 1761350060000n,
    },
  },
  {
    name: 'gap_update',
    replayId: '0000000000004e23',
    eventId: 'e0000000-0000-4000-8000-000000000003',
    value: {
      ChangeEventHeader: h({
        entityName: 'Account',
        recordIds: [ACC2],
        changeType: 'GAP_UPDATE',
        transactionKey: '0001c-tx-gap',
        commitTimestamp: 1761350120000n,
        commitNumber: 1082985383900n,
      }),
      ...empty,
    },
  },
  {
    name: 'gap_overflow',
    replayId: '0000000000004e24',
    eventId: 'e0000000-0000-4000-8000-000000000004',
    value: {
      ChangeEventHeader: h({
        entityName: 'Account',
        recordIds: ['000000000000000AAA'],
        changeType: 'GAP_OVERFLOW',
        transactionKey: '0001d-tx-overflow',
        commitTimestamp: 1761350180000n,
        commitNumber: 1082985384000n,
      }),
      ...empty,
    },
  },
];
const out = {
  source:
    'Documented, NOT recorded: written from RQ-0036 findings 5 and 6 and their sources (S7, S8); payloads are Avro binary produced by avsc 5.7.9 from the schema below. No Salesforce org was contacted. Replace with redacted recordings in fixtures/recorded/ from a scratch org (RQ-0036 follow-up). No real id, user or token appears here.',
  topic: '/data/AccountChangeEvent',
  schemaId: 'TESTaccountChangeEventSchema01',
  schema,
  events: events.map((e) => ({
    name: e.name,
    replayIdHex: e.replayId,
    eventId: e.eventId,
    payloadBase64: type.toBuffer(e.value).toString('base64'),
  })),
};
writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + '\n');
