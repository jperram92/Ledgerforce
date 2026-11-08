/**
 * KMS contract (SS-PLAT-87): the SS-PLAT-38 envelope behaviours, written once and run for every
 * `Kms` adapter — the local keyring (ADR-0018) and the transit adapter (ADR-0038) against the
 * fake and, opt-in, the real OpenBao. Plus key rotation and `rewrapField`.
 */
import { describe, expect, it } from 'vitest';
import { DecryptionError, openField, rewrapField, sealField, type Kms } from '../envelope.ts';

export interface KmsContractFixture {
  /** A KMS whose active key is fresh for this test. */
  kms: Kms;
  /** A KMS with different key material; its active key id is used to relabel a sealed field. */
  other: Kms;
  /** A KMS that does not know `kms`'s key ids. */
  stranger: Kms;
  /** Rotate `kms`'s key; resolves to a KMS that sees the new version. */
  rotate(): Promise<Kms>;
}

const AAD = 'lf-field-v1|tenant|company|party|record|account_number';
const SECRET = '123456789';
/** The database CHECKs on every sealed column (migrations 0013, 0017). */
const DB_KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function describeKmsContract(label: string, setup: () => Promise<KmsContractFixture>): void {
  describe(`SS-PLAT-87: KMS contract (${label})`, () => {
    it('seals and opens; sealed parts never contain the plaintext; wrapped key and id fit the columns', async () => {
      const { kms } = await setup();
      const sealed = await sealField(kms, SECRET, AAD);
      expect(sealed.keyId).toBe(kms.activeKeyId);
      expect(sealed.keyId).toMatch(DB_KEY_ID);
      expect(sealed.wrappedDek).toHaveLength(60);
      expect(sealed.iv).toHaveLength(12);
      expect(sealed.tag).toHaveLength(16);
      for (const part of [sealed.ciphertext, sealed.wrappedDek]) {
        expect(part.toString('latin1')).not.toContain(SECRET);
      }
      expect(await openField(kms, sealed, AAD)).toBe(SECRET);
    });

    it('two seals of the same value differ (fresh DEK, IV and wrap each time)', async () => {
      const { kms } = await setup();
      const a = await sealField(kms, SECRET, AAD);
      const b = await sealField(kms, SECRET, AAD);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    });

    it('a different AAD (another record or field) fails closed', async () => {
      const { kms } = await setup();
      const sealed = await sealField(kms, SECRET, AAD);
      await expect(
        openField(kms, sealed, AAD.replace('record', 'other-record')),
      ).rejects.toBeInstanceOf(DecryptionError);
    });

    it('any flipped bit in ciphertext, tag, IV or wrapped key fails closed', async () => {
      const { kms } = await setup();
      const sealed = await sealField(kms, SECRET, AAD);
      for (const field of ['ciphertext', 'tag', 'iv', 'wrappedDek'] as const) {
        for (const at of [0, sealed[field].length - 1]) {
          const copy = { ...sealed, [field]: Buffer.from(sealed[field]) };
          copy[field][at] = (copy[field][at] ?? 0) ^ 0x01;
          await expect(openField(kms, copy, AAD), `${field}[${String(at)}]`).rejects.toBeInstanceOf(
            DecryptionError,
          );
        }
      }
    });

    it('another key fails closed, and an unknown key id is refused', async () => {
      const { kms, other, stranger } = await setup();
      const sealed = await sealField(kms, SECRET, AAD);
      await expect(
        openField(other, { ...sealed, keyId: other.activeKeyId }, AAD),
      ).rejects.toBeInstanceOf(DecryptionError);
      await expect(openField(stranger, sealed, AAD)).rejects.toThrow(
        new RegExp(`unknown key id ${sealed.keyId.replace(/\./g, '\\.')}`),
      );
    });

    it('rotation: data sealed before still opens; new seals use the new key', async () => {
      const fx = await setup();
      const before = await sealField(fx.kms, '987654321', AAD);
      const rotated = await fx.rotate();
      expect(await openField(rotated, before, AAD)).toBe('987654321');
      const after = await sealField(rotated, '987654321', AAD);
      expect(after.keyId).not.toBe(before.keyId);
      expect(after.keyId).toBe(rotated.activeKeyId);
      expect(after.keyId).toMatch(DB_KEY_ID);
    });

    it('rewrapField moves a sealed field to the new key without touching its data ciphertext', async () => {
      const fx = await setup();
      const before = await sealField(fx.kms, '987654321', AAD);
      const rotated = await fx.rotate();
      const moved = await rewrapField(rotated, before, AAD);
      expect(moved.keyId).toBe(rotated.activeKeyId);
      expect(moved.keyId).not.toBe(before.keyId);
      expect(moved.wrappedDek).toHaveLength(60);
      expect(moved.wrappedDek.equals(before.wrappedDek)).toBe(false);
      expect(moved.ciphertext.equals(before.ciphertext)).toBe(true);
      expect(moved.iv.equals(before.iv)).toBe(true);
      expect(moved.tag.equals(before.tag)).toBe(true);
      expect(await openField(rotated, moved, AAD)).toBe('987654321');
      await expect(
        rewrapField(rotated, before, AAD.replace('record', 'other-record')),
      ).rejects.toBeInstanceOf(DecryptionError);
    });
  });
}
