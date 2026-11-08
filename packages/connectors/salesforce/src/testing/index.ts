/** Test-only helpers for other packages' tests (never imported by production code). */
export {
  DOCUMENTED_COLLECTIONS,
  startFakeSalesforceRest,
  type FakeSalesforceRest,
  type RecordedRequest,
  type StoredRecord,
} from './fake-salesforce-rest.ts';
export { startFakeTokenEndpoint, type FakeTokenEndpoint } from './fake-token-endpoint.ts';
export { generateTestKeyPair, selfSignedCertificate } from './keys.ts';
