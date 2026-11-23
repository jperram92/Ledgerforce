/**
 * Route-scoped raw body reader for the Mailgun inbound webhook (T-0215, ADR-0099 + addendum,
 * RQ-0181 F6, security review r11 F1/F4).
 *
 * `POST /webhooks/mailgun/messages.mime` carries a whole email as multipart/form-data, which no
 * Nest parser reads, and nothing about the request is authenticated until the form is parsed. So
 * the reader bounds what an anonymous client can make the process hold, before reading a byte:
 *
 * - media type must be multipart/form-data with no content encoding (415);
 * - at most `maxInFlight` uploads of this route at once, and at most `maxBufferedBytes` reserved
 *   across them (a declared Content-Length is reserved up front; a chunked body is reserved per
 *   chunk at twice its size, for the final copy). Over either: 503 `inbound_busy` + Retry-After
 *   (Mailgun retries anything but 406). The reservation is held until the response is sent;
 * - at most `maxBytes` per request, by Content-Length or by count (413);
 * - the body must arrive within `timeoutMs` (408);
 * - with a Content-Length the body is read into one buffer of that size (no chunk list + copy);
 *   a body longer or shorter than declared is refused (400).
 *
 * Every refusal answers `Connection: close` and stops reading (r11 F4): the socket is not kept
 * alive to drain an unbounded body. Registered after applySecurity, so headers and the route's own
 * `inbound_email` rate class run first. When the route is not configured nothing is read.
 */
import { INBOUND_BODY_LIMIT } from '@ledgerforce/ap';
import type { NextFunction, Request, Response } from 'express';

export const MAILGUN_INBOUND_PATH = /^\/webhooks\/mailgun\/messages\.mime\/?$/i;

export interface InboundBodyLimits {
  readonly maxBytes: number;
  readonly maxInFlight: number;
  readonly maxBufferedBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_INBOUND_BODY_LIMITS: InboundBodyLimits = {
  maxBytes: INBOUND_BODY_LIMIT,
  maxInFlight: 4,
  maxBufferedBytes: 64 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** Seconds Mailgun (or any client) is asked to wait when the route is busy. */
const RETRY_AFTER_SECONDS = 30;

const bodies = new WeakMap<Request, Buffer>();

/** The bytes read for this request, if the reader ran. */
export const inboundBodyOf = (req: Request): Buffer | undefined => bodies.get(req);

export function inboundWebhookBody(enabled: boolean, overrides: Partial<InboundBodyLimits> = {}) {
  const limits: InboundBodyLimits = { ...DEFAULT_INBOUND_BODY_LIMITS, ...overrides };
  let inFlight = 0;
  let reserved = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || req.method !== 'POST' || !MAILGUN_INBOUND_PATH.test(req.path)) {
      next();
      return;
    }
    let finished = false;
    let held = 0;
    let counted = false;
    const timer: { t?: NodeJS.Timeout } = {};
    const release = (): void => {
      if (counted) {
        counted = false;
        inFlight -= 1;
      }
      reserved -= held;
      held = 0;
    };
    const reserve = (n: number): boolean => {
      if (reserved + n > limits.maxBufferedBytes) return false;
      reserved += n;
      held += n;
      return true;
    };
    const refuse = (status: number, error: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer.t);
      req.pause();
      release();
      // Never keep this socket alive to drain an upload nobody will use (r11 F4).
      res.setHeader('Connection', 'close');
      if (status === 503) res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      res.status(status).json({ error });
      // Once the answer is out, drop the connection even if the client keeps sending.
      res.once('finish', () => {
        setTimeout(() => req.socket.destroy(), 1000).unref();
      });
    };

    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (type !== 'multipart/form-data' || encoding !== 'identity') {
      refuse(415, 'unsupported_media_type');
      return;
    }
    const declaredHeader = req.headers['content-length'];
    const declared =
      declaredHeader !== undefined && /^\d{1,15}$/.test(declaredHeader)
        ? Number.parseInt(declaredHeader, 10)
        : declaredHeader === undefined
          ? null
          : -1;
    if (declared === -1 || (declared !== null && declared > limits.maxBytes)) {
      refuse(413, 'payload_too_large');
      return;
    }
    if (inFlight >= limits.maxInFlight || (declared !== null && !reserve(declared))) {
      refuse(503, 'inbound_busy');
      return;
    }
    inFlight += 1;
    counted = true;
    // Held until the answer is sent (or the client goes away): the buffer lives that long.
    res.once('finish', release);
    res.once('close', release);
    timer.t = setTimeout(() => refuse(408, 'request_timeout'), limits.timeoutMs);

    const fixed = declared !== null ? Buffer.allocUnsafe(declared) : null;
    let offset = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (fixed) {
        if (offset + chunk.length > fixed.length) {
          refuse(400, 'length_mismatch');
          return;
        }
        chunk.copy(fixed, offset);
        offset += chunk.length;
        return;
      }
      if (offset + chunk.length > limits.maxBytes) {
        chunks.length = 0;
        refuse(413, 'payload_too_large');
        return;
      }
      if (!reserve(2 * chunk.length)) {
        chunks.length = 0;
        refuse(503, 'inbound_busy');
        return;
      }
      chunks.push(chunk);
      offset += chunk.length;
    });
    req.on('error', () => {
      if (finished) return;
      chunks.length = 0;
      refuse(400, 'request_aborted');
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer.t);
      if (fixed && offset !== fixed.length) {
        finished = false;
        refuse(400, 'length_mismatch');
        return;
      }
      bodies.set(req, fixed ?? Buffer.concat(chunks, offset));
      chunks.length = 0;
      next();
    });
  };
}
