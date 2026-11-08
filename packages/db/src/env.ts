/**
 * Deployment configuration helpers (T-0094, RQ-0041 finding 9). A secret is given either as the
 * variable `<NAME>` or as a file path in `<NAME>_FILE` (compose file secrets under /run/secrets),
 * never both. Connection strings always name the role they must use: the application connects as
 * lf_app and migrations as lf_migrator (AGENTS.md §4). Errors name variables, never values.
 */
import { readFileSync } from 'node:fs';

export type Env = Readonly<Record<string, string | undefined>>;
export type ReadFile = (path: string) => string;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const readUtf8: ReadFile = (p) => readFileSync(p, 'utf8');

export function readSecret(
  env: Env,
  name: string,
  readFile: ReadFile = readUtf8,
): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new ConfigError(`${name} and ${name}_FILE are both set; set only one`);
  }
  if (file !== undefined) {
    let value: string;
    try {
      value = readFile(file).trim();
    } catch {
      throw new ConfigError(`${name}_FILE names a file that cannot be read`);
    }
    if (value === '') throw new ConfigError(`${name}_FILE names an empty file`);
    return value;
  }
  return direct === '' ? undefined : direct;
}

export function requireSecret(env: Env, name: string, readFile: ReadFile = readUtf8): string {
  const v = readSecret(env, name, readFile);
  if (v === undefined) throw new ConfigError(`${name} or ${name}_FILE is required`);
  return v;
}

export function requireEnv(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new ConfigError(`${name} is required`);
  return v;
}

export type DbRole = 'lf_app' | 'lf_migrator';

const ROLE_VARS: Record<DbRole, { url: string; password: string }> = {
  lf_app: { url: 'LF_DATABASE_URL', password: 'LF_APP_DB_PASSWORD' },
  lf_migrator: { url: 'LF_MIGRATOR_DATABASE_URL', password: 'LF_MIGRATOR_DB_PASSWORD' },
};

/**
 * Connection string for `role`: the full URL variable if set (it must name that role), else
 * `postgres://<role>:<password>@LF_DB_HOST:LF_DB_PORT/LF_DB_NAME` with the role's password secret.
 */
export function databaseUrlFromEnv(env: Env, role: DbRole, readFile: ReadFile = readUtf8): string {
  const vars = ROLE_VARS[role];
  const full = env[vars.url];
  if (full !== undefined && full !== '') {
    let user: string;
    try {
      user = decodeURIComponent(new URL(full).username);
    } catch {
      throw new ConfigError(`${vars.url} is not a valid URL`);
    }
    if (user !== role) throw new ConfigError(`${vars.url} must connect as ${role}`);
    return full;
  }
  const host = requireEnv(env, 'LF_DB_HOST');
  const portText = env['LF_DB_PORT'] ?? '5432';
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new ConfigError('LF_DB_PORT must be a port number');
  }
  const database = env['LF_DB_NAME'] ?? 'ledgerforce';
  const password = requireSecret(env, vars.password, readFile);
  const u = new URL('postgres://placeholder');
  u.hostname = host;
  u.port = portText;
  u.pathname = `/${database}`;
  u.username = role;
  u.password = encodeURIComponent(password);
  return u.href;
}
