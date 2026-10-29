/**
 * Test-only local stand-in for the Salesforce token endpoint (RQ-0024). It runs on 127.0.0.1 and
 * behaves as the documented endpoint does: it checks the form body, verifies the RS256
 * signature with the certificate the admin "uploaded", checks iss/aud/exp/sub and the
 * pre-authorisation, and answers with the documented responses in
 * fixtures/documented/oauth2-token-responses.json. Nothing here contacts Salesforce.
 *
 * `http` is the injectable client for the code under test: it accepts only the real token URL
 * of the configured audience and forwards it to this local server, so a wrong host fails loudly.
 */
import { createVerify, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpPost } from '../token-client.ts';

interface Documented {
  responses: Record<string, { status: number; body: Record<string, string> }>;
}
export const DOCUMENTED = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/oauth2-token-responses.json', import.meta.url),
    'utf8',
  ),
) as Documented;

export interface FakeEndpointOptions {
  certificatePem: string;
  consumerKey: string;
  audience: string;
  /** Active users and whether the app is pre-authorised for them. */
  users: Record<string, { preauthorized: boolean; active?: boolean }>;
  now?: () => Date;
}

export interface FakeTokenEndpoint {
  http: HttpPost;
  /** Every request the server received (body fields), and the tokens it issued. */
  requests: { url: string; contentType: string; form: Record<string, string> }[];
  issued: string[];
  /** Answer the next requests with a raw status/body instead of evaluating them. */
  override: { status: number; body: string } | null;
  /** Delay every answer (to make concurrent callers overlap). */
  delayMs: number;
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });

export async function startFakeTokenEndpoint(
  opts: FakeEndpointOptions,
): Promise<FakeTokenEndpoint> {
  const publicKey = new X509Certificate(opts.certificatePem).publicKey;
  const now = opts.now ?? (() => new Date());
  const state: FakeTokenEndpoint = {
    http: () => Promise.reject(new Error('not started')),
    requests: [],
    issued: [],
    override: null,
    delayMs: 0,
    close: () => Promise.resolve(),
  };

  const evaluate = (form: Record<string, string>): keyof Documented['responses'] => {
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return 'unsupported_grant_type';
    const [h, c, s] = (form.assertion ?? '').split('.');
    if (!h || !c || !s) return 'invalid_assertion';
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return 'invalid_assertion';
    }
    if (header.alg !== 'RS256') return 'invalid_assertion';
    const valid = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s, 'base64url'));
    if (!valid) return 'invalid_assertion';
    if (claims.iss !== opts.consumerKey) return 'invalid_client';
    if (claims.aud !== opts.audience) return 'invalid_audience';
    const t = Math.floor(now().getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= t || claims.exp > t + 180)
      return 'invalid_assertion';
    const user = opts.users[String(claims.sub)];
    if (!user || user.active === false) return 'invalid_user';
    if (!user.preauthorized) return 'not_preauthorized';
    return 'success';
  };

  const server = createServer((req, res) => {
    void read(req).then(async (raw) => {
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.requests.push({
        url: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        form,
      });
      if (state.override) {
        res.writeHead(state.override.status, { 'content-type': 'application/json' });
        res.end(state.override.body);
        return;
      }
      const name =
        req.method === 'POST' && req.url === '/services/oauth2/token'
          ? evaluate(form)
          : 'unsupported_grant_type';
      const doc = DOCUMENTED.responses[name] ?? { status: 500, body: {} };
      let body = doc.body;
      if (name === 'success') {
        const token = `00DTEST000000000!${randomBytes(24).toString('base64url')}`;
        state.issued.push(token);
        body = { ...body, access_token: token, issued_at: String(now().getTime()) };
      }
      res.writeHead(doc.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const tokenUrl = `${opts.audience}/services/oauth2/token`;

  state.http = async (url, init) => {
    if (url !== tokenUrl) throw new Error(`fake endpoint: unexpected URL ${url}`);
    const res = await fetch(`http://127.0.0.1:${String(port)}/services/oauth2/token`, init);
    return { status: res.status, text: () => res.text() };
  };
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e) reject(e);
        else resolve();
      });
      server.closeAllConnections();
    });
  return state;
}
