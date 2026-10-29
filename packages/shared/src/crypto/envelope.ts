/**
 * Envelope encryption (design §6.6, RQ-0018, ADR-0018). Each sealed field gets a fresh 32-byte
 * data key (DEK) used once with AES-256-GCM, a random 96-bit IV and caller-supplied AAD that
 * binds the ciphertext to its record and field. The DEK is wrapped by a key-encryption key
 * (KEK) held by a Kms. Every failure to open is a DecryptionError with no detail (fail closed).
 * node:crypto only; no runtime dependency.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const ENVELOPE_VERSION = 1;

export class DecryptionError extends Error {
  constructor() {
    super('value cannot be decrypted (wrong key, wrong record, or tampered)');
    this.name = 'DecryptionError';
  }
}

/** Key management: wraps and unwraps data keys. Async so remote KMS adapters fit. */
export interface Kms {
  readonly activeKeyId: string;
  wrap(dek: Buffer, aad: string): Promise<{ keyId: string; wrapped: Buffer }>;
  unwrap(wrapped: Buffer, keyId: string, aad: string): Promise<Buffer>;
  /**
   * Optional: re-wrap under the active key without exposing the DEK to the caller (the transit
   * adapter does this inside OpenBao, ADR-0038). Without it, `rewrapField` unwraps and wraps.
   */
  rewrap?(wrapped: Buffer, keyId: string, aad: string): Promise<{ keyId: string; wrapped: Buffer }>;
}

export interface SealedField {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  wrappedDek: Buffer;
  keyId: string;
  version: number;
}

function gcmSeal(
  key: Buffer,
  plaintext: Buffer,
  aad: string,
): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  try {
    const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * KEKs from a JSON keyring `{ "active": "<id>", "keys": { "<id>": "<base64 32 bytes>" } }`,
 * normally a Docker secret file (LF_KMS_KEYRING_FILE). Old keys stay for unwrapping, so
 * rotation is: add a key, switch `active`. Errors never include key material.
 */
export class LocalKeyringKms implements Kms {
  readonly activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  private constructor(active: string, keys: Map<string, Buffer>) {
    this.activeKeyId = active;
    this.#keys = keys;
  }

  static fromJson(json: string): LocalKeyringKms {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('keyring is not valid JSON');
    }
    const { active, keys } = (parsed ?? {}) as { active?: unknown; keys?: unknown };
    if (typeof active !== 'string' || typeof keys !== 'object' || keys === null) {
      throw new Error('keyring must be { "active": "<id>", "keys": { "<id>": "<base64>" } }');
    }
    const ring = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(keys)) {
      if (!KEY_ID.test(id))
        throw new Error(`keyring: invalid key id (letters, digits, _ . - only)`);
      const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
      if (bytes.length !== KEY_BYTES)
        throw new Error(`keyring: key ${id} must be 32 bytes (base64)`);
      ring.set(id, bytes);
    }
    if (!ring.has(active)) throw new Error(`keyring: active key ${active} is not in keys`);
    return new LocalKeyringKms(active, ring);
  }

  static async fromFile(path: string): Promise<LocalKeyringKms> {
    return LocalKeyringKms.fromJson(await readFile(path, 'utf8'));
  }

  #key(id: string): Buffer {
    const k = this.#keys.get(id);
    if (!k) throw new Error(`keyring: unknown key id ${id}`);
    return k;
  }

  wrap(dek: Buffer, aad: string): Promise<{ keyId: string; wrapped: Buffer }> {
    const keyId = this.activeKeyId;
    const { iv, ct, tag } = gcmSeal(this.#key(keyId), dek, `lf-kek-v1|${keyId}|${aad}`);
    return Promise.resolve({ keyId, wrapped: Buffer.concat([iv, tag, ct]) });
  }

  unwrap(wrapped: Buffer, keyId: string, aad: string): Promise<Buffer> {
    const kek = this.#key(keyId);
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = wrapped.subarray(IV_BYTES + TAG_BYTES);
    return Promise.resolve(gcmOpen(kek, iv, ct, tag, `lf-kek-v1|${keyId}|${aad}`));
  }
}

/** Encrypt one value for one record/field (`aad` names them; see ADR-0018). */
export async function sealField(kms: Kms, plaintext: string, aad: string): Promise<SealedField> {
  const dek = randomBytes(KEY_BYTES);
  try {
    const { iv, ct, tag } = gcmSeal(dek, Buffer.from(plaintext, 'utf8'), aad);
    const { keyId, wrapped } = await kms.wrap(dek, aad);
    return { ciphertext: ct, iv, tag, wrappedDek: wrapped, keyId, version: ENVELOPE_VERSION };
  } finally {
    dek.fill(0);
  }
}

export async function openField(kms: Kms, sealed: SealedField, aad: string): Promise<string> {
  if (sealed.version !== ENVELOPE_VERSION) throw new DecryptionError();
  const dek = await kms.unwrap(sealed.wrappedDek, sealed.keyId, aad);
  try {
    return gcmOpen(dek, sealed.iv, sealed.ciphertext, sealed.tag, aad).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Move a sealed field's data key to the KMS's active key (after rotation) without touching the
 * data ciphertext, IV or tag. Fails closed like `openField` for a wrong AAD or tampering.
 */
export async function rewrapField(
  kms: Kms,
  sealed: SealedField,
  aad: string,
): Promise<SealedField> {
  if (sealed.version !== ENVELOPE_VERSION) throw new DecryptionError();
  if (kms.rewrap) {
    const { keyId, wrapped } = await kms.rewrap(sealed.wrappedDek, sealed.keyId, aad);
    return { ...sealed, keyId, wrappedDek: wrapped };
  }
  const dek = await kms.unwrap(sealed.wrappedDek, sealed.keyId, aad);
  try {
    const { keyId, wrapped } = await kms.wrap(dek, aad);
    return { ...sealed, keyId, wrappedDek: wrapped };
  } finally {
    dek.fill(0);
  }
}
