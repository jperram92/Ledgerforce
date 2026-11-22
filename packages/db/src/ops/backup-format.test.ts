/**
 * SS-PLAT-176 — the lf-backup/v1 file format (T-0143, ADR-0101, RQ-0183 Findings 4-5): envelope
 * encryption through the Kms, an HMAC'd header, a sealed manifest and an AES-256-GCM STREAM
 * payload. Every change to the bytes, a wrong key, truncation or trailing data must fail with
 * BackupDecryptError before any plaintext is trusted.
 */
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BackupDecryptError,
  BACKUP_CHUNK_SIZE,
  openBackup,
  writeEncryptedBackup,
  type BackupManifest,
} from './backup-format.ts';

const keyring = (id: string) =>
  LocalKeyringKms.fromJson(
    JSON.stringify({ active: id, keys: { [id]: randomBytes(32).toString('base64') } }),
  );
const kms = keyring('backup-2026');
const otherKms = keyring('backup-2026'); // same key id, different key

const manifest: BackupManifest = {
  version: 1,
  serverVersion: '17.0',
  tables: { 'app.journal_entry': '3' },
  chains: [
    { tenantId: 't', companyId: 'c', entries: '3', headSeq: '3', headHash: 'ab'.repeat(32) },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'lf-backup-format-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function write(plain: Buffer): Promise<string> {
  n += 1;
  const file = join(dir, `b${String(n)}.lfbackup`);
  await writeEncryptedBackup({ kms, manifest, source: Readable.from([plain]), out: file });
  return file;
}

async function readAll(file: string, k = kms): Promise<{ plain: Buffer; m: BackupManifest }> {
  const opened = await openBackup(file, k);
  const parts: Buffer[] = [];
  for await (const c of opened.payload()) parts.push(c as Buffer);
  return { plain: Buffer.concat(parts), m: opened.manifest };
}

const sizes = [
  0,
  1,
  BACKUP_CHUNK_SIZE - 1,
  BACKUP_CHUNK_SIZE,
  BACKUP_CHUNK_SIZE + 1,
  3 * BACKUP_CHUNK_SIZE,
];

describe('SS-PLAT-176 lf-backup/v1 format', () => {
  it.each(sizes)('SS-PLAT-176 round-trips a %i-byte payload and the manifest', async (size) => {
    const plain = randomBytes(size);
    const file = await write(plain);
    const { plain: back, m } = await readAll(file);
    expect(back.equals(plain)).toBe(true);
    expect(m).toEqual(manifest);
  });

  it('SS-PLAT-176 the file holds neither the plaintext nor the manifest in the clear', async () => {
    const plain = Buffer.from('PGDMP journal_entry Harbour & Co '.repeat(5000));
    const file = await write(plain);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('LFBACKUP');
    for (const needle of [
      'PGDMP',
      'journal_entry',
      'Harbour',
      'app.journal_entry',
      'ab'.repeat(32),
    ]) {
      expect(bytes.includes(Buffer.from(needle)), needle).toBe(false);
    }
  });

  it('SS-PLAT-176 a different key does not open the backup', async () => {
    const file = await write(randomBytes(1000));
    await expect(openBackup(file, otherKms)).rejects.toBeInstanceOf(BackupDecryptError);
  });

  it('SS-PLAT-176 any altered byte (header, MAC, manifest or payload) fails closed', async () => {
    const plain = randomBytes(2 * BACKUP_CHUNK_SIZE + 10);
    const file = await write(plain);
    const good = readFileSync(file);
    const headerLen = good.readUInt32BE(8);
    const positions = [
      9, // header length
      12 + 5, // header JSON
      12 + headerLen + 3, // header MAC
      12 + headerLen + 32 + 1, // first payload chunk
      good.length - 1, // last chunk tag
    ];
    for (const pos of positions) {
      const bad = Buffer.from(good);
      bad[pos] = (bad[pos] ?? 0) ^ 0x01;
      const f = join(dir, `flip-${String(pos)}.lfbackup`);
      writeFileSync(f, bad);
      await expect(readAll(f), `byte ${String(pos)}`).rejects.toBeInstanceOf(BackupDecryptError);
    }
  });

  it('SS-PLAT-176 truncation (at a chunk boundary or mid-chunk), dropped chunks and trailing bytes fail', async () => {
    const plain = randomBytes(3 * BACKUP_CHUNK_SIZE + 7);
    const file = await write(plain);
    const good = readFileSync(file);
    const headerLen = good.readUInt32BE(8);
    const payloadStart = 12 + headerLen + 32;
    const ct = BACKUP_CHUNK_SIZE + 16;
    const cases: Record<string, Buffer> = {
      'boundary truncation': good.subarray(0, payloadStart + 2 * ct),
      'mid-chunk truncation': good.subarray(0, good.length - 5),
      'no payload': good.subarray(0, payloadStart),
      'dropped chunk': Buffer.concat([
        good.subarray(0, payloadStart + ct),
        good.subarray(payloadStart + 2 * ct),
      ]),
      'swapped chunks': Buffer.concat([
        good.subarray(0, payloadStart),
        good.subarray(payloadStart + ct, payloadStart + 2 * ct),
        good.subarray(payloadStart, payloadStart + ct),
        good.subarray(payloadStart + 2 * ct),
      ]),
      'trailing bytes': Buffer.concat([good, Buffer.from('x')]),
    };
    for (const [name, bad] of Object.entries(cases)) {
      const f = join(dir, `${name.replace(/\s/g, '-')}.lfbackup`);
      writeFileSync(f, bad);
      await expect(readAll(f), name).rejects.toBeInstanceOf(BackupDecryptError);
    }
  });

  it('SS-PLAT-176 a wrapped key copied from another backup does not open this one', async () => {
    const a = readFileSync(await write(randomBytes(100)));
    const b = readFileSync(await write(randomBytes(100)));
    const ha = JSON.parse(a.subarray(12, 12 + a.readUInt32BE(8)).toString('utf8')) as Record<
      string,
      unknown
    >;
    const hbLen = b.readUInt32BE(8);
    const hb = JSON.parse(b.subarray(12, 12 + hbLen).toString('utf8')) as Record<string, unknown>;
    const spliced = Buffer.from(JSON.stringify({ ...hb, wrappedKey: ha['wrappedKey'] }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(spliced.length);
    const f = join(dir, 'spliced.lfbackup');
    writeFileSync(f, Buffer.concat([b.subarray(0, 8), len, spliced, b.subarray(12 + hbLen)]));
    await expect(readAll(f)).rejects.toBeInstanceOf(BackupDecryptError);
  });

  it('SS-PLAT-176 a file that is not an lf-backup fails with BackupDecryptError', async () => {
    const f = join(dir, 'plain.dump');
    writeFileSync(f, Buffer.from('PGDMP\x01\x0f\x00'));
    await expect(openBackup(f, kms)).rejects.toBeInstanceOf(BackupDecryptError);
  });
});
