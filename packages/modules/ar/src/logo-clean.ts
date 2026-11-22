/**
 * Cleaning of an uploaded invoice logo before it is stored (T-0195, ADR-0100, RQ-0182 findings 2
 * and 3). Checks the file's structure, not just its first bytes, refuses absurd dimensions and
 * drops metadata without decoding the picture (no image codec, design §10.6):
 * - PNG (W3C PNG 3rd ed. §5): signature, then chunks `length · type · data · CRC-32`; IHDR first,
 *   at least one IDAT, IEND last and nothing after it. Only chunks that affect how the picture
 *   looks are kept; text, Exif, time and unknown chunks are dropped (a kept chunk's CRC is its own).
 * - JPEG (ITU-T T.81 Annex B): SOI, marker segments with lengths up to the first SOS, a frame
 *   header (SOFn) before it, EOI last. APP1 (Exif/XMP), APP3–APP13, APP15 and COM before SOS are
 *   dropped; APP0 (JFIF), APP2 (ICC) and APP14 (Adobe) are kept because they change the colours.
 *   Security review r11 (ADR-0100 addendum): the walk continues through the entropy-coded data
 *   of every scan (FF 00 and RSTn are data), drops metadata between scans too (F2), allows at
 *   most 100 scans (F3) and stops at the first real EOI, refusing anything after it (F1). PNG
 *   IHDR values must be ones the standard allows (F4).
 * SVG and any other type are refused. Refusals are InvoiceSettingsError in plain words.
 */
import { crc32 } from 'node:zlib';
import { InvoiceSettingsError, MAX_LOGO_BYTES, type LogoContentType } from './invoice-settings.ts';

/** The largest logo side in pixels (a logo is printed at most 70 mm wide). */
export const MAX_LOGO_PIXELS = 4000;

/** The most scans a JPEG logo may have; a progressive JPEG normally has about 10 (F3). */
export const MAX_JPEG_SCANS = 100;

/** Allowed bit depths per PNG colour type (W3C PNG 3rd ed. §11.2.1, Table 11). */
const PNG_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export interface CleanLogo {
  readonly contentType: LogoContentType;
  readonly content: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const invalid = (message: string) => new InvoiceSettingsError('INVALID_INVOICE_SETTINGS', message);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'bKGD',
  'pHYs',
]);

function checkSize(width: number, height: number): void {
  if (width < 1 || height < 1)
    throw invalid('the logo has no width or height: export it again as a PNG or JPEG');
  if (width > MAX_LOGO_PIXELS || height > MAX_LOGO_PIXELS)
    throw invalid(
      `the logo must be at most 4,000 by 4,000 pixels; this one is ${String(width)} by ${String(height)}`,
    );
}

function cleanPng(b: Buffer): CleanLogo {
  const incomplete = () => invalid('the logo file is not a complete PNG image');
  if (b.length < PNG_SIG.length || !b.subarray(0, 8).equals(PNG_SIG))
    throw invalid('the logo file is not a PNG');
  const kept: Buffer[] = [PNG_SIG];
  let at = 8;
  let width = 0;
  let height = 0;
  let idat = false;
  let first = true;
  for (;;) {
    if (at + 12 > b.length) throw incomplete();
    const len = b.readUInt32BE(at);
    const end = at + 12 + len;
    if (len > 0x7fffffff || end > b.length) throw incomplete();
    const type = b.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw incomplete();
    if (crc32(b.subarray(at + 4, at + 8 + len)) !== b.readUInt32BE(at + 8 + len))
      throw invalid('the logo file is damaged (a PNG checksum does not match)');
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw incomplete();
      width = b.readUInt32BE(at + 8);
      height = b.readUInt32BE(at + 12);
      checkSize(width, height);
      const [depth = 0, colour = 0, compression, filter, interlace = 0] = b.subarray(
        at + 16,
        at + 21,
      );
      const depths = Object.hasOwn(PNG_DEPTHS, colour) ? PNG_DEPTHS[colour] : undefined;
      if (!depths?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1)
        throw invalid(
          'the logo file is not a valid PNG (its header is not one the PNG standard allows)',
        );
      first = false;
    } else if (type === 'IHDR') throw incomplete();
    if (type === 'IDAT') idat = true;
    if (PNG_KEEP.has(type)) kept.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  if (!idat) throw incomplete();
  if (at !== b.length) throw invalid('the logo file has data after the end of the image');
  return { contentType: 'image/png', content: new Uint8Array(Buffer.concat(kept)), width, height };
}

/** JPEG markers with no length field. */
const standalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);
/** Frame headers: C0–CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Metadata segments dropped before SOS. */
const dropped = (m: number) => m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;

function cleanJpeg(b: Buffer): CleanLogo {
  const incomplete = () => invalid('the logo file is not a complete JPEG image');
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff)
    throw invalid('the logo file is not a JPEG');
  const kept: Buffer[] = [b.subarray(0, 2)];
  let at = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  for (;;) {
    if (at + 2 > b.length || b[at] !== 0xff) throw incomplete();
    const m = b[at + 1] ?? 0;
    if (m === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (m === 0xd9) {
      // The first real EOI ends the image: nothing may follow it (no polyglots, F1).
      kept.push(b.subarray(at, at + 2));
      if (at + 2 !== b.length) throw invalid('the logo file has data after the end of the image');
      break;
    }
    if (m === 0xd8 || m === 0x00) throw incomplete();
    if (standalone(m)) {
      kept.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > b.length) throw incomplete();
    const len = b.readUInt16BE(at + 2);
    let end = at + 2 + len;
    if (len < 2 || end > b.length) throw incomplete();
    if (isSof(m)) {
      if (len < 8) throw incomplete();
      height = b.readUInt16BE(at + 5);
      width = b.readUInt16BE(at + 7);
      checkSize(width, height);
    }
    if (m === 0xda) {
      if (width === 0) throw incomplete();
      scans += 1;
      if (scans > MAX_JPEG_SCANS)
        throw invalid(
          `the logo has too many scans (at most ${String(MAX_JPEG_SCANS)}): export it again as a standard JPEG or PNG`,
        );
      // Entropy-coded data: FF is followed by 00 (stuffing) or RSTn inside it; any other marker
      // (after optional FF fill bytes) ends the scan.
      for (;;) {
        const ff = b.indexOf(0xff, end);
        if (ff < 0 || ff + 1 >= b.length) throw incomplete();
        const n = b[ff + 1] ?? 0;
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
          end = ff + 2;
          continue;
        }
        end = ff;
        break;
      }
    }
    // Metadata is dropped wherever it appears, before or between scans (F2).
    if (!dropped(m)) kept.push(b.subarray(at, end));
    at = end;
  }
  return { contentType: 'image/jpeg', content: new Uint8Array(Buffer.concat(kept)), width, height };
}

/** Check and clean an uploaded logo; throws InvoiceSettingsError in plain words. */
export function cleanInvoiceLogo(contentType: LogoContentType, content: Uint8Array): CleanLogo {
  if (contentType !== 'image/png' && contentType !== 'image/jpeg')
    throw invalid('the logo must be a PNG or JPEG image (SVG is not accepted: export it as PNG)');
  if (content.length === 0 || content.length > MAX_LOGO_BYTES)
    throw invalid(`the logo must be 1 byte to ${String(MAX_LOGO_BYTES / 1024)} KiB`);
  const b = Buffer.from(content.buffer, content.byteOffset, content.length);
  return contentType === 'image/png' ? cleanPng(b) : cleanJpeg(b);
}
