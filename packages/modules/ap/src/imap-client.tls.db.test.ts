/**
 * Implicit TLS with certificate verification (T-0127, ADR-0095 rule 1, RFC 8314). A loopback
 * TLS server with a self-signed certificate stands in for a mail server an attacker controls:
 * the production connector must refuse it before a single IMAP byte (or the password) is sent.
 * Lives in the `db` project because it opens a loopback socket (the `unit` project does no I/O).
 */
import { createServer, type Server } from 'node:tls';
import {
  generateTestKeyPair,
  selfSignedCertificate,
} from '@ledgerforce/connector-salesforce/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient, ImapError, tlsConnector } from './imap-client.ts';

let server: Server;
let port = 0;
let received = 0;

beforeAll(async () => {
  const keys = generateTestKeyPair();
  const cert = selfSignedCertificate(
    keys,
    new Date(Date.now() - 86_400_000),
    new Date(Date.now() + 86_400_000),
    'localhost',
  );
  server = createServer({ key: keys.privateKeyPem, cert }, (sock) => {
    sock.on('data', (d: Buffer) => {
      received += d.length;
    });
    sock.on('error', () => undefined);
    sock.write('* OK fake ready\r\n');
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SS-PLAT-156: the IMAP connector verifies the server certificate', () => {
  it('SS-PLAT-156 a self-signed certificate is refused as tls_failed and nothing is sent', async () => {
    const err = await ImapClient.connect(tlsConnector('localhost', port, 5_000)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe('tls_failed');
    expect(received).toBe(0);
  });

  it('SS-PLAT-156 a closed port is connect_failed', async () => {
    const err = await ImapClient.connect(tlsConnector('127.0.0.1', 1, 5_000)).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ImapError).kind).toBe('connect_failed');
  });
});
