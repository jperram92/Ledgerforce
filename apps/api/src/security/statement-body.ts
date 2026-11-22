/**
 * Route-scoped JSON body reader for statement import (T-0161, ADR-0078, RQ-0151 option A).
 *
 * `POST /bank-rec/accounts/:id/statements` carries the statement file as base64 in JSON, so it
 * needs more than body-parser's 100 kB default. This middleware reads JSON bodies up to
 * STATEMENT_BODY_LIMIT for that one route and sets `req.body`; Nest's own JSON parser then skips
 * the request because its stream is already read (body-parser checks `onFinished.isFinished`).
 * Every other request passes through untouched and keeps the 100 kB default, so a spelling this
 * matcher does not recognise falls back to the smaller limit.
 *
 * Registered after applySecurity (headers, rate limits, CSRF; ADR-0054, ADR-0076), so those run
 * before any byte is read. Uses only Node APIs (no new runtime dependency, design §10.6).
 */
import type { NextFunction, Request, Response } from 'express';

/** 10 MB: the reverse proxy's client_max_body_size (RQ-0151 S5). */
export const STATEMENT_BODY_LIMIT = 10 * 1024 * 1024;

/** The import route as Express matches it: case-insensitive, optional trailing slash. */
export const STATEMENT_IMPORT_PATH = /^\/bank-rec\/accounts\/[^/]+\/statements\/?$/i;

function mediaType(req: Request): { type: string; charset: string | null } {
  const header = req.headers['content-type'] ?? '';
  const [type = '', ...params] = header.split(';').map((s) => s.trim().toLowerCase());
  const charset = params
    .map((p) => p.match(/^charset\s*=\s*"?([^";]+)"?$/)?.[1] ?? null)
    .find((c) => c !== null);
  return { type, charset: charset ?? null };
}

/**
 * A JSON reader with its own size limit for requests of `methods` (POST by default) whose path
 * matches `path`.
 * Refusals: 413 payload_too_large (declared or counted), 415 unsupported_content_encoding or
 * unsupported_charset, 400 invalid_json (malformed, or not an object or array at the top).
 */
export function scopedJsonBody(path: RegExp, limit: number, methods: readonly string[] = ['POST']) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!methods.includes(req.method) || !path.test(req.path)) {
      next();
      return;
    }
    const { type, charset } = mediaType(req);
    if (type !== 'application/json') {
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
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity') {
      refuse(415, 'unsupported_content_encoding');
      return;
    }
    if (charset !== null && charset !== 'utf-8' && charset !== 'utf8') {
      refuse(415, 'unsupported_charset');
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
      const text = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      if (text.trim() === '') {
        req.body = {};
        next();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
      if (typeof value !== 'object' || value === null) {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
      req.body = value;
      next();
    });
  };
}

/** The statement import route's reader (ADR-0078). */
export const statementImportBody = () =>
  scopedJsonBody(STATEMENT_IMPORT_PATH, STATEMENT_BODY_LIMIT);

/**
 * 1 MiB: a 512 KiB logo is 683 KiB as base64, plus the JSON keys (T-0195, ADR-0100, RQ-0182
 * finding 1).
 */
export const LOGO_BODY_LIMIT = 1024 * 1024;

/** The logo upload route as Express matches it: case-insensitive, optional trailing slash. */
export const LOGO_UPLOAD_PATH = /^\/setup\/billing\/logo\/?$/i;

/** The invoice logo upload route's reader (ADR-0100). */
export const logoUploadBody = () => scopedJsonBody(LOGO_UPLOAD_PATH, LOGO_BODY_LIMIT, ['PUT']);
