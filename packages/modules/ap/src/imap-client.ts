/**
 * Minimal read-only IMAP4rev1 client for the bills inbox poller (T-0127, ADR-0095, RQ-0177).
 *
 * The subset of RFC 3501 (also served by IMAP4rev2, RFC 9051) the poller needs: greeting, LOGIN,
 * EXAMINE (read-only select), UID SEARCH UID n:*, UID FETCH (UID RFC822.SIZE) and
 * UID FETCH (UID BODY.PEEK[]) (never sets \Seen), LOGOUT, and `AUTHENTICATE XOAUTH2` with the
 * initial response on the command line (SASL-IR, RFC 4959; T-0216, ADR-0105, RQ-0187 F1): an
 * error challenge is answered with one empty line and the tagged NO is `auth_failed`. There is
 * deliberately no command that
 * stores flags, expunges, copies, moves or appends: LedgerForce never changes the mailbox.
 *
 * Production connects with implicit TLS and full certificate verification (RFC 8314;
 * `tlsConnector`); tests inject an in-memory connection to the fake server. Every response line
 * is bounded (maxLineBytes) and every literal (maxLiteralBytes, the message ceiling); each command
 * has a timeout. Errors carry a fixed kind and a fixed message — never server text, which could
 * echo the username or other data.
 */
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type ImapErrorKind =
  | 'connect_failed'
  | 'tls_failed'
  | 'auth_failed'
  | 'folder_missing'
  | 'protocol_error'
  | 'timeout'
  | 'too_large';

const MESSAGES: Record<ImapErrorKind, string> = {
  connect_failed: 'could not connect to the IMAP server',
  tls_failed: 'the IMAP server certificate could not be verified',
  auth_failed: 'the IMAP server refused the username or password',
  folder_missing: 'the IMAP folder does not exist',
  protocol_error: 'the IMAP server answered something this client does not accept',
  timeout: 'the IMAP server did not answer in time',
  too_large: 'the IMAP server sent more data than the configured limit',
};

export class ImapError extends Error {
  readonly kind: ImapErrorKind;
  constructor(kind: ImapErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'ImapError';
    this.kind = kind;
  }
}

export type ImapConnector = () => Promise<Duplex>;

export interface ImapLimits {
  /** Longest response line without its literals. Default 64 KiB. */
  readonly maxLineBytes?: number;
  /** Largest literal (a whole message). Default 25 MiB (RQ-0177 F5). */
  readonly maxLiteralBytes?: number;
  /** Per-command (and greeting) timeout. Default 60 s. */
  readonly commandTimeoutMs?: number;
}

export const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Implicit TLS (port 993) with certificate and host-name verification. Never disabled. */
export function tlsConnector(host: string, port: number, timeoutMs = 30_000): ImapConnector {
  return () =>
    new Promise((resolve, reject) => {
      const sock = tlsConnect({
        host,
        port,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: true,
      });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new ImapError('timeout'));
      }, timeoutMs);
      sock.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new ImapError(TLS_CODES.has(e.code ?? '') ? 'tls_failed' : 'connect_failed'));
      });
    });
}

/** One untagged or tagged response: text with literal placeholders \0n\0, and the literals. */
interface Response {
  readonly text: string;
  readonly literals: Buffer[];
}

type Token = string | Buffer | Token[];

interface Pending {
  readonly tag: string;
  readonly untagged: Response[];
  resolve(r: { status: string; text: string; untagged: Response[] }): void;
  reject(e: ImapError): void;
  timer: NodeJS.Timeout;
}

export class ImapClient {
  readonly #sock: Duplex;
  readonly #maxLine: number;
  readonly #maxLiteral: number;
  readonly #timeoutMs: number;
  #buf: Buffer = Buffer.alloc(0);
  #lineParts: string[] = [];
  #literals: Buffer[] = [];
  #literalNeeded = -1;
  #seq = 0;
  #pending: Pending | null = null;
  #continuation: (() => void) | null = null;
  /** Set during AUTHENTICATE: how to answer a server challenge (`+ …`). */
  #challenge: (() => void) | null = null;
  #greeting: { resolve(): void; reject(e: ImapError): void } | null = null;
  #failed: ImapError | null = null;

  private constructor(sock: Duplex, limits: ImapLimits) {
    this.#sock = sock;
    this.#maxLine = limits.maxLineBytes ?? 64 * 1024;
    this.#maxLiteral = limits.maxLiteralBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#timeoutMs = limits.commandTimeoutMs ?? 60_000;
    sock.on('data', (chunk: Buffer) => {
      this.#onData(chunk);
    });
    sock.on('error', () => {
      this.#fail(new ImapError('connect_failed'));
    });
    sock.on('close', () => {
      this.#fail(new ImapError('connect_failed'));
    });
  }

  /** Connect and wait for the server greeting (`* OK` or `* PREAUTH`). */
  static async connect(connector: ImapConnector, limits: ImapLimits = {}): Promise<ImapClient> {
    let sock: Duplex;
    try {
      sock = await connector();
    } catch (e) {
      throw e instanceof ImapError ? e : new ImapError('connect_failed');
    }
    const client = new ImapClient(sock, limits);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.#fail(new ImapError('timeout'));
      }, client.#timeoutMs);
      client.#greeting = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
    return client;
  }

  async login(user: string, pass: string): Promise<void> {
    const r = await this.#command(['LOGIN', user, pass]);
    if (r.status !== 'OK') throw new ImapError('auth_failed');
  }

  /**
   * SASL XOAUTH2 with an OAuth 2.0 access token (Microsoft 365, Google; RQ-0187 F1). The token is
   * never echoed in an error. A server challenge (Google sends its JSON error this way) gets one
   * empty line; a second challenge is a protocol error.
   */
  async authenticateXOAuth2(user: string, accessToken: string): Promise<void> {
    const ir = xoauth2InitialResponse(user, accessToken);
    let challenges = 0;
    this.#challenge = () => {
      challenges += 1;
      if (challenges > 1) {
        this.#fail(new ImapError('protocol_error'));
        return;
      }
      this.#sock.write('\r\n');
    };
    try {
      const r = await this.#command(['AUTHENTICATE', 'XOAUTH2', ir], true);
      if (r.status !== 'OK') throw new ImapError('auth_failed');
    } finally {
      this.#challenge = null;
    }
  }

  /** Read-only select; returns UIDVALIDITY and the message count. */
  async examine(folder: string): Promise<{ uidValidity: number; exists: number }> {
    const r = await this.#command(['EXAMINE', folder]);
    if (r.status !== 'OK') throw new ImapError('folder_missing');
    let uidValidity: number | null = null;
    let exists = 0;
    for (const u of r.untagged) {
      const v = /^OK \[UIDVALIDITY (\d{1,10})\]/i.exec(u.text);
      if (v) uidValidity = Number.parseInt(v[1] ?? '', 10);
      const e = /^(\d{1,10}) EXISTS$/i.exec(u.text);
      if (e) exists = Number.parseInt(e[1] ?? '', 10);
    }
    if (uidValidity === null || uidValidity < 1 || uidValidity > 0xffffffff) {
      throw new ImapError('protocol_error');
    }
    return { uidValidity, exists };
  }

  /** UIDs strictly above `lastUid`, ascending (`n:*` can return the last UID, RFC 9051 §6.4.4). */
  async searchUidsAfter(lastUid: number): Promise<number[]> {
    const r = await this.#ok(['UID', 'SEARCH', 'UID', `${String(lastUid + 1)}:*`]);
    const uids = new Set<number>();
    for (const u of r.untagged) {
      const m = /^SEARCH((?: \d{1,10})*)$/i.exec(u.text);
      if (!m) continue;
      for (const n of (m[1] ?? '').trim().split(' ')) {
        if (n !== '' && Number.parseInt(n, 10) > lastUid) uids.add(Number.parseInt(n, 10));
      }
    }
    return [...uids].sort((a, b) => a - b);
  }

  /** RFC822.SIZE of each UID the server still has. */
  async fetchSizes(uids: readonly number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (uids.length === 0) return out;
    const r = await this.#ok(['UID', 'FETCH', uids.map(String).join(','), '(UID RFC822.SIZE)']);
    for (const f of fetchItems(r.untagged)) {
      const uid = num(f.get('UID'));
      const size = num(f.get('RFC822.SIZE'));
      if (uid !== null && size !== null) out.set(uid, size);
    }
    return out;
  }

  /** The whole raw message (BODY.PEEK[]: does not set \Seen). */
  async fetchMessage(uid: number): Promise<Buffer> {
    const r = await this.#ok(['UID', 'FETCH', String(uid), '(UID BODY.PEEK[])']);
    for (const f of fetchItems(r.untagged)) {
      const body = f.get('BODY[]');
      if (num(f.get('UID')) === uid && Buffer.isBuffer(body)) return body;
      if (num(f.get('UID')) === uid && typeof body === 'string' && body !== 'NIL') {
        return Buffer.from(body, 'latin1');
      }
    }
    throw new ImapError('protocol_error');
  }

  async logout(): Promise<void> {
    try {
      await this.#command(['LOGOUT']);
    } catch {
      // The server may close before the tagged OK; logging out is best effort.
    } finally {
      this.close();
    }
  }

  close(): void {
    this.#failed ??= new ImapError('connect_failed');
    this.#sock.destroy();
  }

  async #ok(args: string[]) {
    const r = await this.#command(args);
    if (r.status !== 'OK') throw new ImapError('protocol_error');
    return r;
  }

  /**
   * Send one command; string arguments become atoms, quoted strings or literals. `atoms` sends
   * every argument as an atom (SASL mechanism and base64 initial response); each must be one.
   */
  async #command(
    args: string[],
    atoms = false,
  ): Promise<{ status: string; text: string; untagged: Response[] }> {
    if (this.#failed) throw this.#failed;
    if (this.#pending) throw new ImapError('protocol_error');
    const pieces: (string | Buffer)[] = [];
    for (const [i, a] of args.entries()) {
      if (atoms && !/^[A-Za-z0-9+/=]+$/.test(a)) throw new ImapError('protocol_error');
      pieces.push(i === 0 || atoms ? a : encodeArg(a, i < 2 || args[0] === 'UID'));
    }
    this.#seq += 1;
    const tag = `L${String(this.#seq)}`;
    const result = new Promise<{ status: string; text: string; untagged: Response[] }>(
      (resolve, reject) => {
        this.#pending = {
          tag,
          untagged: [],
          resolve,
          reject,
          timer: setTimeout(() => {
            this.#fail(new ImapError('timeout'));
          }, this.#timeoutMs),
        };
      },
    );
    // Write the line, pausing at each literal for the server's continuation (`+`).
    let line = `${tag}`;
    for (const p of pieces) {
      if (typeof p === 'string') {
        line += ` ${p}`;
        continue;
      }
      // Arm the continuation before writing: a server (or in-memory pair) may answer at once.
      const go = new Promise<void>((resolve, reject) => {
        this.#continuation = resolve;
        result.catch(reject);
      });
      this.#sock.write(`${line} {${String(p.length)}}\r\n`);
      await go;
      this.#sock.write(p);
      line = '';
    }
    this.#sock.write(`${line}\r\n`);
    return result;
  }

  #fail(e: ImapError): void {
    if (this.#failed && !this.#pending && !this.#greeting) return;
    this.#failed ??= e;
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    const g = this.#greeting;
    this.#greeting = null;
    g?.reject(e);
    this.#sock.destroy();
  }

  #onData(chunk: Buffer): void {
    if (this.#failed) return;
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#literalNeeded >= 0) {
        if (this.#buf.length < this.#literalNeeded) return;
        this.#literals.push(Buffer.from(this.#buf.subarray(0, this.#literalNeeded)));
        this.#buf = this.#buf.subarray(this.#literalNeeded);
        this.#lineParts.push(`\u0000${String(this.#literals.length - 1)}\u0000`);
        this.#literalNeeded = -1;
        continue;
      }
      const eol = this.#buf.indexOf('\r\n');
      if (eol < 0) {
        if (this.#buf.length > this.#maxLine) this.#fail(new ImapError('protocol_error'));
        return;
      }
      if (eol > this.#maxLine) {
        this.#fail(new ImapError('protocol_error'));
        return;
      }
      const text = this.#buf.subarray(0, eol).toString('latin1');
      this.#buf = this.#buf.subarray(eol + 2);
      const lit = /\{(\d{1,10})\}$/.exec(text);
      if (lit) {
        const n = Number.parseInt(lit[1] ?? '', 10);
        if (n > this.#maxLiteral) {
          this.#fail(new ImapError('too_large'));
          return;
        }
        this.#lineParts.push(text.slice(0, text.length - lit[0].length));
        this.#literalNeeded = n;
        continue;
      }
      this.#lineParts.push(text);
      const response = { text: this.#lineParts.join(''), literals: this.#literals };
      this.#lineParts = [];
      this.#literals = [];
      this.#dispatch(response);
      if (this.#failed) return;
    }
  }

  #dispatch(r: Response): void {
    if (this.#greeting) {
      const g = this.#greeting;
      if (/^\* (OK|PREAUTH)\b/i.test(r.text)) {
        this.#greeting = null;
        g.resolve();
      } else {
        this.#fail(new ImapError('connect_failed'));
      }
      return;
    }
    if (r.text.startsWith('+')) {
      const c = this.#continuation;
      this.#continuation = null;
      if (c) c();
      else if (this.#challenge && this.#pending) this.#challenge();
      else this.#fail(new ImapError('protocol_error'));
      return;
    }
    const p = this.#pending;
    if (r.text.startsWith('* ')) {
      // An unsolicited BYE outside LOGOUT ends the session.
      if (/^\* BYE\b/i.test(r.text) && !p) this.#fail(new ImapError('connect_failed'));
      p?.untagged.push({ text: r.text.slice(2), literals: r.literals });
      return;
    }
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/is.exec(r.text);
    if (!p || !m || m[1] !== p.tag) {
      this.#fail(new ImapError('protocol_error'));
      return;
    }
    this.#pending = null;
    clearTimeout(p.timer);
    p.resolve({ status: (m[2] ?? '').toUpperCase(), text: m[3] ?? '', untagged: p.untagged });
  }
}

/**
 * The XOAUTH2 initial client response: base64(`user=` U ^A `auth=Bearer ` T ^A ^A) (RQ-0187 S5,
 * X1). The user may not contain ^A, CR, LF or NUL; the token must be printable ASCII without
 * spaces (RFC 6750 b64token is narrower still).
 */
export function xoauth2InitialResponse(user: string, accessToken: string): string {
  // eslint-disable-next-line no-control-regex
  if (user.length === 0 || user.length > 320 || /[\u0000-\u001f\u007f]/.test(user)) {
    throw new ImapError('protocol_error');
  }
  if (!/^[\x21-\x7e]{1,16384}$/.test(accessToken)) throw new ImapError('protocol_error');
  return Buffer.from(`user=${user}\u0001auth=Bearer ${accessToken}\u0001\u0001`, 'utf8').toString(
    'base64',
  );
}

/**
 * Encode one argument: an atom when safe (always for UID command parts and the first argument),
 * a quoted string for printable ASCII, a literal for 8-bit text. CR, LF and NUL are refused.
 */
function encodeArg(a: string, atomOk: boolean): string | Buffer {
  if (/[\r\n\0]/.test(a)) throw new ImapError('protocol_error');
  if (atomOk && /^[!#-'*-[\]-~]+$/.test(a) && !/[(){%"\\]/.test(a)) return a;
  if (/^[\x20-\x7e]*$/.test(a)) return `"${a.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return Buffer.from(a, 'utf8');
}

/** The key/value pairs of each `n FETCH (...)` response. */
function fetchItems(untagged: readonly Response[]): Map<string, Token>[] {
  const out: Map<string, Token>[] = [];
  for (const u of untagged) {
    if (!/^\d{1,10} FETCH \(/i.test(u.text)) continue;
    const tokens = tokenize(u.text.slice(u.text.indexOf('(')), u.literals);
    const list = tokens[0];
    if (!Array.isArray(list) || list.length % 2 !== 0) throw new ImapError('protocol_error');
    const m = new Map<string, Token>();
    for (let i = 0; i < list.length; i += 2) {
      const k = list[i];
      const v = list[i + 1];
      if (typeof k !== 'string' || v === undefined) throw new ImapError('protocol_error');
      m.set(k.toUpperCase(), v);
    }
    out.push(m);
  }
  return out;
}

/** Atoms (incl. `BODY[]`), quoted strings, literals and nested parenthesised lists. */
function tokenize(s: string, literals: readonly Buffer[]): Token[] {
  const stack: Token[][] = [[]];
  let i = 0;
  const top = () => stack[stack.length - 1] ?? [];
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') {
      i += 1;
    } else if (c === '(') {
      const l: Token[] = [];
      top().push(l);
      stack.push(l);
      i += 1;
    } else if (c === ')') {
      if (stack.length < 2) throw new ImapError('protocol_error');
      stack.pop();
      i += 1;
    } else if (c === '"') {
      let v = '';
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i += 1;
        v += s[i] ?? '';
        i += 1;
      }
      if (i >= s.length) throw new ImapError('protocol_error');
      i += 1;
      top().push(v);
    } else if (c === '\u0000') {
      const end = s.indexOf('\u0000', i + 1);
      const lit = literals[Number.parseInt(s.slice(i + 1, end), 10)];
      if (end < 0 || !lit) throw new ImapError('protocol_error');
      top().push(lit);
      i = end + 1;
    } else {
      let v = '';
      let depth = 0;
      while (i < s.length) {
        const ch = s[i] ?? '';
        if (ch === '[') depth += 1;
        if (ch === ']') depth -= 1;
        if (depth === 0 && (ch === ' ' || ch === '(' || ch === ')')) break;
        v += ch;
        i += 1;
      }
      top().push(v);
    }
  }
  if (stack.length !== 1) throw new ImapError('protocol_error');
  return stack[0] ?? [];
}

function num(t: Token | undefined): number | null {
  return typeof t === 'string' && /^\d{1,10}$/.test(t) ? Number.parseInt(t, 10) : null;
}
