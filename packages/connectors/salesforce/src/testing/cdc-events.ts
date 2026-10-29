/**
 * Test-only: Avro-encoded AccountChangeEvent payloads with the documented fixture schema
 * (RQ-0036; fixtures/documented/pubsub-account-change-events.json). Not used in production.
 */
import { readFileSync } from 'node:fs';
import { parseEventSchema, type ChangeType } from '../pubsub/avro.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/pubsub-account-change-events.json', import.meta.url),
    'utf8',
  ),
) as { schemaId: string; schema: unknown };

export const ACCOUNT_CHANGE_SCHEMA_ID = fixture.schemaId;
export const accountChangeSchemaJson = JSON.stringify(fixture.schema);
const schema = parseEventSchema(accountChangeSchemaJson);

const RECORD_FIELDS = [
  'Name',
  'Type',
  'BillingCity',
  'Phone',
  'OwnerId',
  'CreatedDate',
  'LastModifiedDate',
] as const;

export function encodeAccountChange(e: {
  recordIds: string[];
  changeType: ChangeType | string;
  commitNumber: bigint;
  sequenceNumber?: number;
  fields: Partial<Record<(typeof RECORD_FIELDS)[number], string | bigint | null>>;
}): Buffer {
  const value: Record<string, unknown> = {
    ChangeEventHeader: {
      entityName: 'Account',
      recordIds: e.recordIds,
      changeType: e.changeType,
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: `tx-${e.commitNumber.toString()}`,
      sequenceNumber: e.sequenceNumber ?? 1,
      commitTimestamp: 1_761_350_000_000n + e.commitNumber,
      commitNumber: e.commitNumber,
      commitUser: '005TEST00000001AAA',
      nulledFields: [],
      diffFields: [],
      changedFields: [],
    },
  };
  for (const f of RECORD_FIELDS) value[f] = e.fields[f] ?? null;
  return schema.type.toBuffer(value);
}
