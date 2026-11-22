/**
 * lf-backup/v1 — the encrypted backup file format (T-0143, ADR-0101, RQ-0183 Findings 4-5).
 *
 *   "LFBACKUP" | header length (u32 BE) | header JSON | HMAC-SHA256(header JSON) | payload
 *
 * A fresh 32-byte data key per backup is wrapped by the configured Kms (ADR-0018 / ADR-0038) with
 * AAD `lf-backup-v1|<backupId>`. HKDF-SHA256(data key, salt = backupId) gives three keys: the
 * header MAC key, the manifest key (AES-256-GCM, AAD = backupId) and the payload key. The payload
 * is an age-style STREAM: 64 KiB plaintext chunks, AES-256-GCM, nonce = 11-byte big-endian counter
 * ‖ final flag (1 on the last chunk), AAD = the header MAC. The last chunk is non-empty unless the
 * payload is empty. Any failure — wrong key, altered byte, truncation, dropped/reordered chunk,
 * trailing data — is a BackupDecryptError with no detail. node:crypto only.
 */
import type { Kms } from '@ledgerforce/shared/crypto';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BACKUP_FORMAT = 'lf-backup/v1';
export const BACKUP_CHUNK_SIZE = 64 * 1024;
const MAGIC = Buffer.from('LFBACKUP', 'latin1');
const TAG = 16;
const MAC = 32;
const MAX_HEADER = 1024 * 1024;

export class BackupDecryptError extends Error {
  readonly code = 'BACKUP_DECRYPT_FAILED';
  constructor() {
    super('backup cannot be decrypted (wrong key, not an lf-backup file, altered or truncated)');
    this.name = 'BackupDecryptError';
  }
}

export interface ChainManifest {
  tenantId: string;
  companyId: string;
  /** Chained (posted or reversed) entries, decimal string. */
  entries: string;
  /** app.journal_chain_head.last_seq ('0' when the company has no head row). */
  headSeq: string;
  headHash: string | null;
}

export interface BackupManifest {
  version: 1;
  serverVersion: string;
  /** "schema.table" → exact row count (decimal string) at the backup snapshot. */
  tables: Record<string, string>;
  chains: ChainManifest[];
}

interface Header {
  format: string;
  backupId: string;
  createdAt: string;
  keyId: string;
  wrappedKey: string;
  chunkSize: number;
  manifest: { iv: string; tag: string; ciphertext: string };
}

const wrapAad = (backupId: string) => `lf-backup-v1|${backupId}`;

function deriveKeys(
  dek: Buffer,
  backupId: string,
): { mac: Buffer; manifest: Buffer; payload: Buffer } {
  const k = (info: string) =>
    Buffer.from(hkdfSync('sha256', dek, Buffer.from(backupId, 'utf8'), `lf-backup-v1 ${info}`, 32));
  return { mac: k('header-mac'), manifest: k('manifest'), payload: k('payload') };
}

function nonce(counter: bigint, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  if (counter >= 1n << 88n) throw new Error('backup too large for one file');
  for (let i = 10, c = counter; i >= 0; i -= 1, c >>= 8n) n[i] = Number(c & 0xffn);
  n[11] = final ? 1 : 0;
  return n;
}

class EncryptStream extends Transform {
  #buf = Buffer.alloc(0);
  #counter = 0n;
  readonly key: Buffer;
  readonly aad: Buffer;
  constructor(key: Buffer, aad: Buffer) {
    super();
    this.key = key;
    this.aad = aad;
  }
  #seal(chunk: Buffer, final: boolean): void {
    const c = createCipheriv('aes-256-gcm', this.key, nonce(this.#counter, final), {
      authTagLength: TAG,
    });
    c.setAAD(this.aad);
    this.push(Buffer.concat([c.update(chunk), c.final(), c.getAuthTag()]));
    this.#counter += 1n;
  }
  override _transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#buf = Buffer.concat([this.#buf, data]);
    // Strictly greater: the last full chunk is held back so that it can be marked final.
    while (this.#buf.length > BACKUP_CHUNK_SIZE) {
      this.#seal(this.#buf.subarray(0, BACKUP_CHUNK_SIZE), false);
      this.#buf = this.#buf.subarray(BACKUP_CHUNK_SIZE);
    }
    cb();
  }
  override _flush(cb: TransformCallback): void {
    this.#seal(this.#buf, true);
    cb();
  }
}

class DecryptStream extends Transform {
  #buf = Buffer.alloc(0);
  #counter = 0n;
  readonly key: Buffer;
  readonly aad: Buffer;
  constructor(key: Buffer, aad: Buffer) {
    super();
    this.key = key;
    this.aad = aad;
  }
  #open(chunk: Buffer, final: boolean): Buffer {
    if (chunk.length < TAG) throw new BackupDecryptError();
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, nonce(this.#counter, final), {
        authTagLength: TAG,
      });
      d.setAAD(this.aad);
      d.setAuthTag(chunk.subarray(chunk.length - TAG));
      const out = Buffer.concat([d.update(chunk.subarray(0, chunk.length - TAG)), d.final()]);
      this.#counter += 1n;
      return out;
    } catch {
      throw new BackupDecryptError();
    }
  }
  override _transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#buf = Buffer.concat([this.#buf, data]);
    const ct = BACKUP_CHUNK_SIZE + TAG;
    try {
      while (this.#buf.length > ct) {
        this.push(this.#open(this.#buf.subarray(0, ct), false));
        this.#buf = this.#buf.subarray(ct);
      }
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  override _flush(cb: TransformCallback): void {
    try {
      const last = this.#open(this.#buf, true);
      // A non-empty payload never ends in an empty chunk (age rule).
      if (last.length === 0 && this.#counter > 1n) throw new BackupDecryptError();
      this.push(last);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
}

/** Encrypt `source` (normally the pg_dump stream) into `out` (written as `out.partial`, mode 0600). */
export async function writeEncryptedBackup(opts: {
  kms: Kms;
  manifest: BackupManifest;
  source: Readable;
  out: string;
  backupId?: string;
}): Promise<{ backupId: string }> {
  const backupId = opts.backupId ?? randomUUID();
  const dek = randomBytes(32);
  try {
    const keys = deriveKeys(dek, backupId);
    const { keyId, wrapped } = await opts.kms.wrap(dek, wrapAad(backupId));
    const iv = randomBytes(12);
    const mc = createCipheriv('aes-256-gcm', keys.manifest, iv, { authTagLength: TAG });
    mc.setAAD(Buffer.from(backupId, 'utf8'));
    const mct = Buffer.concat([mc.update(JSON.stringify(opts.manifest), 'utf8'), mc.final()]);
    const header: Header = {
      format: BACKUP_FORMAT,
      backupId,
      createdAt: new Date().toISOString(),
      keyId,
      wrappedKey: wrapped.toString('base64'),
      chunkSize: BACKUP_CHUNK_SIZE,
      manifest: {
        iv: iv.toString('base64'),
        tag: mc.getAuthTag().toString('base64'),
        ciphertext: mct.toString('base64'),
      },
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    const mac = createHmac('sha256', keys.mac).update(json).digest();

    const partial = `${opts.out}.partial`;
    const file = createWriteStream(partial, { mode: 0o600, flags: 'wx' });
    file.write(Buffer.concat([MAGIC, len, json, mac]));
    try {
      await pipeline(opts.source, new EncryptStream(keys.payload, mac), file);
      await rename(partial, opts.out);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
    return { backupId };
  } finally {
    dek.fill(0);
  }
}

export interface OpenedBackup {
  backupId: string;
  createdAt: string;
  keyId: string;
  manifest: BackupManifest;
  /** The decrypted payload; errors with BackupDecryptError on any authentication failure. */
  payload(): Readable;
}

/** Read and authenticate the header and manifest; the payload is decrypted when streamed. */
export async function openBackup(file: string, kms: Kms): Promise<OpenedBackup> {
  const fh = await open(file, 'r');
  let header: Header;
  let json: Buffer;
  let mac: Buffer;
  try {
    const head = Buffer.alloc(12);
    const r = await fh.read(head, 0, 12, 0);
    if (r.bytesRead !== 12 || !head.subarray(0, 8).equals(MAGIC)) throw new BackupDecryptError();
    const n = head.readUInt32BE(8);
    if (n === 0 || n > MAX_HEADER) throw new BackupDecryptError();
    json = Buffer.alloc(n);
    mac = Buffer.alloc(MAC);
    if ((await fh.read(json, 0, n, 12)).bytesRead !== n) throw new BackupDecryptError();
    if ((await fh.read(mac, 0, MAC, 12 + n)).bytesRead !== MAC) throw new BackupDecryptError();
    try {
      header = JSON.parse(json.toString('utf8')) as Header;
    } catch {
      throw new BackupDecryptError();
    }
  } finally {
    await fh.close();
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    header.format !== BACKUP_FORMAT ||
    header.chunkSize !== BACKUP_CHUNK_SIZE ||
    typeof header.backupId !== 'string' ||
    typeof header.keyId !== 'string' ||
    typeof header.wrappedKey !== 'string'
  ) {
    throw new BackupDecryptError();
  }
  let dek: Buffer;
  try {
    dek = await kms.unwrap(
      Buffer.from(header.wrappedKey, 'base64'),
      header.keyId,
      wrapAad(header.backupId),
    );
  } catch {
    throw new BackupDecryptError();
  }
  const keys = deriveKeys(dek, header.backupId);
  dek.fill(0);
  const expected = createHmac('sha256', keys.mac).update(json).digest();
  if (!timingSafeEqual(expected, mac)) throw new BackupDecryptError();

  let manifest: BackupManifest;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      keys.manifest,
      Buffer.from(header.manifest.iv, 'base64'),
      {
        authTagLength: TAG,
      },
    );
    d.setAAD(Buffer.from(header.backupId, 'utf8'));
    d.setAuthTag(Buffer.from(header.manifest.tag, 'base64'));
    const plain = Buffer.concat([
      d.update(Buffer.from(header.manifest.ciphertext, 'base64')),
      d.final(),
    ]);
    manifest = JSON.parse(plain.toString('utf8')) as BackupManifest;
  } catch {
    throw new BackupDecryptError();
  }
  const start = 12 + json.length + MAC;
  return {
    backupId: header.backupId,
    createdAt: header.createdAt,
    keyId: header.keyId,
    manifest,
    payload: () => {
      const decrypt = new DecryptStream(keys.payload, mac);
      const source = createReadStream(file, { start });
      source.on('error', (e) => decrypt.destroy(e));
      return source.pipe(decrypt);
    },
  };
}
