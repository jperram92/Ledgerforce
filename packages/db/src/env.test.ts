/**
 * SS-PLAT-86 — deployment configuration (T-0094, RQ-0041): secrets come from `<NAME>` or from the
 * file named by `<NAME>_FILE` (compose file secrets), never both, and every connection string
 * names the role it must use. Error messages name the variable, never the secret.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, databaseUrlFromEnv, readSecret, requireSecret } from './env.ts';

const files: Record<string, string> = {
  '/run/secrets/app': 's3cret-app\n',
  '/run/secrets/odd': 'p@ss:/w#rd %?&\n',
  '/run/secrets/empty': '\n',
};
const readFile = (p: string): string => {
  const v = files[p];
  if (v === undefined) throw new Error(`ENOENT ${p}`);
  return v;
};

describe('SS-PLAT-86 secrets from env or file', () => {
  it('SS-PLAT-86 reads a secret from the variable or, trimmed, from the _FILE path', () => {
    expect(readSecret({ X: 'direct' }, 'X', readFile)).toBe('direct');
    expect(readSecret({ X_FILE: '/run/secrets/app' }, 'X', readFile)).toBe('s3cret-app');
    expect(readSecret({}, 'X', readFile)).toBeUndefined();
  });

  it('SS-PLAT-86 refuses both forms at once, an empty file and a missing required secret', () => {
    expect(() => readSecret({ X: 'a', X_FILE: '/run/secrets/app' }, 'X', readFile)).toThrow(
      /X and X_FILE/,
    );
    expect(() => readSecret({ X_FILE: '/run/secrets/empty' }, 'X', readFile)).toThrow(/X_FILE/);
    expect(() => requireSecret({}, 'X', readFile)).toThrow(ConfigError);
    expect(() => requireSecret({}, 'X', readFile)).toThrow(/X or X_FILE is required/);
  });

  it('SS-PLAT-86 never puts the secret value in an error message', () => {
    const msgs: string[] = [];
    for (const env of [
      { LF_DATABASE_URL: 'postgres://postgres:topsecret-pw@db/ledgerforce' },
      { LF_DATABASE_URL: 'not a url topsecret-pw' },
    ]) {
      try {
        databaseUrlFromEnv(env, 'lf_app', readFile);
      } catch (e) {
        msgs.push((e as Error).message);
      }
    }
    expect(msgs).toHaveLength(2);
    for (const m of msgs) expect(m).not.toContain('topsecret-pw');
  });
});

describe('SS-PLAT-86 database URL per role', () => {
  it('SS-PLAT-86 composes host, port, database, role and the URL-encoded password file', () => {
    const url = databaseUrlFromEnv(
      { LF_DB_HOST: 'postgres', LF_DB_NAME: 'ledgerforce', LF_APP_DB_PASSWORD_FILE: '/run/secrets/odd' },
      'lf_app',
      readFile,
    );
    const u = new URL(url);
    expect(u.protocol).toBe('postgres:');
    expect(u.username).toBe('lf_app');
    expect(decodeURIComponent(u.password)).toBe('p@ss:/w#rd %?&');
    expect(u.hostname).toBe('postgres');
    expect(u.port).toBe('5432');
    expect(u.pathname).toBe('/ledgerforce');
  });

  it('SS-PLAT-86 uses the migrator password for lf_migrator and a given port', () => {
    const u = new URL(
      databaseUrlFromEnv(
        {
          LF_DB_HOST: 'db',
          LF_DB_PORT: '6543',
          LF_DB_NAME: 'lf',
          LF_MIGRATOR_DB_PASSWORD: 'm-pw',
          LF_APP_DB_PASSWORD: 'a-pw',
        },
        'lf_migrator',
        readFile,
      ),
    );
    expect([u.username, u.password, u.port, u.pathname]).toEqual(['lf_migrator', 'm-pw', '6543', '/lf']);
  });

  it('SS-PLAT-86 accepts a full URL only when it names the expected role', () => {
    expect(
      databaseUrlFromEnv({ LF_DATABASE_URL: 'postgres://lf_app:x@h:5432/d' }, 'lf_app', readFile),
    ).toBe('postgres://lf_app:x@h:5432/d');
    expect(
      databaseUrlFromEnv(
        { LF_MIGRATOR_DATABASE_URL: 'postgres://lf_migrator:x@h/d' },
        'lf_migrator',
        readFile,
      ),
    ).toBe('postgres://lf_migrator:x@h/d');
    expect(() =>
      databaseUrlFromEnv({ LF_DATABASE_URL: 'postgres://postgres:x@h/d' }, 'lf_app', readFile),
    ).toThrow(/must connect as lf_app/);
    expect(() =>
      databaseUrlFromEnv({ LF_DATABASE_URL: 'postgres://lf_migrator:x@h/d' }, 'lf_app', readFile),
    ).toThrow(/must connect as lf_app/);
  });

  it('SS-PLAT-86 names what is missing', () => {
    expect(() => databaseUrlFromEnv({}, 'lf_app', readFile)).toThrow(/LF_DB_HOST/);
    expect(() => databaseUrlFromEnv({ LF_DB_HOST: 'h' }, 'lf_app', readFile)).toThrow(
      /LF_APP_DB_PASSWORD or LF_APP_DB_PASSWORD_FILE is required/,
    );
    expect(() => databaseUrlFromEnv({ LF_DB_HOST: 'h', LF_DB_PORT: '0x10', LF_APP_DB_PASSWORD: 'p' }, 'lf_app', readFile)).toThrow(/LF_DB_PORT/);
  });
});
