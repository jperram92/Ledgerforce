/**
 * Salesforce REST sObject Collections client for the write-back (design §5.4, §5.6; RQ-0040;
 * ADR-0036). One call sends one planned request (≤ 200 records) and returns the ordered
 * per-record results. Non-2xx answers become a classified, secret-free SalesforceApiError; the
 * org's daily usage from `Sforce-Limit-Info` feeds the ApiUsageGate (design §5.6 rule 3).
 */
import type { CollectionRequest } from './batch.ts';

/** The package's API version (DL-0095); sObject Collections upsert needs ≥ 46.0 (RQ-0040 F5). */
export const SALESFORCE_REST_API_VERSION = '67.0';
export const MAX_COLLECTION_RECORDS = 200;

export type HttpRequest = (
  url: string,
  init: { method: 'PATCH'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; header(name: string): string | null; text(): Promise<string> }>;

/** Production client: global fetch, no redirects (a redirect would forward the bearer token). */
export const fetchHttpRequest: HttpRequest = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' });
  return { status: res.status, header: (n) => res.headers.get(n), text: () => res.text() };
};

export type SalesforceApiErrorKind =
  | 'session_expired'
  | 'unavailable'
  | 'rate_limited'
  | 'request_limit'
  | 'throttled'
  | 'rejected'
  | 'malformed_response';

const RETRYABLE: ReadonlySet<SalesforceApiErrorKind> = new Set([
  'session_expired',
  'unavailable',
  'rate_limited',
  'request_limit',
  'throttled',
]);

export class SalesforceApiError extends Error {
  readonly kind: SalesforceApiErrorKind;
  readonly status: number | null;
  readonly errorCode: string | null;
  readonly retryable: boolean;
  /** From a Retry-After header, if Salesforce sent one; the queue backoff still decides. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: SalesforceApiErrorKind,
    status: number | null,
    errorCode: string | null,
    detail: string | null,
    retryAfterSeconds: number | null = null,
  ) {
    super(
      `salesforce write-back failed (${kind}${status === null ? '' : ` ${String(status)}`}` +
        `${errorCode ? ` ${errorCode}` : ''})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'SalesforceApiError';
    this.kind = kind;
    this.status = status;
    this.errorCode = errorCode;
    this.retryable = RETRYABLE.has(kind);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Retry-After as delay-seconds or an HTTP-date (RFC 9110 §10.2.3); null when absent/invalid. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** `Sforce-Limit-Info: api-usage=used/max[; …]` (RQ-0040 S6). */
export function parseLimitInfo(value: string | null): { used: number; max: number } | null {
  const m = value === null ? null : /(?:^|[;\s])api-usage=(\d+)\/(\d+)/.exec(value);
  if (!m?.[1] || !m[2]) return null;
  return { used: Number.parseInt(m[1], 10), max: Number.parseInt(m[2], 10) };
}

export interface ApiUsageGateOptions {
  /** Share of the daily API allocation the write-back may use (design §5.6: default 25 %). */
  share?: number;
  /** A reading older than this no longer blocks: the next call sends and refreshes it. */
  staleAfterMs?: number;
  now?: () => Date;
}

/**
 * A budget share as integer basis points (1..10 000): `0.2500` → 2500. Accepts the database's
 * NUMERIC(5,4) text (at most four decimals).
 */
export function shareBasisPoints(share: string): number {
  const text = share.trim();
  const m = /^([01])(?:\.(\d{1,4}))?$/.exec(text);
  if (!m) throw new RangeError(`API budget share must be in (0, 1] with ≤ 4 decimals: ${text}`);
  const bp =
    Number.parseInt(m[1] ?? '0', 10) * 10_000 + Number.parseInt((m[2] ?? '').padEnd(4, '0'), 10);
  if (bp < 1 || bp > 10_000) throw new RangeError(`API budget share must be in (0, 1]: ${text}`);
  return bp;
}

/**
 * Self-throttle per org from the usage Salesforce reports on every answer. It never spends an
 * extra API call: when the last reading is at or above the share, sending is refused until the
 * reading goes stale, then one call goes out and brings a fresh reading. The share is the
 * connection's configured one when the caller passes it (data, migration 0030; T-0071), else the
 * gate's default. Compared in integers: used · 10 000 ≥ max · basis points.
 */
export class ApiUsageGate {
  readonly share: number;
  readonly #basisPoints: number;
  readonly #staleAfterMs: number;
  readonly #now: () => Date;
  readonly #readings = new Map<string, { used: number; max: number; at: number }>();

  constructor(opts: ApiUsageGateOptions = {}) {
    const share = opts.share ?? 0.25;
    if (!(share > 0 && share <= 1)) throw new RangeError('ApiUsageGate share must be in (0, 1]');
    this.share = share;
    this.#basisPoints = Math.max(1, Math.round(share * 10_000));
    this.#staleAfterMs = opts.staleAfterMs ?? 5 * 60_000;
    this.#now = opts.now ?? (() => new Date());
  }

  observe(instanceUrl: string, header: string | null): void {
    const r = parseLimitInfo(header);
    if (r) this.#readings.set(instanceUrl, { ...r, at: this.#now().getTime() });
  }

  assertWithinBudget(instanceUrl: string, share?: string): void {
    const r = this.#readings.get(instanceUrl);
    if (!r || this.#now().getTime() - r.at > this.#staleAfterMs) return;
    const bp = share === undefined ? this.#basisPoints : shareBasisPoints(share);
    if (r.used * 10_000 >= r.max * bp) {
      throw new SalesforceApiError(
        'throttled',
        null,
        null,
        `daily API usage ${String(r.used)}/${String(r.max)} reached the ${String(bp / 100)} % share`,
      );
    }
  }
}

export interface RestSession {
  http: HttpRequest;
  /** https://<my-domain>.my.salesforce.com, from the token grant. */
  instanceUrl: string;
  accessToken: string;
  apiVersion?: string;
  gate?: ApiUsageGate;
  /** The connection's configured share (NUMERIC text, e.g. `0.2500`); else the gate's default. */
  budgetShare?: string;
  now?: () => Date;
}

export interface RecordError {
  statusCode: string;
  message: string;
  fields: string[];
}
export interface RecordResult {
  id: string | null;
  success: boolean;
  created: boolean | null;
  errors: RecordError[];
}

function firstError(text: string): { errorCode: string | null; message: string | null } {
  try {
    const body: unknown = JSON.parse(text);
    const first: unknown = Array.isArray(body) ? body[0] : body;
    if (first && typeof first === 'object') {
      const f = first as Record<string, unknown>;
      return {
        errorCode: typeof f.errorCode === 'string' ? f.errorCode : null,
        message: typeof f.message === 'string' ? f.message.slice(0, 200) : null,
      };
    }
  } catch {
    // not JSON: an HTML maintenance page, an empty body …
  }
  return { errorCode: null, message: null };
}

/** Map a non-2xx answer to a stable kind (RQ-0040 F6). */
export function classifyHttpError(
  status: number,
  bodyText: string,
  retryAfter: number | null,
): SalesforceApiError {
  const { errorCode, message } = firstError(bodyText);
  let kind: SalesforceApiErrorKind;
  if (status === 401) kind = 'session_expired';
  else if (status === 429) kind = 'rate_limited';
  else if (status === 403 && errorCode === 'REQUEST_LIMIT_EXCEEDED') kind = 'request_limit';
  else if (status >= 500) kind = 'unavailable';
  else kind = 'rejected';
  return new SalesforceApiError(kind, status, errorCode, message, retryAfter);
}

function parseResults(text: string, expected: number): RecordResult[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!Array.isArray(body) || body.length !== expected) {
    throw new SalesforceApiError('malformed_response', 200, null, 'not one result per record');
  }
  return body.map((r: unknown) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    if (typeof o.success !== 'boolean') {
      throw new SalesforceApiError('malformed_response', 200, null, 'result without success');
    }
    const errors = Array.isArray(o.errors) ? (o.errors as Record<string, unknown>[]) : [];
    return {
      id: typeof o.id === 'string' ? o.id : null,
      success: o.success,
      created: typeof o.created === 'boolean' ? o.created : null,
      errors: errors.map((e) => ({
        statusCode: String(e.statusCode ?? 'UNKNOWN'),
        message: String(e.message ?? '').slice(0, 200),
        fields: Array.isArray(e.fields) ? e.fields.map(String) : [],
      })),
    };
  });
}

/** Send one planned request; per-record results come back in request order (RQ-0040 F1). */
export async function sendCollection(
  session: RestSession,
  request: CollectionRequest,
): Promise<RecordResult[]> {
  const version = session.apiVersion ?? SALESFORCE_REST_API_VERSION;
  const major = /^(\d+)\.0$/.exec(version)?.[1];
  if (!major || Number.parseInt(major, 10) < 46) {
    throw new RangeError('sObject Collections upsert needs API version 46.0 or later');
  }
  if (request.body.records.length > MAX_COLLECTION_RECORDS) {
    throw new RangeError(`at most ${String(MAX_COLLECTION_RECORDS)} records per request`);
  }
  session.gate?.assertWithinBudget(session.instanceUrl, session.budgetShare);
  const url = `${session.instanceUrl}/services/data/v${version}${request.path}`;
  let res: Awaited<ReturnType<HttpRequest>>;
  let text: string;
  try {
    res = await session.http(url, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: request.text,
    });
    text = await res.text();
  } catch {
    // Connection refused, reset, DNS, TLS: the org is unreachable — an outage.
    throw new SalesforceApiError('unavailable', null, null, 'Salesforce could not be reached');
  }
  session.gate?.observe(session.instanceUrl, res.header('sforce-limit-info'));
  if (res.status < 200 || res.status >= 300) {
    const now = session.now?.() ?? new Date();
    throw classifyHttpError(res.status, text, parseRetryAfter(res.header('retry-after'), now));
  }
  return parseResults(text, request.body.records.length);
}
