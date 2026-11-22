/**
 * Route-scoped raw body reader for the Mailgun inbound webhook (T-0215, ADR-0099, RQ-0181 F6).
 *
 * `POST /webhooks/mailgun/messages.mime` carries a whole email as multipart/form-data, which no
 * Nest parser reads. This middleware refuses any other media type (415) or a content encoding
 * (415) before reading, refuses more than INBOUND_BODY_LIMIT bytes by `Content-Length` or by
 * running count (413), and keeps the bytes for the controller — the multipart and MIME parsers
 * run only there, after the size check. Registered after applySecurity, so headers and the
 * `/webhooks/*` rate limit run before any byte is read (statement-body pattern, ADR-0078).
 * When the route is not configured the body is not read at all (the controller answers 503).
 */
import { INBOUND_BODY_LIMIT } from '@ledgerforce/ap';
import type { NextFunction, Request, Response } from 'express';

export const MAILGUN_INBOUND_PATH = /^\/webhooks\/mailgun\/messages\.mime\/?$/i;

const bodies = new WeakMap<Request, Buffer>();

/** The bytes read for this request, if the reader ran. */
export const inboundBodyOf = (req: Request): Buffer | undefined => bodies.get(req);

export function inboundWebhookBody(enabled: boolean, limit: number = INBOUND_BODY_LIMIT) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || req.method !== 'POST' || !MAILGUN_INBOUND_PATH.test(req.path)) {
      next();
      return;
    }
    let finished = false;
    const refuse = (status: number, error: string): void => {
      finished = true;
      // Read and drop the rest of the upload so the client can read the answer; keep nothing.
      req.resume();
      if (status === 413) res.setHeader('Connection', 'close');
      res.status(status).json({ error });
    };
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (type !== 'multipart/form-data' || encoding !== 'identity') {
      refuse(415, 'unsupported_media_type');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
      refuse(413, 'payload_too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        refuse(413, 'payload_too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      if (!res.headersSent) res.status(400).json({ error: 'request_aborted' });
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      bodies.set(req, Buffer.concat(chunks));
      chunks.length = 0;
      next();
    });
  };
}
