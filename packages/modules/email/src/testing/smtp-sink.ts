/**
 * In-process SMTP sink for tests (T-0042, ADR-0046 rule 5): a real SMTP conversation over TCP on
 * 127.0.0.1 (EHLO/HELO, MAIL, RCPT, DATA with dot-unstuffing, RSET, NOOP, QUIT), collecting each
 * message's envelope and raw RFC 5322 text. No TLS, no auth, no relaying — test use only.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface SunkMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

export class SmtpSink {
  readonly messages: SunkMessage[] = [];
  #server: Server | null = null;
  #port = 0;

  get url(): string {
    return `smtp://127.0.0.1:${String(this.#port)}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((socket) => {
      this.#session(socket);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  #session(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    let from = '';
    let to: string[] = [];
    let data: string[] | null = null;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 lf-test-sink ESMTP');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') {
            this.messages.push({ from, to, raw: data.join('\r\n') });
            data = null;
            from = '';
            to = [];
            reply('250 OK queued');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') reply('250-lf-test-sink\r\n250 8BITMIME');
        else if (verb === 'HELO') reply('250 lf-test-sink');
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 OK');
        } else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 OK');
        } else if (verb === 'DATA') {
          data = [];
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          from = '';
          to = [];
          reply('250 OK');
        } else if (verb === 'NOOP') reply('250 OK');
        else if (verb === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('502 Command not implemented');
      }
    });
  }
}
