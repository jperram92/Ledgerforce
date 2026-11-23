/**
 * Mailgun inbound webhook primitives (T-0215, ADR-0099, RQ-0181): the signature verifier against
 * the recorded Rails Action Mailbox vector, the octet-exact multipart/form-data parser and its
 * limits, and recipient → inbound-token parsing. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import {
  InboundWebhookError,
  inboundAddress,
  inboundTokenOf,
  newInboundToken,
  parseMultipartForm,
  verifyMailgunSignature,
} from './inbound-webhook.ts';
import { encodeMultipart, MAILGUN_BILL_EML } from './testing/mailgun-forward.ts';

// Recorded vector (RQ-0181 S1, X1): a test key published in the Rails source, not a credential.
const RAILS = {
  key: 'tbsy84uSV1Kt3ZJZELY2TmShPRs91E3yL4tzf96297vBCkDWgL',
  timestamp: '1539112500',
  token: '7VwW7k6Ak7zcTwoSoNm7aTtbk1g67MKAnsYLfUB7PdszbgR5Xi',
  signature: 'ef24c5225322217bb065b80bb54eb4f9206d764e3e16abab07f0a64d1cf477cc',
};
const NOW = 1539112500;

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InboundWebhookError) return e.reason;
    throw e;
  }
  return 'accepted';
};

describe('SS-PLAT-168 Mailgun signature: HMAC-SHA256(timestamp‖token), constant time, ±300 s', () => {
  it('SS-PLAT-168 accepts the recorded Mailgun vector and any configured key during a roll', () => {
    expect(reason(() => verifyMailgunSignature(RAILS, [RAILS.key], NOW))).toBe('accepted');
    expect(reason(() => verifyMailgunSignature(RAILS, ['other-key', RAILS.key], NOW + 300))).toBe(
      'accepted',
    );
    expect(
      reason(() =>
        verifyMailgunSignature(
          { ...RAILS, signature: RAILS.signature.toUpperCase() },
          [RAILS.key],
          NOW,
        ),
      ),
    ).toBe('accepted');
  });

  it('SS-PLAT-168 refuses a wrong key, a changed token or timestamp, and malformed signatures', () => {
    expect(reason(() => verifyMailgunSignature(RAILS, ['not-the-key'], NOW))).toBe('bad_signature');
    expect(
      reason(() =>
        verifyMailgunSignature({ ...RAILS, token: `${RAILS.token.slice(1)}X` }, [RAILS.key], NOW),
      ),
    ).toBe('bad_signature');
    expect(
      reason(() => verifyMailgunSignature({ ...RAILS, timestamp: '1539112501' }, [RAILS.key], NOW)),
    ).toBe('bad_signature');
    for (const signature of ['', 'zz', RAILS.signature.slice(2), `${RAILS.signature}00`]) {
      expect(reason(() => verifyMailgunSignature({ ...RAILS, signature }, [RAILS.key], NOW))).toBe(
        'bad_signature',
      );
    }
  });

  it('SS-PLAT-168 refuses a stale or future timestamp outside ±300 s even when correctly signed', () => {
    expect(reason(() => verifyMailgunSignature(RAILS, [RAILS.key], NOW + 301))).toBe(
      'stale_timestamp',
    );
    expect(reason(() => verifyMailgunSignature(RAILS, [RAILS.key], NOW - 301))).toBe(
      'stale_timestamp',
    );
  });

  it('SS-PLAT-168 moving characters across timestamp‖token (same signed string) is refused (r11 F7)', () => {
    // The HMAC input has no separator, so these keep a valid signature; the window refuses them.
    const shiftedRight = {
      ...RAILS,
      timestamp: RAILS.timestamp.slice(0, -1),
      token: `${RAILS.timestamp.slice(-1)}${RAILS.token}`,
    };
    const shiftedLeft = { ...RAILS, timestamp: `${RAILS.timestamp}7`, token: RAILS.token.slice(1) };
    expect(RAILS.token.startsWith('7')).toBe(true);
    for (const f of [shiftedRight, shiftedLeft]) {
      expect(`${f.timestamp}${f.token}`).toBe(`${RAILS.timestamp}${RAILS.token}`);
      expect(reason(() => verifyMailgunSignature(f, [RAILS.key], NOW))).toBe('stale_timestamp');
    }
  });

  it('SS-PLAT-168 refuses missing or malformed fields and an empty key set', () => {
    expect(
      reason(() => verifyMailgunSignature({ ...RAILS, signature: undefined }, [RAILS.key], NOW)),
    ).toBe('missing_signature');
    expect(
      reason(() => verifyMailgunSignature({ ...RAILS, token: undefined }, [RAILS.key], NOW)),
    ).toBe('missing_signature');
    expect(
      reason(() => verifyMailgunSignature({ ...RAILS, timestamp: '15391125.0' }, [RAILS.key], NOW)),
    ).toBe('malformed_form');
    expect(
      reason(() => verifyMailgunSignature({ ...RAILS, token: 'short' }, [RAILS.key], NOW)),
    ).toBe('malformed_form');
    expect(reason(() => verifyMailgunSignature(RAILS, [], NOW))).toBe('not_configured');
    expect(reason(() => verifyMailgunSignature(RAILS, [''], NOW))).toBe('not_configured');
  });

  it('SS-PLAT-168 error messages never contain the key, token or signature', () => {
    try {
      verifyMailgunSignature(RAILS, ['not-the-key'], NOW);
    } catch (e) {
      const text = `${String(e)} ${JSON.stringify(e)}`;
      for (const secret of ['not-the-key', RAILS.token, RAILS.signature]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe('SS-PLAT-168 multipart/form-data parser: octet-exact, bounded', () => {
  it('SS-PLAT-168 returns every field with its bytes unchanged, including 8-bit and CRLF content', () => {
    const eightBit = Buffer.concat([
      Buffer.from('Subject: caf'),
      Buffer.from([0xe9, 0x80, 0xff]),
      Buffer.from('\r\n\r\n--not-the-boundary\r\nbody\r\n'),
    ]);
    const { body, contentType } = encodeMultipart([
      ['token', 'abc'],
      ['body-mime', eightBit],
      ['eml', MAILGUN_BILL_EML],
      ['empty', ''],
    ]);
    const parts = parseMultipartForm(body, contentType);
    expect(parts.map((p) => p.name)).toEqual(['token', 'body-mime', 'eml', 'empty']);
    expect(parts[1]?.data.equals(eightBit)).toBe(true);
    expect(parts[2]?.data.equals(MAILGUN_BILL_EML)).toBe(true);
    expect(parts[3]?.data.length).toBe(0);
  });

  it('SS-PLAT-168 reads what a standard client (fetch FormData) encodes, with a quoted boundary and file parts', async () => {
    const fd = new FormData();
    fd.append('recipient', 'bills-x@inbound.example');
    fd.append('attachment-1', new Blob([Buffer.from([1, 2, 3])]), 'a.pdf');
    const req = new Request('http://localhost/', { method: 'POST', body: fd });
    const body = Buffer.from(await req.arrayBuffer());
    const ct = req.headers.get('content-type') ?? '';
    const boundary = /boundary=(.+)$/.exec(ct)?.[1] ?? '';
    for (const contentType of [ct, `multipart/form-data; boundary="${boundary}"`]) {
      const parts = parseMultipartForm(body, contentType);
      expect(parts.map((p) => [p.name, p.filename])).toEqual([
        ['recipient', null],
        ['attachment-1', 'a.pdf'],
      ]);
      expect(parts[0]?.data.toString()).toBe('bills-x@inbound.example');
      expect([...(parts[1]?.data ?? [])]).toEqual([1, 2, 3]);
    }
  });

  it('SS-PLAT-168 refuses a missing boundary, a truncated body, too many parts and oversized part headers', () => {
    const ok = encodeMultipart([['a', '1']], 'B0UNDARY');
    expect(reason(() => parseMultipartForm(ok.body, 'multipart/form-data'))).toBe('malformed_form');
    expect(reason(() => parseMultipartForm(ok.body, 'application/json'))).toBe('malformed_form');
    expect(
      reason(() => parseMultipartForm(ok.body.subarray(0, ok.body.length - 12), ok.contentType)),
    ).toBe('malformed_form');
    expect(reason(() => parseMultipartForm(Buffer.from('garbage'), ok.contentType))).toBe(
      'malformed_form',
    );
    const many = encodeMultipart(
      Array.from({ length: 33 }, (_, i) => [`f${String(i)}`, 'x'] as const),
    );
    expect(reason(() => parseMultipartForm(many.body, many.contentType))).toBe('malformed_form');
    const bigHeader = Buffer.from(
      `--B\r\nContent-Disposition: form-data; name="a"\r\nX-Pad: ${'p'.repeat(9000)}\r\n\r\nv\r\n--B--\r\n`,
    );
    expect(reason(() => parseMultipartForm(bigHeader, 'multipart/form-data; boundary=B'))).toBe(
      'malformed_form',
    );
    const noName = Buffer.from('--B\r\nContent-Disposition: form-data\r\n\r\nv\r\n--B--\r\n');
    expect(reason(() => parseMultipartForm(noName, 'multipart/form-data; boundary=B'))).toBe(
      'malformed_form',
    );
  });
});

describe('SS-PLAT-169 recipient → inbound token', () => {
  const token = newInboundToken();

  it('SS-PLAT-169 new tokens are 26 base32 characters (130 bits) and differ every time', () => {
    expect(token).toMatch(/^[a-z2-7]{26}$/);
    expect(new Set(Array.from({ length: 200 }, newInboundToken)).size).toBe(200);
    expect(inboundAddress(token, 'Inbound.Example')).toBe(`bills-${token}@inbound.example`);
  });

  it('SS-PLAT-169 accepts exactly one bills-<token> address at the configured domain, case-insensitively', () => {
    expect(inboundTokenOf(`bills-${token}@inbound.example`, 'inbound.example')).toBe(token);
    expect(
      inboundTokenOf(` BILLS-${token.toUpperCase()}@Inbound.Example `, 'inbound.example'),
    ).toBe(token);
  });

  it('SS-PLAT-169 refuses other domains, look-alike domains, lists, display names and malformed tokens', () => {
    for (const r of [
      `bills-${token}@other.example`,
      `bills-${token}@inbound.example.evil`,
      `bills-${token}@sub.inbound.example`,
      `bills-${token}@inbound.example, bills-${token}@inbound.example`,
      `Bills <bills-${token}@inbound.example>`,
      `bills-${token.slice(1)}@inbound.example`,
      `bills-${token}1@inbound.example`,
      `${token}@inbound.example`,
      `bills-${token.slice(0, 25)}!@inbound.example`,
      '',
    ]) {
      expect(inboundTokenOf(r, 'inbound.example')).toBeNull();
    }
  });
});
