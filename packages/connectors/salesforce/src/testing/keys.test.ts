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

  // Regression (found in T-0030's gate runs): random serial bytes 00 xx (xx < 0x80) encoded a
  // non-minimal DER INTEGER, which OpenSSL refuses ("illegal padding") — about 1 cert in 256.
  it.each([
    ['leading zero, small next byte', [0x00, 0x05, 0, 0, 0, 0, 0, 1]],
    ['leading zero, high next byte', [0x00, 0xff, 0, 0, 0, 0, 0, 1]],
    ['high first byte', [0xff, 0x00, 0, 0, 0, 0, 0, 0]],
    ['all zero', [0, 0, 0, 0, 0, 0, 0, 0]],
  ])('encodes any random serial as a minimal positive INTEGER (%s)', (_label, bytes) => {
    const keys = generateTestKeyPair(1024);
    const pem = selfSignedCertificate(
      keys,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
      'serial-test',
      Buffer.from(bytes),
    );
    const cert = new X509Certificate(pem);
    expect(cert.verify(keys.publicKey)).toBe(true);
    // Eight bytes, the first one 0x01..0x7f (positive, no padding byte).
    expect(cert.serialNumber).toMatch(/^(0[1-9A-F]|[1-7][0-9A-F])[0-9A-F]{14}$/);
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
