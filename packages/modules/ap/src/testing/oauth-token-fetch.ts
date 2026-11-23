/**
 * Recorded OAuth token-endpoint answers for tests (T-0216, RQ-0187). `recordedTokenFetch` is a
 * `fetch` stand-in: it records each request (URL, method, form fields, redirect mode) and answers
 * the next queued recorded response. Nothing touches the network.
 */
import { readFileSync } from 'node:fs';

export type RecordedName =
  | 'microsoft_code'
  | 'microsoft_refresh'
  | 'microsoft_invalid_grant'
  | 'google_code'
  | 'google_refresh'
  | 'google_invalid_grant'
  | 'server_error';

interface Recorded {
  status: number;
  body: Record<string, unknown>;
}

const RECORDED = JSON.parse(
  readFileSync(new URL('./fixtures/oauth/recorded-token-responses.json', import.meta.url), 'utf8'),
) as Record<RecordedName, Recorded>;

/** The recorded JSON body of `name` (to compare tokens in assertions). */
export function recordedBody(name: RecordedName): Record<string, unknown> {
  return structuredClone(RECORDED[name].body);
}

export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly redirect: string | undefined;
  readonly contentType: string | null;
  readonly form: Record<string, string>;
}

export type Answer = RecordedName | Response | (() => Promise<Response>);

export interface RecordedTokenFetch {
  readonly fetch: typeof fetch;
  readonly seen: SeenRequest[];
  /** Queue answers, used in order; a request with nothing queued fails the test. */
  queue(...answers: Answer[]): void;
}

export function recordedTokenFetch(): RecordedTokenFetch {
  const seen: SeenRequest[] = [];
  const answers: Answer[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    seen.push({
      url,
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
      contentType: headers.get('content-type'),
      form: Object.fromEntries(new URLSearchParams(body)),
    });
    const next = answers.shift();
    if (next === undefined) throw new Error(`recordedTokenFetch: no answer queued for ${url}`);
    if (typeof next === 'function') return next();
    if (next instanceof Response) return next;
    const r = RECORDED[next];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return {
    fetch: f as typeof fetch,
    seen,
    queue: (...a) => {
      answers.push(...a);
    },
  };
}
