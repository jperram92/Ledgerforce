/**
 * Uploaded invoice logos are checked by structure and stripped of metadata before they are
 * stored (T-0195, ADR-0100, RQ-0182 findings 2 and 3). The fixtures in ./testing/logos are real
 * encoder output (Pillow): JPEGs with Exif (camera, artist, GPS), XMP and a comment, a
 * progressive JPEG, and PNGs with and without tEXt/iTXt/eXIf chunks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cleanInvoiceLogo, InvoiceSettingsError } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, 'testing', 'logos', name)));
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));

/** The chunk types of a PNG, in order. */
function pngChunks(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes);
  const out: string[] = [];
  for (let at = 8; at < b.length;) {
    const len = b.readUInt32BE(at);
    out.push(b.toString('latin1', at + 4, at + 8));
    at += 12 + len;
  }
  return out;
}

/** The JPEG markers before the first SOS, e.g. ['E0', 'DB', 'C0', ...]. */
function jpegMarkers(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes);
  const out: string[] = [];
  for (let at = 2; at < b.length;) {
    const m = b[at + 1] ?? 0;
    out.push(m.toString(16).toUpperCase());
    if (m === 0xda) break;
    at += 2 + b.readUInt16BE(at + 2);
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function ihdr(width: number, height: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8;
  d[9] = 2;
  return chunk('IHDR', d);
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceSettingsError);
    return (e as InvoiceSettingsError).message;
  }
  throw new Error('not refused');
};

describe('SS-PLAT-171: uploaded logos are checked by structure and stripped of metadata', () => {
  it('SS-PLAT-171 a JPEG keeps its picture and loses Exif (camera, artist, GPS), XMP and the comment [T-0195]', () => {
    const raw = fixture('logo-exif.jpg');
    expect(has(raw, 'Jane Secret')).toBe(true);
    expect(has(raw, 'Jane XMP')).toBe(true);
    expect(has(raw, 'TestCam')).toBe(true);
    const out = cleanInvoiceLogo('image/jpeg', raw);
    expect(out.width).toBe(120);
    expect(out.height).toBe(40);
    expect(has(out.content, 'Jane')).toBe(false);
    expect(has(out.content, 'TestCam')).toBe(false);
    expect(has(out.content, 'Exif')).toBe(false);
    expect(jpegMarkers(out.content)).not.toContain('E1');
    expect(jpegMarkers(out.content)).not.toContain('FE');
    expect(jpegMarkers(out.content)).toContain('DB');
    expect(jpegMarkers(out.content).at(-1)).toBe('DA');
    // The scan data is unchanged: everything from SOS on is the original's.
    const sos = (b: Uint8Array) => Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]));
    expect(Buffer.from(out.content.subarray(sos(out.content)))).toEqual(
      Buffer.from(raw.subarray(sos(raw))),
    );
    // Cleaning twice gives the same bytes (replay-safe by state).
    expect(cleanInvoiceLogo('image/jpeg', out.content).content).toEqual(out.content);
  });

  it('SS-PLAT-171 a progressive JPEG is accepted and stripped [T-0195]', () => {
    const out = cleanInvoiceLogo('image/jpeg', fixture('logo-progressive.jpg'));
    expect([out.width, out.height]).toEqual([120, 40]);
    expect(has(out.content, 'TestCam')).toBe(false);
  });

  it('SS-PLAT-171 a PNG keeps IHDR, IDAT and IEND and loses tEXt, iTXt and eXIf [T-0195]', () => {
    const raw = fixture('logo-text.png');
    expect(pngChunks(raw)).toEqual(expect.arrayContaining(['tEXt', 'iTXt', 'eXIf']));
    const out = cleanInvoiceLogo('image/png', raw);
    expect([out.width, out.height]).toEqual([120, 40]);
    const kept = pngChunks(out.content);
    expect(kept[0]).toBe('IHDR');
    expect(kept.at(-1)).toBe('IEND');
    expect(kept).toContain('IDAT');
    expect(kept.filter((t) => ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'].includes(t))).toEqual([]);
    expect(has(out.content, 'Jane')).toBe(false);
    const plain = fixture('logo-plain.png');
    expect(cleanInvoiceLogo('image/png', plain).content).toEqual(plain);
  });

  it('SS-PLAT-171 refuses, in plain words, files that only start like an image, trailing data, bad CRCs, huge sizes and SVG [T-0195]', () => {
    const plain = Buffer.from(fixture('logo-plain.png'));
    // Magic bytes followed by anything (a polyglot).
    expect(
      refusal(() =>
        cleanInvoiceLogo('image/png', Buffer.concat([SIG, Buffer.from('<script>x</script>')])),
      ),
    ).toMatch(/not a complete PNG/);
    expect(
      refusal(() =>
        cleanInvoiceLogo('image/png', Buffer.concat([plain, Buffer.from('<html>tail')])),
      ),
    ).toMatch(/after the end of the image/);
    const corrupt = Buffer.from(plain);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0x01; // inside IHDR's data: its CRC no longer matches
    expect(refusal(() => cleanInvoiceLogo('image/png', corrupt))).toMatch(/damaged/);
    const huge = Buffer.concat([SIG, ihdr(5000, 10), chunk('IEND', Buffer.alloc(0))]);
    expect(refusal(() => cleanInvoiceLogo('image/png', huge))).toMatch(/4,000/);
    const noIdat = Buffer.concat([SIG, ihdr(10, 10), chunk('IEND', Buffer.alloc(0))]);
    expect(refusal(() => cleanInvoiceLogo('image/png', noIdat))).toMatch(/not a complete PNG/);
    expect(refusal(() => cleanInvoiceLogo('image/jpeg', plain))).toMatch(/not a JPEG/);
    const jpeg = Buffer.from(fixture('logo-exif.jpg'));
    expect(refusal(() => cleanInvoiceLogo('image/jpeg', jpeg.subarray(0, 300)))).toMatch(
      /not a complete JPEG/,
    );
    expect(
      refusal(() => cleanInvoiceLogo('image/jpeg', Buffer.concat([jpeg, Buffer.from('tail')]))),
    ).toMatch(/after the end of the image/);
    expect(
      refusal(() =>
        cleanInvoiceLogo(
          'image/svg+xml' as 'image/png',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
        ),
      ),
    ).toMatch(/PNG or JPEG/);
    expect(refusal(() => cleanInvoiceLogo('image/png', new Uint8Array(512 * 1024 + 1)))).toMatch(
      /512 KiB/,
    );
  });
});

/** A JPEG segment `FF m` with its 2-byte length and data. */
const segment = (m: number, data: Buffer) => {
  const h = Buffer.from([0xff, m, 0, 0]);
  h.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([h, data]);
};
const EOI = Buffer.from([0xff, 0xd9]);
/** The JPEG with `extra` inserted just before its final EOI (between/after the scans). */
const beforeEoi = (jpeg: Buffer, extra: Buffer) =>
  Buffer.concat([jpeg.subarray(0, jpeg.length - 2), extra, EOI]);
/** A PNG of one 1x1 pixel with the given IHDR fields (CRCs correct). */
function pngWith(depth: number, colour: number, comp = 0, filter = 0, interlace = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(1, 0);
  d.writeUInt32BE(1, 4);
  d[8] = depth;
  d[9] = colour;
  d[10] = comp;
  d[11] = filter;
  d[12] = interlace;
  return Buffer.concat([
    SIG,
    chunk('IHDR', d),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('SS-PLAT-171: security review r11 fixes (F1-F4)', () => {
  it('SS-PLAT-171 F1 refuses a JPEG with data after its end even when the file ends with FF D9 (polyglot) [T-0195]', () => {
    for (const name of ['logo-exif.jpg', 'logo-progressive.jpg']) {
      const jpeg = Buffer.from(fixture(name));
      const polyglot = Buffer.concat([jpeg, Buffer.from('<html><script>SECRET</script>'), EOI]);
      expect(
        refusal(() => cleanInvoiceLogo('image/jpeg', polyglot)),
        name,
      ).toBe('the logo file has data after the end of the image');
      const twoImages = Buffer.concat([jpeg, jpeg]);
      expect(
        refusal(() => cleanInvoiceLogo('image/jpeg', twoImages)),
        name,
      ).toBe('the logo file has data after the end of the image');
    }
  });

  it('SS-PLAT-171 F2 drops APP1, APPn and COM segments placed after the first scan, keeping the image [T-0195]', () => {
    const jpeg = Buffer.from(fixture('logo-progressive.jpg'));
    const sneaky = beforeEoi(
      jpeg,
      Buffer.concat([
        segment(0xfe, Buffer.from('COMMENT SECRET')),
        segment(0xe1, Buffer.from('Exif\0\0APP1 SECRET')),
        segment(0xed, Buffer.from('Photoshop 3.0\0IPTC SECRET')),
      ]),
    );
    const out = cleanInvoiceLogo('image/jpeg', sneaky);
    expect(has(out.content, 'SECRET')).toBe(false);
    // Exactly the original's scans remain (its own metadata before SOS is dropped as before).
    expect(Buffer.from(out.content)).toEqual(
      Buffer.from(cleanInvoiceLogo('image/jpeg', jpeg).content),
    );
  });

  it('SS-PLAT-171 F3 refuses a JPEG with more than 100 scans [T-0195]', () => {
    const jpeg = Buffer.from(fixture('logo-progressive.jpg'));
    // An empty scan of one component: SOS header, no entropy-coded bytes.
    const scan = segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
    const many = beforeEoi(jpeg, Buffer.concat(Array.from({ length: 101 }, () => scan)));
    expect(refusal(() => cleanInvoiceLogo('image/jpeg', many))).toBe(
      'the logo has too many scans (at most 100): export it again as a standard JPEG or PNG',
    );
  });

  it('SS-PLAT-171 F4 accepts only the PNG header values the standard allows [T-0195]', () => {
    for (const [depth, colour] of [
      [1, 0],
      [16, 0],
      [8, 2],
      [16, 2],
      [1, 3],
      [8, 3],
      [8, 4],
      [8, 6],
      [16, 6],
    ] as const)
      expect(cleanInvoiceLogo('image/png', pngWith(depth, colour)).width).toBe(1);
    expect(cleanInvoiceLogo('image/png', pngWith(8, 2, 0, 0, 1)).width).toBe(1);
    for (const bad of [
      pngWith(99, 2),
      pngWith(8, 99),
      pngWith(4, 2),
      pngWith(16, 3),
      pngWith(1, 6),
      pngWith(8, 2, 1),
      pngWith(8, 2, 0, 1),
      pngWith(8, 2, 0, 0, 2),
    ])
      expect(refusal(() => cleanInvoiceLogo('image/png', bad))).toBe(
        'the logo file is not a valid PNG (its header is not one the PNG standard allows)',
      );
  });
});
