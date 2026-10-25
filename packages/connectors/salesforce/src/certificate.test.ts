/**
 * SS-PLAT-50 — certificate checks (design §5.2: rotate every 12 months, alert 30 days before
 * expiry; RQ-0024 F5). The expiry status is a pure function; the scheduled job and notification
 * come with a later connector task.
 */
import { describe, expect, it } from 'vitest';
import { certificateExpiryStatus, EXPIRY_ALERT_DAYS, inspectCredentials } from './certificate.ts';
import { SalesforceConfigError } from './jwt.ts';
import { generateTestKeyPair, selfSignedCertificate } from './testing/keys.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-10-24T10:00:00Z');
const at = (days: number, extraMs = 0) => new Date(NOW.getTime() + days * DAY + extraMs);

describe('SS-PLAT-50: certificate expiry alert 30 days ahead', () => {
  it('is ok at 31 days, expiring_soon at 30 and 29 days, with the days left', () => {
    expect(EXPIRY_ALERT_DAYS).toBe(30);
    expect(certificateExpiryStatus(at(31), NOW)).toEqual({
      status: 'ok',
      daysLeft: 31,
      notAfter: at(31),
    });
    expect(certificateExpiryStatus(at(30), NOW)).toMatchObject({
      status: 'expiring_soon',
      daysLeft: 30,
    });
    expect(certificateExpiryStatus(at(29), NOW)).toMatchObject({
      status: 'expiring_soon',
      daysLeft: 29,
    });
  });

  it('counts whole days left: 30 days and 23 hours is still 30', () => {
    expect(certificateExpiryStatus(at(30, 23 * 3_600_000), NOW)).toMatchObject({
      status: 'expiring_soon',
      daysLeft: 30,
    });
    expect(certificateExpiryStatus(at(31, -1), NOW)).toMatchObject({
      status: 'expiring_soon',
      daysLeft: 30,
    });
  });

  it('is expired at and after notAfter', () => {
    expect(certificateExpiryStatus(at(0), NOW)).toMatchObject({ status: 'expired', daysLeft: 0 });
    expect(certificateExpiryStatus(at(-2), NOW)).toMatchObject({ status: 'expired', daysLeft: -2 });
    expect(certificateExpiryStatus(at(0, 1), NOW)).toMatchObject({
      status: 'expiring_soon',
      daysLeft: 0,
    });
  });
});

describe('SS-PLAT-50: credentials are checked before they are saved', () => {
  const keys = generateTestKeyPair();
  const cert = selfSignedCertificate(keys, at(-1), at(365));

  it('reads notAfter and the SHA-256 fingerprint of a matching RSA pair', () => {
    const info = inspectCredentials(keys.privateKeyPem, cert, NOW);
    expect(info.notAfter.toISOString()).toBe(at(365).toISOString());
    expect(info.sha256Fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a private key that does not match the certificate', () => {
    expect(() => inspectCredentials(generateTestKeyPair().privateKeyPem, cert, NOW)).toThrow(
      /does not match/,
    );
  });

  it('refuses an expired certificate, a malformed one, and a small key', () => {
    const expired = selfSignedCertificate(keys, at(-400), at(-1));
    expect(() => inspectCredentials(keys.privateKeyPem, expired, NOW)).toThrow(/expired/);
    expect(() => inspectCredentials(keys.privateKeyPem, 'nope', NOW)).toThrow(
      SalesforceConfigError,
    );
    const small = generateTestKeyPair(1024);
    expect(() =>
      inspectCredentials(small.privateKeyPem, selfSignedCertificate(small, at(-1), at(9)), NOW),
    ).toThrow(/2048/);
  });
});
