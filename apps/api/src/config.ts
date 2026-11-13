/**
 * Runtime configuration of the API from the environment (T-0094, RQ-0041). Used by `main.ts`.
 *
 *  - Database: lf_app only (`databaseUrlFromEnv`): LF_DATABASE_URL, or LF_DB_HOST/LF_DB_PORT/
 *    LF_DB_NAME with LF_APP_DB_PASSWORD[_FILE].
 *  - Sessions are always on (ADR-0016). OIDC login is on when LF_OIDC_ISSUER is set; it needs
 *    LF_OIDC_CLIENT_ID and LF_OIDC_CLIENT_SECRET[_FILE], and LF_PUBLIC_URL (the redirect base).
 *  - Plain http (issuer or public URL) only for a loopback host — localhost, 127.0.0.1, ::1 or a
 *    `*.localhost` name (a local install); anything else must be https.
 */
import {
  ConfigError,
  databaseUrlFromEnv,
  readSecret,
  requireEnv,
  requireSecret,
  type Env,
  type ReadFile,
} from '@ledgerforce/db';
import { readFileSync } from 'node:fs';
import type { ApiOptions } from './app.ts';
import { DEFAULT_RATE_LIMITS } from './security/rate-limit.ts';

export type ApiRuntimeOptions = ApiOptions & { host: string; port: number };

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Parses an http(s) URL; http only for loopback hosts. Returns the URL without a trailing slash. */
function webUrl(env: Env, name: string): { href: string; insecure: boolean } {
  const raw = requireEnv(env, name);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ConfigError(`${name} must use https`);
  }
  const insecure = u.protocol === 'http:';
  if (insecure && !isLoopback(u.hostname)) {
    throw new ConfigError(`${name} must use https (http is allowed only for a loopback host)`);
  }
  return { href: u.href.replace(/\/+$/, ''), insecure };
}

function port(env: Env): number {
  const raw = env['PORT'] ?? '3000';
  const n = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new ConfigError('PORT must be a port number');
  return n;
}

/**
 * LF_TRUST_PROXY_HOPS (ADR-0054 rule 5): how many proxies in front of the API append trusted
 * X-Forwarded-For entries — compose's nginx is 1, plus 1 for an operator's TLS proxy. Default 0.
 */
function trustProxyHops(env: Env): number {
  const raw = env['LF_TRUST_PROXY_HOPS'];
  if (raw === undefined) return 0;
  if (!/^[0-5]$/.test(raw)) throw new ConfigError('LF_TRUST_PROXY_HOPS must be an integer 0–5');
  return Number(raw);
}

export function apiOptionsFromEnv(
  env: Env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): ApiRuntimeOptions {
  const databaseUrl = databaseUrlFromEnv(env, 'lf_app', readFile);
  const publicUrl = webUrl(env, 'LF_PUBLIC_URL');
  const opts: ApiRuntimeOptions = {
    databaseUrl,
    sessions: {},
    // ADR-0054: always on in production; HSTS only when the public origin is https.
    security: {
      hsts: !publicUrl.insecure,
      trustProxyHops: trustProxyHops(env),
      rateLimits: DEFAULT_RATE_LIMITS,
    },
    host: env['HOST'] ?? '127.0.0.1',
    port: port(env),
  };
  if (env['LF_OIDC_ISSUER'] !== undefined && env['LF_OIDC_ISSUER'] !== '') {
    const issuer = webUrl(env, 'LF_OIDC_ISSUER');
    opts.oidc = {
      issuer: issuer.href,
      clientId: requireEnv(env, 'LF_OIDC_CLIENT_ID'),
      clientSecret: requireSecret(env, 'LF_OIDC_CLIENT_SECRET', readFile),
      publicUrl: publicUrl.href,
      allowInsecureIssuer: issuer.insecure,
    };
  }
  const webhook = stripeWebhook(env, readFile);
  if (webhook) opts.stripeWebhook = webhook;
  return opts;
}

/**
 * Stripe webhook signing (ADR-0049): LF_STRIPE_WEBHOOK_SECRET[_FILE], comma-separated `whsec_…`
 * values during a secret roll, and LF_STRIPE_MODE (`test` by default). Unset: the route answers 503.
 */
function stripeWebhook(
  env: Env,
  readFile: ReadFile,
): { secrets: string[]; mode: 'test' | 'live' } | undefined {
  const raw = readSecret(env, 'LF_STRIPE_WEBHOOK_SECRET', readFile);
  if (raw === undefined || raw === '') return undefined;
  const secrets = raw.split(',').map((s) => s.trim());
  if (secrets.some((s) => !/^whsec_\S+$/.test(s))) {
    throw new ConfigError('LF_STRIPE_WEBHOOK_SECRET must be one or more whsec_… values');
  }
  const mode = env['LF_STRIPE_MODE'] ?? 'test';
  if (mode !== 'test' && mode !== 'live') {
    throw new ConfigError('LF_STRIPE_MODE must be test or live');
  }
  return { secrets, mode };
}
