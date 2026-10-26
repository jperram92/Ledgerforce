/**
 * SS-PLAT-86 — the API's runtime configuration for the self-hosted install (T-0094, RQ-0041):
 * lf_app only, sessions on, OIDC from the environment with the client secret from a file, and a
 * plain-http issuer or public URL only on a loopback host (a local install), never elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { apiOptionsFromEnv } from './config.ts';

const files: Record<string, string> = {
  '/run/secrets/lf_app_password': 'app-pw\n',
  '/run/secrets/oidc_client_secret': 'client-secret\n',
};
const readFile = (p: string): string => {
  const v = files[p];
  if (v === undefined) throw new Error(`ENOENT ${p}`);
  return v;
};

const LOCAL = 'http://ledgerforce.localhost:8080';
const base = {
  LF_DB_HOST: 'postgres',
  LF_DB_NAME: 'ledgerforce',
  LF_APP_DB_PASSWORD_FILE: '/run/secrets/lf_app_password',
  LF_PUBLIC_URL: LOCAL,
  LF_OIDC_ISSUER: `${LOCAL}/realms/ledgerforce`,
  LF_OIDC_CLIENT_ID: 'ledgerforce',
  LF_OIDC_CLIENT_SECRET_FILE: '/run/secrets/oidc_client_secret',
};

describe('SS-PLAT-86 API configuration from the environment', () => {
  it('SS-PLAT-86 a local install: lf_app, sessions, OIDC with the secret from its file', () => {
    const o = apiOptionsFromEnv(base, readFile);
    expect(new URL(o.databaseUrl).username).toBe('lf_app');
    expect(o.sessions).toEqual({});
    expect(o.oidc).toEqual({
      issuer: `${LOCAL}/realms/ledgerforce`,
      clientId: 'ledgerforce',
      clientSecret: 'client-secret',
      publicUrl: LOCAL,
      allowInsecureIssuer: true,
    });
    expect(o.host).toBe('127.0.0.1');
    expect(o.port).toBe(3000);
  });

  it('SS-PLAT-86 HOST and PORT are honoured and a bad port is refused', () => {
    const o = apiOptionsFromEnv({ ...base, HOST: '0.0.0.0', PORT: '3100' }, readFile);
    expect([o.host, o.port]).toEqual(['0.0.0.0', 3100]);
    expect(() => apiOptionsFromEnv({ ...base, PORT: '70000' }, readFile)).toThrow(/PORT/);
    expect(() => apiOptionsFromEnv({ ...base, PORT: 'abc' }, readFile)).toThrow(/PORT/);
  });

  it('SS-PLAT-86 an https deployment does not allow insecure requests', () => {
    const o = apiOptionsFromEnv(
      {
        ...base,
        LF_PUBLIC_URL: 'https://ledger.example.com',
        LF_OIDC_ISSUER: 'https://ledger.example.com/realms/ledgerforce',
      },
      readFile,
    );
    expect(o.oidc?.allowInsecureIssuer).toBe(false);
    expect(o.oidc?.publicUrl).toBe('https://ledger.example.com');
  });

  it('SS-PLAT-86 plain http is refused for any host that is not loopback', () => {
    expect(() =>
      apiOptionsFromEnv(
        { ...base, LF_OIDC_ISSUER: 'http://idp.example.com/realms/ledgerforce' },
        readFile,
      ),
    ).toThrow(/LF_OIDC_ISSUER must use https/);
    expect(() =>
      apiOptionsFromEnv({ ...base, LF_PUBLIC_URL: 'http://ledger.example.com' }, readFile),
    ).toThrow(/LF_PUBLIC_URL must use https/);
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'acme.localhost']) {
      expect(() =>
        apiOptionsFromEnv(
          {
            ...base,
            LF_PUBLIC_URL: `http://${host}:8080`,
            LF_OIDC_ISSUER: `http://${host}:8080/realms/ledgerforce`,
          },
          readFile,
        ),
      ).not.toThrow();
    }
    expect(() =>
      apiOptionsFromEnv({ ...base, LF_PUBLIC_URL: 'http://localhost.example.com' }, readFile),
    ).toThrow(/https/);
  });

  it('SS-PLAT-86 OIDC needs a client id and secret, and refuses a database role other than lf_app', () => {
    const { LF_OIDC_CLIENT_SECRET_FILE: _s, ...noSecret } = base;
    expect(() => apiOptionsFromEnv(noSecret, readFile)).toThrow(
      /LF_OIDC_CLIENT_SECRET or LF_OIDC_CLIENT_SECRET_FILE is required/,
    );
    const { LF_OIDC_CLIENT_ID: _c, ...noClient } = base;
    expect(() => apiOptionsFromEnv(noClient, readFile)).toThrow(/LF_OIDC_CLIENT_ID/);
    expect(() =>
      apiOptionsFromEnv({ ...base, LF_DATABASE_URL: 'postgres://lf_migrator:x@h/d' }, readFile),
    ).toThrow(/must connect as lf_app/);
    const { LF_PUBLIC_URL: _p, ...noPublic } = base;
    expect(() => apiOptionsFromEnv(noPublic, readFile)).toThrow(/LF_PUBLIC_URL/);
  });

  it('SS-PLAT-86 without an issuer the API runs with sessions but no login routes', () => {
    const { LF_OIDC_ISSUER: _i, LF_OIDC_CLIENT_ID: _c, LF_OIDC_CLIENT_SECRET_FILE: _s, ...rest } =
      base;
    const o = apiOptionsFromEnv(rest, readFile);
    expect(o.oidc).toBeUndefined();
    expect(o.sessions).toEqual({});
  });
});
