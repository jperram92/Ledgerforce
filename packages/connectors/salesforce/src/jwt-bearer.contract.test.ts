/**
 * SS-PLAT-50 — JWT bearer token exchange against a local fake of the Salesforce token endpoint
 * (RQ-0024, DL-0105). The fake verifies the signature with the certificate's public key and
 * answers with the documented responses (fixtures/documented, not recorded: no org contacted).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildJwtAssertion } from './jwt.ts';
import {
  exchangeJwtAssertion,
  mapTokenError,
  SalesforceAuthError,
  tokenEndpoint,
  type HttpPost,
} from './token-client.ts';
import {
  DOCUMENTED,
  startFakeTokenEndpoint,
  type FakeTokenEndpoint,
} from './testing/fake-token-endpoint.ts';
import { generateTestKeyPair, selfSignedCertificate } from './testing/keys.ts';

const AUD = 'https://test.salesforce.com';
const KEY = '3MVG9TEST.consumer.key';
const USER = 'integration@harbour.example';
const keys = generateTestKeyPair();
const cert = selfSignedCertificate(
  keys,
  new Date(Date.now() - 86_400_000),
  new Date(Date.now() + 365 * 86_400_000),
);
let fake: FakeTokenEndpoint;

const assertion = (over: Partial<Parameters<typeof buildJwtAssertion>[0]> = {}) =>
  buildJwtAssertion({
    consumerKey: KEY,
    username: USER,
    audience: AUD,
    privateKeyPem: keys.privateKeyPem,
    ...over,
  });

const failure = async (p: Promise<unknown>): Promise<SalesforceAuthError> => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(SalesforceAuthError);
    return error as SalesforceAuthError;
  }
  throw new Error('expected a SalesforceAuthError');
};

beforeAll(async () => {
  fake = await startFakeTokenEndpoint({
    certificatePem: cert,
    consumerKey: KEY,
    audience: AUD,
    users: {
      [USER]: { preauthorized: true },
      'not-approved@harbour.example': { preauthorized: false },
      'frozen@harbour.example': { preauthorized: true, active: false },
    },
  });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.override = null;
});

describe('SS-PLAT-50: JWT bearer token exchange (fake endpoint verifies the signature)', () => {
  it('posts the form-encoded jwt-bearer grant to <aud>/services/oauth2/token and returns the token', async () => {
    expect(tokenEndpoint(AUD)).toBe('https://test.salesforce.com/services/oauth2/token');
    const jwt = assertion();
    const grant = await exchangeJwtAssertion(fake.http, AUD, jwt);
    const req = fake.requests.at(-1);
    expect(req?.contentType).toBe('application/x-www-form-urlencoded');
    expect(req?.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    });
    expect(Object.keys(req?.form ?? {})).not.toContain('client_secret');
    expect(grant.accessToken).toBe(fake.issued.at(-1));
    expect(grant.instanceUrl).toBe('https://harbour-dev-ed.develop.my.salesforce.com');
    expect(grant.issuedAt).toBeInstanceOf(Date);
    expect(grant.scope).toBe('api');
  });

  it('an assertion signed by another key is refused as invalid_assertion', async () => {
    const other = generateTestKeyPair();
    const e = await failure(
      exchangeJwtAssertion(fake.http, AUD, assertion({ privateKeyPem: other.privateKeyPem })),
    );
    expect(e.code).toBe('invalid_assertion');
    expect(e.retryable).toBe(false);
  });

  it('an expired assertion is refused as invalid_assertion', async () => {
    const e = await failure(
      exchangeJwtAssertion(fake.http, AUD, assertion({ now: new Date(Date.now() - 10 * 60_000) })),
    );
    expect(e.code).toBe('invalid_assertion');
  });

  it('maps the documented failures to clear codes', async () => {
    const cases: [Partial<Parameters<typeof buildJwtAssertion>[0]>, string][] = [
      [{ username: 'not-approved@harbour.example' }, 'not_preauthorized'],
      [{ username: 'frozen@harbour.example' }, 'invalid_user'],
      [{ username: 'nobody@harbour.example' }, 'invalid_user'],
      [{ consumerKey: '3MVG9OTHER' }, 'invalid_client'],
      [{ audience: 'https://login.salesforce.com' }, 'invalid_audience'],
    ];
    for (const [over, code] of cases) {
      const e = await failure(exchangeJwtAssertion(fake.http, AUD, assertion(over)));
      expect(e.code, JSON.stringify(over)).toBe(code);
    }
  });

  it('maps every documented error response, by error and description', () => {
    const expected: Record<string, string> = {
      not_preauthorized: 'not_preauthorized',
      invalid_audience: 'invalid_audience',
      invalid_assertion: 'invalid_assertion',
      invalid_user: 'invalid_user',
      ip_restricted: 'ip_restricted',
      invalid_grant: 'invalid_grant',
      invalid_client: 'invalid_client',
      unsupported_grant_type: 'unsupported_grant_type',
    };
    for (const [name, code] of Object.entries(expected)) {
      const doc = DOCUMENTED.responses[name];
      const e = mapTokenError(doc?.status ?? 0, JSON.stringify(doc?.body));
      expect(e.code, name).toBe(code);
      expect(e.retryable, name).toBe(false);
      expect(e.description, name).toBe(doc?.body.error_description);
    }
    expect(
      mapTokenError(400, '{"error":"invalid_grant","error_description":"User Is Not Active"}').code,
    ).toBe('invalid_user');
    expect(
      mapTokenError(
        400,
        '{"error":"invalid_client","error_description":"invalid client credentials"}',
      ).code,
    ).toBe('invalid_client');
  });

  it('5xx, network failures and non-JSON bodies are retryable token_endpoint_unavailable', async () => {
    fake.override = { status: 503, body: '<html>maintenance</html>' };
    const e = await failure(exchangeJwtAssertion(fake.http, AUD, assertion()));
    expect(e).toMatchObject({ code: 'token_endpoint_unavailable', retryable: true, status: 503 });
    const down: HttpPost = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await failure(exchangeJwtAssertion(down, AUD, assertion()))).toMatchObject({
      code: 'token_endpoint_unavailable',
      retryable: true,
    });
  });

  it('a 200 without an access token or an https instance URL is malformed_response', async () => {
    for (const body of [
      '{"instance_url":"https://x.my.salesforce.com"}',
      '{"access_token":"t","instance_url":"http://x.my.salesforce.com"}',
      '{"access_token":"t"}',
      'not json',
    ]) {
      fake.override = { status: 200, body };
      expect((await failure(exchangeJwtAssertion(fake.http, AUD, assertion()))).code, body).toBe(
        'malformed_response',
      );
    }
  });

  it('errors never carry the assertion or a token', async () => {
    const jwt = assertion({ username: 'not-approved@harbour.example' });
    const e = await failure(exchangeJwtAssertion(fake.http, AUD, jwt));
    const text = `${e.message} ${JSON.stringify(e)} ${String(e.stack)}`;
    expect(text).not.toContain(jwt);
    expect(text).not.toContain(jwt.split('.')[2] ?? 'x');
    fake.override = {
      status: 200,
      body: '{"access_token":"SECRET-TOKEN-123","instance_url":"ftp://x"}',
    };
    const m = await failure(exchangeJwtAssertion(fake.http, AUD, assertion()));
    expect(`${m.message} ${JSON.stringify(m)}`).not.toContain('SECRET-TOKEN-123');
  });

  it('refuses to send an assertion to any host but the login or test URL', async () => {
    await expect(
      exchangeJwtAssertion(fake.http, 'https://evil.example' as typeof AUD, assertion()),
    ).rejects.toThrow(/audience/);
  });

  it('no source file requests the username-password flow (ADR-0007)', () => {
    const dir = new URL('.', import.meta.url);
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/grant_type=password|grant_type['"]?\s*[:,]\s*['"]password/);
    }
  });
});
