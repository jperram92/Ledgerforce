/**
 * In-process fake IMAP4rev1 server for tests (T-0127, RQ-0177 S15, ADR-0095). No network: each
 * `connect()` returns one end of an in-memory duplex pair and the server speaks RFC 3501
 * responses on the other end — greeting, CAPABILITY, LOGIN (quoted, atom or literal arguments),
 * EXAMINE, UID SEARCH UID n:*, UID FETCH (UID, RFC822.SIZE, BODY.PEEK[] → BODY[] literal),
 * NOOP, LOGOUT, and `AUTHENTICATE XOAUTH2 <initial response>` (SASL-IR, RFC 4959; T-0216): a
 * wrong token gets Google's JSON error challenge, the client's (empty) answer is recorded as
 * `<sasl-response:N bytes>`, then a tagged NO (RQ-0187 S5). Every received command line is
 * recorded so tests can prove the client never
 * sends a mailbox-changing command. Fault knobs simulate hostile or broken servers.
 */
import { duplexPair, type Duplex } from 'node:stream';

export interface FakeMessage {
  readonly uid: number;
  readonly raw: Buffer;
}

export interface FakeFolder {
  uidValidity: number;
  messages: FakeMessage[];
}

export interface FakeImapOptions {
  readonly user: string;
  readonly pass: string;
  /** The OAuth access token `AUTHENTICATE XOAUTH2` accepts for `user` (T-0216). */
  readonly accessToken?: string;
  readonly folders: Record<string, FakeFolder>;
}

export interface FakeFaults {
  /** Greet with `* BYE` and close. */
  byeOnGreeting?: boolean;
  /** Never answer commands after the greeting (client timeout). */
  silent?: boolean;
  /** Announce a literal of this size in the next FETCH body instead of the real one. */
  announceLiteral?: number;
  /** Send an unterminated line of this many bytes after the greeting. */
  hugeLine?: number;
  /** Put BODY[] before UID in FETCH responses (servers may order items freely). */
  bodyFirst?: boolean;
}

const MAX_COMMAND_BYTES = 1024 * 1024;

export class FakeImapServer {
  /** Every command line received, tag removed (e.g. `UID FETCH 3 (UID BODY.PEEK[])`). */
  readonly commands: string[] = [];
  faults: FakeFaults = {};
  connections = 0;

  readonly #opts: FakeImapOptions;

  constructor(opts: FakeImapOptions) {
    this.#opts = opts;
  }

  folder(name: string): FakeFolder {
    const f = this.#opts.folders[name];
    if (!f) throw new Error(`no folder ${name}`);
    return f;
  }

  /** Append a message with the next UID; returns it. */
  deliver(folder: string, raw: Buffer | string): number {
    const f = this.folder(folder);
    const uid = (f.messages.at(-1)?.uid ?? 0) + 1;
    f.messages.push({ uid, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8') });
    return uid;
  }

  /** The client end of a new connection. */
  connect(): Promise<Duplex> {
    const [client, server] = duplexPair();
    this.connections += 1;
    this.#serve(server);
    return Promise.resolve(client);
  }

  #serve(sock: Duplex): void {
    let selected: FakeFolder | null = null;
    let authed = false;
    let buf = Buffer.alloc(0);
    let pendingLiteral = 0;
    let parts: Buffer[] = [];
    /** Tag of an AUTHENTICATE waiting for the client's answer to our error challenge. */
    let saslTag: string | null = null;
    const send = (s: string | Buffer) => {
      if (!sock.destroyed) sock.write(s);
    };
    if (this.faults.byeOnGreeting) {
      send('* BYE server shutting down\r\n');
      sock.end();
      return;
    }
    send('* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=XOAUTH2] fake ready\r\n');
    if (this.faults.hugeLine) {
      send(Buffer.alloc(this.faults.hugeLine, 0x61));
      return;
    }

    const handle = (line: Buffer, literals: Buffer[]) => {
      const text = line.toString('latin1');
      if (saslTag !== null) {
        // The client's answer to the error challenge (must be empty, RQ-0187 S5).
        this.commands.push(`<sasl-response:${String(line.length)} bytes>`);
        const t = saslTag;
        saslTag = null;
        return send(`${t} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
      }
      const m = /^(\S+) (.*)$/s.exec(text);
      if (!m) return send('* BAD missing tag\r\n');
      const tag = m[1] ?? '';
      const rest = m[2] ?? '';
      this.commands.push(rest.replace(/\{\d+\}/g, '{literal}'));
      if (this.faults.silent) return;
      const args = tokens(rest, literals);
      const cmd = String(args[0] ?? '').toUpperCase();
      if (cmd === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
        return send(`${tag} OK done\r\n`);
      }
      if (cmd === 'NOOP') return send(`${tag} OK done\r\n`);
      if (cmd === 'LOGOUT') {
        send('* BYE logging out\r\n');
        send(`${tag} OK done\r\n`);
        sock.end();
        return;
      }
      if (cmd === 'LOGIN') {
        const u = args[1];
        const p = args[2];
        const asText = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
        if (asText(u) === this.#opts.user && asText(p) === this.#opts.pass) {
          authed = true;
          return send(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`);
        }
        return send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials for ${asText(u)}\r\n`);
      }
      if (cmd === 'AUTHENTICATE' && String(args[1]).toUpperCase() === 'XOAUTH2') {
        const ir = Buffer.from(String(args[2] ?? ''), 'base64').toString('utf8');
        const token = this.#opts.accessToken;
        if (
          token !== undefined &&
          ir === `user=${this.#opts.user}\u0001auth=Bearer ${token}\u0001\u0001`
        ) {
          authed = true;
          return send(`${tag} OK [CAPABILITY IMAP4rev1] ${this.#opts.user} authenticated\r\n`);
        }
        saslTag = tag;
        const challenge = JSON.stringify({
          status: '400',
          schemes: 'Bearer',
          scope: 'https://mail.google.com/',
        });
        return send(`+ ${Buffer.from(challenge).toString('base64')}\r\n`);
      }
      if (!authed) return send(`${tag} BAD not authenticated\r\n`);
      if (cmd === 'EXAMINE') {
        const f = this.#opts.folders[String(args[1])];
        if (!f) return send(`${tag} NO [NONEXISTENT] no such mailbox\r\n`);
        selected = f;
        const next = (f.messages.at(-1)?.uid ?? 0) + 1;
        send(`* ${String(f.messages.length)} EXISTS\r\n* 0 RECENT\r\n`);
        send(`* OK [UIDVALIDITY ${String(f.uidValidity)}] UIDs valid\r\n`);
        send(`* OK [UIDNEXT ${String(next)}] predicted next UID\r\n`);
        send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
        return send(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
      }
      if (cmd === 'UID' && selected) {
        const sub = String(args[1]).toUpperCase();
        const max = selected.messages.at(-1)?.uid ?? 0;
        if (sub === 'SEARCH' && String(args[2]).toUpperCase() === 'UID') {
          const set = parseSet(String(args[3]), max);
          const hits = selected.messages.filter((x) => set(x.uid)).map((x) => x.uid);
          send(`* SEARCH${hits.map((h) => ` ${String(h)}`).join('')}\r\n`);
          return send(`${tag} OK SEARCH completed\r\n`);
        }
        if (sub === 'FETCH') {
          const set = parseSet(String(args[2]), max);
          const items = rest.toUpperCase();
          for (const [i, msg] of selected.messages.entries()) {
            if (!set(msg.uid)) continue;
            const seq = String(i + 1);
            const uidPart = `UID ${String(msg.uid)}`;
            if (items.includes('BODY.PEEK[]')) {
              const n = this.faults.announceLiteral ?? msg.raw.length;
              const head = `BODY[] {${String(n)}}\r\n`;
              if (this.faults.bodyFirst) {
                send(`* ${seq} FETCH (${head}`);
                send(msg.raw);
                send(` ${uidPart})\r\n`);
              } else {
                send(`* ${seq} FETCH (${uidPart} ${head}`);
                send(msg.raw);
                send(')\r\n');
              }
            } else {
              send(`* ${seq} FETCH (${uidPart} RFC822.SIZE ${String(msg.raw.length)})\r\n`);
            }
          }
          return send(`${tag} OK FETCH completed\r\n`);
        }
      }
      return send(`${tag} BAD unsupported command\r\n`);
    };

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (pendingLiteral > 0) {
          if (buf.length < pendingLiteral) return;
          parts.push(buf.subarray(0, pendingLiteral));
          buf = buf.subarray(pendingLiteral);
          pendingLiteral = 0;
          parts.push(Buffer.from('\u0000LIT\u0000', 'latin1'));
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol < 0) {
          if (buf.length > MAX_COMMAND_BYTES) sock.destroy();
          return;
        }
        const line = buf.subarray(0, eol);
        buf = buf.subarray(eol + 2);
        const lit = /\{(\d+)\}$/.exec(line.toString('latin1'));
        if (lit) {
          parts.push(line.subarray(0, line.length - lit[0].length));
          pendingLiteral = Number.parseInt(lit[1] ?? '', 10);
          send('+ go ahead\r\n');
          continue;
        }
        parts.push(line);
        // Re-assemble: text pieces joined, literal bodies collected in order.
        const literals: Buffer[] = [];
        const textParts: Buffer[] = [];
        for (let k = 0; k < parts.length; k += 1) {
          const p = parts[k] ?? Buffer.alloc(0);
          const next = parts[k + 1];
          if (next && next.toString('latin1') === '\u0000LIT\u0000') {
            // p is the literal body that preceded the marker
            literals.push(p);
            textParts.push(Buffer.from(`\u0000${String(literals.length - 1)}\u0000`, 'latin1'));
            k += 1;
          } else {
            textParts.push(p);
          }
        }
        parts = [];
        handle(Buffer.concat(textParts), literals);
      }
    });
    sock.on('error', () => undefined);
  }
}

/** Space-separated atoms / quoted strings / literal placeholders (\0n\0) of a command. */
function tokens(s: string, literals: Buffer[]): (string | Buffer)[] {
  const out: (string | Buffer)[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') {
      i += 1;
    } else if (c === '"') {
      let v = '';
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i += 1;
        v += s[i] ?? '';
        i += 1;
      }
      i += 1;
      out.push(v);
    } else if (c === '\u0000') {
      const end = s.indexOf('\u0000', i + 1);
      out.push(literals[Number.parseInt(s.slice(i + 1, end), 10)] ?? Buffer.alloc(0));
      i = end + 1;
    } else if (c === '(') {
      const end = s.indexOf(')', i);
      out.push(s.slice(i, end + 1));
      i = end + 1;
    } else {
      let v = '';
      while (i < s.length && s[i] !== ' ') {
        v += s[i] ?? '';
        i += 1;
      }
      out.push(v);
    }
  }
  return out;
}

/** RFC 3501 sequence-set membership over UIDs; `*` is the largest UID in use. */
function parseSet(set: string, max: number): (uid: number) => boolean {
  const ranges = set.split(',').map((r) => {
    const [a, b] = r.split(':');
    const num = (x: string | undefined) => (x === '*' ? max : Number.parseInt(x ?? '', 10));
    const lo = num(a);
    const hi = b === undefined ? lo : num(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (uid) => ranges.some(([lo, hi]) => uid >= lo && uid <= hi);
}
