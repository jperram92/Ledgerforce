/**
 * SS-PLAT-85 — the `setup` service's configuration from the environment (T-0094): both role URLs,
 * the public URL and issuer, tenant and Owner, the reissue switch and the Keycloak admin client
 * (secret from a file). Nothing has a default that is a credential.
 */
import { describe, expect, it } from 'vitest';
import { setupConfigFromEnv } from './setup-config.ts';

const files: Record<string, string> = {
  '/s/mig': 'mig-pw\n',
  '/s/app': 'app-pw\n',
  '/s/kc': 'kc-client-secret\n',
};
const readFile = (p: string): string => {
  const v = files[p];
  if (v === undefined) throw new Error('ENOENT');
  return v;
};
const env = {
  LF_DB_HOST: 'postgres',
  LF_MIGRATOR_DB_PASSWORD_FILE: '/s/mig',
  LF_APP_DB_PASSWORD_FILE: '/s/app',
  LF_PUBLIC_URL: 'http://ledgerforce.localhost:8080/',
  LF_TENANT_SLUG: 'harbour-co',
  LF_TENANT_NAME: 'Harbour Co',
  LF_OWNER_EMAIL: 'owner@example.test',
  LF_OWNER_NAME: 'Olivia Owner',
  LF_KEYCLOAK_URL: 'http://keycloak:8080',
  LF_KEYCLOAK_ADMIN_CLIENT_ID: 'lf-bootstrap',
  LF_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/s/kc',
};

describe('SS-PLAT-85 setup configuration', () => {
  it('SS-PLAT-85 reads both roles, the tenant, the Owner and the Keycloak admin client', () => {
    const c = setupConfigFromEnv(env, readFile);
    expect(new URL(c.setup.migratorUrl).username).toBe('lf_migrator');
    expect(new URL(c.setup.appUrl).username).toBe('lf_app');
    expect(c.setup.publicUrl).toBe('http://ledgerforce.localhost:8080');
    expect(c.setup.issuer).toBe('http://ledgerforce.localhost:8080/realms/ledgerforce');
    expect(c.setup.tenant).toEqual({ slug: 'harbour-co', name: 'Harbour Co' });
    expect(c.setup.owner).toEqual({ email: 'owner@example.test', displayName: 'Olivia Owner' });
    expect(c.setup.reissue).toBe(false);
    expect(c.keycloak).toEqual({
      baseUrl: 'http://keycloak:8080',
      realm: 'ledgerforce',
      clientId: 'lf-bootstrap',
      clientSecret: 'kc-client-secret',
    });
  });

  it('SS-PLAT-85 honours LF_OIDC_ISSUER, LF_KEYCLOAK_REALM and LF_SETUP_REISSUE=1 only', () => {
    const c = setupConfigFromEnv(
      {
        ...env,
        LF_OIDC_ISSUER: 'https://id.example.com/realms/acme',
        LF_KEYCLOAK_REALM: 'acme',
        LF_SETUP_REISSUE: '1',
      },
      readFile,
    );
    expect(c.setup.issuer).toBe('https://id.example.com/realms/acme');
    expect(c.keycloak.realm).toBe('acme');
    expect(c.setup.reissue).toBe(true);
    expect(setupConfigFromEnv({ ...env, LF_SETUP_REISSUE: 'yes' }, readFile).setup.reissue).toBe(
      false,
    );
  });

  it('SS-PLAT-85 names each missing setting and has no credential default', () => {
    for (const k of [
      'LF_TENANT_SLUG',
      'LF_TENANT_NAME',
      'LF_OWNER_EMAIL',
      'LF_OWNER_NAME',
      'LF_PUBLIC_URL',
      'LF_KEYCLOAK_URL',
      'LF_KEYCLOAK_ADMIN_CLIENT_ID',
    ] as const) {
      const { [k]: _drop, ...rest } = env;
      expect(() => setupConfigFromEnv(rest, readFile)).toThrow(new RegExp(k));
    }
    const { LF_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: _s, ...noSecret } = env;
    expect(() => setupConfigFromEnv(noSecret, readFile)).toThrow(
      /LF_KEYCLOAK_ADMIN_CLIENT_SECRET or LF_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE/,
    );
    const { LF_MIGRATOR_DB_PASSWORD_FILE: _m, ...noMig } = env;
    expect(() => setupConfigFromEnv(noMig, readFile)).toThrow(/LF_MIGRATOR_DB_PASSWORD/);
  });
});
