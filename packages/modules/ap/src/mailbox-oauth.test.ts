/**
 * SS-PLAT-189 — the bills mailbox OAuth2 client (T-0216, ADR-0105, RQ-0187): PKCE, the
 * authorization URL per provider, code exchange and refresh against recorded token responses,
 * error classes, transport limits, and configuration. No network: `fetch` is the recorded stand-in.
 */
import { ConfigError } from '@ledgerforce/db';
import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  MAILBOX_OAUTH_PROVIDERS,
  MailboxOAuthError,
  mailboxOAuthConfigFromEnv,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
  refreshAccessToken,
  type MailboxOAuthConfig,
} from './mailbox-oauth.ts';
import { recordedBody, recordedTokenFetch } from './testing/oauth-token-fetch.ts';

const MS_SECRET = 'ms-client-secret-value~1';
const G_SECRET = 'GOCSPX-google-client-secret';

function config(f: typeof fetch): MailboxOAuthConfig {
  return {
    redirectUri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
    microsoft: { clientId: '11111111-2222-3333-4444-555555555555', clientSecret: MS_SECRET },
    google: { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: G_SECRET },
    fetch: f,
  };
}

const failure = async (p: Promise<unknown>): Promise<MailboxOAuthError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MailboxOAuthError);
    return e as MailboxOAuthError;
  }
  throw new Error('expected a MailboxOAuthError');
};

/** No secret, token or provider text in a thrown error. */
const clean = (e: Error) => {
  for (const leak of [
    MS_SECRET,
    G_SECRET,
    'AADSTS',
    'harbour',
    'expired or revoked',
    'refresh',
    'ya29',
    '1//0g',
  ]) {
    expect(e.message).not.toContain(leak);
  }
};

describe('SS-PLAT-189: PKCE and state (RFC 7636)', () => {
  it('SS-PLAT-189 the S256 challenge equals the RFC 7636 Appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('SS-PLAT-189 verifiers and states are 43-character base64url values from 256 random bits, never repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const v of [newPkceVerifier(), newOAuthState()]) {
        expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(seen.has(v)).toBe(false);
        seen.add(v);
      }
    }
  });
});

describe('SS-PLAT-189: authorization URL per provider', () => {
  it('SS-PLAT-189 Microsoft: v2.0 authorize endpoint of the configured tenant, IMAP delegated scope + offline_access, PKCE S256, state, login_hint', () => {
    const f = recordedTokenFetch();
    const c = config(f.fetch);
    const u = new URL(
      authorizationUrl(c, 'microsoft', {
        state: 'state-1',
        codeChallenge: 'challenge-1',
        loginHint: 'bills@harbour.example',
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '11111111-2222-3333-4444-555555555555',
      response_type: 'code',
      redirect_uri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
      response_mode: 'query',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      login_hint: 'bills@harbour.example',
    });
    expect(u.href).not.toContain(MS_SECRET);
    const t = new URL(
      authorizationUrl(
        {
          ...c,
          microsoft: {
            ...(c.microsoft ?? { clientId: '', clientSecret: '' }),
            tenant: 'harbour.onmicrosoft.com',
          },
        },
        'microsoft',
        { state: 's', codeChallenge: 'c', loginHint: 'a@b.example' },
      ),
    );
    expect(t.pathname).toBe('/harbour.onmicrosoft.com/oauth2/v2.0/authorize');
  });

  it('SS-PLAT-189 Google: v2 auth endpoint, https://mail.google.com/ scope, offline access with consent, PKCE S256, state, login_hint', () => {
    const f = recordedTokenFetch();
    const u = new URL(
      authorizationUrl(config(f.fetch), 'google', {
        state: 'state-2',
        codeChallenge: 'challenge-2',
        loginHint: 'bills@harbour.example',
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '1234-abc.apps.googleusercontent.com',
      response_type: 'code',
      redirect_uri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
      scope: 'https://mail.google.com/',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: 'state-2',
      code_challenge: 'challenge-2',
      code_challenge_method: 'S256',
      login_hint: 'bills@harbour.example',
    });
  });

  it('SS-PLAT-189 the IMAP endpoints are fixed per provider (never operator-entered)', () => {
    expect(MAILBOX_OAUTH_PROVIDERS.microsoft.imapHost).toBe('outlook.office365.com');
    expect(MAILBOX_OAUTH_PROVIDERS.google.imapHost).toBe('imap.gmail.com');
    expect(MAILBOX_OAUTH_PROVIDERS.microsoft.imapPort).toBe(993);
    expect(MAILBOX_OAUTH_PROVIDERS.google.imapPort).toBe(993);
  });

  it('SS-PLAT-189 a provider without configuration is not_configured', async () => {
    const f = recordedTokenFetch();
    const c: MailboxOAuthConfig = { redirectUri: config(f.fetch).redirectUri, fetch: f.fetch };
    const e = await failure(
      Promise.resolve().then(() =>
        authorizationUrl(c, 'google', { state: 's', codeChallenge: 'c', loginHint: 'a@b.example' }),
      ),
    );
    expect(e.kind).toBe('not_configured');
  });
});

describe('SS-PLAT-189: code exchange and refresh against recorded token responses', () => {
  it('SS-PLAT-189 Microsoft code exchange: form POST with code, verifier, redirect URI and client credentials; returns both tokens', async () => {
    const f = recordedTokenFetch();
    f.queue('microsoft_code');
    const t = await exchangeAuthorizationCode(config(f.fetch), 'microsoft', {
      code: 'M.C507_BAY.2.U.code',
      codeVerifier: 'v'.repeat(43),
    });
    const body = recordedBody('microsoft_code');
    expect(t).toEqual({ accessToken: body.access_token, refreshToken: body.refresh_token });
    expect(f.seen).toHaveLength(1);
    const r = f.seen[0];
    expect(r?.url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    expect(r?.method).toBe('POST');
    expect(r?.redirect).toBe('error');
    expect(r?.contentType).toBe('application/x-www-form-urlencoded');
    expect(r?.form).toEqual({
      grant_type: 'authorization_code',
      code: 'M.C507_BAY.2.U.code',
      redirect_uri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
      code_verifier: 'v'.repeat(43),
      client_id: '11111111-2222-3333-4444-555555555555',
      client_secret: MS_SECRET,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    });
  });

  it('SS-PLAT-189 Google code exchange returns both tokens; an answer without a refresh token is auth_failed', async () => {
    const f = recordedTokenFetch();
    f.queue('google_code', 'google_refresh');
    const c = config(f.fetch);
    const t = await exchangeAuthorizationCode(c, 'google', {
      code: '4/0Ab',
      codeVerifier: 'x'.repeat(43),
    });
    expect(t.refreshToken).toBe(recordedBody('google_code').refresh_token);
    expect(f.seen[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(f.seen[0]?.form.scope).toBeUndefined();
    // A code answer without refresh_token (offline access not granted) cannot poll later.
    const e = await failure(
      exchangeAuthorizationCode(c, 'google', { code: '4/0Ac', codeVerifier: 'x'.repeat(43) }),
    );
    expect(e.kind).toBe('auth_failed');
  });

  it('SS-PLAT-189 refresh: Microsoft rotates the refresh token, Google keeps it (refreshToken null)', async () => {
    const f = recordedTokenFetch();
    f.queue('microsoft_refresh', 'google_refresh');
    const c = config(f.fetch);
    const ms = await refreshAccessToken(c, 'microsoft', 'old-ms-refresh');
    expect(ms).toEqual({
      accessToken: recordedBody('microsoft_refresh').access_token,
      refreshToken: recordedBody('microsoft_refresh').refresh_token,
    });
    expect(f.seen[0]?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-ms-refresh',
      client_id: '11111111-2222-3333-4444-555555555555',
      client_secret: MS_SECRET,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    });
    const g = await refreshAccessToken(c, 'google', 'old-g-refresh');
    expect(g).toEqual({
      accessToken: recordedBody('google_refresh').access_token,
      refreshToken: null,
    });
  });
});

describe('SS-PLAT-189: failures are fixed classes without secrets or provider text', () => {
  it('SS-PLAT-189 invalid_grant (Microsoft and Google) → auth_failed', async () => {
    const f = recordedTokenFetch();
    f.queue('microsoft_invalid_grant', 'google_invalid_grant');
    const c = config(f.fetch);
    for (const p of ['microsoft', 'google'] as const) {
      const e = await failure(refreshAccessToken(c, p, 'revoked'));
      expect(e.kind).toBe('auth_failed');
      clean(e);
    }
  });

  it('SS-PLAT-189 5xx, network failure, timeout, redirect, non-JSON and oversized answers → connect_failed', async () => {
    const f = recordedTokenFetch();
    const big = JSON.stringify({ access_token: 'a'.repeat(70 * 1024), token_type: 'Bearer' });
    f.queue(
      'server_error',
      () => Promise.reject(new TypeError('fetch failed: getaddrinfo ENOTFOUND')),
      () => Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')),
      () => Promise.reject(new TypeError('unexpected redirect')),
      new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const c = config(f.fetch);
    for (let i = 0; i < 7; i += 1) {
      const e = await failure(refreshAccessToken(c, 'microsoft', 'r'));
      expect(e.kind).toBe('connect_failed');
      clean(e);
    }
  });

  it('SS-PLAT-189 an access token that could not be sent safely over IMAP is refused (connect_failed)', async () => {
    const f = recordedTokenFetch();
    f.queue(
      new Response(
        JSON.stringify({ access_token: 'has space', token_type: 'Bearer', refresh_token: 'r2' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const e = await failure(refreshAccessToken(config(f.fetch), 'microsoft', 'r'));
    expect(e.kind).toBe('connect_failed');
  });
});

describe('SS-PLAT-189: install configuration from the environment', () => {
  const files: Record<string, string> = { '/run/secrets/ms': `${MS_SECRET}\n` };
  const read = (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error('no file');
    return v;
  };

  it('SS-PLAT-189 nothing set → null; one provider with a secret file → configured', () => {
    expect(mailboxOAuthConfigFromEnv({}, read)).toBeNull();
    const c = mailboxOAuthConfigFromEnv(
      {
        LF_MAILBOX_OAUTH_REDIRECT_URI:
          'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
        LF_MAILBOX_OAUTH_MS_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
        LF_MAILBOX_OAUTH_MS_CLIENT_SECRET_FILE: '/run/secrets/ms',
        LF_MAILBOX_OAUTH_MS_TENANT: 'harbour.onmicrosoft.com',
      },
      read,
    );
    expect(c?.microsoft).toEqual({
      clientId: '11111111-2222-3333-4444-555555555555',
      clientSecret: MS_SECRET,
      tenant: 'harbour.onmicrosoft.com',
    });
    expect(c?.google).toBeUndefined();
  });

  it('SS-PLAT-189 incomplete or unsafe configuration is a ConfigError naming the variable, never the secret', () => {
    const bad = [
      { LF_MAILBOX_OAUTH_MS_CLIENT_ID: 'id', LF_MAILBOX_OAUTH_MS_CLIENT_SECRET: 's' },
      {
        LF_MAILBOX_OAUTH_REDIRECT_URI: 'http://books.harbour.example/cb',
        LF_MAILBOX_OAUTH_GOOGLE_CLIENT_ID: 'id',
        LF_MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET: 's',
      },
      {
        LF_MAILBOX_OAUTH_REDIRECT_URI: 'https://books.harbour.example/cb',
        LF_MAILBOX_OAUTH_GOOGLE_CLIENT_ID: 'id',
      },
      {
        LF_MAILBOX_OAUTH_REDIRECT_URI: 'https://books.harbour.example/cb',
        LF_MAILBOX_OAUTH_MS_CLIENT_ID: 'id',
        LF_MAILBOX_OAUTH_MS_CLIENT_SECRET: G_SECRET,
        LF_MAILBOX_OAUTH_MS_TENANT: 'bad/tenant',
      },
    ];
    for (const env of bad) {
      let err: unknown = null;
      try {
        mailboxOAuthConfigFromEnv(env, read);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/LF_MAILBOX_OAUTH_/);
      expect((err as Error).message).not.toContain(G_SECRET);
    }
    // A loopback redirect over http is allowed for local development.
    expect(
      mailboxOAuthConfigFromEnv(
        {
          LF_MAILBOX_OAUTH_REDIRECT_URI: 'http://localhost:3000/setup/bills-mailbox/oauth/callback',
          LF_MAILBOX_OAUTH_GOOGLE_CLIENT_ID: 'id',
          LF_MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET: 's',
        },
        read,
      )?.google?.clientId,
    ).toBe('id');
  });
});
