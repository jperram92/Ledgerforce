/**
 * Test-only key material, generated at runtime (never committed). Node has no API to create an
 * X.509 certificate, so this builds a minimal self-signed v3 certificate in DER by hand
 * (RFC 5280 §4.1: TBSCertificate, sha256WithRSAEncryption, BIT STRING signature). It exists so
 * tests can exercise the real certificate parsing (`X509Certificate`) without openssl (DL-0108).
 */
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p % 128];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v % 128));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const compact = iso.slice(0, 19).replace(/[-:T]/g, '') + 'Z';
  const year = d.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(compact.slice(2), 'ascii')) // UTCTime YYMMDDHHMMSSZ
    : tlv(0x18, Buffer.from(compact, 'ascii')); // GeneralizedTime
}

const name = (cn: string): Buffer =>
  seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));

export interface TestKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateKeyPem: string;
}

export function generateTestKeyPair(modulusLength = 2048): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  return {
    privateKey,
    publicKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Self-signed certificate PEM for `keys`, valid from notBefore to notAfter (second precision). */
export function selfSignedCertificate(
  keys: Pick<TestKeyPair, 'privateKey' | 'publicKey'>,
  notBefore: Date,
  notAfter: Date,
  commonName = 'ledgerforce-test-integration',
  random: Buffer = randomBytes(8),
): string {
  const serial = Buffer.from(random);
  // DER INTEGER: positive (top bit clear) and minimal (no leading 0x00 byte), so first byte 1..7f.
  serial[0] = (serial[0] ?? 0) & 0x7f || 0x01;
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // [0] EXPLICIT version v3
    tlv(0x02, serial),
    SHA256_RSA,
    name(commonName),
    seq(time(notBefore), time(notAfter)),
    name(commonName),
    spki,
  );
  const signature = createSign('RSA-SHA256').update(tbs).sign(keys.privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}
