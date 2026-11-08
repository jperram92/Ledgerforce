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
  requireEnv,
  requireSecret,
  type Env,
  type ReadFile,
} from '@ledgerforce/db';
import { readFileSync } from 'node:fs';
import type { ApiOptions } from './app.ts';

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

export function apiOptionsFromEnv(
  env: Env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): ApiRuntimeOptions {
  const databaseUrl = databaseUrlFromEnv(env, 'lf_app', readFile);
  const publicUrl = webUrl(env, 'LF_PUBLIC_URL');
  const opts: ApiRuntimeOptions = {
    databaseUrl,
    sessions: {},
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
  return opts;
}
