/**
 * SS-PLAT-38 — envelope encryption fails closed and survives key rotation (T-0037, RQ-0018,
 * ADR-0018). Per field: fresh data key (DEK), AES-256-GCM, random 96-bit IV, AAD binding the
 * record; the DEK is wrapped by the key-encryption key (KEK) from the KMS.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecryptionError, LocalKeyringKms, openField, sealField } from './envelope.ts';

const key = () => randomBytes(32).toString('base64');
const ring = (active: string, keys: Record<string, string>) =>
  LocalKeyringKms.fromJson(JSON.stringify({ active, keys }));
const AAD = 'lf-field-v1|tenant|company|party|record|account_number';

describe('SS-PLAT-38: Envelope encryption fails closed and survives key rotation', () => {
  it('seals and opens a value; the sealed form never contains the plaintext', async () => {
    const kms = ring('k1', { k1: key() });
    const sealed = await sealField(kms, '123456789', AAD);
    expect(sealed.keyId).toBe('k1');
    expect(sealed.version).toBe(1);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    for (const part of [sealed.ciphertext, sealed.wrappedDek]) {
      expect(part.toString('latin1')).not.toContain('123456789');
    }
    expect(await openField(kms, sealed, AAD)).toBe('123456789');
  });

  it('two seals of the same value differ (fresh DEK and IV each time)', async () => {
    const kms = ring('k1', { k1: key() });
    const a = await sealField(kms, '123456789', AAD);
    const b = await sealField(kms, '123456789', AAD);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('a different AAD (another record or field) fails closed', async () => {
    const kms = ring('k1', { k1: key() });
    const sealed = await sealField(kms, '123456789', AAD);
    await expect(
      openField(kms, sealed, AAD.replace('record', 'other-record')),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('any flipped bit in ciphertext, tag, IV or wrapped key fails closed', async () => {
    const kms = ring('k1', { k1: key() });
    const sealed = await sealField(kms, '123456789', AAD);
    for (const field of ['ciphertext', 'tag', 'iv', 'wrappedDek'] as const) {
      const copy = { ...sealed, [field]: Buffer.from(sealed[field]) };
      copy[field][0] = (copy[field][0] ?? 0) ^ 0x01;
      await expect(openField(kms, copy, AAD), field).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it('the wrong KEK, or an unknown key id, fails closed', async () => {
    const sealed = await sealField(ring('k1', { k1: key() }), '123456789', AAD);
    await expect(openField(ring('k1', { k1: key() }), sealed, AAD)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(openField(ring('k9', { k9: key() }), sealed, AAD)).rejects.toThrow(
      /unknown key id k1/,
    );
  });

  it('rotation: data sealed under k1 still opens after k2 becomes active; new seals use k2', async () => {
    const k1 = key();
    const before = await sealField(ring('k1', { k1 }), '987654321', AAD);
    const rotated = ring('k2', { k1, k2: key() });
    expect(await openField(rotated, before, AAD)).toBe('987654321');
    expect((await sealField(rotated, '987654321', AAD)).keyId).toBe('k2');
  });

  it('the keyring refuses keys that are not 32 bytes, a missing active key, and bad ids', () => {
    expect(() => ring('k1', { k1: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
    expect(() => ring('k2', { k1: key() })).toThrow(/active key k2/);
    expect(() => ring('bad id', { 'bad id': key() })).toThrow(/key id/);
    expect(() => LocalKeyringKms.fromJson('not json')).toThrow(/keyring/);
  });

  it('loads from a key file (Docker secret), and its errors never echo key material', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-kms-'));
    const k = key();
    const file = join(dir, 'keyring.json');
    await writeFile(file, JSON.stringify({ active: 'k1', keys: { k1: k } }), { mode: 0o600 });
    const kms = await LocalKeyringKms.fromFile(file);
    expect(kms.activeKeyId).toBe('k1');
    await writeFile(file, JSON.stringify({ active: 'k1', keys: { k1: k.slice(0, 20) } }));
    await expect(LocalKeyringKms.fromFile(file)).rejects.toThrow(/32 bytes/);
    await LocalKeyringKms.fromFile(file).catch((error: unknown) => {
      expect(String(error)).not.toContain(k.slice(0, 20));
    });
  });
});
