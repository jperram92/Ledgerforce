/**
 * Minimal Stripe API client over fetch (RQ-0115, ADR-0048): form-encoded POSTs with a bearer
 * secret key, a pinned Stripe-Version and an Idempotency-Key on every write, and read-only GETs
 * with the parameters in the query string (List Refunds, RQ-0164). No SDK (no new
 * runtime dependency). Test mode unless the deployment is explicitly configured live: the key
 * prefix must match the mode, and every returned object's `livemode` must match too.
 * The key comes from the runtime environment (LF_STRIPE_SECRET_KEY) and never appears in errors.
 */

export const STRIPE_API_VERSION = '2026-10-28.endive';
export const STRIPE_API_BASE = 'https://api.stripe.com';

/** The transport (named for its first use): a POST with a form body, or a GET without a body. */
export type HttpPost = (
  url: string,
  init: { method: 'POST' | 'GET'; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Production transport: global fetch, no redirects. */
export const fetchHttpPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' });
  return { status: res.status, text: () => res.text() };
};

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

export class StripeApiError extends Error {
  /** HTTP status, or null when Stripe could not be reached. */
  readonly status: number | null;
  /** Stripe's error code (e.g. amount_too_small), or a local one (livemode_mismatch, …). */
  readonly stripeCode: string | null;
  readonly retryable: boolean;
  constructor(status: number | null, stripeCode: string | null, message: string) {
    super(`stripe request failed (${String(status ?? 'unreachable')}): ${message}`);
    this.name = 'StripeApiError';
    this.status = status;
    this.stripeCode = stripeCode;
    this.retryable = status === null || status === 429 || status >= 500;
  }
}

type FormValue = string | number | boolean | FormObject | readonly FormValue[];
interface FormObject {
  readonly [k: string]: FormValue | undefined;
}

/** Stripe's form encoding: nested objects and arrays as bracketed keys, in insertion order. */
export function formEncode(params: FormObject): string {
  const pairs: [string, string][] = [];
  const walk = (prefix: string, v: FormValue | undefined) => {
    if (v === undefined) return;
    if (Array.isArray(v)) {
      (v as readonly FormValue[]).forEach((x, i) => walk(`${prefix}[${String(i)}]`, x));
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as FormObject)) walk(prefix ? `${prefix}[${k}]` : k, x);
    } else {
      pairs.push([prefix, String(v)]);
    }
  };
  walk('', params);
  return new URLSearchParams(pairs).toString();
}

export interface CreatePaymentLink {
  /** ISO 4217; sent lower-case. */
  readonly currency: string;
  /** Integer cents as a decimal string (never a float). */
  readonly unitAmountCents: string;
  /** Product name shown on the Stripe payment page. */
  readonly name: string;
  /** Limit the link to one completed payment. */
  readonly singleUse?: boolean;
  readonly inactiveMessage?: string;
  /** Copied to the link, its Checkout Sessions and (via payment_intent_data) its PaymentIntents. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateRefund {
  readonly paymentIntentId: string;
  /** Integer cents as a decimal string (never a float). */
  readonly amountCents: string;
  readonly reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface Refund {
  readonly id: string;
  /** Integer cents as a decimal string. */
  readonly amountCents: string;
  /** ISO 4217, upper-case. */
  readonly currency: string;
  /** pending | requires_action | succeeded | failed | canceled. */
  readonly status: string;
}

/** A refund as List Refunds returns it (RQ-0164): with the metadata it was created with. */
export interface ListedRefund extends Refund {
  readonly paymentIntentId: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** List Refunds pages read before giving up (100 refunds a page): a PaymentIntent has far fewer. */
const MAX_LIST_PAGES = 20;

export interface PaymentLink {
  readonly id: string;
  readonly url: string;
  readonly active: boolean;
  readonly livemode: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A List Refunds item of `paymentIntentId`, or null when it is not one. */
function listedRefundOf(raw: unknown, paymentIntentId: string): ListedRefund | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { id, amount, currency, status } = o;
  const md = o['metadata'];
  if (
    typeof id !== 'string' ||
    !/^re_[A-Za-z0-9]+$/.test(id) ||
    o['object'] !== 'refund' ||
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    typeof currency !== 'string' ||
    typeof status !== 'string' ||
    o['payment_intent'] !== paymentIntentId ||
    (md !== null && (typeof md !== 'object' || Array.isArray(md)))
  ) {
    return null;
  }
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries((md ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') metadata[k] = v;
  }
  return {
    id,
    amountCents: String(amount),
    currency: currency.toUpperCase(),
    status,
    paymentIntentId,
    metadata,
  };
}

export class StripeClient {
  readonly mode: 'test' | 'live';
  readonly #key: string;
  readonly #base: string;
  readonly #http: HttpPost;

  constructor(cfg: {
    secretKey: string;
    mode?: 'test' | 'live';
    baseUrl?: string;
    http?: HttpPost;
  }) {
    this.mode = cfg.mode ?? 'test';
    const prefix = this.mode === 'live' ? /^(sk|rk)_live_\S+$/ : /^(sk|rk)_test_\S+$/;
    if (!prefix.test(cfg.secretKey)) {
      throw new StripeConfigError(
        `the Stripe secret key is not a ${this.mode}-mode key (expected sk_${this.mode}_… or rk_${this.mode}_…)`,
      );
    }
    const base = new URL(cfg.baseUrl ?? STRIPE_API_BASE);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.has(base.hostname))) {
      throw new StripeConfigError('the Stripe API base URL must be https (http only on loopback)');
    }
    this.#key = cfg.secretKey;
    this.#base = base.origin;
    this.#http = cfg.http ?? fetchHttpPost;
  }

  /** LF_STRIPE_SECRET_KEY (required) and LF_STRIPE_MODE (`test` by default, or `live`). */
  static fromEnv(env: Readonly<Record<string, string | undefined>>): StripeClient {
    const key = env['LF_STRIPE_SECRET_KEY'];
    if (!key)
      throw new StripeConfigError('LF_STRIPE_SECRET_KEY is required for Stripe payment links');
    const mode = env['LF_STRIPE_MODE'] ?? 'test';
    if (mode !== 'test' && mode !== 'live') {
      throw new StripeConfigError('LF_STRIPE_MODE must be test or live');
    }
    return new StripeClient({ secretKey: key, mode });
  }

  async createPaymentLink(p: CreatePaymentLink, idempotencyKey: string): Promise<PaymentLink> {
    if (!/^\d+$/.test(p.unitAmountCents)) {
      throw new StripeConfigError('unitAmountCents must be a non-negative integer string');
    }
    return this.#paymentLink(
      '/v1/payment_links',
      {
        line_items: [
          {
            price_data: {
              currency: p.currency.toLowerCase(),
              product_data: { name: p.name },
              unit_amount: p.unitAmountCents,
            },
            quantity: '1',
          },
        ],
        ...(p.singleUse ? { restrictions: { completed_sessions: { limit: '1' } } } : {}),
        ...(p.inactiveMessage ? { inactive_message: p.inactiveMessage } : {}),
        ...(p.metadata
          ? { metadata: p.metadata, payment_intent_data: { metadata: p.metadata } }
          : {}),
      },
      idempotencyKey,
    );
  }

  /** Deactivate a link so its URL can no longer be paid (it stays in Stripe). */
  async deactivatePaymentLink(id: string): Promise<PaymentLink> {
    if (!/^plink_[A-Za-z0-9]+$/.test(id)) throw new StripeConfigError('not a Payment Link id');
    return this.#paymentLink(`/v1/payment_links/${id}`, { active: false }, `lf-plink-off-v1-${id}`);
  }

  /**
   * Refund (part of) a PaymentIntent (RQ-0104 S6): `POST /v1/refunds` with `payment_intent`,
   * integer-cent `amount`, `reason`, `metadata` and an Idempotency-Key.
   */
  async createRefund(p: CreateRefund, idempotencyKey: string): Promise<Refund> {
    if (!/^pi_[A-Za-z0-9]+$/.test(p.paymentIntentId)) {
      throw new StripeConfigError('not a PaymentIntent id');
    }
    if (!/^[1-9]\d*$/.test(p.amountCents)) {
      throw new StripeConfigError('amountCents must be a positive integer string');
    }
    const { status, body } = await this.#post(
      '/v1/refunds',
      {
        payment_intent: p.paymentIntentId,
        amount: p.amountCents,
        reason: p.reason ?? 'requested_by_customer',
        ...(p.metadata ? { metadata: p.metadata } : {}),
      },
      idempotencyKey,
    );
    const id = body['id'];
    const amount = body['amount'];
    const currency = body['currency'];
    const st = body['status'];
    if (
      typeof id !== 'string' ||
      !/^re_[A-Za-z0-9]+$/.test(id) ||
      body['object'] !== 'refund' ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      typeof currency !== 'string' ||
      typeof st !== 'string' ||
      body['payment_intent'] !== p.paymentIntentId
    ) {
      throw new StripeApiError(
        status,
        'malformed_response',
        'not a Refund object for this payment',
      );
    }
    return { id, amountCents: String(amount), currency: currency.toUpperCase(), status: st };
  }

  /**
   * The first refund of a PaymentIntent that `match` accepts, or null (RQ-0164): `GET /v1/refunds`
   * with `payment_intent` and `limit=100`, following `starting_after` while `has_more`. Read-only;
   * a list longer than MAX_LIST_PAGES pages is refused (the caller must not assume "none").
   */
  async findRefund(
    paymentIntentId: string,
    match: (r: ListedRefund) => boolean,
  ): Promise<ListedRefund | null> {
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) {
      throw new StripeConfigError('not a PaymentIntent id');
    }
    let after: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const { status, body } = await this.#get('/v1/refunds', {
        payment_intent: paymentIntentId,
        limit: '100',
        ...(after ? { starting_after: after } : {}),
      });
      const data = body['data'];
      const more = body['has_more'];
      if (body['object'] !== 'list' || !Array.isArray(data) || typeof more !== 'boolean') {
        throw new StripeApiError(status, 'malformed_response', 'not a list of refunds');
      }
      let last: string | undefined;
      for (const raw of data as unknown[]) {
        const r = listedRefundOf(raw, paymentIntentId);
        if (!r) {
          throw new StripeApiError(status, 'malformed_response', 'not a Refund of this payment');
        }
        if (match(r)) return r;
        last = r.id;
      }
      if (!more) return null;
      if (!last) throw new StripeApiError(status, 'malformed_response', 'an empty page with more');
      after = last;
    }
    throw new StripeApiError(
      null,
      'too_many_refunds',
      `more than ${String(MAX_LIST_PAGES * 100)} refunds on ${paymentIntentId}; check Stripe by hand`,
    );
  }

  async #get(
    path: string,
    params: FormObject,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.#send(`${path}?${formEncode(params)}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.#key}`,
        'stripe-version': STRIPE_API_VERSION,
      },
    });
  }

  async #post(
    path: string,
    params: FormObject,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 255) {
      throw new StripeConfigError('an idempotency key is 1–255 characters');
    }
    return this.#send(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#key}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': STRIPE_API_VERSION,
        'idempotency-key': idempotencyKey,
      },
      body: formEncode(params),
    });
  }

  async #send(
    path: string,
    init: Parameters<HttpPost>[1],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#http(`${this.#base}${path}`, init);
    } catch {
      throw new StripeApiError(null, 'unreachable', 'the Stripe API could not be reached');
    }
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === 'object' && v !== null && !Array.isArray(v))
        body = v as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (body?.['error'] ?? {}) as Record<string, unknown>;
      const code = typeof err['code'] === 'string' ? err['code'] : null;
      const msg = typeof err['message'] === 'string' ? err['message'].slice(0, 300) : 'no message';
      throw new StripeApiError(res.status, code, msg);
    }
    return { status: res.status, body: body ?? {} };
  }

  async #paymentLink(
    path: string,
    params: FormObject,
    idempotencyKey: string,
  ): Promise<PaymentLink> {
    const { status, body } = await this.#post(path, params, idempotencyKey);
    const id = body['id'];
    const url = body['url'];
    const active = body['active'];
    const livemode = body['livemode'];
    if (
      typeof id !== 'string' ||
      typeof url !== 'string' ||
      !url.startsWith('https://') ||
      typeof active !== 'boolean' ||
      typeof livemode !== 'boolean'
    ) {
      throw new StripeApiError(status, 'malformed_response', 'not a Payment Link object');
    }
    if (livemode !== (this.mode === 'live')) {
      throw new StripeApiError(
        status,
        'livemode_mismatch',
        `a ${livemode ? 'live' : 'test'}-mode object was returned to a ${this.mode}-mode client`,
      );
    }
    return { id, url, active, livemode };
  }
}
