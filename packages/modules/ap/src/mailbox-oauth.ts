/**
 * OAuth 2.0 client for the bills mailbox (T-0216, ADR-0105, RQ-0187, DL-0931, DL-0932).
 *
 * Delegated authorization code + PKCE S256 (RFC 6749 §4.1, RFC 7636) for Microsoft 365 and
 * Google Workspace, and the refresh-token grant (RFC 6749 §6) the poller uses for each poll's
 * access token. Endpoints, scopes and IMAP hosts are fixed per provider; the client id/secret and
 * the redirect URI are install configuration (`mailboxOAuthConfigFromEnv`), never per company.
 *
 * Transport: HTTPS form POSTs with `redirect: 'error'`, a timeout (default 15 s) and a 64 KiB
 * answer bound. Errors carry a fixed kind and message, never provider text (which can echo the
 * account) and never a secret: `invalid_grant`, `invalid_client`, `unauthorized_client` →
 * auth_failed (the administrator must reconnect); anything else → connect_failed (DL-0935).
 * No new runtime dependency: `fetch` and `node:crypto` only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ConfigError, readSecret, type Env, type ReadFile } from '@ledgerforce/db';

export type MailboxOAuthProvider = 'microsoft' | 'google';

export const MAILBOX_OAUTH_PROVIDER_IDS: readonly MailboxOAuthProvider[] = ['microsoft', 'google'];

export interface MailboxOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Microsoft only: the Entra tenant in the authority URL; default `organizations`. */
  readonly tenant?: string;
}

export interface MailboxOAuthConfig {
  /** The exact registered redirect URI (the API's callback route). */
  readonly redirectUri: string;
  readonly microsoft?: MailboxOAuthClient;
  readonly google?: MailboxOAuthClient;
  /** Test hook: the recorded-response stand-in. Default global fetch. */
  readonly fetch?: typeof fetch;
  /** Token request timeout; default 15 s. */
  readonly timeoutMs?: number;
}

export type MailboxOAuthErrorKind =
  'auth_failed' | 'connect_failed' | 'not_configured' | 'invalid_request';

const MESSAGES: Record<MailboxOAuthErrorKind, string> = {
  auth_failed: 'the mailbox provider refused the sign-in; connect the mailbox again',
  connect_failed: 'the mailbox provider could not be reached or answered something unexpected',
  not_configured: 'sign-in with this mailbox provider is not configured on this server',
  invalid_request: 'the mailbox sign-in request is not valid',
};

export class MailboxOAuthError extends Error {
  readonly kind: MailboxOAuthErrorKind;
  constructor(kind: MailboxOAuthErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'MailboxOAuthError';
    this.kind = kind;
  }
}

interface ProviderSpec {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly scope: string;
  readonly authorizeUrl: (tenant: string) => string;
  readonly tokenUrl: (tenant: string) => string;
  /** Extra authorization parameters (offline access). */
  readonly authorizeExtra: Readonly<Record<string, string>>;
  /** Whether token requests repeat the scope (Microsoft v2.0 does; Google does not). */
  readonly scopeOnToken: boolean;
}

/** Fixed per provider (ADR-0105 rule 1); an access token only ever goes to these IMAP hosts. */
export const MAILBOX_OAUTH_PROVIDERS: Readonly<Record<MailboxOAuthProvider, ProviderSpec>> = {
  microsoft: {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    authorizeUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    tokenUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    authorizeExtra: { response_mode: 'query' },
    scopeOnToken: true,
  },
  google: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    scope: 'https://mail.google.com/',
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeExtra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
    scopeOnToken: false,
  },
};

const MAX_ANSWER_BYTES = 64 * 1024;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const AUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export const isMailboxOAuthProvider = (v: unknown): v is MailboxOAuthProvider =>
  v === 'microsoft' || v === 'google';

/** RFC 7636 §4.2: BASE64URL(SHA-256(ASCII(verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** RFC 7636 §4.1: 256 random bits as 43 base64url characters. */
export function newPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** The `state` value: 256 random bits as 43 base64url characters (stored only as a hash). */
export function newOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

function clientOf(config: MailboxOAuthConfig, provider: MailboxOAuthProvider): MailboxOAuthClient {
  const c = config[provider];
  if (!c) throw new MailboxOAuthError('not_configured');
  return c;
}

const tenantOf = (c: MailboxOAuthClient) => c.tenant ?? 'organizations';

/** The provider's authorization URL the administrator's browser is sent to. */
export function authorizationUrl(
  config: MailboxOAuthConfig,
  provider: MailboxOAuthProvider,
  p: { state: string; codeChallenge: string; loginHint: string },
): string {
  const c = clientOf(config, provider);
  const spec = MAILBOX_OAUTH_PROVIDERS[provider];
  const u = new URL(spec.authorizeUrl(tenantOf(c)));
  const q = u.searchParams;
  q.set('client_id', c.clientId);
  q.set('response_type', 'code');
  q.set('redirect_uri', config.redirectUri);
  q.set('scope', spec.scope);
  for (const [k, v] of Object.entries(spec.authorizeExtra)) q.set(k, v);
  q.set('state', p.state);
  q.set('code_challenge', p.codeChallenge);
  q.set('code_challenge_method', 'S256');
  q.set('login_hint', p.loginHint);
  return u.href;
}

/** POST a token request; returns the parsed JSON object of a 2xx answer. */
async function tokenRequest(
  config: MailboxOAuthConfig,
  provider: MailboxOAuthProvider,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const c = clientOf(config, provider);
  const spec = MAILBOX_OAUTH_PROVIDERS[provider];
  const body = new URLSearchParams({
    ...form,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    ...(spec.scopeOnToken ? { scope: spec.scope } : {}),
  });
  const doFetch = config.fetch ?? fetch;
  let res: Response;
  let text: string;
  try {
    res = await doFetch(spec.tokenUrl(tenantOf(c)), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    text = await boundedText(res);
  } catch (e) {
    if (e instanceof MailboxOAuthError) throw e;
    // Network failure, timeout, redirect: the next poll retries (never the error text).
    throw new MailboxOAuthError('connect_failed');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MailboxOAuthError('connect_failed');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new MailboxOAuthError('connect_failed');
  }
  const o = json as Record<string, unknown>;
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500 && AUTH_ERRORS.has(String(o.error))) {
      throw new MailboxOAuthError('auth_failed');
    }
    throw new MailboxOAuthError('connect_failed');
  }
  return o;
}

/** The body as text, refusing more than MAX_ANSWER_BYTES. */
async function boundedText(res: Response): Promise<string> {
  const declaredBytes = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
  if (declaredBytes > MAX_ANSWER_BYTES) throw new MailboxOAuthError('connect_failed');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new MailboxOAuthError('connect_failed');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function accessTokenOf(o: Record<string, unknown>): string {
  const t = o.access_token;
  if (typeof t !== 'string' || !TOKEN.test(t)) throw new MailboxOAuthError('connect_failed');
  if (typeof o.token_type === 'string' && o.token_type.toLowerCase() !== 'bearer') {
    throw new MailboxOAuthError('connect_failed');
  }
  return t;
}

function refreshTokenOf(o: Record<string, unknown>): string | null {
  const r = o.refresh_token;
  if (r === undefined || r === null) return null;
  if (typeof r !== 'string' || !TOKEN.test(r)) throw new MailboxOAuthError('connect_failed');
  return r;
}

/** Exchange the authorization code (with the PKCE verifier) for an access and a refresh token. */
export async function exchangeAuthorizationCode(
  config: MailboxOAuthConfig,
  provider: MailboxOAuthProvider,
  p: { code: string; codeVerifier: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  if (!TOKEN.test(p.code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.codeVerifier)) {
    throw new MailboxOAuthError('invalid_request');
  }
  const o = await tokenRequest(config, provider, {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: config.redirectUri,
    code_verifier: p.codeVerifier,
  });
  const accessToken = accessTokenOf(o);
  const refreshToken = refreshTokenOf(o);
  // Without a refresh token (offline access refused) the mailbox could not be polled later.
  if (refreshToken === null) throw new MailboxOAuthError('auth_failed');
  return { accessToken, refreshToken };
}

/**
 * A fresh access token for one poll. `refreshToken` in the answer is the rotated token
 * (Microsoft replaces it on every use, RQ-0187 S4) or null when the provider keeps the old one.
 */
export async function refreshAccessToken(
  config: MailboxOAuthConfig,
  provider: MailboxOAuthProvider,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  if (!TOKEN.test(refreshToken)) throw new MailboxOAuthError('auth_failed');
  const o = await tokenRequest(config, provider, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return { accessToken: accessTokenOf(o), refreshToken: refreshTokenOf(o) };
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

function providerFromEnv(
  env: Env,
  readFile: ReadFile | undefined,
  prefix: string,
  withTenant: boolean,
): MailboxOAuthClient | undefined {
  const clientId = (env[`${prefix}_CLIENT_ID`] ?? '').trim();
  const secret = readSecret(env, `${prefix}_CLIENT_SECRET`, readFile)?.trim() ?? '';
  const tenant = withTenant ? (env[`${prefix}_TENANT`] ?? '').trim() : '';
  if (clientId === '' && secret === '' && tenant === '') return undefined;
  if (clientId === '' || !/^[\x21-\x7e]{1,256}$/.test(clientId)) {
    throw new ConfigError(`${prefix}_CLIENT_ID is required (printable, no spaces)`);
  }
  if (secret === '' || !/^[\x21-\x7e]{1,1024}$/.test(secret)) {
    throw new ConfigError(`${prefix}_CLIENT_SECRET (or ${prefix}_CLIENT_SECRET_FILE) is required`);
  }
  if (tenant !== '' && !/^[A-Za-z0-9.-]{1,253}$/.test(tenant)) {
    throw new ConfigError(`${prefix}_TENANT must be a tenant id, domain, organizations or common`);
  }
  return { clientId, clientSecret: secret, ...(tenant !== '' ? { tenant } : {}) };
}

/**
 * Install configuration (ADR-0105 rule 2): `LF_MAILBOX_OAUTH_REDIRECT_URI` (https, or http on a
 * loopback host for development), `LF_MAILBOX_OAUTH_MS_CLIENT_ID`, `…_MS_CLIENT_SECRET[_FILE]`,
 * `…_MS_TENANT` (default organizations), `LF_MAILBOX_OAUTH_GOOGLE_CLIENT_ID`,
 * `…_GOOGLE_CLIENT_SECRET[_FILE]`. Null when no provider is configured.
 */
export function mailboxOAuthConfigFromEnv(
  env: Env,
  readFile?: ReadFile,
): MailboxOAuthConfig | null {
  const microsoft = providerFromEnv(env, readFile, 'LF_MAILBOX_OAUTH_MS', true);
  const google = providerFromEnv(env, readFile, 'LF_MAILBOX_OAUTH_GOOGLE', false);
  if (!microsoft && !google) return null;
  const raw = (env['LF_MAILBOX_OAUTH_REDIRECT_URI'] ?? '').trim();
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    throw new ConfigError('LF_MAILBOX_OAUTH_REDIRECT_URI must be an absolute URL');
  }
  if (
    uri.hash !== '' ||
    uri.username !== '' ||
    !(uri.protocol === 'https:' || (uri.protocol === 'http:' && isLoopback(uri.hostname)))
  ) {
    throw new ConfigError(
      'LF_MAILBOX_OAUTH_REDIRECT_URI must be https (http only on a loopback host), without fragment or credentials',
    );
  }
  return {
    redirectUri: uri.href,
    ...(microsoft ? { microsoft } : {}),
    ...(google ? { google } : {}),
  };
}
