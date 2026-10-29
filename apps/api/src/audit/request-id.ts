import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE = /^[A-Za-z0-9._-]{1,64}$/;
const ids = new WeakMap<Request, string>();

/** Every request gets an id: the client's `x-request-id` if it is safe, otherwise a new UUID. Echoed back. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const given = req.headers['x-request-id'];
  const id = typeof given === 'string' && SAFE.test(given) ? given : randomUUID();
  ids.set(req, id);
  res.setHeader('x-request-id', id);
  next();
}

export function requestIdOf(req: Request): string | undefined {
  return ids.get(req);
}
