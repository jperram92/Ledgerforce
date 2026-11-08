/**
 * Certificate checks for the JWT bearer connection (design §5.2: 12-month rotation, alert 30
 * days before expiry; RQ-0024 F5). The certificate is public; only its private key is secret.
 */
import { X509Certificate } from 'node:crypto';
import { loadRsaPrivateKey, SalesforceConfigError } from './jwt.ts';

export const EXPIRY_ALERT_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CertificateStatus {
  status: 'ok' | 'expiring_soon' | 'expired';
  /** Whole days until notAfter, rounded down (negative once expired). */
  daysLeft: number;
  notAfter: Date;
}

export function certificateExpiryStatus(notAfter: Date, now: Date): CertificateStatus {
  const ms = notAfter.getTime() - now.getTime();
  const daysLeft = Math.floor(ms / DAY_MS);
  const status = ms <= 0 ? 'expired' : daysLeft <= EXPIRY_ALERT_DAYS ? 'expiring_soon' : 'ok';
  return { status, daysLeft, notAfter };
}

export interface CredentialInfo {
  notBefore: Date;
  notAfter: Date;
  /** Lower-case hex SHA-256 of the DER certificate. */
  sha256Fingerprint: string;
}

/** Check that the key is RSA ≥ 2048, matches the certificate, and the certificate is current. */
export function inspectCredentials(
  privateKeyPem: string,
  certificatePem: string,
  now: Date,
): CredentialInfo {
  const key = loadRsaPrivateKey(privateKeyPem);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch {
    throw new SalesforceConfigError('certificate is not a readable X.509 PEM certificate');
  }
  if (!cert.checkPrivateKey(key)) {
    throw new SalesforceConfigError('private key does not match the certificate');
  }
  const notAfter = new Date(cert.validTo);
  const notBefore = new Date(cert.validFrom);
  if (notAfter.getTime() <= now.getTime()) {
    throw new SalesforceConfigError(`certificate expired on ${notAfter.toISOString()}`);
  }
  return {
    notBefore,
    notAfter,
    sha256Fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
  };
}
