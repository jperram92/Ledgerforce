export {
  assertLoginUrl,
  buildJwtAssertion,
  MAX_ASSERTION_TTL_SECONDS,
  SALESFORCE_LOGIN_URLS,
  SalesforceConfigError,
  type AssertionInput,
  type SalesforceLoginUrl,
} from './jwt.ts';
export {
  certificateExpiryStatus,
  EXPIRY_ALERT_DAYS,
  inspectCredentials,
  type CertificateStatus,
  type CredentialInfo,
} from './certificate.ts';
export {
  exchangeJwtAssertion,
  fetchHttpPost,
  mapTokenError,
  SalesforceAuthError,
  tokenEndpoint,
  type HttpPost,
  type SalesforceAuthErrorCode,
  type TokenGrant,
} from './token-client.ts';
export {
  createJwtConnection,
  DEFAULT_TOKEN_MAX_AGE_SECONDS,
  getAccessToken,
  getConnection,
  invalidateAccessToken,
  listConnections,
  SalesforceConnectionNotFound,
  type AccessToken,
  type JwtConnectionInput,
  type SalesforceConnectionView,
  type TokenOptions,
} from './connection-store.ts';
export {
  bitmapFieldNames,
  changeKind,
  decodeConsumerEvent,
  idempotencyKeys,
  parseEventSchema,
  type ChangeEventHeader,
  type ChangeKind,
  type ChangeType,
  type DecodedEvent,
  type EventSchema,
} from './pubsub/avro.ts';
export {
  createPubSubClient,
  pubSubMetadata,
  type PubSubAuth,
  type PubSubClient,
} from './pubsub/client.ts';
export {
  classifyPubSubError,
  PubSubError,
  REPLAY_ID_CORRUPTED,
  type PubSubErrorInfo,
  type PubSubErrorKind,
} from './pubsub/errors.ts';
export { MAX_NUM_REQUESTED, PUBSUB_DEFAULT_ENDPOINT, PUBSUB_PROTO_SHA256 } from './pubsub/proto.ts';
export {
  advanceReplayCursor,
  getReplayCursor,
  listResyncRequests,
  ReplayCursorConflict,
  type ReplayCursor,
  type ResyncReason,
  type ResyncRequest,
} from './pubsub/replay-store.ts';
export {
  runSubscription,
  type CdcHandler,
  type SubscriberOptions,
  type SubscriptionOutcome,
} from './pubsub/subscriber.ts';
export {
  planBatches,
  SfNumber,
  SfReference,
  type CollectionRequest,
  type SfValue,
  type WriteBackRecord,
} from './writeback/batch.ts';
export {
  ApiUsageGate,
  classifyHttpError,
  fetchHttpRequest,
  MAX_COLLECTION_RECORDS,
  parseLimitInfo,
  parseRetryAfter,
  SALESFORCE_REST_API_VERSION,
  SalesforceApiError,
  sendCollection,
  type ApiUsageGateOptions,
  type HttpRequest,
  type RecordError,
  type RecordResult,
  type RestSession,
  type SalesforceApiErrorKind,
} from './writeback/collections.ts';
export {
  CREDIT_STATUS_LABELS,
  FIELD_MAP,
  INVOICE_STATUS_LABELS,
  mapToRecords,
  parseWriteBackPayload,
  WRITEBACK_TOPICS,
  type FieldKind,
  type FieldRule,
  type SectionMap,
  type WriteBackPayloadV1,
} from './writeback/mapping.ts';
export {
  SALESFORCE_WRITEBACK_HANDLER,
  salesforceWriteBackHandler,
  writeBack,
  WriteBackRecordError,
  type RecordFailure,
  type WriteBackEvent,
  type WriteBackHandler,
  type WriteBackHandlerDeps,
  type WriteBackReport,
} from './writeback/writeback.ts';
