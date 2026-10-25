/** The test-only certificate builder produces certificates node:crypto parses and verifies (DL-0108). */
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateTestKeyPair, selfSignedCertificate } from './keys.ts';

describe('test key material', () => {
  it('builds a self-signed certificate that parses, verifies and matches its key', () => {
    const keys = generateTestKeyPair();
    const pem = selfSignedCertificate(
      keys,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T12:34:56Z'),
    );
    const cert = new X509Certificate(pem);
    expect(cert.verify(keys.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(keys.privateKey)).toBe(true);
    expect(new Date(cert.validTo).toISOString()).toBe('2027-01-01T12:34:56.000Z');
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(cert.checkPrivateKey(generateTestKeyPair().privateKey)).toBe(false);
  });

  it('uses GeneralizedTime from 2050', () => {
    const keys = generateTestKeyPair();
    const pem = selfSignedCertificate(
      keys,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2051-06-30T00:00:00Z'),
    );
    expect(new Date(new X509Certificate(pem).validTo).toISOString()).toBe(
      '2051-06-30T00:00:00.000Z',
    );
  });
});
