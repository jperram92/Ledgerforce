/**
 * SS-PLAT-50 — the JWT bearer assertion (RFC 7523, RQ-0024, DL-0105): RS256 over
 * base64url(header).base64url(claims), iss = consumer key, sub = integration username,
 * aud = login or test URL, exp at most 3 minutes after iat. Keys are generated at runtime.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildJwtAssertion, SalesforceConfigError } from './jwt.ts';
import { generateTestKeyPair } from './testing/keys.ts';

const keys = generateTestKeyPair();
const NOW = new Date('2026-10-24T10:00:00Z');
const base = {
  consumerKey: '3MVG9TEST.consumer.key',
  username: 'integration@harbour.example',
  audience: 'https://test.salesforce.com',
  privateKeyPem: keys.privateKeyPem,
  now: NOW,
} as const;

const decode = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

describe('SS-PLAT-50: JWT bearer assertion', () => {
  it('carries the RS256 header and the iss/sub/aud/iat/exp claims', () => {
    const jwt = buildJwtAssertion(base);
    const [h, c, s] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(c);
    expect(claims).toMatchObject({
      iss: '3MVG9TEST.consumer.key',
      sub: 'integration@harbour.example',
      aud: 'https://test.salesforce.com',
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 180,
    });
    expect(typeof claims.jti).toBe('string');
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('the signature verifies with the public key, and not with another key or altered claims', () => {
    const jwt = buildJwtAssertion(base);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    const verify = (input: string, key = keys.publicKey) =>
      createVerify('RSA-SHA256').update(input).verify(key, Buffer.from(s, 'base64url'));
    expect(verify(`${h}.${c}`)).toBe(true);
    expect(verify(`${h}.${c}`, generateTestKeyPair().publicKey)).toBe(false);
    const forged = Buffer.from(
      JSON.stringify({ ...decode(c), sub: 'admin@harbour.example' }),
    ).toString('base64url');
    expect(verify(`${h}.${forged}`)).toBe(false);
  });

  it('exp is never more than 3 minutes after iat', () => {
    const short = decode(buildJwtAssertion({ ...base, ttlSeconds: 60 }).split('.')[1]);
    expect(Number(short.exp) - Number(short.iat)).toBe(60);
    expect(() => buildJwtAssertion({ ...base, ttlSeconds: 181 })).toThrow(SalesforceConfigError);
    expect(() => buildJwtAssertion({ ...base, ttlSeconds: 0 })).toThrow(SalesforceConfigError);
  });

  it('each assertion has a fresh jti', () => {
    const a = decode(buildJwtAssertion(base).split('.')[1]);
    const b = decode(buildJwtAssertion(base).split('.')[1]);
    expect(a.jti).not.toBe(b.jti);
  });

  it('refuses audiences other than the login and test URLs', () => {
    for (const audience of [
      'https://harbour.my.salesforce.com',
      'http://login.salesforce.com',
      'https://login.salesforce.com/',
      'https://evil.example',
    ]) {
      expect(
        () => buildJwtAssertion({ ...base, audience: audience as 'https://login.salesforce.com' }),
        audience,
      ).toThrow(SalesforceConfigError);
    }
    expect(() =>
      buildJwtAssertion({ ...base, audience: 'https://login.salesforce.com' }),
    ).not.toThrow();
  });

  it('refuses non-RSA keys and RSA keys under 2048 bits (RQ-0005, RQ-0024)', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => buildJwtAssertion({ ...base, privateKeyPem: ec })).toThrow(/RSA/);
    const small = generateTestKeyPair(1024).privateKeyPem;
    expect(() => buildJwtAssertion({ ...base, privateKeyPem: small })).toThrow(/2048/);
    expect(() => buildJwtAssertion({ ...base, privateKeyPem: 'not a key' })).toThrow(
      SalesforceConfigError,
    );
  });

  it('refuses empty consumer keys and usernames', () => {
    expect(() => buildJwtAssertion({ ...base, consumerKey: ' ' })).toThrow(SalesforceConfigError);
    expect(() => buildJwtAssertion({ ...base, username: '' })).toThrow(SalesforceConfigError);
  });

  it('errors never contain the key material', () => {
    const pem = keys.privateKeyPem;
    try {
      buildJwtAssertion({ ...base, privateKeyPem: pem.slice(0, -40) });
      expect.unreachable();
    } catch (error) {
      const body = pem.split('\n')[1] ?? '';
      expect(String(error)).not.toContain(body);
    }
  });
});
