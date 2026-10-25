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
