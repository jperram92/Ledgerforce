/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the install smoke test: the Owner enrols an
 * authenticator in Keycloak and the test plays the authenticator app. Test-only helper.
 */
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Buffer {
  let bits = '';
  for (const c of text.replace(/[\s=]/g, '').toUpperCase()) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error('not base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
