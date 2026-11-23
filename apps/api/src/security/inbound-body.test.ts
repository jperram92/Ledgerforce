/**
 * T-0230 (api-unit) — slow-upload protection on the Mailgun inbound route (RQ-0186, DL-0898 N1):
 * one upload in flight per client address, a first-byte timeout and a minimum average transfer
 * rate, each refusal closing the connection and freeing its slots. Time is driven with fake
 * timers against a fake request/response pair; the trusted-proxy tests use a real Express server
 * and wait on events, never on sleeps.
 */
import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INBOUND_BODY_LIMITS, inboundWebhookBody } from './inbound-body.ts';
import { clientAddress } from './rate-limit.ts';
import { applySecurity } from './security.ts';

@Module({})
class EmptyModule {}

const PATH = '/webhooks/mailgun/messages.mime';
const MULTIPART = 'multipart/form-data; boundary=x';

interface Upload {
  req: Request;
  res: Response;
  socket: { destroyed: boolean };
  /** True once the reader handed the request on (the whole body arrived). */
  passed: () => boolean;
  /** The refusal (or answer) sent, if any. */
  answer: () => { status: number; body: unknown; headers: Record<string, string> } | null;
  send: (bytes: number) => void;
  end: () => void;
  /** The client goes away before an answer. */
  abort: () => void;
  /** The app answers a request the reader passed on. */
  reply: (status?: number) => void;
}

function start(
  mw: ReturnType<typeof inboundWebhookBody>,
  opts: { ip?: string; length?: number | null } = {},
): Upload {
  const socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const headers: Record<string, string> = { 'content-type': MULTIPART };
  const length = opts.length === undefined ? 1024 : opts.length;
  if (length !== null) headers['content-length'] = String(length);
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    path: PATH,
    headers,
    ip: opts.ip ?? '203.0.113.7',
    socket,
    pause: () => undefined,
  }) as unknown as Request;
  const sent: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  let answered = false;
  const resEmitter = new EventEmitter();
  const res = Object.assign(resEmitter, {
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      answered = true;
      resEmitter.emit('finish');
      resEmitter.emit('close');
      return res;
    },
  }) as unknown as Response;
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  mw(req, res, next);
  return {
    req,
    res,
    socket,
    passed: () => passed,
    answer: () => (answered ? sent : null),
    send: (bytes) => {
      req.emit('data', Buffer.alloc(bytes, 0x41));
    },
    end: () => {
      req.emit('end');
    },
    abort: () => {
      req.emit('aborted');
      resEmitter.emit('close');
    },
    reply: (status = 200) => {
      res.status(status).json({ received: true });
    },
  };
}

describe('T-0230 slow-upload protection (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-23T00:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('SS-PLAT-186 at most one upload in flight per client address', () => {
    it('SS-PLAT-186 AC-1 a second concurrent upload from the same address is refused 503 + Retry-After without taking a global slot [T-0230]', () => {
      const mw = inboundWebhookBody(true, { maxInFlight: 2 });
      const first = start(mw, { ip: '198.51.100.1' });
      first.send(10);
      const second = start(mw, { ip: '198.51.100.1' });
      expect(second.answer()).toMatchObject({
        status: 503,
        body: { error: 'inbound_busy' },
        headers: { connection: 'close' },
      });
      expect(Number(second.answer()?.headers['retry-after'])).toBeGreaterThan(0);
      // The refused upload took no global slot: another address still gets the second one.
      expect(mw.stats()).toEqual({ inFlight: 1, reservedBytes: 1024, clients: 1 });
      const other = start(mw, { ip: '198.51.100.2' });
      expect(other.answer()).toBeNull();
      expect(mw.stats()).toEqual({ inFlight: 2, reservedBytes: 2048, clients: 2 });
      // The first upload is unaffected and, once answered, frees its address.
      first.send(1014);
      first.end();
      expect(first.passed()).toBe(true);
      first.reply();
      const again = start(mw, { ip: '198.51.100.1' });
      expect(again.answer()).toBeNull();
      expect(mw.stats().clients).toBe(2);
    });

    it('SS-PLAT-186 AC-1 IPv4-mapped IPv6 and plain IPv4 spellings are the same client [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      start(mw, { ip: '::ffff:198.51.100.9' });
      expect(start(mw, { ip: '198.51.100.9' }).answer()?.status).toBe(503);
    });

    it('SS-PLAT-186 AC-1 the per-client cap is configurable and must lie between 1 and the global cap [T-0230]', () => {
      const mw = inboundWebhookBody(true, { maxInFlight: 4, maxInFlightPerClient: 2 });
      start(mw, { ip: '198.51.100.3' });
      expect(start(mw, { ip: '198.51.100.3' }).answer()).toBeNull();
      expect(start(mw, { ip: '198.51.100.3' }).answer()?.status).toBe(503);
      expect(() => inboundWebhookBody(true, { maxInFlightPerClient: 0 })).toThrow(/per client/i);
      expect(() => inboundWebhookBody(true, { maxInFlight: 2, maxInFlightPerClient: 3 })).toThrow(
        /per client/i,
      );
    });

    it('SS-PLAT-186 AC-1 defaults: one per client, first byte 3 s, 64 KiB/s after 5 s (RQ-0186 F2) [T-0230]', () => {
      expect(DEFAULT_INBOUND_BODY_LIMITS).toMatchObject({
        maxInFlight: 4,
        maxInFlightPerClient: 1,
        firstByteTimeoutMs: 3_000,
        minBytesPerSecond: 64 * 1024,
        minRateGraceMs: 5_000,
        timeoutMs: 60_000,
      });
    });
  });

  describe('SS-PLAT-187 a slow or silent upload is aborted with Connection: close and its slots released', () => {
    it('SS-PLAT-187 AC-2 no first byte within the first-byte timeout answers 408 first_byte_timeout and frees both slots [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      const silent = start(mw, { ip: '198.51.100.4' });
      vi.advanceTimersByTime(2_999);
      expect(silent.answer()).toBeNull();
      vi.advanceTimersByTime(1);
      expect(silent.answer()).toMatchObject({
        status: 408,
        body: { error: 'first_byte_timeout' },
        headers: { connection: 'close' },
      });
      expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
      vi.advanceTimersByTime(1_000);
      expect(silent.socket.destroyed).toBe(true);
    });

    it('SS-PLAT-187 AC-2 an upload averaging under 64 KiB/s after the first 5 s answers 408 upload_too_slow [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      const slow = start(mw, { ip: '198.51.100.5', length: 8 * 1024 * 1024 });
      // 60 KiB/s: under the floor once the grace period is over.
      for (let s = 0; s < 5 && slow.answer() === null; s += 1) {
        slow.send(60 * 1024);
        vi.advanceTimersByTime(1_000);
      }
      expect(slow.answer()).toMatchObject({
        status: 408,
        body: { error: 'upload_too_slow' },
        headers: { connection: 'close' },
      });
      expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
    });

    it('SS-PLAT-187 AC-2 an upload at or above the floor is not aborted by the rate check [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      const steady = start(mw, { ip: '198.51.100.6', length: 20 * 70 * 1024 });
      for (let s = 0; s < 20; s += 1) {
        steady.send(70 * 1024);
        vi.advanceTimersByTime(1_000);
        expect(steady.answer()).toBeNull();
      }
      steady.end();
      expect(steady.passed()).toBe(true);
    });

    it('SS-PLAT-187 AC-2 a chunked (no Content-Length) trickle is aborted the same way [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      const chunked = start(mw, { ip: '198.51.100.7', length: null });
      chunked.send(1);
      vi.advanceTimersByTime(6_000);
      expect(chunked.answer()?.body).toEqual({ error: 'upload_too_slow' });
      expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
    });

    it('SS-PLAT-187 AC-2 no slot leaks: after silent, slow, aborted, refused, mismatched and completed uploads every counter is back to zero [T-0230]', () => {
      const mw = inboundWebhookBody(true, { maxInFlight: 4 });
      const ips = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4'] as const;
      for (let round = 0; round < 25; round += 1) {
        const silent = start(mw, { ip: ips[0] });
        const slow = start(mw, { ip: ips[1] });
        slow.send(1);
        const aborted = start(mw, { ip: ips[2], length: null });
        aborted.send(100);
        aborted.abort();
        const busy = start(mw, { ip: ips[1] });
        expect(busy.answer()?.status).toBe(503);
        const mismatch = start(mw, { ip: ips[2], length: 10 });
        mismatch.send(11);
        expect(mismatch.answer()?.status).toBe(400);
        const ok = start(mw, { ip: ips[3], length: 10 });
        ok.send(10);
        ok.end();
        ok.reply();
        vi.advanceTimersByTime(6_000);
        expect(silent.answer()?.status).toBe(408);
        expect(slow.answer()?.status).toBe(408);
        expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
      }
      // Every slot is still usable: four addresses get four uploads.
      for (const ip of ips) expect(start(mw, { ip }).answer()).toBeNull();
      expect(mw.stats()).toMatchObject({ inFlight: 4, clients: 4 });
      // And no timer of a finished upload is left behind.
      vi.advanceTimersByTime(10_000);
      expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
    });
  });

  describe('SS-PLAT-188 a trickling upload is refused long before the 60 s body timeout; a normal delivery afterwards lands', () => {
    it('SS-PLAT-188 AC-3 one byte every 500 ms is refused within 6 s; the next delivery from the same address is passed on and answered 200 [T-0230]', () => {
      const mw = inboundWebhookBody(true);
      const ip = '198.51.100.8';
      const trickle = start(mw, { ip, length: 4096 });
      const t0 = Date.now();
      while (trickle.answer() === null && Date.now() - t0 < 61_000) {
        trickle.send(1);
        vi.advanceTimersByTime(500);
      }
      expect(Date.now() - t0).toBeLessThanOrEqual(6_000);
      expect(trickle.answer()).toMatchObject({
        status: 408,
        body: { error: 'upload_too_slow' },
        headers: { connection: 'close' },
      });
      const normal = start(mw, { ip, length: 4096 });
      normal.send(4096);
      normal.end();
      expect(normal.passed()).toBe(true);
      expect(normal.req.listenerCount('data')).toBeGreaterThan(0);
      normal.reply(200);
      expect(normal.answer()?.status).toBe(200);
      expect(mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
    });
  });
});

describe('SS-PLAT-186 the client address comes from the trusted-proxy setting, never from X-Forwarded-For alone', () => {
  // The production wiring: Nest + Express with applySecurity's `trust proxy` hop count.
  async function serve(trustProxyHops: number) {
    const app = await NestFactory.create(EmptyModule, { logger: false });
    applySecurity(app, { trustProxyHops });
    const mw = inboundWebhookBody(true, { maxInFlight: 4, firstByteTimeoutMs: 30_000 });
    const arrived: (() => void)[] = [];
    // Every request is completed before the server closes, so a failed assertion cannot hang it.
    const finishers: (() => void)[] = [];
    app.use((req: Request, res: Response, next: NextFunction) => {
      mw(req, res, next);
      // The reader counts the request synchronously; signal its arrival after that.
      arrived.shift()?.();
    });
    app.use((_req: Request, res: Response) => {
      res.json({ received: true });
    });
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const ready = Promise.resolve(port);
    const post = (
      forwardedFor: string,
      hold: boolean,
    ): {
      counted: Promise<void>;
      done: Promise<{ status: number; headers: IncomingHttpHeaders }>;
      finish: () => void;
    } => {
      let finish = () => {};
      const counted = new Promise<void>((resolve) => arrived.push(resolve));
      const done = ready.then(
        (port) =>
          new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
            const r = httpRequest(
              {
                host: '127.0.0.1',
                port,
                path: PATH,
                method: 'POST',
                headers: {
                  'content-type': MULTIPART,
                  'content-length': '8',
                  'x-forwarded-for': forwardedFor,
                },
              },
              (res) => {
                res.resume();
                res.on('end', () => {
                  resolve({ status: res.statusCode ?? 0, headers: res.headers });
                });
                res.on('error', reject);
              },
            );
            r.on('error', () => {});
            r.write('1234');
            finish = () => r.end('5678');
            finishers.push(finish);
            if (!hold) finish();
          }),
      );
      return { counted, done, finish: () => finish() };
    };
    return {
      mw,
      post,
      close: async () => {
        for (const f of finishers) f();
        await app.close();
      },
    };
  }

  it('SS-PLAT-186 AC-1 with no trusted hop, uploads claiming different X-Forwarded-For from one socket address share one slot [T-0230]', async () => {
    const s = await serve(0);
    try {
      const first = s.post('10.0.0.1', true);
      await first.counted;
      const second = s.post('10.0.0.2', false);
      await second.counted;
      const res = await second.done;
      expect({ status: res.status, connection: res.headers.connection }).toEqual({
        status: 503,
        connection: 'close',
      });
      first.finish();
      expect((await first.done).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('SS-PLAT-186 AC-1 behind one trusted proxy, the forwarded address is the client: two addresses get two slots [T-0230]', async () => {
    const s = await serve(1);
    try {
      const first = s.post('10.0.0.1', true);
      await first.counted;
      const second = s.post('10.0.0.2', false);
      expect((await second.done).status).toBe(200);
      // A forged extra entry on the left is not trusted: the rightmost (proxy-added) one counts.
      const forged = s.post('10.9.9.9, 10.0.0.1', false);
      expect((await forged.done).status).toBe(503);
      first.finish();
      expect((await first.done).status).toBe(200);
      expect(s.mw.stats()).toEqual({ inFlight: 0, reservedBytes: 0, clients: 0 });
    } finally {
      await s.close();
    }
  });

  it('SS-PLAT-186 AC-1 the reader and the rate limiter use the same address helper [T-0230]', () => {
    expect(clientAddress({ ip: '::ffff:192.0.2.10' } as Request)).toBe('192.0.2.10');
    expect(clientAddress({ ip: '2001:db8::1' } as Request)).toBe('2001:db8::1');
    expect(clientAddress({ ip: undefined } as unknown as Request)).toBe('unknown');
  });
});
