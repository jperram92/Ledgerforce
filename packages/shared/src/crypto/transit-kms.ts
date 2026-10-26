/**
 * OpenBao/Vault transit KMS adapter (T-0108, RQ-0042, ADR-0038). Wraps the envelope's data keys
 * with the transit engine over HTTP using Node's built-in `fetch` — no SDK, no runtime dependency.
 *
 * - Record binding: the key must be `aes256-gcm96` with `derived=true`; every call sends
 *   `context = base64("lf-kek-transit-v1|" + aad)`, so a wrapped key copied to another record
 *   fails GCM authentication inside OpenBao, and server-side rewrap still works (rewrap ignores
 *   `associated_data`, RQ-0042 Finding 5). `connect` refuses any other key (context on a
 *   non-derived key is silently ignored by the server, Finding 4).
 * - Storage: `wrapped` = the 60 bytes after `vault:v<N>:`; `keyId` = `tr.<key>.v<N>`. Both fit the
 *   existing sealed columns (migrations 0013, 0017).
 * - Transport: https only (http only for loopback with explicit opt-in); redirects refused (fetch
 *   would forward X-Vault-Token cross-origin, Finding 9); per-attempt timeout; 429/5xx/network
 *   errors retried with capped exponential full-jitter backoff honouring Retry-After; 4xx never.
 * - Secrets: tokens, AppRole credentials, data keys, AAD/context and server error bodies never
 *   appear in errors or log events. A private CA is given with NODE_EXTRA_CA_CERTS.
 */
import { DecryptionError, type Kms } from './envelope.ts';

export type TransitOp = 'connect' | 'login' | 'read_key' | 'encrypt' | 'decrypt' | 'rewrap';
export type TransitErrorKind =
  | 'config'
  | 'key_policy'
  | 'auth_failed'
  | 'permission_denied'
  | 'not_found'
  | 'bad_request'
  | 'unavailable'
  | 'timeout'
  | 'redirect_refused'
  | 'bad_response';

/** Operational failure talking to the transit engine. Carries no server text and no secrets. */
export class TransitKmsError extends Error {
  readonly op: TransitOp;
  readonly kind: TransitErrorKind;
  readonly status: number | undefined;

  constructor(op: TransitOp, kind: TransitErrorKind, status?: number, detail?: string) {
    const http = status === undefined ? '' : ` (HTTP ${String(status)})`;
    super(`transit ${op} failed: ${kind}${http}${detail ? ` — ${detail}` : ''}`);
    this.name = 'TransitKmsError';
    this.op = op;
    this.kind = kind;
    this.status = status;
  }
}

/** One structured log event per HTTP attempt. Never carries values, tokens or server bodies. */
export interface TransitKmsLogEvent {
  op: TransitOp;
  outcome: 'ok' | 'retry' | 'error';
  attempt: number;
  ms: number;
  status?: number;
  kind?: TransitErrorKind;
  /** Fixed classification of a 4xx body, e.g. `auth_failed`, `version_too_old`. */
  reason?: string;
}

export type TransitAuth =
  { token: string } | { appRole: { roleId: string; secretId: string; mount?: string } };

export interface TransitKmsOptions {
  /** `https://host:port` (no path, no credentials). */
  address: string;
  /** Transit key name, `[A-Za-z0-9_-]{1,48}`. */
  keyName: string;
  /** Transit mount path (default `transit`). */
  mount?: string;
  /** OpenBao/Vault namespace, sent as `X-Vault-Namespace`. */
  namespace?: string;
  auth: TransitAuth;
  /** Per-attempt timeout (default 5000 ms). */
  timeoutMs?: number;
  /** Attempts per request including the first (default 3). */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Allow `http:` for a loopback host (tests, `bao server -dev`). Default false. */
  allowInsecureLoopbackHttp?: boolean;
  log?: (event: TransitKmsLogEvent) => void;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const NAME = /^[A-Za-z0-9_-]{1,48}$/;
const PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const NAMESPACE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/;
const KEY_ID = /^tr\.([A-Za-z0-9_-]{1,48})\.v([1-9][0-9]{0,9})$/;
/** aes256-gcm96 wrap of a 32-byte key: nonce(12) ‖ ct(32) ‖ tag(16) = 60 bytes = 80 base64 chars. */
const CIPHERTEXT = /^vault:v([1-9][0-9]{0,9}):([A-Za-z0-9+/]{80})$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WRAPPED_BYTES = 60;
const DEK_BYTES = 32;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 1_000_000;
const CONTEXT_PREFIX = 'lf-kek-transit-v1|';

function configError(detail: string): TransitKmsError {
  return new TransitKmsError('connect', 'config', undefined, detail);
}

function int(value: number | undefined, fallback: number, min: number, max: number, what: string) {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max)
    throw configError(`${what} must be ${String(min)}..${String(max)}`);
  return v;
}

function headerSafe(value: string, what: string): string {
  if (value.length === 0 || /[\r\n\0]/.test(value))
    throw configError(`${what} is empty or malformed`);
  return value;
}

function origin(address: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw configError('address is not a URL');
  }
  if (url.username || url.password) throw configError('address must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw configError('address must be scheme://host:port only');
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && allowHttp && LOOPBACK.has(url.hostname)) return url.origin;
  throw configError('address must be https (http only for a loopback host with explicit opt-in)');
}

/** Classify a 4xx error body into a fixed reason code; the text itself is never kept. */
function reasonOf(text: string): string {
  let messages: string[] = [];
  try {
    const parsed = JSON.parse(text) as { errors?: unknown };
    if (Array.isArray(parsed.errors)) messages = parsed.errors.filter((e) => typeof e === 'string');
  } catch {
    return 'unparsed';
  }
  const all = messages.join('\n');
  if (all.includes('message authentication failed')) return 'auth_failed';
  if (all.includes('(too old)')) return 'version_too_old';
  if (all.includes("missing 'context'")) return 'missing_context';
  if (all.includes('encryption key not found')) return 'key_not_found';
  if (all.includes('namespace not found')) return 'namespace_not_found';
  if (all.includes('permission denied')) return 'permission_denied';
  if (all.includes('invalid role or secret ID') || all.includes('invalid secret id'))
    return 'invalid_credentials';
  return 'other';
}

function kindFor4xx(op: TransitOp, status: number): TransitErrorKind {
  if (op === 'login' && (status === 400 || status === 401 || status === 403)) return 'auth_failed';
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  return 'bad_request';
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || (error.cause as Error | undefined)?.name === 'TimeoutError')
  );
}

type Json = Record<string, unknown>;

export class TransitKms implements Kms {
  readonly keyName: string;
  readonly #origin: string;
  readonly #mount: string;
  readonly #namespace: string | undefined;
  readonly #auth: TransitAuth;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #log: ((event: TransitKmsLogEvent) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  #latest = 0;
  #minDecryption = 0;
  #token: string | undefined;
  #refreshAt: number | undefined;
  #pendingLogin: Promise<string> | undefined;

  private constructor(o: TransitKmsOptions) {
    this.#origin = origin(o.address, o.allowInsecureLoopbackHttp === true);
    if (!NAME.test(o.keyName)) throw configError('keyName must match [A-Za-z0-9_-]{1,48}');
    this.keyName = o.keyName;
    this.#mount = o.mount ?? 'transit';
    if (!PATH.test(this.#mount))
      throw configError('mount must be a path of [A-Za-z0-9_-] segments');
    if (o.namespace !== undefined && !NAMESPACE.test(o.namespace)) {
      throw configError('namespace must be a path of [A-Za-z0-9_-] segments');
    }
    this.#namespace = o.namespace;
    if ('token' in o.auth) {
      headerSafe(o.auth.token, 'token');
    } else {
      headerSafe(o.auth.appRole.roleId, 'AppRole role id');
      headerSafe(o.auth.appRole.secretId, 'AppRole secret id');
      if (!PATH.test(o.auth.appRole.mount ?? 'approle'))
        throw configError('AppRole mount is malformed');
    }
    this.#auth = o.auth;
    this.#timeoutMs = int(o.timeoutMs, 5000, 1, 600_000, 'timeoutMs');
    this.#maxAttempts = int(o.maxAttempts, 3, 1, 10, 'maxAttempts');
    this.#baseMs = int(o.backoffBaseMs, 100, 0, 60_000, 'backoffBaseMs');
    this.#capMs = int(o.backoffCapMs, 2000, 0, 300_000, 'backoffCapMs');
    this.#log = o.log;
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = o.random ?? Math.random;
    this.#now = o.now ?? Date.now;
  }

  /** Validate the options, authenticate, and check the key's policy (DL-0202). */
  static async connect(options: TransitKmsOptions): Promise<TransitKms> {
    const kms = new TransitKms(options);
    await kms.refresh();
    return kms;
  }

  get activeKeyId(): string {
    return this.#keyId(this.#latest);
  }

  /** Versions as last seen from the server. */
  get keyVersions(): { latest: number; minDecryption: number } {
    return { latest: this.#latest, minDecryption: this.#minDecryption };
  }

  /** Re-read the key (after a rotation or config change) and re-check its policy. */
  async refresh(): Promise<void> {
    const json = await this.#request('read_key', 'GET', `${this.#mount}/keys/${this.keyName}`);
    const d = json['data'] as Json | null | undefined;
    const fail = (rule: string) => new TransitKmsError('read_key', 'key_policy', undefined, rule);
    if (typeof d !== 'object' || d === null) throw fail('key info missing');
    if (d['type'] !== 'aes256-gcm96') throw fail('key type must be aes256-gcm96');
    if (d['derived'] !== true) throw fail('key must be derived (context binds the record)');
    if (d['convergent_encryption'] === true) throw fail('key must not use convergent encryption');
    if (d['supports_encryption'] !== true || d['supports_decryption'] !== true) {
      throw fail('key must support encryption and decryption');
    }
    if (d['exportable'] !== false) throw fail('key must not be exportable');
    if (d['allow_plaintext_backup'] !== false) throw fail('key must not allow plaintext backup');
    const latest = d['latest_version'];
    const minDec = d['min_decryption_version'];
    if (typeof latest !== 'number' || !Number.isInteger(latest) || latest < 1) {
      throw fail('latest_version missing');
    }
    this.#latest = latest;
    this.#minDecryption = typeof minDec === 'number' ? minDec : 0;
  }

  async wrap(dek: Buffer, aad: string): Promise<{ keyId: string; wrapped: Buffer }> {
    const json = await this.#request('encrypt', 'POST', `${this.#mount}/encrypt/${this.keyName}`, {
      plaintext: dek.toString('base64'),
      context: this.#context(aad),
    });
    return this.#accept('encrypt', json);
  }

  async unwrap(wrapped: Buffer, keyId: string, aad: string): Promise<Buffer> {
    const ciphertext = this.#ciphertext(wrapped, keyId);
    const json = await this.#failClosed(
      this.#request('decrypt', 'POST', `${this.#mount}/decrypt/${this.keyName}`, {
        ciphertext,
        context: this.#context(aad),
      }),
    );
    const data = json['data'] as Json | null | undefined;
    const plaintext = data?.['plaintext'];
    if (typeof plaintext !== 'string' || !B64.test(plaintext)) throw new DecryptionError();
    const dek = Buffer.from(plaintext, 'base64');
    if (dek.length !== DEK_BYTES) {
      dek.fill(0);
      throw new DecryptionError();
    }
    return dek;
  }

  /** Server-side rewrap to the latest version: the DEK never leaves OpenBao. */
  async rewrap(
    wrapped: Buffer,
    keyId: string,
    aad: string,
  ): Promise<{ keyId: string; wrapped: Buffer }> {
    const ciphertext = this.#ciphertext(wrapped, keyId);
    const json = await this.#failClosed(
      this.#request('rewrap', 'POST', `${this.#mount}/rewrap/${this.keyName}`, {
        ciphertext,
        context: this.#context(aad),
      }),
    );
    return this.#accept('rewrap', json);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  #keyId(version: number): string {
    return `tr.${this.keyName}.v${String(version)}`;
  }

  #context(aad: string): string {
    return Buffer.from(CONTEXT_PREFIX + aad, 'utf8').toString('base64');
  }

  /** Rebuild `vault:v<N>:<base64>` from the stored parts; unknown ids and bad sizes never leave. */
  #ciphertext(wrapped: Buffer, keyId: string): string {
    const m = KEY_ID.exec(keyId);
    if (!m || m[1] !== this.keyName) throw new Error(`transit: unknown key id ${keyId}`);
    if (wrapped.length !== WRAPPED_BYTES) throw new DecryptionError();
    return `vault:v${m[2] ?? ''}:${wrapped.toString('base64')}`;
  }

  #accept(op: TransitOp, json: Json): { keyId: string; wrapped: Buffer } {
    const data = json['data'] as Json | null | undefined;
    const ct = data?.['ciphertext'];
    const m = typeof ct === 'string' ? CIPHERTEXT.exec(ct) : null;
    if (!data || !m) throw new TransitKmsError(op, 'bad_response', undefined, 'ciphertext shape');
    const version = Number(m[1]);
    const reported = data['key_version'];
    if (reported !== undefined && reported !== version) {
      throw new TransitKmsError(op, 'bad_response', undefined, 'key_version mismatch');
    }
    const wrapped = Buffer.from(m[2] ?? '', 'base64');
    if (wrapped.length !== WRAPPED_BYTES) {
      throw new TransitKmsError(op, 'bad_response', undefined, 'wrapped size');
    }
    if (version > this.#latest) this.#latest = version;
    return { keyId: this.#keyId(version), wrapped };
  }

  /** A 400 on decrypt/rewrap (wrong context, tampering, retired version…) fails closed. */
  async #failClosed(p: Promise<Json>): Promise<Json> {
    try {
      return await p;
    } catch (error) {
      if (error instanceof TransitKmsError && error.status === 400) throw new DecryptionError();
      throw error;
    }
  }

  #emit(event: TransitKmsLogEvent): void {
    try {
      this.#log?.(event);
    } catch {
      // a failing logger must not change crypto behaviour
    }
  }

  #backoff(attempt: number): number {
    const step = Math.min(this.#capMs, this.#baseMs * 2 ** (attempt - 1));
    return Math.floor(this.#random() * step);
  }

  async #currentToken(): Promise<string> {
    if ('token' in this.#auth) return this.#auth.token;
    if (
      this.#token !== undefined &&
      (this.#refreshAt === undefined || this.#now() < this.#refreshAt)
    ) {
      return this.#token;
    }
    this.#pendingLogin ??= this.#login().finally(() => {
      this.#pendingLogin = undefined;
    });
    return this.#pendingLogin;
  }

  async #login(): Promise<string> {
    if ('token' in this.#auth) throw new Error('unreachable');
    const { roleId, secretId, mount } = this.#auth.appRole;
    const json = await this.#request(
      'login',
      'POST',
      `auth/${mount ?? 'approle'}/login`,
      { role_id: roleId, secret_id: secretId },
      false,
    );
    const auth = json['auth'] as Json | null | undefined;
    const token = auth?.['client_token'];
    const lease = auth?.['lease_duration'];
    if (typeof token !== 'string' || token.length === 0 || /[\r\n\0]/.test(token)) {
      throw new TransitKmsError('login', 'bad_response', undefined, 'client_token missing');
    }
    this.#token = token;
    this.#refreshAt =
      typeof lease === 'number' && lease > 0
        ? this.#now() + Math.floor((lease * 2000) / 3)
        : undefined;
    return token;
  }

  async #request(
    op: TransitOp,
    method: 'GET' | 'POST',
    path: string,
    body?: Json,
    withToken = true,
  ): Promise<Json> {
    let relogged = false;
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (this.#namespace !== undefined) headers['X-Vault-Namespace'] = this.#namespace;
      if (withToken) headers['X-Vault-Token'] = await this.#currentToken();
      const started = Date.now();
      const init: RequestInit = {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        const res = await fetch(`${this.#origin}/v1/${path}`, init);
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        if (status >= 300 && status < 400) {
          await res.body?.cancel().catch(() => undefined);
          this.#emit({
            op,
            outcome: 'error',
            attempt,
            ms: Date.now() - started,
            status,
            kind: 'redirect_refused',
          });
          throw new TransitKmsError(op, 'redirect_refused', status);
        }
        text = await res.text();
      } catch (error) {
        if (error instanceof TransitKmsError) throw error;
        const kind: TransitErrorKind = isTimeout(error) ? 'timeout' : 'unavailable';
        const ms = Date.now() - started;
        if (attempt < this.#maxAttempts) {
          this.#emit({ op, outcome: 'retry', attempt, ms, kind });
          await this.#sleep(this.#backoff(attempt));
          continue;
        }
        this.#emit({ op, outcome: 'error', attempt, ms, kind });
        throw new TransitKmsError(op, kind);
      }
      const ms = Date.now() - started;
      if (status === 429 || status >= 500) {
        if (attempt < this.#maxAttempts) {
          this.#emit({ op, outcome: 'retry', attempt, ms, status, kind: 'unavailable' });
          const hinted = retryAfterMs(retryAfter);
          await this.#sleep(
            hinted === undefined ? this.#backoff(attempt) : Math.min(hinted, this.#capMs),
          );
          continue;
        }
        this.#emit({ op, outcome: 'error', attempt, ms, status, kind: 'unavailable' });
        throw new TransitKmsError(op, 'unavailable', status);
      }
      if (status >= 200 && status < 300) {
        if (text.length > MAX_BODY)
          throw new TransitKmsError(op, 'bad_response', status, 'body too large');
        let json: unknown = {};
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            throw new TransitKmsError(op, 'bad_response', status, 'not JSON');
          }
        }
        if (typeof json !== 'object' || json === null) {
          throw new TransitKmsError(op, 'bad_response', status, 'not an object');
        }
        this.#emit({ op, outcome: 'ok', attempt, ms, status });
        return json as Json;
      }
      const reason = reasonOf(text);
      if (status === 403 && withToken && 'appRole' in this.#auth && !relogged) {
        // The token may have expired or been revoked: log in again once, without spending an attempt.
        relogged = true;
        this.#token = undefined;
        this.#emit({ op, outcome: 'retry', attempt, ms, status, reason: 'relogin' });
        attempt--;
        continue;
      }
      const kind = kindFor4xx(op, status);
      this.#emit({ op, outcome: 'error', attempt, ms, status, kind, reason });
      throw new TransitKmsError(op, kind, status);
    }
  }
}
