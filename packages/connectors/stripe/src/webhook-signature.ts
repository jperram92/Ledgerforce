/**
 * Stripe webhook signature verification (T-0074, RQ-0104 Q1/Q2, ADR-0049 rule 2).
 *
 * `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. The expected signature is
 * HMAC-SHA256(endpoint secret, `${t}.${raw body}`) in hex; the request is accepted when any v1
 * equals it for any configured secret (several during a secret roll), compared in constant time.
 * The timestamp must be within ±300 s of now (stricter than Stripe's SDK, which only bounds the
 * age): a captured request cannot be replayed later. Verify the raw bytes before parsing JSON.
 * Secrets come from configuration only and never appear in errors.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookSignatureReason =
  | 'not_configured'
  | 'missing_header'
  | 'malformed_header'
  | 'no_signatures'
  | 'no_matching_signature'
  | 'timestamp_outside_tolerance'
  | 'malformed_event';

export class WebhookSignatureError extends Error {
  readonly reason: WebhookSignatureReason;
  constructor(reason: WebhookSignatureReason) {
    super(`stripe webhook refused: ${reason}`);
    this.name = 'WebhookSignatureError';
    this.reason = reason;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Throws WebhookSignatureError unless `header` signs `rawBody` with one of `secrets` near `nowSeconds`. */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secrets: readonly string[],
  nowSeconds: number,
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): void {
  if (secrets.length === 0 || secrets.some((s) => s.length === 0)) {
    throw new WebhookSignatureError('not_configured');
  }
  if (!header) throw new WebhookSignatureError('missing_header');
  let t: number | null = null;
  const v1: string[] = [];
  for (const item of header.split(',')) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new WebhookSignatureError('malformed_header');
    const k = item.slice(0, eq).trim();
    const v = item.slice(eq + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v) || t !== null) throw new WebhookSignatureError('malformed_header');
      t = Number(v);
    } else if (k === 'v1') {
      v1.push(v.toLowerCase());
    }
  }
  if (t === null) throw new WebhookSignatureError('malformed_header');
  if (v1.length === 0) throw new WebhookSignatureError('no_signatures');

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const prefix = Buffer.from(`${String(t)}.`, 'utf8');
  const candidates = v1.filter((s) => HEX64.test(s)).map((s) => Buffer.from(s, 'hex'));
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(prefix).update(body).digest();
    for (const c of candidates) {
      // Equal lengths (32 bytes) are guaranteed by HEX64, so timingSafeEqual never throws.
      if (timingSafeEqual(c, expected)) matched = true;
    }
  }
  if (!matched) throw new WebhookSignatureError('no_matching_signature');
  if (Math.abs(nowSeconds - t) > toleranceSeconds) {
    throw new WebhookSignatureError('timestamp_outside_tolerance');
  }
}

/** The fields of a Stripe event this connector reads (RQ-0104 S3). */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly data: { readonly object: Record<string, unknown> };
}

/** Parse a verified body; anything but an event object is refused. */
export function parseStripeEvent(rawBody: Buffer | string): StripeEvent {
  let v: unknown;
  try {
    v = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    throw new WebhookSignatureError('malformed_event');
  }
  const e = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<
    string,
    unknown
  >;
  const data = e['data'] as Record<string, unknown> | undefined;
  const object = data?.['object'];
  if (
    typeof e['id'] !== 'string' ||
    !/^evt_[A-Za-z0-9]{1,250}$/.test(e['id']) ||
    e['object'] !== 'event' ||
    typeof e['type'] !== 'string' ||
    typeof e['created'] !== 'number' ||
    typeof e['livemode'] !== 'boolean' ||
    typeof object !== 'object' ||
    object === null ||
    Array.isArray(object)
  ) {
    throw new WebhookSignatureError('malformed_event');
  }
  return {
    id: e['id'],
    type: e['type'],
    created: e['created'],
    livemode: e['livemode'],
    data: { object: object as Record<string, unknown> },
  };
}
