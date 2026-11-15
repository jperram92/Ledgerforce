/**
 * A local HTTP stub of the Stripe API that replays request/response pairs from a fixture file
 * (RQ-0115). Each incoming request is matched by method, path and Idempotency-Key, then its form
 * body, Stripe-Version and test-mode bearer key are compared with the fixture; a mismatch answers
 * 400 and is listed in `mismatches`, so a contract test fails if the client's request drifts.
 * Replaying a key returns the same response, as Stripe does for idempotent retries. Test use only;
 * the network is never contacted and the bearer key is never stored.
 *
 * GET requests (list endpoints, RQ-0164) carry no Idempotency-Key and no body: their query string
 * is the "form", and a GET interaction matches only on its exact query. An interaction with
 * `times` answers at most that many requests, after which the next matching one answers, so a
 * fixture can say "the list is empty until the refund is created".
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedInteraction {
  readonly name: string;
  readonly request: {
    readonly method: 'POST' | 'GET';
    readonly path: string;
    /** Required for POST; a GET carries none. */
    readonly idempotencyKey?: string;
    readonly form: Readonly<Record<string, string>>;
  };
  readonly response: { readonly status: number; readonly body: unknown };
  /** Answer at most this many requests (then the next matching interaction answers). */
  readonly times?: number;
}

export interface RecordedCassette {
  readonly source: string;
  readonly apiVersion: string;
  readonly interactions: readonly RecordedInteraction[];
}

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly stripeVersion: string | null;
  readonly form: Record<string, string>;
  /** Name of the fixture interaction answered, or null when nothing matched. */
  readonly matched: string | null;
}

export interface RecordedStripe {
  /** Base URL to give the client, e.g. http://127.0.0.1:12345 */
  readonly url: string;
  readonly received: ReceivedRequest[];
  readonly mismatches: string[];
  /** Placeholder values ({{name}} in the fixture); set before the matching request is sent. */
  readonly vars: Record<string, string>;
  close(): Promise<void>;
}

export function loadCassette(path: string | URL): RecordedCassette {
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedCassette;
}

const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);

const fillDeep = (v: unknown, vars: Record<string, string>): unknown =>
  JSON.parse(fill(JSON.stringify(v), vars)) as unknown;

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
};

export async function startRecordedStripe(cassette: RecordedCassette): Promise<RecordedStripe> {
  const received: ReceivedRequest[] = [];
  const mismatches: string[] = [];
  const vars: Record<string, string> = {};

  const used = new Map<RecordedInteraction, number>();
  const sameForm = (want: Record<string, string>, got: Record<string, string>) =>
    [...new Set([...Object.keys(want), ...Object.keys(got)])].every((k) => want[k] === got[k]);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await body(req);
      const isGet = req.method === 'GET';
      const url = new URL(req.url ?? '', 'http://stub.invalid');
      const form = Object.fromEntries(isGet ? url.searchParams : new URLSearchParams(raw));
      const path = isGet ? url.pathname : (req.url ?? '');
      const key = header(req, 'idempotency-key');
      const version = header(req, 'stripe-version');
      const auth = header(req, 'authorization') ?? '';
      const problems: string[] = [];
      const hit = cassette.interactions.find(
        (i) =>
          i.request.method === req.method &&
          fill(i.request.path, vars) === path &&
          (i.request.idempotencyKey === undefined
            ? key === null
            : fill(i.request.idempotencyKey, vars) === key) &&
          (!isGet || sameForm(fillDeep(i.request.form, vars) as Record<string, string>, form)) &&
          (i.times === undefined || (used.get(i) ?? 0) < i.times),
      );
      if (!hit) problems.push(`no fixture for ${String(req.method)} ${path} key=${String(key)}`);
      if (!/^Bearer (sk|rk)_test_\S+$/.test(auth)) problems.push('not a test-mode bearer key');
      if (version !== cassette.apiVersion) problems.push(`Stripe-Version ${String(version)}`);
      if (isGet) {
        if (raw !== '') problems.push('a GET with a body');
      } else if (header(req, 'content-type') !== 'application/x-www-form-urlencoded') {
        problems.push(`content-type ${String(header(req, 'content-type'))}`);
      }
      if (hit && !isGet) {
        const want = fillDeep(hit.request.form, vars) as Record<string, string>;
        const keys = new Set([...Object.keys(want), ...Object.keys(form)]);
        for (const k of keys) {
          if (want[k] !== form[k]) {
            problems.push(
              `${k}: sent ${JSON.stringify(form[k])}, fixture ${JSON.stringify(want[k])}`,
            );
          }
        }
      }
      received.push({
        method: req.method ?? '',
        path,
        idempotencyKey: key,
        stripeVersion: version,
        form,
        matched: problems.length === 0 && hit ? hit.name : null,
      });
      res.setHeader('content-type', 'application/json');
      if (problems.length > 0 || !hit) {
        mismatches.push(...problems);
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: `fixture mismatch: ${problems.join('; ')}`,
            },
          }),
        );
        return;
      }
      used.set(hit, (used.get(hit) ?? 0) + 1);
      res.statusCode = hit.response.status;
      res.end(JSON.stringify(fillDeep(hit.response.body, vars)));
    })().catch((e: unknown) => {
      mismatches.push(`stub failure: ${String(e)}`);
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    mismatches,
    vars,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
