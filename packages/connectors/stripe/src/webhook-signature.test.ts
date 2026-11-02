/**
 * SS-UC03-06 — Stripe webhook signature and replay window (T-0074, RQ-0104, ADR-0049).
 * The signing secret is generated per run; the expected HMAC is computed here independently with
 * node:crypto, so the verifier is not checked against itself.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseStripeEvent,
  verifyStripeSignature,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookSignatureError,
} from './webhook-signature.ts';

const secret = `whsec_${randomBytes(24).toString('hex')}`;
const other = `whsec_${randomBytes(24).toString('hex')}`;
const NOW = 1_794_787_200; // 2026-11-15T00:00:00Z
const body = JSON.stringify({
  id: 'evt_1TestSignature',
  object: 'event',
  type: 'payment_intent.succeeded',
  created: NOW,
  livemode: false,
  data: { object: { id: 'pi_1Test', object: 'payment_intent' } },
});
const hmac = (s: string, t: number, b: string) =>
  createHmac('sha256', s)
    .update(`${String(t)}.${b}`, 'utf8')
    .digest('hex');
const header = (t: number, ...sigs: string[]) =>
  [`t=${String(t)}`, ...sigs.map((s) => `v1=${s}`)].join(',');

const reasonOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof WebhookSignatureError) return e.reason;
    throw e;
  }
  return 'accepted';
};

describe('SS-UC03-06 Stripe webhook signature', () => {
  it('SS-UC03-06: Invalid or replayed webhook rejected — a bad signature and a timestamp outside tolerance are both refused', () => {
    const bad = hmac(other, NOW, body);
    expect(reasonOf(() => verifyStripeSignature(body, header(NOW, bad), [secret], NOW))).toBe(
      'no_matching_signature',
    );
    const stale = NOW - WEBHOOK_TOLERANCE_SECONDS - 1;
    expect(
      reasonOf(() =>
        verifyStripeSignature(body, header(stale, hmac(secret, stale, body)), [secret], NOW),
      ),
    ).toBe('timestamp_outside_tolerance');
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it('SS-UC03-06 a correctly signed body within the window is accepted, on the edge of the window too', () => {
    expect(
      reasonOf(() =>
        verifyStripeSignature(body, header(NOW, hmac(secret, NOW, body)), [secret], NOW),
      ),
    ).toBe('accepted');
    const edge = NOW - WEBHOOK_TOLERANCE_SECONDS;
    expect(
      reasonOf(() =>
        verifyStripeSignature(
          Buffer.from(body),
          header(edge, hmac(secret, edge, body)),
          [secret],
          NOW,
        ),
      ),
    ).toBe('accepted');
  });

  it('SS-UC03-06 a timestamp too far in the future is refused (clock skew either way)', () => {
    const ahead = NOW + WEBHOOK_TOLERANCE_SECONDS + 1;
    expect(
      reasonOf(() =>
        verifyStripeSignature(body, header(ahead, hmac(secret, ahead, body)), [secret], NOW),
      ),
    ).toBe('timestamp_outside_tolerance');
  });

  it('SS-UC03-06 a tampered body or a signature over another timestamp is refused', () => {
    const sig = hmac(secret, NOW, body);
    expect(
      reasonOf(() =>
        verifyStripeSignature(
          body.replace('pi_1Test', 'pi_1Evil'),
          header(NOW, sig),
          [secret],
          NOW,
        ),
      ),
    ).toBe('no_matching_signature');
    // The timestamp is part of what is signed: moving t invalidates the signature.
    expect(reasonOf(() => verifyStripeSignature(body, header(NOW - 1, sig), [secret], NOW))).toBe(
      'no_matching_signature',
    );
  });

  it('SS-UC03-06 any of several v1 signatures may match (secret roll), and any configured secret may sign', () => {
    const h = header(NOW, hmac(other, NOW, body), hmac(secret, NOW, body));
    expect(reasonOf(() => verifyStripeSignature(body, h, [secret], NOW))).toBe('accepted');
    expect(
      reasonOf(() =>
        verifyStripeSignature(body, header(NOW, hmac(other, NOW, body)), [secret, other], NOW),
      ),
    ).toBe('accepted');
  });

  it('SS-UC03-06 missing, malformed or v0-only headers and an empty secret list are refused', () => {
    expect(reasonOf(() => verifyStripeSignature(body, undefined, [secret], NOW))).toBe(
      'missing_header',
    );
    expect(reasonOf(() => verifyStripeSignature(body, 'garbage', [secret], NOW))).toBe(
      'malformed_header',
    );
    expect(
      reasonOf(() => verifyStripeSignature(body, `t=abc,v1=${'0'.repeat(64)}`, [secret], NOW)),
    ).toBe('malformed_header');
    expect(
      reasonOf(() =>
        verifyStripeSignature(
          body,
          `t=${String(NOW)},v0=${hmac(secret, NOW, body)}`,
          [secret],
          NOW,
        ),
      ),
    ).toBe('no_signatures');
    expect(
      reasonOf(() => verifyStripeSignature(body, header(NOW, hmac(secret, NOW, body)), [], NOW)),
    ).toBe('not_configured');
    // A short or non-hex v1 never reaches a length-mismatched comparison.
    expect(reasonOf(() => verifyStripeSignature(body, header(NOW, 'abc'), [secret], NOW))).toBe(
      'no_matching_signature',
    );
  });

  it('SS-UC03-06 only a JSON event object parses', () => {
    expect(parseStripeEvent(body).id).toBe('evt_1TestSignature');
    expect(() => parseStripeEvent('[1]')).toThrow(WebhookSignatureError);
    expect(() => parseStripeEvent('{"id":"x"}')).toThrow(WebhookSignatureError);
    expect(() => parseStripeEvent('not json')).toThrow(WebhookSignatureError);
  });
});
