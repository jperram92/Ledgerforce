/**
 * JWT bearer assertion for the self-host Salesforce connection (RFC 7523; design §5.2; ADR-0007;
 * RQ-0024; DL-0105). RS256 with node:crypto, no JWT library. The audience is also the token
 * host, so only Salesforce's login and test URLs are accepted.
 */
import { createPrivateKey, createSign, randomUUID, type KeyObject } from 'node:crypto';

export const SALESFORCE_LOGIN_URLS = [
  'https://login.salesforce.com',
  'https://test.salesforce.com',
] as const;
export type SalesforceLoginUrl = (typeof SALESFORCE_LOGIN_URLS)[number];

/** Salesforce accepts an `exp` at most 3 minutes ahead (RQ-0024 F1). */
export const MAX_ASSERTION_TTL_SECONDS = 180;
export const MIN_RSA_BITS = 2048;

/** A configuration problem detected locally, before anything is sent. Never carries key material. */
export class SalesforceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalesforceConfigError';
  }
}

export interface AssertionInput {
  consumerKey: string;
  username: string;
  audience: SalesforceLoginUrl;
  privateKeyPem: string;
  now?: Date;
  ttlSeconds?: number;
}

export function assertLoginUrl(audience: string): asserts audience is SalesforceLoginUrl {
  if (!(SALESFORCE_LOGIN_URLS as readonly string[]).includes(audience)) {
    throw new SalesforceConfigError(
      `audience must be ${SALESFORCE_LOGIN_URLS.join(' or ')}, got "${audience}"`,
    );
  }
}

/** Parse a PEM private key and require RSA ≥ 2048 bits (RQ-0005: ECDSA is not accepted). */
export function loadRsaPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SalesforceConfigError('private key is not a readable PEM key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new SalesforceConfigError(
      `private key must be RSA (got ${key.asymmetricKeyType ?? 'unknown'})`,
    );
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new SalesforceConfigError(
      `RSA key must be at least ${String(MIN_RSA_BITS)} bits (got ${String(bits)})`,
    );
  }
  return key;
}

const b64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function buildJwtAssertion(input: AssertionInput): string {
  assertLoginUrl(input.audience);
  const ttl = input.ttlSeconds ?? MAX_ASSERTION_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_ASSERTION_TTL_SECONDS) {
    throw new SalesforceConfigError(
      `assertion lifetime must be 1–${String(MAX_ASSERTION_TTL_SECONDS)} seconds`,
    );
  }
  if (!input.consumerKey.trim()) throw new SalesforceConfigError('consumer key is required');
  if (!input.username.trim()) throw new SalesforceConfigError('integration username is required');
  const key = loadRsaPrivateKey(input.privateKeyPem);
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: input.consumerKey,
    sub: input.username,
    aud: input.audience,
    iat,
    exp: iat + ttl,
    jti: randomUUID(),
  })}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}
